import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { fail } from "./policy";
import {
  fingerprint,
  REVIEW_POLICY,
  type ReviewTarget,
  lineageId,
  validateProvenance,
} from "./contentSafety";
type Ctx = QueryCtx | MutationCtx;
export async function getLineage(ctx: Ctx, id: string | undefined) {
  return id
    ? ctx.db
        .query("contentLineages")
        .withIndex("lineageId", (q) => q.eq("lineageId", id))
        .unique()
    : null;
}
export async function requireLineage(
  ctx: Ctx,
  id: string | undefined,
  draft = false,
) {
  const row = await getLineage(ctx, id);
  if (!row || (row.status !== "active" && !(draft && row.status === "draft")))
    fail("LINEAGE_NOT_ACTIVE");
  if (row.policyVersion !== REVIEW_POLICY) fail("REVIEW_POLICY_MISMATCH");
  return row;
}
export async function isLineageRoot(ctx: Ctx, b: Doc<"branches">) {
  const row = await getLineage(ctx, b.lineageId);
  return (
    !!row && row.rootBranchId === b.branchId && row.worldHash === b.worldHash
  );
}
export async function branchInActiveLineage(ctx: Ctx, b: Doc<"branches">) {
  const row = await getLineage(ctx, b.lineageId);
  return (
    !!row &&
    row.status === "active" &&
    row.worldHash === b.worldHash &&
    row.policyVersion === REVIEW_POLICY
  );
}
export function episodeTarget(
  b: Doc<"branches">,
  e: Doc<"episodes">,
): ReviewTarget | null {
  if (
    !b.lineageId ||
    e.lineageId !== b.lineageId ||
    !e.worldHash ||
    e.worldHash !== b.worldHash ||
    !e.provenanceHash
  )
    return null;
  return {
    lineageId: b.lineageId,
    branchId: e.branchId,
    episodeId: e.episodeId,
    revision: e.revision,
    contentHash: e.contentHash,
    parent: e.parent ?? null,
    worldHash: e.worldHash,
    provenanceHash: e.provenanceHash,
    policyVersion: REVIEW_POLICY,
  };
}
export async function hasRejectedReview(ctx: Ctx, targetHash: string) {
  // Rejection is terminal for this exact target, even after later observations.
  const rejected = await ctx.db
    .query("contentReviews")
    .withIndex("target", (q) => q.eq("targetHash", targetHash))
    .filter((q) => q.eq(q.field("review.decision"), "rejected"))
    .first();
  return rejected !== null;
}
export async function currentReview(
  ctx: Ctx,
  b: Doc<"branches">,
  ep: Doc<"episodes">,
) {
  const target = episodeTarget(b, ep);
  if (!target) return null;
  if (
    !ep.provenance ||
    (await fingerprint(ep.provenance)) !== ep.provenanceHash
  )
    return null;
  const l = await getLineage(ctx, b.lineageId);
  if (
    !l ||
    l.status === "retired" ||
    l.worldHash !== target.worldHash ||
    l.policyVersion !== target.policyVersion
  )
    return null;
  const targetHash = await fingerprint(target);
  if (await hasRejectedReview(ctx, targetHash)) return null;
  const review = await ctx.db
    .query("contentReviews")
    .withIndex("target", (q) => q.eq("targetHash", targetHash))
    .order("desc")
    .first();
  if (!review || review.reviewer === b.owner || review.reviewer === ep.author)
    return null;
  const reviewer = await ctx.db.get(review.reviewer);
  const author = ep.author ? await ctx.db.get(ep.author) : null;
  if (
    !reviewer ||
    reviewer.role !== "auditor" ||
    reviewer.status !== "active" ||
    reviewer.repository === b.repository ||
    reviewer.repository === author?.repository
  )
    return null;
  return review;
}
export async function requireContentReview(
  ctx: Ctx,
  b: Doc<"branches">,
  ep: Doc<"episodes">,
) {
  const r = await currentReview(ctx, b, ep);
  if (
    !r ||
    r.review.inspection !== "completed" ||
    r.review.rights !== "verified" ||
    r.review.decision !== "eligible"
  )
    fail("CONTENT_REVIEW_REQUIRED");
  return r;
}
export async function publicReview(
  ctx: Ctx,
  b: Doc<"branches">,
  ep: Doc<"episodes">,
) {
  const row = await requireContentReview(ctx, b, ep);
  return {
    policyVersion: row.target.policyVersion,
    checkedAt: row.checkedAt,
    summary: row.review.publicSummary,
  };
}
export async function declarationForBranch(
  ctx: MutationCtx,
  value: any,
  ref: ReviewTarget["parent"],
  existing?: Doc<"branches">,
) {
  const id = lineageId(value.lineageId);
  const lineage = await requireLineage(ctx, id);
  if (!ref) fail("INVALID_PARENT");
  const parentBranch = await ctx.db
    .query("branches")
    .withIndex("branchId", (q) => q.eq("branchId", ref.branchId))
    .unique();
  if (parentBranch?.lineageId !== id || (existing && existing.lineageId !== id))
    fail("LINEAGE_MISMATCH");
  const provenance = validateProvenance(value.provenance);
  return {
    lineageId: id,
    worldHash: lineage.worldHash,
    provenance,
    provenanceHash: await fingerprint(provenance),
  };
}
