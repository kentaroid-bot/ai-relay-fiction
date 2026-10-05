import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  getLineage,
  requireLineage,
  publicReview,
  isLineageRoot,
} from "./lineage";
import { parent, audit } from "./desk";
import { fail, text, repo } from "./policy";
import { publicSource } from "./provenance";
import { canReadListedBranch, isListedEpisode } from "./visibility";

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
  if (!branch || !(await canReadListedBranch(ctx, branch))) return null;
  const owner = await ctx.db.get(branch.owner);
  if (owner?.status !== "active") return null;
  const ep = await episode(ctx, ref);
  const lineage = await getLineage(ctx, branch.lineageId);
  return ep && (await isListedEpisode(ctx, branch, ep))
    ? {
        ...ref,
        title: ep.title,
        lineageId: ep.lineageId,
        ...(lineage?.rootContinuation && lineage.rootBranchId === ref.branchId
          ? { continuationReserved: true }
          : {}),
        contentReview: await publicReview(ctx, branch, ep),
        // Use the declaration bound to this reviewed edition, never a newer
        // branch submission or the auditor's comparison candidates.
        influences: (ep.provenance?.influences ?? []).map((influence) => ({
          title: influence.title,
          ...(influence.author ? { author: influence.author } : {}),
          ...(influence.publishedYear !== undefined
            ? { publishedYear: influence.publishedYear }
            : {}),
          relationship: influence.relationship,
        })),
        parent: ep.parent || null,
        contentHash: ep.contentHash,
        readingUrl: branch.repository + "/blob/" + ref.revision + "/" + ep.path,
        author: { maintainer: owner.operatorName, agentName: owner.agentName },
        ...(ep.sourceRef
          ? { sourceRef: await publicSource(ctx, ep.sourceRef) }
          : {}),
      }
    : null;
}
// Legacy repair alone walks to the root; new trees explicitly choose their start.
// Only recorded, listed references are followed; never fetch or guess a route.
async function ancestry(ctx: MutationCtx, target: Ref, stop?: Ref) {
  const path: Ref[] = [],
    seen = new Set<string>();
  let current: Ref | null = target;
  let connected = false;
  const targetEpisode = await episode(ctx, target);
  while (current) {
    if (stop && same(current, stop)) {
      connected = true;
      break;
    }
    const fingerprint = JSON.stringify(current);
    if (seen.has(fingerprint) || path.length >= 200) fail("MAIN_PATH_LIMIT");
    seen.add(fingerprint);
    const ref = await parent(ctx, current);
    const ep = await episode(ctx, ref);
    if (ep?.lineageId !== targetEpisode?.lineageId) fail("LINEAGE_MISMATCH");
    path.push(ref);
    current = ep?.parent || null;
  }
  path.reverse();
  if (!stop) {
    const root = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", path[0]?.branchId))
      .unique();
    if (!root || !(await isLineageRoot(ctx, root))) fail("MAIN_ROOT_REQUIRED");
  }
  return { path, connected };
}
// Follow only the selected interval. Earlier ancestors belong to another tree.
async function selectedPath(ctx: MutationCtx, start: Ref, head: Ref) {
  const first = await parent(ctx, start);
  const firstEpisode = await episode(ctx, first);
  if (!firstEpisode?.parent) {
    const branch = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", first.branchId))
      .unique();
    if (!branch || !(await isLineageRoot(ctx, branch)))
      fail("MAIN_ROOT_REQUIRED");
  }
  if (same(first, head)) return [first];
  const { path, connected } = await ancestry(ctx, head, first);
  if (!connected) fail("MAIN_CONTINUITY_REQUIRED");
  const a = await episode(ctx, first),
    b = await episode(ctx, head);
  if (a?.lineageId !== b?.lineageId) fail("LINEAGE_MISMATCH");
  return [first, ...path];
}
async function mainVisible(
  ctx: QueryCtx | MutationCtx,
  main: Doc<"mains"> | null,
) {
  return (
    !!main &&
    main.hiddenAt === undefined &&
    (await ctx.db.get(main.owner))?.status === "active" &&
    (await getLineage(ctx, main.lineageId))?.status === "active"
  );
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
  if (!(await mainVisible(ctx, main))) fail("MAIN_NOT_FOUND");
  if (!main) fail("MAIN_NOT_FOUND");
  await requireLineage(ctx, main.lineageId);
  const parentBranch = await ctx.db
    .query("branches")
    .withIndex("branchId", (q) => q.eq("branchId", ref.branchId))
    .unique();
  if (main.lineageId !== parentBranch?.lineageId) fail("LINEAGE_MISMATCH");
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
  if (operation === "episode.withdraw") {
    const ref = body.episode as Ref;
    if (!ref?.branchId || !ref?.episodeId || !ref?.revision)
      fail("INVALID_EPISODE_REF");
    const ep = await episode(ctx, ref);
    if (!ep) fail("NOT_FOUND");
    const branch = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", ref.branchId))
      .unique();
    if (!branch) fail("BRANCH_NOT_FOUND");
    if (branch.owner !== agent._id && agent.role !== "editor")
      fail("FORBIDDEN");
    if (ep.lifecycle === "withdrawn" || ep.withdrawnAt !== undefined) {
      return { episode: ref, status: "already_withdrawn" };
    }
    const now = Date.now();
    await ctx.db.patch(ep._id, {
      lifecycle: "withdrawn",
      withdrawnAt: now,
    });
    await audit(ctx, agent._id, operation, ep._id);
    return { episode: ref, status: "withdrawn", withdrawnAt: now };
  }
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
    const owned = await ctx.db
      .query("mains")
      .withIndex("owner", (q) => q.eq("owner", agent._id))
      .take(21);
    if (owned.length >= 20) fail("MAIN_COUNT_LIMIT");
    const start = await parent(ctx, body.start);
    const startBranch = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", start.branchId))
      .unique();
    const lineage = await requireLineage(ctx, startBranch?.lineageId);
    const head = body.head === undefined ? start : await parent(ctx, body.head);
    const path = await selectedPath(ctx, start, head);
    await ctx.db.insert("mains", {
      mainId,
      lineageId: lineage.lineageId,
      title: text(body.title, 200, "TITLE"),
      owner: agent._id,
      head,
      explicitStart: true,
      ...(body.closed === true ? { closed: true } : {}),
      count: path.length,
      version: 1,
    });
    for (const [position, ref] of path.entries())
      await ctx.db.insert("mainSteps", {
        mainId,
        position,
        episode: ref,
        selectedAt: Date.now(),
      });
    await audit(ctx, agent._id, operation, mainId, 1);
    return { mainId, version: 1, head };
  }
  if (
    !["main.append", "main.rename", "main.hide", "main.replace"].includes(
      operation,
    )
  )
    fail("UNKNOWN_OPERATION");
  if (!main || main.owner !== agent._id) fail("FORBIDDEN");
  await requireLineage(ctx, main.lineageId);
  if (body.expectedVersion !== main.version) fail("VERSION_CONFLICT");
  if (operation === "main.hide") {
    if (main.hiddenAt !== undefined)
      return { mainId, version: main.version, hidden: true };
    await ctx.db.patch(main._id, {
      hiddenAt: Date.now(),
      version: main.version + 1,
    });
    await audit(ctx, agent._id, operation, mainId, main.version + 1);
    return { mainId, version: main.version + 1, hidden: true };
  }
  if (main.hiddenAt !== undefined) fail("MAIN_HIDDEN");
  if (main.closed && ["main.append", "main.replace"].includes(operation))
    fail("MAIN_CLOSED");
  if (operation === "main.replace") {
    if (!Number.isSafeInteger(body.position) || body.position < 0)
      fail("INVALID_MAIN_POSITION");
    const step = await ctx.db
      .query("mainSteps")
      .withIndex("path", (q) =>
        q.eq("mainId", mainId).eq("position", body.position),
      )
      .unique();
    if (!step) fail("NOT_FOUND");
    const old = await episode(ctx, step.episode);
    if (
      !old ||
      (old.lifecycle !== "withdrawn" && old.withdrawnAt === undefined)
    )
      fail("WITHDRAWN_STEP_REQUIRED");
    const ref = await parent(ctx, body.episode);
    const replacement = await episode(ctx, ref);
    if (replacement?.lineageId !== main.lineageId) fail("LINEAGE_MISMATCH");
    if (
      !replacement ||
      (old.parent
        ? !same(replacement.parent, old.parent)
        : !!replacement.parent)
    )
      fail("MAIN_CONTINUITY_REQUIRED");
    const duplicate = await ctx.db
      .query("mainSteps")
      .withIndex("episode", (q) =>
        q
          .eq("episode.branchId", ref.branchId)
          .eq("episode.episodeId", ref.episodeId)
          .eq("episode.revision", ref.revision),
      )
      .filter((q) => q.eq(q.field("mainId"), mainId))
      .first();
    if (duplicate) fail("MAIN_DUPLICATE_EPISODE");
    await ctx.db.patch(step._id, {
      episode: ref,
      replaces: step.replaces ?? step.episode,
      selectedAt: Date.now(),
    });
    await ctx.db.patch(main._id, {
      version: main.version + 1,
      ...(step.position === main.count - 1 ? { head: ref } : {}),
    });
    await audit(ctx, agent._id, operation, mainId, main.version + 1);
    return {
      mainId,
      version: main.version + 1,
      position: step.position,
      episode: ref,
    };
  }
  if (operation === "main.rename") {
    const title = text(body.title, 200, "TITLE");
    await ctx.db.patch(main._id, { title, version: main.version + 1 });
    await audit(ctx, agent._id, operation, mainId, main.version + 1);
    return { mainId, version: main.version + 1, head: main.head };
  }
  // A suspended head must not be used to extend a public stream either.
  if (main.count >= 1000) fail("MAIN_PATH_LIMIT");
  const headEpisode = await episode(ctx, main.head);
  if (
    headEpisode?.lifecycle !== "withdrawn" &&
    headEpisode?.withdrawnAt === undefined
  )
    await parent(ctx, main.head);
  const last = await ctx.db
    .query("mainSteps")
    .withIndex("path", (q) =>
      q.eq("mainId", mainId).eq("position", main.count - 1),
    )
    .unique();
  const next = await parent(ctx, body.episode);
  const ep = await episode(ctx, next);
  if (ep?.lineageId !== main.lineageId) fail("LINEAGE_MISMATCH");
  if (
    !ep ||
    (!same(ep.parent, main.head) &&
      !(last?.replaces && same(ep.parent, last.replaces)))
  )
    fail("MAIN_CONTINUITY_REQUIRED");
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
// The HTTP action fetches this declaration from a proved PR at a fixed SHA.
// The privileged caller cannot supply a chosen title, route or target episode.
// An editor's legacy handoff keeps the author's selected route and may refresh
// an unchanged, reviewed prefix to the new edition. Other trees keep their refs.
export async function applyLegacyDeclaredMain(
  ctx: MutationCtx,
  branch: Doc<"branches">,
  manifest: any,
  expectedVersion: number,
) {
  if (manifest.main === undefined) return { outcome: "no_declaration" };
  const declaration = manifest.main;
  if (
    !declaration ||
    typeof declaration !== "object" ||
    Array.isArray(declaration)
  )
    fail("INVALID_MAIN_DECLARATION");
  const mainId = text(declaration.mainId, 80, "MAIN_ID");
  text(declaration.title, 200, "TITLE");
  if (!/^[a-z0-9][a-z0-9-]+$/.test(mainId)) fail("INVALID_MAIN_ID");
  if (mainId === "monku-main") fail("RESERVED_MAIN_ID");
  const main = await ctx.db
    .query("mains")
    .withIndex("mainId", (q) => q.eq("mainId", mainId))
    .unique();
  if (!main)
    return applyDeclaredMain(ctx, branch, {
      ...manifest,
      main: { ...declaration, expectedVersion },
    });
  if (main.owner !== branch.owner) fail("FORBIDDEN");
  if (main.hiddenAt !== undefined) fail("MAIN_HIDDEN");
  if (main.closed) fail("MAIN_CLOSED");
  await requireLineage(ctx, branch.lineageId);
  if (main.lineageId !== branch.lineageId) fail("LINEAGE_MISMATCH");
  if (main.title !== declaration.title) fail("MAIN_TITLE_MISMATCH");
  const episodeId =
    declaration.episodeId ??
    (manifest.episodes?.length === 1
      ? manifest.episodes[0].episodeId
      : undefined);
  const target = await parent(ctx, {
    branchId: branch.branchId,
    episodeId: text(episodeId, 80, "EPISODE_ID"),
    revision: branch.revision,
  });
  const declared = manifest.episodes?.find(
    (e: any) => e.episodeId === episodeId,
  );
  const targetEpisode = await episode(ctx, target);
  if (
    !declared ||
    !targetEpisode ||
    targetEpisode.contentHash !== declared.contentHash ||
    targetEpisode.path !== declared.path
  )
    fail("MANIFEST_MISMATCH");
  const selected = await ctx.db
    .query("mainSteps")
    .withIndex("path", (q) => q.eq("mainId", mainId))
    .take(1001);
  selected.sort((a, b) => a.position - b.position);
  if (selected.some((s) => same(s.episode, target)))
    return { mainId, version: main.version, outcome: "already_applied" };
  if (
    !Number.isSafeInteger(expectedVersion) ||
    main.version !== expectedVersion
  )
    fail("VERSION_CONFLICT");
  if (
    selected.length !== main.count ||
    selected.some((s, i) => s.position !== i) ||
    !selected.length ||
    !same(selected.at(-1)!.episode, main.head)
  )
    fail("MAIN_CONTINUITY_REQUIRED");
  const path = await selectedPath(
    ctx,
    declaration.start ?? selected[0].episode,
    target,
  );
  if (path.length < selected.length || path.length > 1000)
    fail("MAIN_PATH_LIMIT");
  // Check the whole prefix before writing. A changed manuscript or a replaced,
  // withdrawn, or unrelated step requires an explicit new author decision.
  for (const [i, step] of selected.entries()) {
    const ref = path[i];
    await parent(ctx, step.episode);
    if (step.replaces) fail("MAIN_CONTINUITY_REQUIRED");
    if (same(step.episode, ref)) continue;
    const old = await episode(ctx, step.episode),
      next = await episode(ctx, ref);
    if (
      step.replaces ||
      step.episode.branchId !== branch.branchId ||
      ref.branchId !== branch.branchId ||
      step.episode.episodeId !== ref.episodeId ||
      ref.revision !== branch.revision ||
      !old ||
      !next ||
      old.contentHash !== next.contentHash ||
      old.lineageId !== next.lineageId
    )
      fail("MAIN_CONTINUITY_REQUIRED");
    if (old.sourceRef || next.sourceRef) {
      if (!next.sourceRef || !same(old.sourceRef, next.sourceRef))
        fail("MAIN_CONTINUITY_REQUIRED");
    }
    const parentsMatch =
      (old.parent === null && next.parent === null) ||
      (old.parent && next.parent && same(old.parent, next.parent)) ||
      (i > 0 &&
        old.parent &&
        next.parent &&
        same(old.parent, selected[i - 1].episode) &&
        same(next.parent, path[i - 1]));
    if (!parentsMatch) fail("MAIN_CONTINUITY_REQUIRED");
  }
  for (const [i, step] of selected.entries()) {
    if (!same(step.episode, path[i]))
      await ctx.db.patch(step._id, {
        episode: path[i],
        selectedAt: Date.now(),
      });
  }
  for (let i = selected.length; i < path.length; i++)
    await ctx.db.insert("mainSteps", {
      mainId,
      position: i,
      episode: path[i],
      selectedAt: Date.now(),
    });
  const version = main.version + 1;
  await ctx.db.patch(main._id, { head: target, count: path.length, version });
  await audit(ctx, branch.owner, "main.legacy-handoff", mainId, version);
  return { mainId, version, outcome: "extended" };
}

