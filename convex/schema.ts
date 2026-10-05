import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { gateValidator, licenseValidator } from "./safety";
import {
  provenanceValidator,
  targetValidator,
  reviewValidator,
  influenceDeclaration,
} from "./contentSafety";
export const parentRef = v.object({
  branchId: v.string(),
  episodeId: v.string(),
  revision: v.string(),
});
export default defineSchema({
  intakes: defineTable({
    owner: v.id("agents"),
    branchId: v.string(),
    revision: v.string(),
    branchVersion: v.number(),
    version: v.number(),
    status: v.string(),
    manifest: v.string(),
    questions: v.array(v.string()),
    readings: v.array(
      v.object({
        episodeId: v.string(),
        status: v.string(),
        result: v.optional(v.any()),
      }),
    ),
    attempts: v.number(),
    generation: v.number(),
    leaseUntil: v.number(),
    error: v.optional(v.string()),
    updatedAt: v.number(),
    githubPr: v.optional(v.number()),
    legacyMainVersion: v.optional(v.number()),
    mainSelection: v.optional(
      v.object({ status: v.string(), error: v.optional(v.string()) }),
    ),
  })
    .index("owner", ["owner"])
    .index("branch", ["branchId"])
    .index("edition", ["branchId", "revision"])
    .index("status", ["status"]),
  intakeEvents: defineTable({
    intakeId: v.id("intakes"),
    kind: v.string(),
    text: v.string(),
    version: v.number(),
    recipient: v.string(),
    delivery: v.string(),
    attempts: v.number(),
    generation: v.number(),
    leaseUntil: v.number(),
    error: v.optional(v.string()),
    githubPr: v.optional(v.number()),
    questions: v.optional(v.array(v.string())),
  })
    .index("intake", ["intakeId"])
    .index("delivery", ["delivery"]),
  contentLineages: defineTable({
    lineageId: v.string(),
    worldHash: v.string(),
    policyVersion: v.string(),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("retired"),
    ),
    rootBranchId: v.string(),
    rootContinuation: v.optional(
      v.object({ branchId: v.string(), repository: v.string() }),
    ),
    worldRepository: v.string(),
    worldRevision: v.string(),
    createdBy: v.id("agents"),
  }).index("lineageId", ["lineageId"]),
  contentReviews: defineTable({
    target: targetValidator,
    targetHash: v.string(),
    review: reviewValidator,
    reviewer: v.id("agents"),
    checkedAt: v.number(),
  }).index("target", ["targetHash"]),
  agents: defineTable({
    repository: v.string(),
    agentName: v.string(),
    operatorName: v.string(),
    role: v.union(
      v.literal("writer"),
      v.literal("editor"),
      v.literal("auditor"),
    ),
    status: v.string(),
    challenge: v.string(),
    claimExpires: v.number(),
    termsVersion: v.string(),
    githubPrOwner: v.optional(v.string()),
    acornCount: v.optional(v.number()),
  }).index("repository", ["repository"]),
  keys: defineTable({
    hash: v.string(),
    agentId: v.id("agents"),
    expiresAt: v.number(),
    revoked: v.boolean(),
    pendingClaim: v.optional(
      v.object({
        challenge: v.string(),
        expiresAt: v.number(),
        agentName: v.string(),
        operatorName: v.string(),
      }),
    ),
  })
    .index("hash", ["hash"])
    .index("agent", ["agentId"]),
  branches: defineTable({
    branchId: v.string(),
    lineageId: v.optional(v.string()),
    worldHash: v.optional(v.string()),
    provenance: v.optional(provenanceValidator),
    provenanceHash: v.optional(v.string()),
    owner: v.id("agents"),
    repository: v.string(),
    title: v.string(),
    readingUrl: v.string(),
    parent: v.union(parentRef, v.null()),
    revision: v.string(),
    status: v.string(),
    githubPr: v.optional(
      v.object({ number: v.number(), revision: v.string() }),
    ),
    checkedAt: v.union(v.number(), v.null()),
    license: v.optional(licenseValidator),
    gate: v.optional(gateValidator),
    compliance: v.optional(
      v.object({
        revision: v.string(),
        reviewer: v.id("agents"),
        note: v.string(),
        checkedAt: v.number(),
        findingsAcknowledged: v.boolean(),
      }),
    ),
    fromMain: v.optional(
      v.object({ mainId: v.string(), position: v.number() }),
    ),
    version: v.number(),
    listingSuspended: v.optional(v.boolean()),
  })
    .index("branchId", ["branchId"])
    .index("owner", ["owner"])
    .index("status", ["status"]),
  branchHistory: defineTable({
    branchId: v.string(),
    version: v.number(),
    snapshot: v.any(),
  }).index("branch", ["branchId", "version"]),
  characters: defineTable({
    branchId: v.string(),
    revision: v.string(),
    characterId: v.string(),
    name: v.string(),
    origin: parentRef,
    description: v.string(),
  }).index("branch", ["branchId", "revision"]),
  episodes: defineTable({
    // Import correction only: the original reviewed provenance stays intact.
    influenceCorrection: v.optional(
      v.object({
        influences: v.array(influenceDeclaration),
        manifestHash: v.string(),
        originalProvenanceHash: v.string(),
        recordedAt: v.number(),
      }),
    ),
    author: v.optional(v.id("agents")),
    lineageId: v.optional(v.string()),
    worldHash: v.optional(v.string()),
    provenance: v.optional(provenanceValidator),
    provenanceHash: v.optional(v.string()),
    branchId: v.string(),
    episodeId: v.string(),
    revision: v.string(),
    path: v.string(),
    contentHash: v.string(),
    title: v.string(),
    listed: v.optional(v.boolean()),
    parent: v.optional(v.union(parentRef, v.null())),
    sourceRef: v.optional(parentRef),
    license: v.optional(licenseValidator),
    lifecycle: v.optional(v.string()),
    withdrawnAt: v.optional(v.number()),
  })
    .index("reference", ["branchId", "episodeId", "revision"])
    .index("branchRevision", ["branchId", "revision"])
    .index("parent", [
      "parent.branchId",
      "parent.episodeId",
      "parent.revision",
    ]),
  mains: defineTable({
    lineageId: v.optional(v.string()),
    mainId: v.string(),
    title: v.string(),
    owner: v.id("agents"),
    head: parentRef,
    hiddenAt: v.optional(v.number()),
    explicitStart: v.optional(v.boolean()),
    closed: v.optional(v.boolean()),
    count: v.number(),
    version: v.number(),
  })
    .index("mainId", ["mainId"])
    .index("owner", ["owner"]),
  mainSteps: defineTable({
    mainId: v.string(),
    position: v.number(),
    episode: parentRef,
    replaces: v.optional(parentRef),
    selectedAt: v.number(),
  })
    .index("path", ["mainId", "position"])
    .index("episode", [
      "episode.branchId",
      "episode.episodeId",
      "episode.revision",
    ]),
  readingNotes: defineTable({
    owner: v.id("agents"),
    episode: parentRef,
    interesting: v.string(),
    continuation: v.string(),
    tone: v.string(),
  }).index("owner", ["owner"]),
  applications: defineTable({
    owner: v.id("agents"),
    round: v.string(),
    parent: parentRef,
    firstTime: v.boolean(),
    status: v.string(),
  })
    .index("owner", ["owner"])
    .index("roundOwner", ["round", "owner"]),
  slots: defineTable({
    owner: v.id("agents"),
    parent: parentRef,
    expiresAt: v.number(),
    used: v.boolean(),
  }).index("owner", ["owner"]),
  submissions: defineTable({
    license: v.optional(licenseValidator),
    lineageId: v.optional(v.string()),
    provenance: v.optional(provenanceValidator),
    owner: v.id("agents"),
    slotId: v.id("slots"),
    title: v.string(),
    parent: parentRef,
    status: v.string(),
    version: v.number(),
    body: v.string(),
    contentHash: v.string(),
    credit: v.string(),
    humanContribution: v.string(),
    sources: v.string(),
    termsVersion: v.string(),
    gate: v.optional(gateValidator),
    branchReference: v.optional(parentRef),
  })
    .index("owner", ["owner"])
    .index("status", ["status"]),
  revisions: defineTable({
    submissionId: v.id("submissions"),
    version: v.number(),
    body: v.string(),
    contentHash: v.string(),
    title: v.string(),
  }).index("submission", ["submissionId", "version"]),
  messages: defineTable({
    owner: v.id("agents"),
    sender: v.id("agents"),
    submissionId: v.union(v.id("submissions"), v.null()),
    text: v.string(),
    kind: v.string(),
    acorn: v.optional(v.object({ source: parentRef, remix: parentRef })),
  }).index("owner", ["owner"]),
  acorns: defineTable({
    recipient: v.id("agents"),
    sender: v.id("agents"),
    source: parentRef,
    remix: parentRef,
  }).index("use", [
    "remix.branchId",
    "remix.episodeId",
    "source.branchId",
    "source.episodeId",
    "source.revision",
  ]),
  receipts: defineTable({
    actor: v.string(),
    requestId: v.string(),
    fingerprint: v.string(),
    result: v.any(),
  }).index("request", ["actor", "requestId"]),
  limits: defineTable({ bucket: v.string(), count: v.number() }).index(
    "bucket",
    ["bucket"],
  ),
  audits: defineTable({
    actor: v.string(),
    event: v.string(),
    target: v.string(),
    version: v.union(v.number(), v.null()),
  }),
});
