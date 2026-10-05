import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { fail, keyHash, path, revision, text, repo } from "./policy";
import {
  fingerprint,
  lineageId,
  REVIEW_POLICY,
  validateProvenance,
  validateReview,
  validateTarget,
  type ReviewTarget,
} from "./contentSafety";
import {
  episodeTarget,
  getLineage,
  hasRejectedReview,
  requireContentReview,
  requireLineage,
} from "./lineage";
import { workLicense } from "./safety";

async function targetEpisode(
  ctx: QueryCtx | MutationCtx,
  target: ReviewTarget,
) {
  validateTarget(target);
  const branch = await ctx.db
    .query("branches")
    .withIndex("branchId", (q) => q.eq("branchId", target.branchId))
    .unique();
  const episode = await ctx.db
    .query("episodes")
    .withIndex("reference", (q) =>
      q
        .eq("branchId", target.branchId)
        .eq("episodeId", target.episodeId)
        .eq("revision", target.revision),
    )
    .unique();
  const actual = branch && episode && episodeTarget(branch, episode);
  if (!actual || (await fingerprint(actual)) !== (await fingerprint(target)))
    fail("REVIEW_TARGET_MISMATCH");
  const lineage = await requireLineage(ctx, target.lineageId, true);
  if (lineage.worldHash !== target.worldHash) fail("WORLD_HASH_MISMATCH");
  if (
    !episode!.provenance ||
    (await fingerprint(validateProvenance(episode!.provenance))) !==
      target.provenanceHash
  )
    fail("PROVENANCE_MISMATCH");
  return { branch: branch!, episode: episode! };
}

