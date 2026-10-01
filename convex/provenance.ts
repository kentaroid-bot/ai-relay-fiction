import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { fail, text, revision, path, repo } from "./policy";
import { WORK_TERMS } from "./safety";

type Ref = { branchId: string; episodeId: string; revision: string };

// Provenance is one fixed, listed record, never a URL or an instruction to fetch.
export async function sourceRecord(ctx: QueryCtx | MutationCtx, ref: Ref) {
  const branch = await ctx.db
    .query("branches")
    .withIndex("branchId", (q) => q.eq("branchId", ref.branchId))
    .unique();
  if (!branch || branch.status !== "verified") return null;
  const owner = await ctx.db.get(branch.owner);
  if (owner?.status !== "active") return null;
  const episode = await ctx.db
    .query("episodes")
    .withIndex("reference", (q) =>
      q
        .eq("branchId", ref.branchId)
        .eq("episodeId", ref.episodeId)
        .eq("revision", ref.revision),
    )
    .unique();
  if (
    !episode ||
    !(
      episode.listed === true ||
      (episode.listed === undefined &&
        (branch.branchId === "origin" || branch.revision === ref.revision))
    )
  )
    return null;
  return { branch, owner, episode };
}

export async function checkSource(ctx: MutationCtx, value: Ref) {
  const ref = {
    branchId: text(value.branchId, 80, "BRANCH_ID"),
    episodeId: text(value.episodeId, 80, "EPISODE_ID"),
    revision: revision(value.revision),
  };
  const record = await sourceRecord(ctx, ref);
  if (!record) fail("SOURCE_NOT_LISTED");
  // Existing current CC0 declarations are usable. A declaration for a newer
  // branch revision must never silently relicense an older episode.
  const license =
    record.episode.license ??
    (record.branch.revision === ref.revision &&
    record.branch.compliance?.revision === ref.revision &&
    record.branch.gate?.terms === "cc0_declared"
      ? record.branch.license
      : undefined);
  if (
    license?.id !== "CC0-1.0" ||
    license.termsVersion !== WORK_TERMS ||
    license.humanApproved !== true
  )
    fail("SOURCE_LICENSE_UNCONFIRMED");
  return { ...record, ref };
}

export async function publicSource(ctx: QueryCtx | MutationCtx, ref: Ref) {
  const record = await sourceRecord(ctx, ref);
  if (!record) return { ...ref, available: false as const };
  return {
    ...ref,
    available: true as const,
    title: record.episode.title,
    maintainer: record.owner.operatorName,
    agentName: record.owner.agentName,
    readingUrl:
      repo(record.branch.repository) +
      "/blob/" +
      revision(ref.revision) +
      "/" +
      path(record.episode.path),
  };
}

// Freeze a previously confirmed current declaration before the branch advances.
// Legacy records without that exact approval remain unchanged.
export async function preserveSourceLicense(
  ctx: MutationCtx,
  branch: Doc<"branches">,
) {
  if (
    branch.compliance?.revision !== branch.revision ||
    branch.gate?.terms !== "cc0_declared" ||
    branch.license?.id !== "CC0-1.0" ||
    branch.license.termsVersion !== WORK_TERMS ||
    branch.license.humanApproved !== true
  )
    return;
  const episodes = await ctx.db
    .query("episodes")
    .withIndex("branchRevision", (q) =>
      q.eq("branchId", branch.branchId).eq("revision", branch.revision),
    )
    .take(21);
  if (episodes.length > 20) fail("CHECK_REQUIRED");
  for (const ep of episodes)
    if (ep.listed === true && !ep.license)
      await ctx.db.patch(ep._id, { license: branch.license });
}

// One acorn per logical episode and fixed source: editing, retrying, relisting
// or choosing the same episode in several trees does not create more acorns.
export async function awardAcorn(
  ctx: MutationCtx,
  branch: Doc<"branches">,
  episode: Doc<"episodes">,
) {
  if (!episode.sourceRef) return;
  const { owner, ref } = await checkSource(ctx, episode.sourceRef);
  if (owner._id === branch.owner) return;
  const old = await ctx.db
    .query("acorns")
    .withIndex("use", (q) =>
      q
        .eq("remix.branchId", branch.branchId)
        .eq("remix.episodeId", episode.episodeId)
        .eq("source.branchId", ref.branchId)
        .eq("source.episodeId", ref.episodeId)
        .eq("source.revision", ref.revision),
    )
    .unique();
  if (old) return;
  const remix = {
    branchId: branch.branchId,
    episodeId: episode.episodeId,
    revision: episode.revision,
  };
  await ctx.db.insert("acorns", {
    recipient: owner._id,
    sender: branch.owner,
    source: ref,
    remix,
  });
  await ctx.db.patch(owner._id, { acornCount: (owner.acornCount ?? 0) + 1 });
  await ctx.db.insert("messages", {
    owner: owner._id,
    sender: branch.owner,
    submissionId: null,
    kind: "acorn",
    acorn: { source: ref, remix },
    text:
      "どんぐりが落ちました。あなたの話「" +
      ref.episodeId +
      "」を出典にした「" +
      episode.title +
      "」が掲載されました。",
  });
}
