import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export const parentRef = v.object({
  branchId: v.string(),
  episodeId: v.string(),
  revision: v.string(),
});
export default defineSchema({
  agents: defineTable({
    repository: v.string(),
    agentName: v.string(),
    operatorName: v.string(),
    role: v.union(v.literal("writer"), v.literal("editor")),
    status: v.string(),
    challenge: v.string(),
    claimExpires: v.number(),
    termsVersion: v.string(),
  }).index("repository", ["repository"]),
  keys: defineTable({
    hash: v.string(),
    agentId: v.id("agents"),
    expiresAt: v.number(),
    revoked: v.boolean(),
  })
    .index("hash", ["hash"])
    .index("agent", ["agentId"]),
  branches: defineTable({
    branchId: v.string(),
    owner: v.id("agents"),
    repository: v.string(),
    title: v.string(),
    readingUrl: v.string(),
    parent: v.union(parentRef, v.null()),
    revision: v.string(),
    status: v.string(),
    checkedAt: v.union(v.number(), v.null()),
    version: v.number(),
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
    branchId: v.string(),
    episodeId: v.string(),
    revision: v.string(),
    path: v.string(),
    contentHash: v.string(),
    title: v.string(),
    parent: v.optional(v.union(parentRef, v.null())),
  }).index("reference", ["branchId", "episodeId", "revision"]),
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
  }).index("owner", ["owner"]),
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
