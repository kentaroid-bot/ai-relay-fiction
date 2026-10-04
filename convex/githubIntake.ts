import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError } from "convex/values";
import {
  githubPull,
  githubText,
  GITHUB_BASE,
  readBounded,
  fail,
  keyHash,
  revision,
  text,
} from "./policy";
import { parseManifest } from "./sourceCheck";

// GitHub proves event origin; the fixed PR and fork are independently checked again.
export const webhook = httpAction(async (ctx, request) => {
  try {
    if (process.env.INTAKE_OPEN !== "true") fail("INTAKE_CLOSED");
    const secret = process.env.INTAKE_GITHUB_WEBHOOK_SECRET;
    const hash = process.env.INTAKE_IMPORT_KEY_HASH;
    if (!secret || !hash)
      return Response.json({ error: "INTAKE_UNCONFIGURED" }, { status: 503 });
    const signature = request.headers.get("x-hub-signature-256") ?? "";
    if (!/^sha256=[a-f0-9]{64}$/.test(signature)) fail("UNAUTHORIZED");
    const raw = await readBounded(new Response(request.body), 150000);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const bytes = Uint8Array.from(signature.slice(7).match(/../g)!, (x) =>
      parseInt(x, 16),
    );
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        bytes,
        new TextEncoder().encode(raw),
      ))
    )
      fail("UNAUTHORIZED");
    const payload = JSON.parse(raw);
    if (payload.repository?.full_name?.toLowerCase() !== GITHUB_BASE)
      fail("FORBIDDEN");
    keyHash(hash);
    const type = request.headers.get("x-github-event");
    if (type === "ping") return Response.json({ accepted: true });
    let number, commit;
    if (
      type === "pull_request" &&
      ["opened", "reopened", "synchronize", "ready_for_review"].includes(
        payload.action,
      )
    ) {
      number = payload.number;
      commit = revision(payload.pull_request?.head?.sha);
      if (payload.pull_request?.draft) return Response.json({ ignored: true });
    } else if (
      type === "issue_comment" &&
      payload.action === "created" &&
      payload.issue?.pull_request
    ) {
      // A marker is required so ordinary discussion never changes case state.
      const answer = payload.comment?.body;
      const match =
        typeof answer === "string" &&
        /^\/relay-answer ([a-zA-Z0-9]+) ([0-9]+)\r?\n([\s\S]+)$/.exec(answer);
      if (!match) return Response.json({ ignored: true });
      return Response.json(
        await ctx.runMutation(internal.intake.githubReply, {
          hash,
          number: payload.issue.number,
          login: text(
            payload.comment?.user?.login,
            80,
            "GITHUB_LOGIN",
          ).toLowerCase(),
          commentId: text(String(payload.comment?.id), 30, "COMMENT_ID"),
          answer: text(match[3], 8000, "ANSWER"),
          intakeId: match[1] as any,
          expectedVersion: Number(match[2]),
        }),
      );
    } else return Response.json({ ignored: true });
    await ctx.runMutation(internal.desk.githubImportAccess, { hash });
    const source = await githubPull(number, commit);
    const manifest = parseManifest(
      await githubText(source.repository, commit, "relay-branch.json", 20000),
    );
    const expectedVersion = await ctx.runQuery(
      internal.desk.githubImportState,
      { hash, branchId: text(manifest.branchId, 80, "BRANCH_ID") },
    );
    await githubPull(number, commit);
    const imported = await ctx.runMutation(internal.desk.importGithubBranch, {
      hash,
      ...source,
      manifest,
      expectedVersion,
    });
    const result = await ctx.runMutation(internal.intake.adoptGithub, {
      hash,
      branchId: imported.branchId,
      revision: commit,
      manifest,
      number,
      login: source.login,
    });
    return Response.json(result, { status: 202 });
  } catch (e) {
    const code =
      e instanceof ConvexError &&
      typeof e.data === "string" &&
      /^[A-Z_]+$/.test(e.data)
        ? e.data
        : "REQUEST_FAILED";
    return Response.json(
      { error: code },
      {
        status:
          code === "UNAUTHORIZED" ? 401 : code === "FORBIDDEN" ? 403 : 400,
      },
    );
  }
});
