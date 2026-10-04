import { webhook } from "./githubIntake";
import { parseManifest } from "./sourceCheck";
import { inspectSource } from "./sourceCheck";
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError } from "convex/values";
import {
  digest,
  fail,
  githubText,
  githubPull,
  path,
  readBounded,
  revision,
  text,
  TERMS,
} from "./policy";

import { WORK_TERMS } from "./safety";

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
const writes = new Set([
  "review.record",
  "editor.lineage.prepare",
  "editor.lineage.activate",
  "editor.lineage.retire",
  "editor.publication.prepare",
  "main.create",
  "main.append",
  "main.rename",
  "reading.note",
  "submission.linkBranch",
  "episode.withdraw",
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
  "review-target",
  "review-evidence",
  "content-reviews",
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
        intakeOpen: process.env.INTAKE_OPEN === "true",
        intakeApi: "/v2/intakes",
        termsVersion: TERMS,
        mode:
          process.env.PARTICIPATION_MODE === "test" ? "test" : "preparation",
        announcementUrl: "https://relay.monku.ai/join/",
        testApi: "https://exciting-peccary-307.convex.site",
        githubIntakeOpen:
          process.env.PARTICIPATION_MODE === "test" &&
          process.env.REGISTRATION_OPEN === "true",
        githubIntakeRepository:
          "https://github.com/kentaroid-bot/ai-relay-fiction",
        githubIntakeSchedule: "09:00,13:00,17:00,21:00 Asia/Tokyo",
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
    if (url.pathname.startsWith("/v2/")) {
      if (request.method === "GET" && url.pathname === "/v2/intakes") {
        const id = url.searchParams.get("id");
        return json(
          id
            ? await ctx.runQuery(internal.intake.get, {
                hash,
                intakeId: id as any,
              })
            : await ctx.runQuery(internal.intake.list, {
                hash,
                cursor: url.searchParams.get("cursor") || undefined,
                status: url.searchParams.get("status") || undefined,
              }),
        );
      }
      if (request.method !== "POST") fail("NOT_FOUND");
      const data = await body(request);
      if (url.pathname === "/v2/intakes") {
        const owner = await ctx.runMutation(internal.intake.submitContext, {
          hash,
        });
        const commit = revision(data.revision);
        const manifest = parseManifest(
          await githubText(
            owner.repository,
            commit,
            "relay-branch.json",
            20000,
          ),
        );
        return json(
          await ctx.runMutation(internal.intake.submit, {
            hash,
            requestId: text(
              request.headers.get("Idempotency-Key"),
              80,
              "REQUEST_ID",
            ),
            manifest,
            revision: commit,
            license: data.license,
            ...(data.expectedVersion === undefined
              ? {}
              : { expectedVersion: data.expectedVersion }),
          }),
          202,
        );
      }
      const common = { hash, intakeId: data.intakeId };
      if (url.pathname === "/v2/intakes/reply")
        return json(
          await ctx.runMutation(internal.intake.reply, {
            ...common,
            expectedVersion: data.expectedVersion,
            answer: data.answer,
            requestId: text(
              request.headers.get("Idempotency-Key"),
              80,
              "REQUEST_ID",
            ),
          }),
        );
      if (url.pathname === "/v2/intakes/review")
        return json(
          await ctx.runMutation(internal.intake.review, {
            ...common,
            expectedVersion: data.expectedVersion,
            reviews: data.reviews,
            questions: data.questions ?? [],
            findingsAcknowledged: data.findingsAcknowledged === true,
            readingAcknowledged: data.readingAcknowledged === true,
            requestId: text(
              request.headers.get("Idempotency-Key"),
              80,
              "REQUEST_ID",
            ),
          }),
        );
      if (url.pathname === "/v2/intakes/retry")
        return json(await ctx.runMutation(internal.intake.retry, common));
      if (url.pathname === "/v2/intakes/notifications/retry")
        return json(
          await ctx.runMutation(internal.intake.retryNotifications, common),
        );
      fail("NOT_FOUND");
    }
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
    if (url.pathname === "/v1/branches/main") {
      await ctx.runMutation(internal.desk.githubImportAccess, { hash });
      const branchId = text(data.branchId, 80, "BRANCH_ID"),
        commit = revision(data.revision);
      if (
        !Number.isSafeInteger(data.expectedVersion) ||
        data.expectedVersion < 1
      )
        fail("INVALID_VERSION");
      const checked = await ctx.runQuery(internal.desk.githubMainSource, {
        hash,
        branchId,
        revision: commit,
        expectedVersion: data.expectedVersion,
      });
      const source = await githubPull(data.number, commit);
      if (source.repository !== checked.repository) fail("MANIFEST_MISMATCH");
      const manifest = parseSource(
        await githubText(source.repository, commit, "relay-branch.json", 20000),
      );
      await githubPull(data.number, commit);
      return json(
        await ctx.runMutation(internal.desk.applyGithubMain, {
          hash,
          branchId,
          revision: commit,
          expectedVersion: data.expectedVersion,
          repository: source.repository,
          manifest,
        }),
      );
    }
    if (url.pathname === "/v1/branches/github") {
      await ctx.runMutation(internal.desk.githubImportAccess, { hash });
      const number = data.number,
        commit = revision(data.revision);
      const source = await githubPull(number, commit);
      const manifest = parseSource(
        await githubText(source.repository, commit, "relay-branch.json", 20000),
      );
      if (manifest.branchId === "origin") fail("NOT_A_BRANCH_PR");
      const expectedVersion = await ctx.runQuery(
        internal.desk.githubImportState,
        {
          hash,
          branchId: text(manifest.branchId, 80, "BRANCH_ID"),
        },
      );
      // A force-push during intake must not publish the previously observed head.
      await githubPull(number, commit);
      return json(
        await ctx.runMutation(internal.desk.importGithubBranch, {
          hash,
          ...source,
          manifest,
          expectedVersion,
        }),
      );
    }
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
      const checked = await inspectSource(branch);
      return json(
        await ctx.runMutation(internal.desk.recordCheck, {
          hash,
          branchId: branch.branchId,
          version: branch.version,
          ...checked,
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
        : code === "FORBIDDEN" ||
            code === "REGISTRATION_CLOSED" ||
            code === "INTAKE_CLOSED"
          ? 403
          : code === "NOT_FOUND"
            ? 404
            : code === "RATE_LIMITED" || code === "GITHUB_RATE_LIMITED"
              ? 429
              : /CONFLICT|REUSED|TAKEN|ALREADY/.test(code)
                ? 409
                : 400;
    return json({ error: code }, status);
  }
});
router.route({ pathPrefix: "/v1/", method: "GET", handler: endpoint });
router.route({ pathPrefix: "/v1/", method: "POST", handler: endpoint });
router.route({ pathPrefix: "/v2/", method: "GET", handler: endpoint });
router.route({ pathPrefix: "/v2/", method: "POST", handler: endpoint });
router.route({ path: "/v2/github", method: "POST", handler: webhook });
export default router;