export async function applyDeclaredMain(
  ctx: MutationCtx,
  branch: Doc<"branches">,
  manifest: any,
) {
  if (manifest.main === undefined) return { outcome: "no_declaration" };
  const declaration = manifest.main;
  if (
    !declaration ||
    typeof declaration !== "object" ||
    Array.isArray(declaration)
  )
    fail("INVALID_MAIN_DECLARATION");
  const mainId = text(declaration.mainId, 80, "MAIN_ID"),
    title = text(declaration.title, 200, "TITLE");
  if (!/^[a-z0-9][a-z0-9-]+$/.test(mainId)) fail("INVALID_MAIN_ID");
  if (mainId === "monku-main") fail("RESERVED_MAIN_ID");
  if (
    !Array.isArray(manifest.episodes) ||
    !manifest.episodes.length ||
    manifest.episodes.length > 20
  )
    fail("INVALID_EPISODES");
  const episodeId =
    declaration.episodeId === undefined && manifest.episodes.length === 1
      ? manifest.episodes[0].episodeId
      : text(declaration.episodeId, 80, "EPISODE_ID");
  const declared = manifest.episodes.find(
    (e: any) => e.episodeId === episodeId,
  );
  if (!declared) fail("MAIN_TARGET_NOT_DECLARED");
  const target = await parent(ctx, {
    branchId: branch.branchId,
    episodeId,
    revision: branch.revision,
  });
  const targetEpisode = await episode(ctx, target);
  if (
    !targetEpisode ||
    targetEpisode.contentHash !== declared.contentHash ||
    targetEpisode.path !== declared.path
  )
    fail("MANIFEST_MISMATCH");
  const main = await ctx.db
    .query("mains")
    .withIndex("mainId", (q) => q.eq("mainId", mainId))
    .unique();
  if (main && main.owner !== branch.owner) fail("FORBIDDEN");
  if (main?.hiddenAt !== undefined) fail("MAIN_HIDDEN");
  await requireLineage(ctx, branch.lineageId);
  if (main && main.lineageId !== branch.lineageId) fail("LINEAGE_MISMATCH");
  if (main && main.title !== title) fail("MAIN_TITLE_MISMATCH");
  // Check the recorded target before ancestry traversal: a retry of an old
  // selection remains idempotent even after the owner has extended the tree.
  if (main) {
    const selected = await ctx.db
      .query("mainSteps")
      .withIndex("path", (q) => q.eq("mainId", mainId))
      .take(1001);
    if (selected.some((s) => same(s.episode, target)))
      return { mainId, version: main.version, outcome: "already_applied" };
  }
  if (main?.closed) fail("MAIN_CLOSED");
  const { path, connected } = main
    ? await ancestry(ctx, target, main.head)
    : {
        path: await selectedPath(ctx, declaration.start ?? target, target),
        connected: true,
      };
  const expected = declaration.expectedVersion ?? 0;
  if (
    !Number.isSafeInteger(expected) ||
    expected < 0 ||
    expected !== (main?.version ?? 0)
  )
    fail("VERSION_CONFLICT");
  if (main && !connected) fail("MAIN_CONTINUITY_REQUIRED");
  if (!main) {
    const owned = await ctx.db
      .query("mains")
      .withIndex("owner", (q) => q.eq("owner", branch.owner))
      .take(21);
    if (owned.length >= 20) fail("MAIN_COUNT_LIMIT");
  }
  if ((main?.count ?? 0) + path.length > 1000) fail("MAIN_PATH_LIMIT");
  const version = (main?.version ?? 0) + 1;
  const count = (main?.count ?? 0) + path.length;
  if (main) await ctx.db.patch(main._id, { head: target, count, version });
  else
    await ctx.db.insert("mains", {
      mainId,
      title,
      owner: branch.owner,
      lineageId: branch.lineageId,
      head: target,
      explicitStart: true,
      count,
      version,
    });
  for (const [i, ref] of path.entries())
    await ctx.db.insert("mainSteps", {
      mainId,
      position: (main?.count ?? 0) + i,
      episode: ref,
      selectedAt: Date.now(),
    });
  await audit(ctx, branch.owner, "main.declaration", mainId, version);
  return {
    mainId,
    version,
    count,
    head: target,
    outcome: main ? "appended" : "created",
  };
}

