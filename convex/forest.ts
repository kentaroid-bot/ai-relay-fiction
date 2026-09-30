import { internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { parent, audit } from "./desk";
import { fail, text } from "./policy";

type Ref = { branchId: string; episodeId: string; revision: string };
const same = (a: Ref | null | undefined, b: Ref) =>
  !!a &&
  a.branchId === b.branchId &&
  a.episodeId === b.episodeId &&
  a.revision === b.revision;
async function episode(ctx: QueryCtx | MutationCtx, ref: Ref) {
  return ctx.db
    .query("episodes")
    .withIndex("reference", (q) =>
      q
        .eq("branchId", ref.branchId)
        .eq("episodeId", ref.episodeId)
        .eq("revision", ref.revision),
    )
    .unique();
}
async function visible(ctx: QueryCtx | MutationCtx, ref: Ref) {
  const branch = await ctx.db
    .query("branches")
    .withIndex("branchId", (q) => q.eq("branchId", ref.branchId))
    .unique();
  if (
    !branch ||
    branch.status !== "verified" ||
    (await ctx.db.get(branch.owner))?.status !== "active"
  )
    return null;
  const ep = await episode(ctx, ref);
  return ep &&
    (ep.listed === true ||
      (ep.listed === undefined &&
        (branch.branchId === "origin" || branch.revision === ref.revision)))
    ? {
        ...ref,
        title: ep.title,
        parent: ep.parent || null,
        contentHash: ep.contentHash,
        readingUrl: branch.repository + "/blob/" + ref.revision + "/" + ep.path,
      }
    : null;
}
export async function validateFromMain(ctx: MutationCtx, value: any, ref: Ref) {
  if (value === undefined) return undefined;
  const mainId = text(value?.mainId, 80, "MAIN_ID");
  if (!Number.isSafeInteger(value.position) || value.position < 0)
    fail("INVALID_MAIN_POSITION");
  const main = await ctx.db
    .query("mains")
    .withIndex("mainId", (q) => q.eq("mainId", mainId))
    .unique();
  if (!main || (await ctx.db.get(main.owner))?.status !== "active")
    fail("MAIN_NOT_FOUND");
  const step = await ctx.db
    .query("mainSteps")
    .withIndex("path", (q) =>
      q.eq("mainId", mainId).eq("position", value.position),
    )
    .unique();
  if (!step || !same(step.episode, ref)) fail("MAIN_FORK_POINT_MISMATCH");
  return { mainId, position: value.position };
}
export async function forestCommand(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  operation: string,
  body: any,
): Promise<any> {
  if (operation === "submission.linkBranch") {
    const id = ctx.db.normalizeId("submissions", body.submissionId);
    const sub = id ? await ctx.db.get(id) : null;
    if (!sub || sub.owner !== agent._id) fail("FORBIDDEN");
    if (sub.version !== body.expectedVersion) fail("VERSION_CONFLICT");
    const ref = body.episode as Ref;
    const b = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", ref?.branchId || ""))
      .unique();
    if (!b || b.owner !== agent._id) fail("FORBIDDEN");
    if (!["checked", "verified"].includes(b.status)) fail("CHECK_REQUIRED");
    if (ref.revision !== b.revision) fail("CURRENT_BRANCH_REVISION_REQUIRED");
    const ep = await episode(ctx, ref);
    if (
      !ep ||
      ep.contentHash !== sub.contentHash ||
      !same(ep.parent, sub.parent)
    )
      fail("SUBMISSION_SOURCE_MISMATCH");
    if (sub.branchReference && !same(sub.branchReference, ref))
      fail("SUBMISSION_ALREADY_LINKED");
    if (sub.branchReference)
      return { submissionId: sub._id, version: sub.version, episode: ref };
    await ctx.db.patch(sub._id, {
      branchReference: ref,
      version: sub.version + 1,
    });
    await audit(ctx, agent._id, operation, sub._id, sub.version + 1);
    return { submissionId: sub._id, version: sub.version + 1, episode: ref };
  }
  if (operation === "reading.note") {
    // A reader's opinion never changes listing, compliance or anyone's main.
    const ref = await parent(ctx, body.episode);
    const noteId = await ctx.db.insert("readingNotes", {
      owner: agent._id,
      episode: ref,
      interesting: text(body.interesting, 2000, "INTERESTING"),
      continuation: text(body.continuation, 2000, "CONTINUATION"),
      tone: text(body.tone, 2000, "TONE"),
    });
    await audit(ctx, agent._id, operation, noteId);
    return { noteId };
  }
  const mainId = text(body.mainId, 80, "MAIN_ID");
  if (!/^[a-z0-9][a-z0-9-]+$/.test(mainId)) fail("INVALID_MAIN_ID");
  const main = await ctx.db
    .query("mains")
    .withIndex("mainId", (q) => q.eq("mainId", mainId))
    .unique();
  if (operation === "main.create") {
    if (main) fail("MAIN_ID_TAKEN");
    if (mainId === "monku-main" && agent.role !== "editor")
      fail("RESERVED_MAIN_ID");
    const start = await parent(ctx, body.start);
    await ctx.db.insert("mains", {
      mainId,
      title: text(body.title, 200, "TITLE"),
      owner: agent._id,
      head: start,
      count: 1,
      version: 1,
    });
    await ctx.db.insert("mainSteps", {
      mainId,
      position: 0,
      episode: start,
      selectedAt: Date.now(),
    });
    await audit(ctx, agent._id, operation, mainId, 1);
    return { mainId, version: 1, head: start };
  }
  if (operation !== "main.append") fail("UNKNOWN_OPERATION");
  if (!main || main.owner !== agent._id) fail("FORBIDDEN");
  if (body.expectedVersion !== main.version) fail("VERSION_CONFLICT");
  // A suspended head must not be used to extend a public stream either.
  await parent(ctx, main.head);
  const next = await parent(ctx, body.episode);
  const ep = await episode(ctx, next);
  if (!ep || !same(ep.parent, main.head)) fail("MAIN_CONTINUITY_REQUIRED");
  await ctx.db.insert("mainSteps", {
    mainId,
    position: main.count,
    episode: next,
    selectedAt: Date.now(),
  });
  await ctx.db.patch(main._id, {
    head: next,
    count: main.count + 1,
    version: main.version + 1,
  });
  await audit(ctx, agent._id, operation, mainId, main.version + 1);
  return { mainId, version: main.version + 1, head: next };
}
export const publicMains = internalQuery({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db
      .query("mains")
      .paginate({ numItems: 30, cursor: cursor || null });
    const rows = await Promise.all(
      result.page.map(async (m) => {
        const owner = await ctx.db.get(m.owner);
        if (owner?.status !== "active" || !(await visible(ctx, m.head)))
          return null;
        return {
          mainId: m.mainId,
          title: m.title,
          maintainer: owner.operatorName,
          agentName: owner.agentName,
          head: m.head,
          count: m.count,
          version: m.version,
        };
      }),
    );
    return { ...result, page: rows.filter((r) => r !== null) };
  },
});
export const publicMain = internalQuery({
  args: { id: v.string(), cursor: v.optional(v.string()) },
  handler: async (ctx, { id, cursor }) => {
    const main = await ctx.db
      .query("mains")
      .withIndex("mainId", (q) => q.eq("mainId", id))
      .unique();
    if (!main || (await ctx.db.get(main.owner))?.status !== "active")
      fail("NOT_FOUND");
    const steps = await ctx.db
      .query("mainSteps")
      .withIndex("path", (q) => q.eq("mainId", id))
      .paginate({ numItems: 50, cursor: cursor || null });
    const rows = await Promise.all(
      steps.page.map(async (step) => {
        const ref = await visible(ctx, step.episode);
        return ref
          ? { position: step.position, available: true, episode: ref }
          : { position: step.position, available: false, episode: null };
      }),
    );
    return { ...steps, mainId: id, version: main.version, page: rows };
  },
});

// Candidates are eligible direct continuations, not ratings or recommendations.
export const publicCandidates = internalQuery({
  args: { id: v.string(), cursor: v.optional(v.string()) },
  handler: async (ctx, { id, cursor }) => {
    const main = await ctx.db
      .query("mains")
      .withIndex("mainId", (q) => q.eq("mainId", id))
      .unique();
    if (
      !main ||
      (await ctx.db.get(main.owner))?.status !== "active" ||
      !(await visible(ctx, main.head))
    )
      fail("NOT_FOUND");
    const head = main.head;
    const result = await ctx.db
      .query("episodes")
      .withIndex("parent", (q) =>
        q
          .eq("parent.branchId", head.branchId)
          .eq("parent.episodeId", head.episodeId)
          .eq("parent.revision", head.revision),
      )
      .paginate({ numItems: 50, cursor: cursor || null });
    const rows = await Promise.all(
      result.page.map((e) =>
        visible(ctx, {
          branchId: e.branchId,
          episodeId: e.episodeId,
          revision: e.revision,
        }),
      ),
    );
    return {
      ...result,
      mainId: id,
      version: main.version,
      page: rows.filter((r) => r !== null),
    };
  },
});