// Authenticated commands share the desk's rate limits and idempotent receipts.
// Reviewers can append observations, but cannot list a work or activate a world.
export async function contentCommand(
  ctx: MutationCtx,
  actor: Doc<"agents">,
  operation: string,
  body: any,
) {
  if (operation === "review.record") {
    if (actor.role !== "auditor") fail("FORBIDDEN");
    const { branch, episode } = await targetEpisode(ctx, body.target);
    const author = episode.author ? await ctx.db.get(episode.author) : null;
    if (
      actor._id === branch.owner ||
      actor._id === episode.author ||
      actor.repository === branch.repository ||
      actor.repository === author?.repository
    )
      fail("REVIEWER_NOT_INDEPENDENT");
    validateReview(body.review);
    const targetHash = await fingerprint(body.target);
    if (
      body.review.decision === "eligible" &&
      (await hasRejectedReview(ctx, targetHash))
    )
      fail("TARGET_REJECTED");
    if (
      body.review.decision === "eligible" &&
      episode.provenance!.statedSources.some(
        (s) =>
          !body.review.candidates.some(
            (c: any) =>
              c.url === s.url &&
              (c.relationship === undefined ||
                c.relationship === "source_use") &&
              c.rights === "verified" &&
              c.licenseType === s.licenseType &&
              c.evidenceUrl === s.licenseEvidenceUrl &&
              c.sourceVersion === s.sourceVersion,
          ),
      )
    )
      fail("DECLARED_SOURCE_NOT_CHECKED");
    const reviewId = await ctx.db.insert("contentReviews", {
      target: body.target,
      targetHash,
      review: body.review,
      reviewer: actor._id,
      checkedAt: Date.now(),
    });
    return { reviewId, decision: body.review.decision };
  }
  if (actor.role !== "editor") fail("FORBIDDEN");
  if (operation === "editor.lineage.prepare") {
    const id = lineageId(body.lineageId);
    const branchId = text(body.branchId, 80, "BRANCH_ID");
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(branchId)) fail("INVALID_BRANCH_ID");
    if (await getLineage(ctx, id)) fail("LINEAGE_ID_TAKEN");
    if (
      await ctx.db
        .query("branches")
        .withIndex("branchId", (q) => q.eq("branchId", branchId))
        .unique()
    )
      fail("BRANCH_ID_TAKEN");
    const commit = revision(body.revision),
      file = path(body.path);
    const worldHash = keyHash(body.worldHash),
      contentHash = keyHash(body.contentHash);
    const provenance = validateProvenance(body.provenance),
      license = workLicense(body.license);
    const provenanceHash = await fingerprint(provenance);
    const episodeId = text(body.episodeId, 80, "EPISODE_ID");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(episodeId)) fail("INVALID_EPISODE_ID");
    const ownerId =
      body.ownerId === undefined
        ? actor._id
        : ctx.db.normalizeId("agents", body.ownerId);
    const owner = ownerId ? await ctx.db.get(ownerId) : null;
    if (!owner || owner.status !== "active" || owner.role === "auditor")
      fail("VERIFIED_OWNER_REQUIRED");
    let rootContinuation;
    if (body.rootContinuation !== undefined) {
      const allowed = body.rootContinuation;
      const childId = text(allowed.branchId, 80, "BRANCH_ID");
      if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(childId) || childId === branchId)
        fail("INVALID_BRANCH_ID");
      rootContinuation = {
        branchId: childId,
        repository: repo(allowed.repository),
      };
    }
    const declaration = {
      lineageId: id,
      worldHash,
      provenance,
      provenanceHash,
      license,
    };
    // Preparing a new root never changes or reuses a previous lineage's rows.
    await ctx.db.insert("contentLineages", {
      lineageId: id,
      worldHash,
      policyVersion: REVIEW_POLICY,
      status: "draft",
      rootBranchId: branchId,
      ...(rootContinuation ? { rootContinuation } : {}),
      worldRepository: owner.repository,
      worldRevision: commit,
      createdBy: actor._id,
    });
    await ctx.db.insert("branches", {
      ...declaration,
      branchId,
      owner: owner._id,
      repository: owner.repository,
      title: text(body.title, 200, "TITLE"),
      readingUrl: owner.repository + "/blob/" + commit + "/" + file,
      parent: null,
      revision: commit,
      status: "pending",
      checkedAt: null,
      version: 1,
    });
    await ctx.db.insert("episodes", {
      ...declaration,
      branchId,
      episodeId,
      author: owner._id,
      parent: null,
      listed: false,
      revision: commit,
      path: file,
      contentHash,
      title: text(body.episodeTitle, 200, "TITLE"),
    });
    return { lineageId: id, branchId, episodeId, status: "review_required" };
  }
  if (
    operation === "editor.lineage.activate" ||
    operation === "editor.lineage.retire"
  ) {
    const lineage = await getLineage(
      ctx,
      text(body.lineageId, 80, "LINEAGE_ID"),
    );
    if (!lineage) fail("NOT_FOUND");
    if (lineage.status === "retired") fail("LINEAGE_RETIRED");
    if (operation.endsWith("activate")) {
      const root = await ctx.db
        .query("branches")
        .withIndex("branchId", (q) => q.eq("branchId", lineage.rootBranchId))
        .unique();
      if (
        !root ||
        root.lineageId !== lineage.lineageId ||
        root.worldHash !== lineage.worldHash ||
        root.status !== "verified"
      )
        fail("ROOT_REVIEW_REQUIRED");
      const episodes = await ctx.db
        .query("episodes")
        .withIndex("branchRevision", (q) =>
          q.eq("branchId", root.branchId).eq("revision", root.revision),
        )
        .take(21);
      if (
        !episodes.length ||
        episodes.length > 20 ||
        episodes.some((e) => e.listed !== true)
      )
        fail("ROOT_REVIEW_REQUIRED");
      for (const ep of episodes) await requireContentReview(ctx, root, ep);
      const active = await ctx.db
        .query("contentLineages")
        .filter((q) => q.eq(q.field("status"), "active"))
        .first();
      if (active && active._id !== lineage._id) {
        if (body.replaceActiveLineageId !== active.lineageId)
          fail("ACTIVE_LINEAGE_EXISTS");
        // Retire only the explicitly identified predecessor, after all checks.
        // Both state changes commit together; failed activation leaves it active.
        await ctx.db.patch(active._id, { status: "retired" });
      } else if (
        body.replaceActiveLineageId !== undefined &&
        active?._id !== lineage._id
      ) {
        fail("ACTIVE_LINEAGE_CHANGED");
      }
    }
    const status = operation.endsWith("activate")
      ? ("active" as const)
      : ("retired" as const);
    await ctx.db.patch(lineage._id, { status });
    return { lineageId: lineage.lineageId, status };
  }
  if (operation === "editor.publication.prepare") {
    const id = ctx.db.normalizeId("submissions", body.submissionId);
    const sub = id && (await ctx.db.get(id));
    if (
      !sub ||
      sub.version !== body.expectedVersion ||
      sub.status !== "accepted"
    )
      fail("ACCEPTED_TEXT_REQUIRED");
    const root = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", "origin"))
      .unique();
    if (!root || root.lineageId !== sub.lineageId) fail("LINEAGE_MISMATCH");
    const lineage = await requireLineage(ctx, sub.lineageId);
    const provenance = validateProvenance(sub.provenance);
    const license = workLicense(sub.license);
    const episodeId = text(body.episodeId, 80, "EPISODE_ID"),
      commit = revision(body.revision);
    const file = path(body.path),
      contentHash = keyHash(sub.contentHash);
    const old = await ctx.db
      .query("episodes")
      .withIndex("reference", (q) =>
        q
          .eq("branchId", "origin")
          .eq("episodeId", episodeId)
          .eq("revision", commit),
      )
      .unique();
    if (old) fail("EPISODE_EXISTS");
    await ctx.db.insert("episodes", {
      author: sub.owner,
      branchId: "origin",
      episodeId,
      revision: commit,
      path: file,
      contentHash,
      title: sub.title,
      parent: sub.parent,
      listed: false,
      lineageId: lineage.lineageId,
      worldHash: lineage.worldHash,
      provenance,
      license,
      provenanceHash: await fingerprint(provenance),
    });
    return {
      branchId: "origin",
      episodeId,
      revision: commit,
      status: "review_required",
    };
  }
  fail("UNKNOWN_OPERATION");
}