// Operator-only repair of legacy API trees that omitted their first episode's
// ancestors. No public endpoint calls this. It cannot choose a new head, title,
// owner or alternative episode, and refuses broken paths or version conflicts.
export const repairMainAncestry = internalMutation({
  args: {
    mainId: v.string(),
    expectedVersion: v.number(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { mainId, expectedVersion, dryRun }) => {
    const main = await ctx.db
      .query("mains")
      .withIndex("mainId", (q) => q.eq("mainId", mainId))
      .unique();
    if (!main || (await ctx.db.get(main.owner))?.status !== "active")
      fail("MAIN_NOT_FOUND");
    await requireLineage(ctx, main.lineageId);
    if (main.version !== expectedVersion) fail("VERSION_CONFLICT");
    if (main.explicitStart || main.hiddenAt !== undefined)
      fail("EXPLICIT_MAIN_START");
    const steps = await ctx.db
      .query("mainSteps")
      .withIndex("path", (q) => q.eq("mainId", mainId))
      .take(1001);
    if (
      !steps.length ||
      steps.length !== main.count ||
      main.count > 1000 ||
      !same(steps[steps.length - 1].episode, main.head)
    )
      fail("MAIN_CONTINUITY_REQUIRED");
    for (const [i, step] of steps.entries()) {
      if (step.position !== i) fail("MAIN_CONTINUITY_REQUIRED");
      const ref = await parent(ctx, step.episode);
      if (i && !same((await episode(ctx, ref))?.parent, steps[i - 1].episode))
        fail("MAIN_CONTINUITY_REQUIRED");
    }
    const { path } = await ancestry(ctx, steps[0].episode);
    const prefix = path.slice(0, -1);
    if (!prefix.length)
      return {
        mainId,
        version: main.version,
        count: main.count,
        outcome: "already_rooted",
        added: [],
      };
    if (prefix.length + main.count > 1000) fail("MAIN_PATH_LIMIT");
    // Old fork positions would otherwise silently point at a different episode.
    const fork = await ctx.db
      .query("branches")
      .filter((q) => q.eq(q.field("fromMain.mainId"), mainId))
      .first();
    if (fork) fail("MAIN_FORK_REFERENCES_REQUIRE_REPAIR");
    if (dryRun)
      return {
        mainId,
        version: main.version,
        count: main.count + prefix.length,
        outcome: "would_prepend",
        added: prefix,
      };
    for (const step of steps)
      await ctx.db.patch(step._id, { position: step.position + prefix.length });
    for (const [position, ref] of prefix.entries())
      await ctx.db.insert("mainSteps", {
        mainId,
        position,
        episode: ref,
        selectedAt: Date.now(),
      });
    await ctx.db.patch(main._id, {
      count: main.count + prefix.length,
      version: main.version + 1,
    });
    await audit(
      ctx,
      "system:main-ancestry-repair",
      "main.ancestryRepair",
      mainId,
      main.version + 1,
    );
    return {
      mainId,
      version: main.version + 1,
      count: main.count + prefix.length,
      outcome: "prepended",
      added: prefix,
    };
  },
});
export const publicMains = internalQuery({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db
      .query("mains")
      .paginate({ numItems: 30, cursor: cursor || null });
    const rows = await Promise.all(
      result.page.map(async (m) => {
        const owner = await ctx.db.get(m.owner);
        if (
          m.hiddenAt !== undefined ||
          owner?.status !== "active" ||
          (await getLineage(ctx, m.lineageId))?.status !== "active"
        )
          return null;
        let isTreeVisible = await visible(ctx, m.head);
        if (!isTreeVisible) {
          const steps = await ctx.db
            .query("mainSteps")
            .withIndex("path", (q) => q.eq("mainId", m.mainId))
            .take(1001);
          for (const s of steps) {
            if (await visible(ctx, s.episode)) {
              isTreeVisible = true as any;
              break;
            }
          }
        }
        if (!isTreeVisible) return null;
        return {
          mainId: m.mainId,
          title: m.title,
          maintainer: owner.operatorName,
          githubOwner: repo(owner.repository).split("/")[3],
          agentName: owner.agentName,
          head: m.head,
          count: m.count,
          version: m.version,
          ...(m.closed ? { closed: true } : {}),
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
    if (main.hiddenAt !== undefined)
      return {
        mainId: id,
        hidden: true,
        count: 0,
        version: main.version,
        page: [],
        isDone: true,
        continueCursor: "",
      };
    if ((await getLineage(ctx, main.lineageId))?.status !== "active")
      fail("NOT_FOUND");
    const steps = await ctx.db
      .query("mainSteps")
      .withIndex("path", (q) => q.eq("mainId", id))
      .paginate({ numItems: 50, cursor: cursor || null });
    const rows = await Promise.all(
      steps.page.map(async (step) => {
        const ref = await visible(ctx, step.episode);
        if (ref) {
          return {
            position: step.position,
            available: true,
            episode: ref,
            ...(step.replaces ? { replaces: step.replaces } : {}),
          };
        }
        const ep = await episode(ctx, step.episode);
        const isWithdrawn =
          ep?.lifecycle === "withdrawn" || ep?.withdrawnAt !== undefined;
        return {
          position: step.position,
          available: false,
          episode: null,
          reason: isWithdrawn
            ? ("withdrawn" as const)
            : ("unavailable" as const),
        };
      }),
    );
    const owner = await ctx.db.get(main.owner);
    return {
      ...steps,
      mainId: id,
      title: main.title,
      count: main.count,
      maintainer: owner!.operatorName,
      githubOwner: repo(owner!.repository).split("/")[3],
      agentName: owner!.agentName,
      version: main.version,
      page: rows,
    };
  },
});

// Locate a reading context without making a hidden tree or withdrawn prose public.
export async function routeFor(
  ctx: QueryCtx,
  ref: Ref,
  exclude?: string,
  adjacent?: Ref,
) {
  const entries = await ctx.db
    .query("mainSteps")
    .withIndex("episode", (q) =>
      q
        .eq("episode.branchId", ref.branchId)
        .eq("episode.episodeId", ref.episodeId)
        .eq("episode.revision", ref.revision),
    )
    .take(101);
  const branch = await ctx.db
    .query("branches")
    .withIndex("branchId", (q) => q.eq("branchId", ref.branchId))
    .unique();
  let fallback = null,
    bestPriority = -1;
  for (const step of entries.slice(0, 100)) {
    if (step.mainId === exclude) continue;
    const tree = await ctx.db
      .query("mains")
      .withIndex("mainId", (q) => q.eq("mainId", step.mainId))
      .unique();
    if (!tree || !(await mainVisible(ctx, tree))) continue;
    const route = {
      mainId: tree.mainId,
      title: tree.title,
      version: tree.version,
      position: step.position,
      authorTree: tree.owner === branch?.owner,
    };
    let priority = route.authorTree ? 2 : 0;
    if (adjacent) {
      const next = await ctx.db
        .query("mainSteps")
        .withIndex("path", (q) =>
          q.eq("mainId", tree.mainId).eq("position", step.position + 1),
        )
        .unique();
      if (
        next &&
        (same(next.episode, adjacent) ||
          (next.replaces && same(next.replaces, adjacent)))
      )
        priority += 4;
    }
    if (priority > bestPriority) {
      fallback = route;
      bestPriority = priority;
    }
  }
  return fallback;
}

// With a position, this is navigation for that episode, even when it is a stump.
// Without a position, preserve the legacy head-candidate API contract.
export const publicCandidates = internalQuery({
  args: {
    id: v.string(),
    cursor: v.optional(v.string()),
    position: v.optional(v.number()),
    version: v.optional(v.number()),
  },
  handler: async (ctx, { id, cursor, position, version }) => {
    const main = await ctx.db
      .query("mains")
      .withIndex("mainId", (q) => q.eq("mainId", id))
      .unique();
    if (!main || !(await mainVisible(ctx, main))) fail("NOT_FOUND");
    if (version !== undefined && version !== main.version)
      fail("VERSION_CONFLICT");
    const at = position ?? main.count - 1;
    if (!Number.isSafeInteger(at) || at < 0 || at >= main.count)
      fail("INVALID_MAIN_POSITION");
    const step = await ctx.db
      .query("mainSteps")
      .withIndex("path", (q) => q.eq("mainId", id).eq("position", at))
      .unique();
    if (!step) fail("NOT_FOUND");
    const ep = await episode(ctx, step.episode);
    const available = await visible(ctx, step.episode);
    const withdrawn =
      ep?.lifecycle === "withdrawn" || ep?.withdrawnAt !== undefined;
    if (!available && !(position !== undefined && withdrawn)) fail("NOT_FOUND");
    let previous = null;
    if (position === 0 && ep?.parent) {
      if (await visible(ctx, ep.parent))
        previous = await routeFor(ctx, ep.parent, id, step.episode);
    }
    const inherited =
      position !== undefined &&
      !!step.replaces &&
      cursor?.startsWith("replacement:");
    const anchor = inherited ? step.replaces! : step.episode;
    const anchorEpisode = inherited ? await episode(ctx, anchor) : ep;
    // A repository commit may change while this story's text stays identical.
    // Share its continuations across listed editions, without changing any
    // fixed parent reference or the selected reading path.
    const parentEditions = new Map<string, Promise<boolean>>();
    const acceptsParent = (ref: Ref): Promise<boolean> => {
      if (same(ref, anchor)) return Promise.resolve(true);
      if (position === undefined) return Promise.resolve(false);
      let accepted = parentEditions.get(ref.revision);
      if (!accepted) {
        accepted = (async () => {
          const other = await episode(ctx, ref);
          return !!(
            anchorEpisode &&
            other &&
            other.contentHash === anchorEpisode.contentHash &&
            other.lineageId === anchorEpisode.lineageId &&
            other.worldHash === anchorEpisode.worldHash &&
            other.parent?.branchId === anchorEpisode.parent?.branchId &&
            other.parent?.episodeId === anchorEpisode.parent?.episodeId &&
            (await visible(ctx, ref))
          );
        })();
        parentEditions.set(ref.revision, accepted);
      }
      return accepted;
    };
    const pageCursor = inherited
      ? cursor!.slice("replacement:".length) || null
      : cursor || null;
    const result = await ctx.db
      .query("episodes")
      .withIndex("parent", (q) => {
        const byEpisode = q
          .eq("parent.branchId", anchor.branchId)
          .eq("parent.episodeId", anchor.episodeId);
        return position === undefined
          ? byEpisode.eq("parent.revision", anchor.revision)
          : byEpisode;
      })
      .paginate({ numItems: 50, cursor: pageCursor });
    const rows = await Promise.all(
      result.page.map(async (e) => {
        if (!e.parent || !(await acceptsParent(e.parent))) return null;
        const ref = {
          branchId: e.branchId,
          episodeId: e.episodeId,
          revision: e.revision,
        };
        const published = await visible(ctx, ref);
        if (!published) return null;
        if (position === undefined) return published;
        const branch = await ctx.db
          .query("branches")
          .withIndex("branchId", (q) => q.eq("branchId", ref.branchId))
          .unique();
        return {
          ...published,
          currentEdition: branch?.revision === ref.revision,
          route: await routeFor(ctx, ref),
        };
      }),
    );
    const pageState =
      position !== undefined && step.replaces
        ? inherited
          ? {
              isDone: result.isDone,
              continueCursor: result.isDone
                ? result.continueCursor
                : "replacement:" + result.continueCursor,
            }
          : result.isDone
            ? { isDone: false, continueCursor: "replacement:" }
            : {}
        : {};
    return {
      ...result,
      ...pageState,
      mainId: id,
      version: main.version,
      page: rows.filter((r) => r !== null),
      ...(position === undefined
        ? {}
        : { previous, hasPrevious: !!ep?.parent, position: at }),
    };
  },
});
