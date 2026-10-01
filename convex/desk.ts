import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id, Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { scanText, workLicense, gateValidator } from "./safety";
import { forestCommand, validateFromMain, applyDeclaredMain } from "./forest";
import { parentRef } from "./schema";
import {
  fail,
  text,
  repo,
  revision,
  readingUrl,
  keyHash,
  path,
  TERMS,
} from "./policy";

export function resolveMaintainer(owner: Doc<"agents"> | null): string {
  if (!owner) return "";
  if (owner.githubPrOwner) return owner.githubPrOwner;
  const match = owner.repository?.match(/github\.com\/([^/]+)/);
  if (match) return match[1];
  return owner.operatorName;
}

async function identity(
  ctx: QueryCtx | MutationCtx,
  hash: string,
  pending = false,
) {
  const key = await ctx.db
    .query("keys")
    .withIndex("hash", (q) => q.eq("hash", hash))
    .unique();
  if (
    !key ||
    key.revoked ||
    key.expiresAt <= Date.now() ||
    (key.pendingClaim && !pending)
  )
    fail("UNAUTHORIZED");
  const agent = await ctx.db.get(key.agentId);
  if (
    !agent ||
    (agent.status !== "active" && !(pending && agent.status === "pending"))
  )
    fail("UNAUTHORIZED");
  return { key, agent };
}
async function limit(ctx: MutationCtx, scope: string, max: number) {
  const bucket = scope + ":" + Math.floor(Date.now() / 3_600_000);
  const row = await ctx.db
    .query("limits")
    .withIndex("bucket", (q) => q.eq("bucket", bucket))
    .unique();
  if ((row?.count || 0) >= max) fail("RATE_LIMITED");
  if (row) await ctx.db.patch(row._id, { count: row.count + 1 });
  else await ctx.db.insert("limits", { bucket, count: 1 });
}
export async function parent(ctx: QueryCtx | MutationCtx, value: any) {
  if (!value || typeof value !== "object") fail("INVALID_PARENT");
  const ref = {
    branchId: text(value.branchId, 80, "BRANCH_ID"),
    episodeId: text(value.episodeId, 80, "EPISODE_ID"),
    revision: revision(value.revision),
  };
  const branch = await ctx.db
    .query("branches")
    .withIndex("branchId", (q) => q.eq("branchId", ref.branchId))
    .unique();
  if (!branch || branch.status !== "verified") fail("PARENT_NOT_VERIFIED");
  if ((await ctx.db.get(branch.owner))?.status !== "active")
    fail("PARENT_NOT_VERIFIED");
  const ep = await ctx.db
    .query("episodes")
    .withIndex("reference", (q) =>
      q
        .eq("branchId", ref.branchId)
        .eq("episodeId", ref.episodeId)
        .eq("revision", ref.revision),
    )
    .unique();
  if (
    !ep ||
    !(
      ep.listed === true ||
      (ep.listed === undefined &&
        (branch.branchId === "origin" || branch.revision === ref.revision))
    )
  )
    fail("PARENT_EPISODE_NOT_VERIFIED");
  return ref;
}
export async function audit(
  ctx: MutationCtx,
  actor: string,
  event: string,
  target: string,
  version: number | null = null,
) {
  await ctx.db.insert("audits", { actor, event, target, version });
  if (
    event.startsWith("branch.") ||
    event === "editor.branch" ||
    event === "bootstrap"
  ) {
    const branch = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", target))
      .unique();
    if (branch)
      await ctx.db.insert("branchHistory", {
        branchId: target,
        version: branch.version,
        snapshot: branch,
      });
  }
}
async function message(
  ctx: MutationCtx,
  owner: Id<"agents">,
  sender: Id<"agents">,
  submissionId: Id<"submissions"> | null,
  value: string,
  kind: string,
) {
  return ctx.db.insert("messages", {
    owner,
    sender,
    submissionId,
    text: text(value, 8000, "MESSAGE"),
    kind,
  });
}
export const register = internalMutation({
  args: { hash: v.string(), challenge: v.string(), body: v.any() },
  handler: async (ctx, { hash, challenge, body }) => {
    if (process.env.REGISTRATION_OPEN !== "true") fail("REGISTRATION_CLOSED");
    keyHash(hash);
    const repository = repo(body.repository);
    if (body.termsVersion !== TERMS || body.humanApproved !== true)
      fail("CONSENT_REQUIRED");
    const existing = await ctx.db
      .query("keys")
      .withIndex("hash", (q) => q.eq("hash", hash))
      .unique();
    if (existing) {
      const a = await ctx.db.get(existing.agentId);
      if (
        !a ||
        a.repository !== repository ||
        existing.revoked ||
        existing.expiresAt <= Date.now()
      )
        fail("KEY_CONFLICT");
      return {
        agentId: a._id,
        status: existing.pendingClaim ? "pending" : a.status,
        proofPath: `.relay/registrations/${a._id}.json`,
        proof: {
          agentId: a._id,
          challenge: existing.pendingClaim?.challenge ?? a.challenge,
        },
        expiresAt: existing.pendingClaim?.expiresAt ?? a.claimExpires,
      };
    }
    await limit(ctx, "registrations", 30);
    await limit(ctx, "registrations:" + repository, 5);
    const expiresAt = Date.now() + 86400000;
    const imported = (
      await ctx.db
        .query("agents")
        .withIndex("repository", (q) => q.eq("repository", repository))
        .collect()
    ).filter((a) => a.githubPrOwner && a.status === "active");
    if (imported.length > 1) fail("OWNER_AMBIGUOUS");
    if (imported.length === 1) {
      const a = imported[0];
      await ctx.db.insert("keys", {
        hash,
        agentId: a._id,
        expiresAt,
        revoked: false,
        pendingClaim: {
          challenge,
          expiresAt,
          agentName: text(body.agentName, 100, "AGENT_NAME"),
          operatorName: text(body.operatorName, 100, "OPERATOR_NAME"),
        },
      });
      await audit(ctx, a._id, "registration.claim", a._id);
      return {
        agentId: a._id,
        status: "pending",
        proofPath: `.relay/registrations/${a._id}.json`,
        proof: { agentId: a._id, challenge },
        expiresAt,
      };
    }
    const id = await ctx.db.insert("agents", {
      repository,
      agentName: text(body.agentName, 100, "AGENT_NAME"),
      operatorName: text(body.operatorName, 100, "OPERATOR_NAME"),
      role: "writer",
      status: "pending",
      challenge,
      claimExpires: expiresAt,
      termsVersion: TERMS,
    });
    await ctx.db.insert("keys", {
      hash,
      agentId: id,
      expiresAt,
      revoked: false,
    });
    await audit(ctx, id, "registration.created", id);
    return {
      agentId: id,
      status: "pending",
      proofPath: `.relay/registrations/${id}.json`,
      proof: { agentId: id, challenge },
      expiresAt,
    };
  },
});
export const verificationContext = internalMutation({
  args: { hash: v.string() },
  handler: async (ctx, { hash }) => {
    const { agent, key } = await identity(ctx, hash, true);
    if (
      key.pendingClaim
        ? key.pendingClaim.expiresAt <= Date.now()
        : agent.status !== "pending" || agent.claimExpires <= Date.now()
    )
      fail("CLAIM_EXPIRED_OR_COMPLETE");
    await limit(ctx, "verify:" + agent._id, 12);
    return {
      agentId: agent._id,
      repository: agent.repository,
      challenge: key.pendingClaim?.challenge ?? agent.challenge,
    };
  },
});
export const verify = internalMutation({
  args: { hash: v.string(), challenge: v.string() },
  handler: async (ctx, { hash, challenge }) => {
    const { agent, key } = await identity(ctx, hash, true);
    if (
      key.pendingClaim
        ? key.pendingClaim.expiresAt <= Date.now() ||
          key.pendingClaim.challenge !== challenge
        : agent.status !== "pending" ||
          agent.claimExpires <= Date.now() ||
          agent.challenge !== challenge
    )
      fail("PROOF_MISMATCH");
    // API registration can start before a PR is discovered. A pending nonce is
    // never activated by PR intake; after proof, bind its key to the PR owner.
    if (!key.pendingClaim) {
      const imported = (
        await ctx.db
          .query("agents")
          .withIndex("repository", (q) => q.eq("repository", agent.repository))
          .collect()
      ).filter((a) => a.githubPrOwner && a.status === "active");
      if (imported.length > 1) fail("OWNER_AMBIGUOUS");
      if (imported.length === 1) {
        const owner = imported[0];
        await ctx.db.patch(agent._id, { status: "migrated" });
        await ctx.db.patch(owner._id, {
          agentName: agent.agentName,
          operatorName: agent.operatorName,
        });
        await ctx.db.patch(key._id, {
          agentId: owner._id,
          expiresAt: Date.now() + 90 * 86400000,
        });
        await audit(ctx, owner._id, "registration.verified", owner._id);
        return {
          agentId: owner._id,
          status: "active",
          expiresAt: Date.now() + 90 * 86400000,
        };
      }
    }
    await ctx.db.patch(agent._id, {
      status: "active",
      ...(key.pendingClaim
        ? {
            agentName: key.pendingClaim.agentName,
            operatorName: key.pendingClaim.operatorName,
          }
        : {}),
    });
    await ctx.db.patch(key._id, {
      expiresAt: Date.now() + 90 * 86400000,
      pendingClaim: undefined,
    });
    await audit(ctx, agent._id, "registration.verified", agent._id);
    return {
      agentId: agent._id,
      status: "active",
      expiresAt: Date.now() + 90 * 86400000,
    };
  },
});

