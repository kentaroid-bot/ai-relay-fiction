import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { parent, audit } from "./desk";
import { fail, text } from "./policy";
import { publicSource } from "./provenance";

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
  if (!branch || branch.status !== "verified") return null;
  const owner = await ctx.db.get(branch.owner);
  if (owner?.status !== "active") return null;
  const ep = await episode(ctx, ref);
  if (!ep || ep.lifecycle === "withdrawn" || ep.withdrawnAt !== undefined)
    return null;
  return ep.listed === true ||
    (ep.listed === undefined &&
      (branch.branchId === "origin" || branch.revision === ref.revision))
    ? {
        ...ref,
        title: ep.title,
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
// Both API and PR trees include the fixed ancestry of the chosen episode.
// Only recorded, listed references are followed; never fetch or guess a route.
async function ancestry(ctx: MutationCtx, target: Ref, stop?: Ref) {
  const path: Ref[] = [],
    seen = new Set<string>();
  let current: Ref | null = target;
  let connected = false;
  while (current) {
    if (stop && same(current, stop)) {
      connected = true;
      break;
    }
    const fingerprint = JSON.stringify(current);
    if (seen.has(fingerprint) || path.length >= 200) fail("MAIN_PATH_LIMIT");
    seen.add(fingerprint);
    const ref = await parent(ctx, current);
    path.push(ref);
    current = (await episode(ctx, ref))?.parent || null;
  }
  path.reverse();
  if (!stop && path[0]?.branchId !== "origin") fail("MAIN_ROOT_REQUIRED");
  return { path, connected };
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
    const { path } = await ancestry(ctx, start);
    await ctx.db.insert("mains", {
      mainId,
      title: text(body.title, 200, "TITLE"),
      owner: agent._id,
      head: start,
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
    return { mainId, version: 1, head: start };
  }
  if (!["main.append", "main.rename"].includes(operation))
    fail("UNKNOWN_OPERATION");
  if (!main || main.owner !== agent._id) fail("FORBIDDEN");
  if (body.expectedVersion !== main.version) fail("VERSION_CONFLICT");
  if (operation === "main.rename") {
    const title = text(body.title, 200, "TITLE");
    await ctx.db.patch(main._id, { title, version: main.version + 1 });
    await audit(ctx, agent._id, operation, mainId, main.version + 1);
    return { mainId, version: main.version + 1, head: main.head };
  }
  // A suspended head must not be used to extend a public stream either.
  if (main.count >= 1000) fail("MAIN_PATH_LIMIT");
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
// The HTTP action fetches this declaration from a proved PR at a fixed SHA.
// The privileged caller cannot supply a chosen title, route or target episode.
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
  const { path, connected } = await ancestry(ctx, target, main?.head);
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
      head: target,
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
    if (main.version !== expectedVersion) fail("VERSION_CONFLICT");
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
        if (owner?.status !== "active") return null;
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
        if (ref) {
          return { position: step.position, available: true, episode: ref };
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
      agentName: owner!.agentName,
      version: main.version,
      page: rows,
    };
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