// First read hides the author's account of influences. The second read provides
// that declaration for a separate evidence check. Neither endpoint fetches URLs.
export async function reviewRead(
  ctx: QueryCtx,
  actor: Doc<"agents">,
  kind: string,
  id: string | undefined,
) {
  if (!["auditor", "editor"].includes(actor.role)) fail("FORBIDDEN");
  const [branchId, candidateRevision, extra] = (id || "").split("@");
  if (extra !== undefined) fail("INVALID_REVIEW_REFERENCE");
  const branch = await ctx.db
    .query("branches")
    .withIndex("branchId", (q) => q.eq("branchId", branchId))
    .unique();
  if (!branch) fail("NOT_FOUND");
  const lineage = await requireLineage(ctx, branch.lineageId, true);
  const commit =
    candidateRevision === undefined
      ? branch.revision
      : revision(candidateRevision);
  const episodes = await ctx.db
    .query("episodes")
    .withIndex("branchRevision", (q) =>
      q.eq("branchId", branch.branchId).eq("revision", commit),
    )
    .take(21);
  if (episodes.length > 20) fail("REVIEW_TOO_LARGE");
  return Promise.all(
    episodes.map(async (e) => {
      const target = episodeTarget(branch, e);
      if (!target) fail("REVIEW_TARGET_MISMATCH");
      const targetHash = await fingerprint(target);
      return {
        target,
        readingUrl: branch.repository + "/blob/" + e.revision + "/" + e.path,
        worldUrl:
          lineage.worldRepository +
          "/blob/" +
          lineage.worldRevision +
          "/world.md",
        ...(kind === "review-evidence"
          ? {
              provenance: e.provenance,
              ...(e.influenceCorrection
                ? { influenceCorrection: e.influenceCorrection }
                : {}),
            }
          : {}),
        ...(kind === "content-reviews"
          ? {
              reviews: await ctx.db
                .query("contentReviews")
                .withIndex("target", (q) => q.eq("targetHash", targetHash))
                .order("desc")
                .take(30),
            }
          : {}),
      };
    }),
  );
}