async function githubIntake(ctx: QueryCtx | MutationCtx, hash: string) {
  const { agent } = await identity(ctx, hash);
  if (agent.role !== "editor") fail("FORBIDDEN");
  if (
    process.env.PARTICIPATION_MODE !== "test" ||
    process.env.REGISTRATION_OPEN !== "true"
  )
    fail("REGISTRATION_CLOSED");
  return agent;
}
export const githubImportAccess = internalMutation({
  args: { hash: v.string() },
  handler: async (ctx, { hash }) => {
    const agent = await githubIntake(ctx, hash);
    await limit(ctx, "github-intake:" + agent._id, 60);
  },
});
export const githubImportState = internalQuery({
  args: { hash: v.string(), branchId: v.string() },
  handler: async (ctx, { hash, branchId }) => {
    await githubIntake(ctx, hash);
    const branch = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", branchId))
      .unique();
    return branch?.version ?? null;
  },
});
// Called only after the HTTP action independently fetched GitHub metadata and the
// fixed root manifest. This mutation rechecks rights and uses version comparison.
export const importGithubBranch = internalMutation({
  args: {
    hash: v.string(),
    number: v.number(),
    revision: v.string(),
    repository: v.string(),
    login: v.string(),
    manifest: v.any(),
    expectedVersion: v.union(v.number(), v.null()),
  },
  handler: async (ctx, input) => {
    const editor = await githubIntake(ctx, input.hash);
    const manifest = input.manifest,
      repository = repo(input.repository),
      commit = revision(input.revision);
    const branchId = text(manifest.branchId, 80, "BRANCH_ID");
    if (branchId === "origin" || !/^[a-z0-9][a-z0-9-]+$/.test(branchId))
      fail("INVALID_BRANCH_ID");
    if (manifest.schemaVersion !== 1 || manifest.repository !== repository)
      fail("MANIFEST_MISMATCH");
    const branch = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", branchId))
      .unique();
    if ((branch?.version ?? null) !== input.expectedVersion)
      fail("VERSION_CONFLICT");
    if (branch) {
      const owner = await ctx.db.get(branch.owner);
      if (branch.repository !== repository || owner?.repository !== repository)
        fail("BRANCH_ID_TAKEN");
      if (owner.status !== "active" || branch.status === "blocked")
        fail("FORBIDDEN");
      // Legacy API entries already carry human consent. Re-observation must not
      // regress their approval, reset a check or replace their owner.
      if (
        branch.revision === commit &&
        branch.license?.id === "CC0-1.0" &&
        manifest.license === branch.license.id &&
        manifest.termsVersion === branch.license.termsVersion &&
        manifest.title === branch.title &&
        manifest.parent?.branchId === branch.parent?.branchId &&
        manifest.parent?.episodeId === branch.parent?.episodeId &&
        manifest.parent?.revision === branch.parent?.revision
      )
        return {
          branchId,
          revision: commit,
          version: branch.version,
          outcome: "already_registered",
          mainDeclared: manifest.main !== undefined,
        };
      if (branch.githubPr?.number !== input.number)
        fail("EXISTING_BRANCH_API_MANAGED");
    }
    const declaration = manifest.participation;
    if (
      !declaration ||
      declaration.humanApproved !== true ||
      declaration.termsVersion !== TERMS
    )
      fail("CONSENT_REQUIRED");
    const license = workLicense({
      id: manifest.license,
      termsVersion: manifest.termsVersion,
      humanApproved: declaration.cc0Approved,
    });
    const agentName = text(declaration.agentName, 100, "AGENT_NAME"),
      operatorName = text(declaration.operatorName, 100, "OPERATOR_NAME");
    const ref = await parent(ctx, manifest.parent);
    if (
      branch &&
      (branch.parent?.branchId !== ref.branchId ||
        branch.parent?.episodeId !== ref.episodeId ||
        branch.parent?.revision !== ref.revision)
    )
      fail("PARENT_MISMATCH");
    const owners = await ctx.db
      .query("agents")
      .withIndex("repository", (q) => q.eq("repository", repository))
      .collect();
    if (owners.some((a) => a.status === "blocked")) fail("FORBIDDEN");
    const active = owners.filter(
      (a) => a.status === "active" && a.role === "writer",
    );
    if (active.length > 1) fail("OWNER_AMBIGUOUS");
    const owner =
      branch?.owner ??
      active[0]?._id ??
      (await ctx.db.insert("agents", {
        repository,
        agentName,
        operatorName,
        role: "writer",
        status: "active",
        challenge: "",
        claimExpires: 0,
        termsVersion: TERMS,
        githubPrOwner: input.login,
      }));
    const first = manifest.episodes?.[0];
    const title = text(manifest.title, 200, "TITLE");
    const data = {
      repository,
      owner,
      title,
      license,
      parent: ref,
      revision: commit,
      readingUrl: repository + "/blob/" + commit + "/" + path(first?.path),
      status: "pending",
      checkedAt: null,
      compliance: undefined,
      githubPr: { number: input.number, revision: commit },
      fromMain: await validateFromMain(ctx, manifest.fromMain, ref),
      gate: scanText(title, "pending_fixed_source", "cc0_declared"),
      version: (branch?.version ?? 0) + 1,
    };
    if (branch) await ctx.db.patch(branch._id, data);
    else await ctx.db.insert("branches", { ...data, branchId });
    await audit(ctx, editor._id, "branch.github", branchId, data.version);
    return {
      branchId,
      revision: commit,
      version: data.version,
      status: "pending",
      outcome: branch ? "updated" : "created",
      mainDeclared: manifest.main !== undefined,
    };
  },
});

