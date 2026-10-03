import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

// An intake revision cannot revoke approval of an immutable, already listed
// episode. Explicit branch/owner stops and per-episode withdrawal still apply.
export function branchCanShowListed(branch: Doc<"branches">) {
  return (
    ["verified", "pending", "checked"].includes(branch.status) &&
    branch.listingSuspended !== true
  );
}

export async function canReadListedBranch(
  ctx: QueryCtx | MutationCtx,
  branch: Doc<"branches">,
) {
  if (!branchCanShowListed(branch)) return false;
  if (branch.listingSuspended !== undefined || branch.status === "verified")
    return true;
  // Older intake records lack the durable stop flag. Consult their last
  // listing decision so deployment cannot revive a previously suspended branch.
  const decision = await ctx.db
    .query("branchHistory")
    .withIndex("branch", (q) => q.eq("branchId", branch.branchId))
    .order("desc")
    .filter((q) =>
      q.or(
        ...["verified", "suspended", "blocked"].map((status) =>
          q.eq(q.field("snapshot.status"), status),
        ),
      ),
    )
    .first();
  return !decision || decision.snapshot.status === "verified";
}

export function isListedEpisode(branch: Doc<"branches">, ep: Doc<"episodes">) {
  return (
    branchCanShowListed(branch) &&
    ep.lifecycle !== "withdrawn" &&
    ep.withdrawnAt === undefined &&
    (ep.listed === true ||
      (ep.listed === undefined &&
        branch.status === "verified" &&
        (branch.branchId === "origin" || branch.revision === ep.revision)))
  );
}
