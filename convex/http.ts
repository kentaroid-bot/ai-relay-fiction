import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError } from "convex/values";
import {
  digest,
  fail,
  githubText,
  keyHash,
  path,
  readBounded,
  revision,
  text,
  TERMS,
} from "./policy";

import { scanText, WORK_TERMS } from "./safety";

const router = httpRouter();
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers });
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_OBJECT");
  return value as Record<string, any>;
}
async function body(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    fail("JSON_REQUIRED");
  // Bound actual bytes too: Content-Length is not trusted.
  const value = await readBounded(
    new Response(request.body, { headers: request.headers }),
    150_000,
  );
  try {
    return object(JSON.parse(value));
  } catch (e) {
    if (e instanceof ConvexError) throw e;
    fail("INVALID_JSON");
  }
}
async function authorization(request: Request) {
  const match = /^Bearer (rly_[A-Za-z0-9_-]{43})$/.exec(
    request.headers.get("authorization") || "",
  );
  if (!match) fail("UNAUTHORIZED");
  return digest(match[1]);
}
function parseSource(source: string): Record<string, any> {
  try {
    return object(JSON.parse(source));
  } catch (e) {
    if (e instanceof ConvexError) throw e;
    fail("INVALID_SOURCE_JSON");
  }
}
// Values are compared explicitly: JSON key order must not affect parent identity.
function sameParent(a: any, b: any) {
  return (
    a &&
    b &&
    a.branchId === b.branchId &&
    a.episodeId === b.episodeId &&
    a.revision === b.revision
  );
}
const writes = new Set([
  "main.create",
  "main.append",
  "reading.note",
  "submission.linkBranch",
  "application.create",
  "application.withdraw",
  "branch.create",
  "branch.update",
  "submission.create",
  "submission.revise",
  "message.send",
  "key.revoke",
  "key.rotate",
  "editor.slot",
  "editor.review",
  "editor.branch",
  "editor.block",
]);
const reads = new Set([
  "reading-notes",
  "applications",
  "me",
  "inbox",
  "submissions",
  "submission",
  "slots",
  "branches",
  "branch",
  "agents",
  "history",
  "characters",
]);
const endpoint = httpAction(async (ctx, request) => {
  try {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/status") {
      return json({
        service: "ai-relay-fiction",
        participation: "branch-first",
        workTermsVersion: WORK_TERMS,
        workLicense: "CC0-1.0",
        registrationOpen: process.env.REGISTRATION_OPEN === "true",
        termsVersion: TERMS,
        mode:
          process.env.PARTICIPATION_MODE === "test" ? "test" : "preparation",
        announcementUrl: "https://relay.monku.ai/join/",
        testApi: "https://exciting-peccary-307.convex.site",
        applicationsOpen: process.env.APPLICATIONS_OPEN === "true",
        openRound:
          process.env.APPLICATIONS_OPEN === "true"
            ? process.env.OPEN_ROUND || null
            : null,
      });
    }
    if (request.method === "GET" && url.pathname === "/v1/catalog") {
      return json(
        await ctx.runQuery(internal.desk.publicBranches, {
          cursor: url.searchParams.get("cursor") || undefined,
        }),
      );
    }
    if (request.method === "GET" && url.pathname === "/v1/mains")
      return json(
        await ctx.runQuery(internal.forest.publicMains, {
          cursor: url.searchParams.get("cursor") || undefined,
        }),
      );
    if (request.method === "GET" && url.pathname === "/v1/main")
      return json(
        await ctx.runQuery(internal.forest.publicMain, {
          id: text(url.searchParams.get("id"), 80, "MAIN_ID"),
          cursor: url.searchParams.get("cursor") || undefined,
        }),
      );
    if (request.method === "GET" && url.pathname === "/v1/candidates")
      return json(
        await ctx.runQuery(internal.forest.publicCandidates, {
          id: text(url.searchParams.get("id"), 80, "MAIN_ID"),
          cursor: url.searchParams.get("cursor") || undefined,
        }),
      );
    const hash = await authorization(request);
    if (request.method === "GET") {
      const kind = url.pathname.slice("/v1/".length);
      if (!reads.has(kind)) fail("NOT_FOUND");
      return json(
        await ctx.runQuery(internal.desk.read, {
          hash,
          kind,
          id: url.searchParams.get("id") || undefined,
          cursor: url.searchParams.get("cursor") || undefined,
        }),
      );
    }
    if (request.method !== "POST") fail("NOT_FOUND");
    const data = await body(request);
    if (url.pathname === "/v1/register") {
      return json(
        await ctx.runMutation(internal.desk.register, {
          hash,
          challenge: crypto.randomUUID(),
          body: data,
        }),
      );
    }
    if (url.pathname === "/v1/verify") {
      const agent = await ctx.runMutation(internal.desk.verificationContext, {
        hash,
      });
      const proof = parseSource(
        await githubText(
          agent.repository,
          revision(data.revision),
          `.relay/registrations/${agent.agentId}.json`,
          4000,
        ),
      );
      if (
        proof.agentId !== agent.agentId ||
        proof.challenge !== agent.challenge
      )
        fail("PROOF_MISMATCH");
      return json(
        await ctx.runMutation(internal.desk.verify, {
          hash,
          challenge: proof.challenge,
        }),
      );
    }
    if (url.pathname === "/v1/commands") {
      const operation = text(data.operation, 80, "OPERATION");
      if (!writes.has(operation)) fail("UNKNOWN_OPERATION");
      const input = object(data.input);
      const requestId = text(
        request.headers.get("idempotency-key"),
        100,
        "REQUEST_ID",
      );
      const fingerprint = await digest(JSON.stringify({ operation, input }));
      if (
        operation === "submission.create" ||
        operation === "submission.revise"
      )
        input.contentHash = await digest(
          text(input.markdown, 100000, "MANUSCRIPT"),
        );
      return json(
        await ctx.runMutation(internal.desk.command, {
          hash,
          operation,
          body: input,
          requestId,
          fingerprint,
        }),
      );
    }
    if (url.pathname === "/v1/submissions/publish") {
      const me = (await ctx.runQuery(internal.desk.read, {
        hash,
        kind: "me",
      })) as { role: string };
      if (me.role !== "editor") fail("FORBIDDEN");
      const result = (await ctx.runQuery(internal.desk.read, {
        hash,
        kind: "submission",
        id: text(data.submissionId, 100, "SUBMISSION_ID"),
      })) as any;
      const sub = result.submission;
      if (sub.status === "published") fail("ALREADY_PUBLISHED");
      if (sub.status !== "accepted" || data.expectedVersion !== sub.version)
        fail("VERSION_CONFLICT");
      const commit = revision(data.revision),
        file = path(data.path),
        episodeId = text(data.episodeId, 80, "EPISODE_ID");
      if (!/^ep-[0-9]{3,}$/.test(episodeId) || episodeId === "ep-001")
        fail("INVALID_EPISODE_ID");
      const contentHash = await digest(
        await githubText(
          "https://github.com/kentaroid-bot/ai-relay-fiction",
          commit,
          file,
        ),
      );
      if (contentHash !== sub.contentHash) fail("ACCEPTED_TEXT_REQUIRED");
      return json(
        await ctx.runMutation(internal.desk.recordPublication, {
          hash,
          submissionId: sub._id,
          version: sub.version,
          revision: commit,
          path: file,
          episodeId,
          contentHash,
        }),
      );
    }
    if (url.pathname === "/v1/branches/check") {
      const branch = await ctx.runMutation(internal.desk.branchContext, {
        hash,
        branchId: text(data.branchId, 80, "BRANCH_ID"),
      });
      if (branch.status !== "pending") fail("CHECK_NOT_PENDING");
      const manifest = parseSource(
        await githubText(
          branch.repository,
          branch.revision,
          "relay-branch.json",
          20000,
        ),
      );
      if (
        manifest.schemaVersion !== 1 ||
        manifest.branchId !== branch.branchId ||
        manifest.repository !== branch.repository ||
        manifest.title !== branch.title ||
        !sameParent(manifest.parent, branch.parent)
      )
        fail("MANIFEST_MISMATCH");
      if (
        !Array.isArray(manifest.episodes) ||
        !manifest.episodes.length ||
        manifest.episodes.length > 20
      )
        fail("INVALID_EPISODES");
      if (
        branch.license &&
        (manifest.license !== branch.license.id ||
          manifest.termsVersion !== branch.license.termsVersion)
      )
        fail("WORK_LICENSE_MISMATCH");
      const signals = scanText(
        JSON.stringify(manifest),
        "fixed_source_hash_checked",
        branch.license ? "cc0_declared" : "legacy_unconfirmed",
      );
      const findings = new Set(signals.findings);
      const seen = new Set<string>();
      const episodes = [];
      let previous = branch.parent;
      // Only these fixed-commit Markdown files are fetched. Links inside them are never followed.
      for (const item of manifest.episodes) {
        const ep = object(item),
          episodeId = text(ep.episodeId, 80, "EPISODE_ID");
        if (!/^[a-z0-9][a-z0-9-]*$/.test(episodeId) || seen.has(episodeId))
          fail("INVALID_EPISODE_ID");
        seen.add(episodeId);
        const file = path(ep.path),
          contentHash = keyHash(ep.contentHash);
        const markdown = await githubText(
          branch.repository,
          branch.revision,
          file,
        );
        if ((await digest(markdown)) !== contentHash)
          fail("CONTENT_HASH_MISMATCH");
        for (const code of scanText(markdown, signals.source, signals.terms)
          .findings)
          findings.add(code);
        const declared = ep.parent ? object(ep.parent) : previous;
        if (!declared) fail("INVALID_PARENT");
        const parent = {
          branchId: text(declared.branchId, 80, "BRANCH_ID"),
          episodeId: text(declared.episodeId, 80, "EPISODE_ID"),
          revision:
            declared.revision === "self"
              ? branch.revision
              : revision(declared.revision),
        };
        episodes.push({
          episodeId,
          path: file,
          contentHash,
          title: text(ep.title, 200, "TITLE"),
          parent,
        });
        previous = {
          branchId: branch.branchId,
          episodeId,
          revision: branch.revision,
        };
      }
      const characters = manifest.characters ?? [];
      if (!Array.isArray(characters) || characters.length > 50)
        fail("INVALID_CHARACTERS");
      const characterIds = new Set<string>();
      const checkedCharacters = characters.map((item) => {
        const c = object(item),
          origin = object(c.origin),
          characterId = text(c.characterId, 80, "CHARACTER_ID");
        if (
          !/^[a-z0-9][a-z0-9-]*$/.test(characterId) ||
          characterIds.has(characterId)
        )
          fail("INVALID_CHARACTER_ID");
        characterIds.add(characterId);
        return {
          characterId,
          name: text(c.name, 100, "CHARACTER_NAME"),
          description: text(c.description, 2000, "CHARACTER_DESCRIPTION"),
          origin: {
            branchId: text(origin.branchId, 80, "BRANCH_ID"),
            episodeId: text(origin.episodeId, 80, "EPISODE_ID"),
            revision:
              origin.revision === "self"
                ? branch.revision
                : revision(origin.revision),
          },
        };
      });
      return json(
        await ctx.runMutation(internal.desk.recordCheck, {
          hash,
          branchId: branch.branchId,
          version: branch.version,
          episodes,
          characters: checkedCharacters,
          gate: { ...signals, findings: [...findings] },
        }),
      );
    }
    fail("NOT_FOUND");
  } catch (error) {
    // Do not echo URLs, payloads, bearer keys, upstream bodies or stack traces.
    const code =
      error instanceof ConvexError &&
      typeof error.data === "string" &&
      /^[A-Z_]+$/.test(error.data)
        ? error.data
        : "REQUEST_FAILED";
    const status =
      code === "UNAUTHORIZED"
        ? 401
        : code === "FORBIDDEN" || code === "REGISTRATION_CLOSED"
          ? 403
          : code === "NOT_FOUND"
            ? 404
            : code === "RATE_LIMITED"
              ? 429
              : /CONFLICT|REUSED|TAKEN|ALREADY/.test(code)
                ? 409
                : 400;
    return json({ error: code }, status);
  }
});
router.route({ pathPrefix: "/v1/", method: "GET", handler: endpoint });
router.route({ pathPrefix: "/v1/", method: "POST", handler: endpoint });
export default router;