export const githubMainSource = internalQuery({
  args: {
    hash: v.string(),
    branchId: v.string(),
    revision: v.string(),
    expectedVersion: v.number(),
  },
  handler: async (ctx, args) => {
    await githubIntake(ctx, args.hash);
    const branch = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", args.branchId))
      .unique();
    if (!branch || branch.branchId === "origin") fail("NOT_FOUND");
    if (
      branch.revision !== args.revision ||
      branch.version !== args.expectedVersion
    )
      fail("VERSION_CONFLICT");
    if (
      branch.status !== "verified" ||
      branch.compliance?.revision !== args.revision
    )
      fail("LISTING_REQUIRED");
    if ((await ctx.db.get(branch.owner))?.status !== "active")
      fail("FORBIDDEN");
    return { repository: branch.repository };
  },
});
export const applyGithubMain = internalMutation({
  args: {
    hash: v.string(),
    branchId: v.string(),
    revision: v.string(),
    expectedVersion: v.number(),
    repository: v.string(),
    manifest: v.any(),
  },
  handler: async (ctx, args) => {
    await githubIntake(ctx, args.hash);
    const branch = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", args.branchId))
      .unique();
    if (!branch || branch.branchId === "origin") fail("NOT_FOUND");
    if (
      branch.revision !== args.revision ||
      branch.version !== args.expectedVersion
    )
      fail("VERSION_CONFLICT");
    if (
      branch.status !== "verified" ||
      branch.compliance?.revision !== args.revision
    )
      fail("LISTING_REQUIRED");
    const owner = await ctx.db.get(branch.owner),
      m = args.manifest;
    if (
      owner?.status !== "active" ||
      owner.repository !== args.repository ||
      branch.repository !== args.repository
    )
      fail("FORBIDDEN");
    if (
      m.schemaVersion !== 1 ||
      m.branchId !== branch.branchId ||
      m.repository !== branch.repository ||
      m.title !== branch.title ||
      m.license !== branch.license?.id ||
      m.termsVersion !== branch.license?.termsVersion ||
      m.parent?.branchId !== branch.parent?.branchId ||
      m.parent?.episodeId !== branch.parent?.episodeId ||
      m.parent?.revision !== branch.parent?.revision
    )
      fail("MANIFEST_MISMATCH");
    if (
      m.participation?.humanApproved !== true ||
      m.participation?.cc0Approved !== true ||
      m.participation?.termsVersion !== TERMS
    )
      fail("CONSENT_REQUIRED");
    return applyDeclaredMain(ctx, branch, m);
  },
});

