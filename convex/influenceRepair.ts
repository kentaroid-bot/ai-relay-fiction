import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { digest, fail, githubText, keyHash, revision } from "./policy";
import {
  fingerprint,
  episodeProvenance,
  validateProvenance,
} from "./contentSafety";
import { inspectSource, parseManifest } from "./sourceCheck";
import { canReadListedBranch, isListedEpisode } from "./visibility";
import { audit } from "./desk";

const targetArgs = { branchId: v.string(), revision: v.string() };
async function context(
  ctx: QueryCtx | MutationCtx,
  args: { branchId: string; revision: string },
) {
  revision(args.revision);
  const branch = await ctx.db
    .query("branches")
    .withIndex("branchId", (q) => q.eq("branchId", args.branchId))
    .unique();
  if (
    !branch ||
    !(await canReadListedBranch(ctx, branch)) ||
    (await ctx.db.get(branch.owner))?.status !== "active"
  )
    fail("NOT_FOUND");
  const episodes = await ctx.db
    .query("episodes")
    .withIndex("branchRevision", (q) =>
      q.eq("branchId", args.branchId).eq("revision", args.revision),
    )
    .take(21);
  if (!episodes.length || episodes.length > 20) fail("INVALID_EPISODES");
  return { branch, episodes };
}
export const source = internalQuery({ args: targetArgs, handler: context });

const applyArgs = {
  ...targetArgs,
  manifest: v.string(),
  manifestHash: v.string(),
  dryRun: v.boolean(),
};
// The action fetches and hashes the fixed manuscript files. This transaction
// rechecks the recorded edition before writing only its display correction.
export const apply = internalMutation({
  args: applyArgs,
  handler: async (ctx, args) => {
    const { branch, episodes } = await context(ctx, args);
    if ((await digest(args.manifest)) !== keyHash(args.manifestHash))
      fail("MANIFEST_MISMATCH");
    const manifest = parseManifest(args.manifest);
    const base = validateProvenance(manifest.provenance);
    const baseHash = await fingerprint(base);
    if (
      manifest.schemaVersion !== 1 ||
      manifest.branchId !== branch.branchId ||
      manifest.repository !== branch.repository ||
      manifest.lineageId !== branch.lineageId ||
      !Array.isArray(manifest.episodes) ||
      manifest.episodes.length !== episodes.length
    )
      fail("MANIFEST_MISMATCH");
    const seen = new Set<string>();
    const plan = [];
    for (const item of manifest.episodes) {
      if (seen.has(item.episodeId)) fail("INVALID_EPISODES");
      seen.add(item.episodeId);
      const ep = episodes.find((e) => e.episodeId === item.episodeId);
      if (
        !ep ||
        ep.path !== item.path ||
        ep.contentHash !== item.contentHash ||
        ep.title !== item.title ||
        ep.lineageId !== branch.lineageId ||
        ep.worldHash !== branch.worldHash ||
        ep.provenanceHash !== baseHash ||
        (await fingerprint(ep.provenance)) !== baseHash ||
        ep.license?.id !== manifest.license ||
        ep.license?.termsVersion !== manifest.termsVersion ||
        !(await isListedEpisode(ctx, branch, ep))
      )
        fail("REPAIR_TARGET_MISMATCH");
      // Missing per-episode fields are legacy branch defaults, not guesses.
      if (item.influences === undefined) continue;
      const influences = episodeProvenance(base, item.influences).influences!;
      if (
        (await fingerprint(influences)) ===
        (await fingerprint(base.influences ?? []))
      )
        continue;
      const existing = ep.influenceCorrection;
      if (
        existing &&
        (existing.manifestHash !== args.manifestHash ||
          existing.originalProvenanceHash !== baseHash ||
          (await fingerprint(existing.influences)) !==
            (await fingerprint(influences)))
      )
        fail("REPAIR_CONFLICT");
      plan.push({
        ep,
        influences,
        status: existing ? "already_corrected" : "correction_required",
      });
    }
    if (!args.dryRun) {
      for (const { ep, influences, status } of plan) {
        if (status === "already_corrected") continue;
        await ctx.db.patch(ep._id, {
          influenceCorrection: {
            influences,
            manifestHash: args.manifestHash,
            originalProvenanceHash: ep.provenanceHash!,
            recordedAt: Date.now(),
          },
        });
        await audit(
          ctx,
          "system:fixed-influence-import-repair",
          "episode.influenceImportCorrection",
          ep._id,
        );
      }
    }
    return {
      branchId: args.branchId,
      revision: args.revision,
      manifestHash: args.manifestHash,
      dryRun: args.dryRun,
      episodes: plan.map(({ ep, influences, status }) => ({
        episodeId: ep.episodeId,
        before: ep.provenance?.influences ?? [],
        after: influences,
        status:
          !args.dryRun && status === "correction_required"
            ? "corrected"
            : status,
      })),
    };
  },
});

// Operator-only, no public HTTP route or participant-key access. The operator
// pins the reviewed source bytes and can inspect the exact changes first.
export const fromFixedManifest = internalAction({
  args: {
    ...targetArgs,
    manifestHash: v.string(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<unknown> => {
    const { branch } = await ctx.runQuery(internal.influenceRepair.source, {
      branchId: args.branchId,
      revision: args.revision,
    });
    const raw = await githubText(
      branch.repository,
      args.revision,
      "relay-branch.json",
      20000,
    );
    if ((await digest(raw)) !== keyHash(args.manifestHash))
      fail("MANIFEST_MISMATCH");
    const manifest = parseManifest(raw);
    const provenance = validateProvenance(manifest.provenance);
    // Historical editions have historical titles/parents/declarations. Their
    // stored episode identities and reviewed hashes are checked by apply.
    await inspectSource(
      {
        ...branch,
        revision: args.revision,
        title: manifest.title,
        parent: manifest.parent,
        provenance,
        provenanceHash: await fingerprint(provenance),
        isLineageRoot: false,
      },
      manifest,
    );
    return ctx.runMutation(internal.influenceRepair.apply, {
      ...args,
      manifest: raw,
      dryRun: args.dryRun ?? true,
    });
  },
});