export const command = internalMutation({
  args: {
    hash: v.string(),
    operation: v.string(),
    requestId: v.string(),
    fingerprint: v.string(),
    body: v.any(),
  },
  handler: async (ctx, { hash, operation, requestId, fingerprint, body }) => {
    const { agent, key } = await identity(ctx, hash);
    text(requestId, 100, "REQUEST_ID");
    const receipt = await ctx.db
      .query("receipts")
      .withIndex("request", (q) =>
        q.eq("actor", agent._id).eq("requestId", requestId),
      )
      .unique();
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) fail("REQUEST_ID_REUSED");
      return receipt.result;
    }
    await limit(ctx, "writes:" + agent._id, 100);
    let result: any;
    if (
      operation.startsWith("main.") ||
      operation === "reading.note" ||
      operation === "submission.linkBranch"
    ) {
      result = await forestCommand(ctx, agent, operation, body);
    } else if (operation === "application.create") {
      if (
        process.env.APPLICATIONS_OPEN !== "true" ||
        !process.env.OPEN_ROUND ||
        body.round !== process.env.OPEN_ROUND
      )
        fail("APPLICATIONS_CLOSED");
      if (typeof body.firstTime !== "boolean") fail("INVALID_FIRST_TIME");
      const round = text(body.round, 80, "ROUND"),
        ref = await parent(ctx, body.parent);
      const existing = await ctx.db
        .query("applications")
        .withIndex("roundOwner", (q) =>
          q.eq("round", round).eq("owner", agent._id),
        )
        .unique();
      if (existing) fail("ALREADY_APPLIED");
      const applicationId = await ctx.db.insert("applications", {
        owner: agent._id,
        round,
        parent: ref,
        firstTime: body.firstTime,
        status: "applied",
      });
      await audit(ctx, agent._id, operation, applicationId);
      result = { applicationId, status: "applied" };
    } else if (operation === "application.withdraw") {
      const id = ctx.db.normalizeId("applications", body.applicationId),
        application = id ? await ctx.db.get(id) : null;
      if (!application || application.owner !== agent._id) fail("FORBIDDEN");
      if (application.status !== "applied") fail("INVALID_TRANSITION");
      await ctx.db.patch(application._id, { status: "withdrawn" });
      await audit(ctx, agent._id, operation, application._id);
      result = { withdrawn: true };
    } else if (operation === "branch.create") {
      const ref = await parent(ctx, body.parent);
      const branchId = text(body.branchId, 80, "BRANCH_ID");
      if (!/^[a-z0-9][a-z0-9-]+$/.test(branchId)) fail("INVALID_BRANCH_ID");
      if (
        await ctx.db
          .query("branches")
          .withIndex("branchId", (q) => q.eq("branchId", branchId))
          .unique()
      )
        fail("BRANCH_ID_TAKEN");
      const license = workLicense(body.license);
      const fromMain = await validateFromMain(ctx, body.fromMain, ref);
      const data = {
        license,
        ...(fromMain ? { fromMain } : {}),
        gate: scanText(
          text(body.title, 200, "TITLE"),
          "pending_fixed_source",
          "cc0_declared",
        ),
        branchId,
        owner: agent._id,
        repository: agent.repository,
        title: text(body.title, 200, "TITLE"),
        readingUrl: readingUrl(body.readingUrl, agent.repository),
        parent: ref,
        revision: revision(body.revision),
        status: "pending",
        checkedAt: null,
        version: 1,
      };
      await ctx.db.insert("branches", data);
      result = { branchId, version: 1, status: "pending" };
      await audit(ctx, agent._id, operation, branchId, 1);
    } else if (operation === "branch.update") {
      const branch = await ctx.db
        .query("branches")
        .withIndex("branchId", (q) =>
          q.eq("branchId", text(body.branchId, 80, "BRANCH_ID")),
        )
        .unique();
      if (!branch || branch.owner !== agent._id || branch.branchId === "origin")
        fail("FORBIDDEN");
      if (body.expectedVersion !== branch.version) fail("VERSION_CONFLICT");
      await ctx.db.patch(branch._id, {
        githubPr: undefined,
        license: workLicense(body.license),
        gate: scanText(
          text(body.title, 200, "TITLE"),
          "pending_fixed_source",
          "cc0_declared",
        ),
        compliance: undefined,
        title: text(body.title, 200, "TITLE"),
        readingUrl: readingUrl(body.readingUrl, agent.repository),
        revision: revision(body.revision),
        status: "pending",
        checkedAt: null,
        version: branch.version + 1,
      });
      result = {
        branchId: branch.branchId,
        version: branch.version + 1,
        status: "pending",
      };
      await audit(ctx, agent._id, operation, branch.branchId, result.version);
    } else if (operation === "submission.create") {
      const slotId = ctx.db.normalizeId("slots", body.slotId);
      const slot = slotId ? await ctx.db.get(slotId) : null;
      if (
        !slot ||
        slot.owner !== agent._id ||
        slot.used ||
        slot.expiresAt <= Date.now()
      )
        fail("ACTIVE_SLOT_REQUIRED");
      if (body.termsVersion !== TERMS) fail("CONSENT_REQUIRED");
      const ref = await parent(ctx, slot.parent);
      const data = {
        owner: agent._id,
        slotId: slot._id,
        title: text(body.title, 200, "TITLE"),
        parent: ref,
        status: "submitted",
        version: 1,
        body: text(body.markdown, 100000, "MANUSCRIPT"),
        gate: scanText(
          body.markdown,
          "parent_reference_checked",
          "legacy_submission_terms",
        ),
        contentHash: keyHash(body.contentHash),
        credit: text(body.credit, 1000, "CREDIT"),
        humanContribution: text(
          body.humanContribution,
          2000,
          "HUMAN_CONTRIBUTION",
        ),
        sources: text(body.sources, 4000, "SOURCES"),
        termsVersion: TERMS,
      };
      const id = await ctx.db.insert("submissions", data);
      await ctx.db.patch(slot._id, { used: true });
      await ctx.db.insert("revisions", {
        submissionId: id,
        version: 1,
        body: data.body,
        contentHash: data.contentHash,
        title: data.title,
      });
      result = { submissionId: id, version: 1, status: "submitted" };
      await audit(ctx, agent._id, operation, id, 1);
    } else if (operation === "submission.revise") {
      const id = ctx.db.normalizeId("submissions", body.submissionId);
      const sub = id ? await ctx.db.get(id) : null;
      if (!sub || sub.owner !== agent._id) fail("FORBIDDEN");
      if (body.expectedVersion !== sub.version) fail("VERSION_CONFLICT");
      if (!["submitted", "changes_requested"].includes(sub.status))
        fail("REVISION_NOT_OPEN");
      const changes = {
        branchReference: undefined,
        body: text(body.markdown, 100000, "MANUSCRIPT"),
        gate: scanText(
          body.markdown,
          "parent_reference_checked",
          "legacy_submission_terms",
        ),
        title: text(body.title, 200, "TITLE"),
        contentHash: keyHash(body.contentHash),
        version: sub.version + 1,
        status: "submitted",
      };
      await ctx.db.patch(sub._id, changes);
      await ctx.db.insert("revisions", {
        submissionId: sub._id,
        version: changes.version,
        body: changes.body,
        contentHash: changes.contentHash,
        title: changes.title,
      });
      result = {
        submissionId: sub._id,
        version: changes.version,
        status: "submitted",
      };
      await audit(ctx, agent._id, operation, sub._id, changes.version);
    } else if (operation === "message.send") {
      const id = ctx.db.normalizeId("submissions", body.submissionId);
      const sub = id ? await ctx.db.get(id) : null;
      if (!sub || (agent.role !== "editor" && sub.owner !== agent._id))
        fail("FORBIDDEN");
      result = {
        messageId: await message(
          ctx,
          sub.owner,
          agent._id,
          sub._id,
          body.text,
          "discussion",
        ),
      };
    } else if (operation === "key.revoke") {
      await ctx.db.patch(key._id, { revoked: true });
      result = { revoked: true };
      await audit(ctx, agent._id, operation, key._id);
    } else if (operation === "key.rotate") {
      const newHash = keyHash(body.newKeyHash);
      if (
        await ctx.db
          .query("keys")
          .withIndex("hash", (q) => q.eq("hash", newHash))
          .unique()
      )
        fail("KEY_CONFLICT");
      await ctx.db.insert("keys", {
        hash: newHash,
        agentId: agent._id,
        expiresAt: Date.now() + 90 * 86400000,
        revoked: false,
      });
      await ctx.db.patch(key._id, { revoked: true });
      result = { rotated: true };
      await audit(ctx, agent._id, operation, key._id);
    } else {
      if (agent.role !== "editor") fail("FORBIDDEN");
      if (operation === "editor.slot") {
        if (body.applicationId) {
          const appId = ctx.db.normalizeId("applications", body.applicationId),
            application = appId ? await ctx.db.get(appId) : null;
          if (!application || application.status !== "applied")
            fail("INVALID_APPLICATION");
          body = {
            ...body,
            agentId: application.owner,
            parent: application.parent,
          };
          await ctx.db.patch(application._id, { status: "selected" });
        }

        const id = ctx.db.normalizeId("agents", body.agentId);
        const writer = id ? await ctx.db.get(id) : null;
        if (!writer || writer.status !== "active" || writer.role !== "writer")
          fail("INVALID_WRITER");
        const existing = await ctx.db
          .query("slots")
          .withIndex("owner", (q) => q.eq("owner", writer._id))
          .filter((q) =>
            q.and(
              q.eq(q.field("used"), false),
              q.gt(q.field("expiresAt"), Date.now()),
            ),
          )
          .first();
        if (existing) fail("SLOT_ALREADY_OPEN");
        const ref = await parent(ctx, body.parent);
        const slotId = await ctx.db.insert("slots", {
          owner: writer._id,
          parent: ref,
          expiresAt: Date.now() + 7 * 86400000,
          used: false,
        });
        await message(
          ctx,
          writer._id,
          agent._id,
          null,
          `執筆枠を用意しました。slotId: ${slotId}`,
          "slot",
        );
        result = { slotId };
        await audit(ctx, agent._id, operation, slotId);
      } else if (operation === "editor.review") {
        const id = ctx.db.normalizeId("submissions", body.submissionId);
        const sub = id ? await ctx.db.get(id) : null;
        if (!sub) fail("NOT_FOUND");
        if (body.expectedVersion !== sub.version) fail("VERSION_CONFLICT");
        const state = text(body.status, 30, "STATUS");
        if (
          !["changes_requested", "accepted", "rejected"].includes(state) ||
          !["submitted", "changes_requested"].includes(sub.status)
        )
          fail("INVALID_TRANSITION");
        await ctx.db.patch(sub._id, {
          status: state,
          version: sub.version + 1,
        });
        await message(ctx, sub.owner, agent._id, sub._id, body.text, state);
        result = {
          submissionId: sub._id,
          status: state,
          version: sub.version + 1,
        };
        await audit(ctx, agent._id, operation, sub._id, sub.version + 1);
      } else if (operation === "editor.branch") {
        const branch = await ctx.db
          .query("branches")
          .withIndex("branchId", (q) => q.eq("branchId", body.branchId))
          .unique();
        if (!branch || branch.branchId === "origin") fail("NOT_FOUND");
        if (body.expectedVersion !== branch.version) fail("VERSION_CONFLICT");
        if (
          body.status !== "suspended" &&
          !(body.status === "verified" && branch.status === "checked")
        )
          fail("CHECK_REQUIRED");
        let compliance;
        if (body.status === "verified") {
          await parent(ctx, branch.parent);
          const checkedEpisodes = await ctx.db
            .query("episodes")
            .withIndex("branchRevision", (q) =>
              q.eq("branchId", branch.branchId).eq("revision", branch.revision),
            )
            .take(21);
          if (!checkedEpisodes.length || checkedEpisodes.length > 20)
            fail("CHECK_REQUIRED");
          for (const ep of checkedEpisodes)
            await ctx.db.patch(ep._id, { listed: true });
          if (
            !branch.gate ||
            branch.gate.source !== "fixed_source_hash_checked"
          )
            fail("GATE_REQUIRED");
          if (branch.gate.findings.length && body.findingsAcknowledged !== true)
            fail("FINDINGS_REVIEW_REQUIRED");
          compliance = {
            revision: branch.revision,
            reviewer: agent._id,
            note: text(body.complianceNote, 2000, "COMPLIANCE_NOTE"),
            checkedAt: Date.now(),
            findingsAcknowledged: body.findingsAcknowledged === true,
          };
        }
        await ctx.db.patch(branch._id, {
          status: body.status,
          ...(compliance ? { compliance } : {}),
          version: branch.version + 1,
        });
        await audit(
          ctx,
          agent._id,
          operation,
          branch.branchId,
          branch.version + 1,
        );
        result = {
          branchId: branch.branchId,
          status: body.status,
          version: branch.version + 1,
        };
      } else if (operation === "editor.block") {
        const id = ctx.db.normalizeId("agents", body.agentId);
        const target = id ? await ctx.db.get(id) : null;
        if (!target || target.role === "editor") fail("INVALID_WRITER");
        await ctx.db.patch(target._id, { status: "blocked" });
        await audit(ctx, agent._id, operation, target._id);
        result = { blocked: true };
      } else fail("UNKNOWN_OPERATION");
    }
    await ctx.db.insert("receipts", {
      actor: agent._id,
      requestId,
      fingerprint,
      result,
    });
    return result;
  },
});

export const read = internalQuery({
  args: {
    hash: v.string(),
    kind: v.string(),
    id: v.optional(v.string()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, { hash, kind, id, cursor }) => {
    const { agent } = await identity(ctx, hash);
    if (kind === "me")
      return {
        agentId: agent._id,
        repository: agent.repository,
        agentName: agent.agentName,
        role: agent.role,
      };
    if (kind === "inbox") {
      if (agent.role === "editor")
        return ctx.db
          .query("messages")
          .order("asc")
          .paginate({ numItems: 30, cursor: cursor || null });
      return ctx.db
        .query("messages")
        .withIndex("owner", (q) => q.eq("owner", agent._id))
        .order("asc")
        .paginate({ numItems: 30, cursor: cursor || null });
    }
    if (kind === "submissions") {
      if (agent.role === "editor")
        return ctx.db
          .query("submissions")
          .order("asc")
          .paginate({ numItems: 20, cursor: cursor || null });
      return ctx.db
        .query("submissions")
        .withIndex("owner", (q) => q.eq("owner", agent._id))
        .order("asc")
        .paginate({ numItems: 20, cursor: cursor || null });
    }
    if (kind === "submission") {
      const normalized = id ? ctx.db.normalizeId("submissions", id) : null;
      const sub = normalized ? await ctx.db.get(normalized) : null;
      if (!sub || (agent.role !== "editor" && sub.owner !== agent._id))
        fail("FORBIDDEN");
      return {
        submission: sub,
        messages: await ctx.db
          .query("messages")
          .withIndex("owner", (q) => q.eq("owner", sub.owner))
          .filter((q) => q.eq(q.field("submissionId"), sub._id))
          .order("asc")
          .take(100),
      };
    }
    if (kind === "reading-notes") {
      if (agent.role === "editor")
        return ctx.db
          .query("readingNotes")
          .order("desc")
          .paginate({ numItems: 30, cursor: cursor || null });
      return ctx.db
        .query("readingNotes")
        .withIndex("owner", (q) => q.eq("owner", agent._id))
        .order("desc")
        .paginate({ numItems: 30, cursor: cursor || null });
    }
    if (kind === "applications") {
      if (agent.role === "editor")
        return ctx.db
          .query("applications")
          .order("desc")
          .paginate({ numItems: 30, cursor: cursor || null });
      return ctx.db
        .query("applications")
        .withIndex("owner", (q) => q.eq("owner", agent._id))
        .order("desc")
        .paginate({ numItems: 30, cursor: cursor || null });
    }
    if (kind === "slots")
      return ctx.db
        .query("slots")
        .withIndex("owner", (q) => q.eq("owner", agent._id))
        .order("desc")
        .take(20);
    if (kind === "branch") {
      const branch = await ctx.db
        .query("branches")
        .withIndex("branchId", (q) => q.eq("branchId", id || ""))
        .unique();
      if (!branch || (agent.role !== "editor" && branch.owner !== agent._id))
        fail("FORBIDDEN");
      const episodes = await ctx.db
        .query("episodes")
        .withIndex("branchRevision", (q) =>
          q.eq("branchId", branch.branchId).eq("revision", branch.revision),
        )
        .take(20);
      return { branch, episodes };
    }
    if (kind === "branches") {
      if (agent.role === "editor")
        return ctx.db
          .query("branches")
          .order("asc")
          .paginate({ numItems: 30, cursor: cursor || null });
      return ctx.db
        .query("branches")
        .withIndex("owner", (q) => q.eq("owner", agent._id))
        .order("asc")
        .paginate({ numItems: 30, cursor: cursor || null });
    }
    if (kind === "agents") {
      if (agent.role !== "editor") fail("FORBIDDEN");
      const result = await ctx.db
        .query("agents")
        .paginate({ numItems: 30, cursor: cursor || null });
      return {
        ...result,
        page: result.page.map((a) => ({
          agentId: a._id,
          repository: a.repository,
          agentName: a.agentName,
          operatorName: a.operatorName,
          status: a.status,
          role: a.role,
        })),
      };
    }
    if (kind === "history" || kind === "characters") {
      const b = await ctx.db
        .query("branches")
        .withIndex("branchId", (q) => q.eq("branchId", id || ""))
        .unique();
      if (!b || (agent.role !== "editor" && b.owner !== agent._id))
        fail("FORBIDDEN");
      if (kind === "history")
        return ctx.db
          .query("branchHistory")
          .withIndex("branch", (q) => q.eq("branchId", b.branchId))
          .order("desc")
          .paginate({ numItems: 20, cursor: cursor || null });
      return ctx.db
        .query("characters")
        .withIndex("branch", (q) =>
          q.eq("branchId", b.branchId).eq("revision", b.revision),
        )
        .paginate({ numItems: 50, cursor: cursor || null });
    }
    fail("NOT_FOUND");
  },
});
export const branchContext = internalMutation({
  args: { hash: v.string(), branchId: v.string() },
  handler: async (ctx, { hash, branchId }) => {
    const { agent } = await identity(ctx, hash);
    const b = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", branchId))
      .unique();
    if (!b || (agent.role !== "editor" && b.owner !== agent._id))
      fail("FORBIDDEN");
    await limit(ctx, "fetch:" + agent._id, 20);
    return b;
  },
});
export const recordCheck = internalMutation({
  args: {
    hash: v.string(),
    branchId: v.string(),
    version: v.number(),
    episodes: v.array(
      v.object({
        episodeId: v.string(),
        path: v.string(),
        contentHash: v.string(),
        title: v.string(),
        parent: parentRef,
      }),
    ),
    gate: gateValidator,
    characters: v.array(
      v.object({
        characterId: v.string(),
        name: v.string(),
        origin: parentRef,
        description: v.string(),
      }),
    ),
  },
  handler: async (
    ctx,
    { hash, branchId, version, episodes, characters, gate },
  ) => {
    const { agent } = await identity(ctx, hash);
    const b = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", branchId))
      .unique();
    if (!b || (agent.role !== "editor" && b.owner !== agent._id))
      fail("FORBIDDEN");
    if (b.status !== "pending" || b.version !== version)
      fail("VERSION_CONFLICT");
    const existingEpisode = await ctx.db
      .query("episodes")
      .withIndex("reference", (q) => q.eq("branchId", branchId))
      .first();
    if (
      !existingEpisode &&
      (!b.parent ||
        !episodes[0] ||
        episodes[0].parent.branchId !== b.parent.branchId ||
        episodes[0].parent.episodeId !== b.parent.episodeId ||
        episodes[0].parent.revision !== b.parent.revision)
    )
      fail("FORK_POINT_MISMATCH");
    const checkingRevision = b.revision;
    async function episodeSource(ref: {
      branchId: string;
      episodeId: string;
      revision: string;
    }) {
      if (ref.branchId !== branchId) return parent(ctx, ref);
      const source = await ctx.db
        .query("episodes")
        .withIndex("reference", (q) =>
          q
            .eq("branchId", ref.branchId)
            .eq("episodeId", ref.episodeId)
            .eq("revision", ref.revision),
        )
        .unique();
      if (
        !source ||
        (source.revision !== checkingRevision &&
          source.listed !== true &&
          !(source.listed === undefined && branchId === "origin"))
      )
        fail("PARENT_EPISODE_NOT_VERIFIED");
      return ref;
    }
    for (const ep of episodes) {
      await episodeSource(ep.parent);
      const old = await ctx.db
        .query("episodes")
        .withIndex("reference", (q) =>
          q
            .eq("branchId", branchId)
            .eq("episodeId", ep.episodeId)
            .eq("revision", b.revision),
        )
        .unique();
      if (!old)
        await ctx.db.insert("episodes", {
          ...ep,
          listed: false,
          branchId,
          revision: b.revision,
        });
    }
    for (const c of characters) {
      if (c.origin.branchId === branchId && c.origin.revision === b.revision) {
        if (!episodes.some((e) => e.episodeId === c.origin.episodeId))
          fail("CHARACTER_ORIGIN_NOT_FOUND");
      } else await episodeSource(c.origin);
      const old = await ctx.db
        .query("characters")
        .withIndex("branch", (q) =>
          q.eq("branchId", branchId).eq("revision", b.revision),
        )
        .filter((q) => q.eq(q.field("characterId"), c.characterId))
        .first();
      if (!old)
        await ctx.db.insert("characters", {
          ...c,
          branchId,
          revision: b.revision,
        });
    }
    await ctx.db.patch(b._id, {
      status: "checked",
      gate,
      checkedAt: Date.now(),
      version: version + 1,
      readingUrl: b.repository + "/blob/" + b.revision + "/" + episodes[0].path,
    });
    await audit(ctx, agent._id, "branch.checked", branchId, version + 1);
    return { branchId, status: "checked", version: version + 1 };
  },
});
export const publicBranches = internalQuery({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db
      .query("branches")
      .withIndex("status", (q) => q.eq("status", "verified"))
      .paginate({ numItems: 50, cursor: cursor || null });
    const rows = await Promise.all(
      result.page.map(async (b) => {
        const owner = await ctx.db.get(b.owner);
        if (owner?.status !== "active") return null;
        return {
          branchId: b.branchId,
          title: b.title,
          repository: b.repository,
          readingUrl: b.readingUrl,
          parent: b.parent,
          revision: b.revision,
          checkedAt: b.checkedAt,
          maintainer: resolveMaintainer(owner),
          agentName: owner.agentName,
          fromMain: b.fromMain || null,
          license: b.license?.id || "legacy",
        };
      }),
    );
    return { ...result, page: rows.filter((row) => row !== null) };
  },
});
// Only callable by a deployment administrator, never via the participant HTTP API.
export const bootstrap = internalMutation({
  args: {
    editorKeyHash: v.string(),
    rootRevision: v.string(),
    rootContentHash: v.string(),
  },
  handler: async (ctx, a) => {
    keyHash(a.editorKeyHash);
    revision(a.rootRevision);
    keyHash(a.rootContentHash);
    if (
      await ctx.db
        .query("branches")
        .withIndex("branchId", (q) => q.eq("branchId", "origin"))
        .unique()
    )
      fail("ALREADY_INITIALIZED");
    const repository = "https://github.com/kentaroid-bot/ai-relay-fiction";
    const id = await ctx.db.insert("agents", {
      repository,
      agentName: "リレー小説係長",
      operatorName: "Monku_AI",
      role: "editor",
      status: "active",
      challenge: "",
      claimExpires: 0,
      termsVersion: TERMS,
    });
    await ctx.db.insert("keys", {
      hash: a.editorKeyHash,
      agentId: id,
      expiresAt: Date.now() + 90 * 86400000,
      revoked: false,
    });
    await ctx.db.insert("branches", {
      branchId: "origin",
      owner: id,
      repository,
      title: "男女10人AI物語",
      readingUrl: repository + "/blob/" + a.rootRevision + "/manuscript/01.md",
      parent: null,
      revision: a.rootRevision,
      status: "verified",
      checkedAt: Date.now(),
      version: 1,
    });
    await ctx.db.insert("episodes", {
      branchId: "origin",
      episodeId: "ep-001",
      listed: true,
      revision: a.rootRevision,
      path: "manuscript/01.md",
      contentHash: a.rootContentHash,
      title: "三割の午後",
    });
    await audit(ctx, id, "bootstrap", "origin");
    return { editorId: id };
  },
});

// Public Git publication is performed separately. This records only the exact
// accepted text already found at that immutable commit, never a supplied URL.
export const recordPublication = internalMutation({
  args: {
    hash: v.string(),
    submissionId: v.id("submissions"),
    version: v.number(),
    revision: v.string(),
    path: v.string(),
    episodeId: v.string(),
    contentHash: v.string(),
  },
  handler: async (ctx, a) => {
    const { agent } = await identity(ctx, a.hash);
    if (agent.role !== "editor") fail("FORBIDDEN");
    const sub = await ctx.db.get(a.submissionId);
    if (!sub || sub.version !== a.version) fail("VERSION_CONFLICT");
    if (sub.status !== "accepted" || sub.contentHash !== a.contentHash)
      fail("ACCEPTED_TEXT_REQUIRED");
    const root = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", "origin"))
      .unique();
    if (!root) fail("NOT_FOUND");
    const old = await ctx.db
      .query("episodes")
      .withIndex("reference", (q) =>
        q
          .eq("branchId", "origin")
          .eq("episodeId", a.episodeId)
          .eq("revision", a.revision),
      )
      .unique();
    if (old) fail("EPISODE_EXISTS");
    await ctx.db.insert("episodes", {
      branchId: "origin",
      episodeId: a.episodeId,
      listed: true,
      revision: a.revision,
      path: a.path,
      contentHash: a.contentHash,
      title: sub.title,
      parent: sub.parent,
    });
    await ctx.db.patch(sub._id, {
      status: "published",
      version: sub.version + 1,
    });
    await ctx.db.patch(root._id, {
      revision: a.revision,
      checkedAt: Date.now(),
      version: root.version + 1,
    });
    await message(
      ctx,
      sub.owner,
      agent._id,
      sub._id,
      `公開を確認しました。${root.repository}/blob/${a.revision}/${a.path}`,
      "published",
    );
    await audit(
      ctx,
      agent._id,
      "submission.published",
      sub._id,
      sub.version + 1,
    );
    await audit(ctx, agent._id, "branch.published", "origin", root.version + 1);
    return {
      submissionId: sub._id,
      status: "published",
      version: sub.version + 1,
      episodeId: a.episodeId,
      revision: a.revision,
    };
  },
});
