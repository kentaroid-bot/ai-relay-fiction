import { v, type Infer } from "convex/values";
import { digest, fail, keyHash, revision, text } from "./policy";

export const REVIEW_POLICY = "relay-content-review-v1";
export const sourceDeclaration = v.object({
  title: v.string(),
  author: v.optional(v.string()),
  url: v.string(),
  licenseType: v.union(v.literal("CC0"), v.literal("PublicDomain")),
  licenseEvidenceUrl: v.string(),
  usedPortion: v.string(),
  sourceVersion: v.string(),
});
export const influenceDeclaration = v.object({
  title: v.string(),
  author: v.optional(v.string()),
  publishedYear: v.optional(v.number()),
  relationship: v.string(),
});
export const provenanceValidator = v.object({
  motivationSummary: v.string(),
  statedSources: v.array(sourceDeclaration),
  influences: v.optional(v.array(influenceDeclaration)),
});
export const targetValidator = v.object({
  lineageId: v.string(),
  branchId: v.string(),
  episodeId: v.string(),
  revision: v.string(),
  contentHash: v.string(),
  parent: v.union(
    v.object({
      branchId: v.string(),
      episodeId: v.string(),
      revision: v.string(),
    }),
    v.null(),
  ),
  worldHash: v.string(),
  provenanceHash: v.string(),
  policyVersion: v.string(),
});
const rightsState = v.union(
  v.literal("unverified"),
  v.literal("verified"),
  v.literal("insufficient"),
  v.literal("incompatible"),
);
export const reviewValidator = v.object({
  inspection: v.union(
    v.literal("pending"),
    v.literal("running"),
    v.literal("completed"),
    v.literal("blocked"),
    v.literal("failed"),
  ),
  rights: rightsState,
  decision: v.union(
    v.literal("pending"),
    v.literal("eligible"),
    v.literal("hold"),
    v.literal("rejected"),
  ),
  reason: v.string(),
  publicSummary: v.string(),
  comparisonCompleted: v.boolean(),
  worldComparisonCompleted: v.boolean(),
  declarationChecked: v.boolean(),
  queries: v.array(
    v.object({
      scope: v.union(v.literal("world"), v.literal("episode")),
      keywords: v.array(v.string()),
      searchedAt: v.number(),
      service: v.string(),
      outcome: v.union(v.literal("completed"), v.literal("failed")),
      candidateUrls: v.array(v.string()),
    }),
  ),
  candidates: v.array(
    v.object({
      title: v.string(),
      url: v.string(),
      comparedPortion: v.string(),
      analysis: v.string(),
      relationship: v.optional(
        v.union(
          v.literal("source_use"),
          v.literal("comparison"),
          v.literal("public_influence"),
        ),
      ),
      rights: rightsState,
      evidenceUrl: v.optional(v.string()),
      sourceVersion: v.optional(v.string()),
      licenseType: v.optional(
        v.union(v.literal("CC0"), v.literal("PublicDomain")),
      ),
    }),
  ),
  notChecked: v.array(v.string()),
});
export type Provenance = Infer<typeof provenanceValidator>;
export type ReviewTarget = Infer<typeof targetValidator>;
export type ContentReview = Infer<typeof reviewValidator>;
export function lineageId(value: unknown) {
  const id = text(value, 80, "LINEAGE_ID");
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(id)) fail("INVALID_LINEAGE_ID");
  return id;
}
function publicUrl(value: unknown) {
  const raw = text(value, 1000, "EVIDENCE_URL");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    fail("INVALID_EVIDENCE_URL");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    /[\u0000-\u0020]/.test(raw)
  )
    fail("INVALID_EVIDENCE_URL");
  // Stored references only. This module never fetches caller-supplied URLs.
  return raw;
}
export function validateProvenance(value: any): Provenance {
  if (
    !value ||
    !Array.isArray(value.statedSources) ||
    value.statedSources.length > 30 ||
    (value.influences !== undefined &&
      (!Array.isArray(value.influences) || value.influences.length > 30))
  )
    fail("PROVENANCE_REQUIRED");
  return {
    motivationSummary: text(value.motivationSummary, 2000, "MOTIVATION"),
    statedSources: value.statedSources.map((s: any) => {
      if (!s || !["CC0", "PublicDomain"].includes(s.licenseType))
        fail("SOURCE_LICENSE_NOT_SUPPORTED");
      return {
        title: text(s.title, 300, "SOURCE_TITLE"),
        ...(s.author === undefined
          ? {}
          : { author: text(s.author, 200, "SOURCE_AUTHOR") }),
        url: publicUrl(s.url),
        licenseType: s.licenseType,
        licenseEvidenceUrl: publicUrl(s.licenseEvidenceUrl),
        usedPortion: text(s.usedPortion, 2000, "USED_PORTION"),
        sourceVersion: text(s.sourceVersion, 300, "SOURCE_VERSION"),
      };
    }),
    ...(value.influences === undefined
      ? {}
      : {
          influences: value.influences.map((influence: any) => {
            if (
              !influence ||
              (influence.publishedYear !== undefined &&
                (!Number.isSafeInteger(influence.publishedYear) ||
                  influence.publishedYear < 0 ||
                  influence.publishedYear > 9999))
            )
              fail("INVALID_INFLUENCE");
            return {
              title: text(influence.title, 300, "INFLUENCE_TITLE"),
              ...(influence.author === undefined
                ? {}
                : {
                    author: text(influence.author, 200, "INFLUENCE_AUTHOR"),
                  }),
              ...(influence.publishedYear === undefined
                ? {}
                : { publishedYear: influence.publishedYear }),
              relationship: text(
                influence.relationship,
                2000,
                "INFLUENCE_RELATIONSHIP",
              ),
            };
          }),
        }),
  };
}
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
}
export const fingerprint = (value: unknown) => digest(canonical(value));
export function validateTarget(t: ReviewTarget) {
  lineageId(t.lineageId);
  revision(t.revision);
  for (const hash of [t.contentHash, t.worldHash, t.provenanceHash])
    keyHash(hash);
  text(t.branchId, 80, "BRANCH_ID");
  text(t.episodeId, 80, "EPISODE_ID");
  if (t.parent) {
    revision(t.parent.revision);
    text(t.parent.branchId, 80, "BRANCH_ID");
    text(t.parent.episodeId, 80, "EPISODE_ID");
  }
  if (t.policyVersion !== REVIEW_POLICY) fail("REVIEW_POLICY_MISMATCH");
}
export function validateReview(r: ContentReview) {
  if (
    !r ||
    !["pending", "running", "completed", "blocked", "failed"].includes(
      r.inspection,
    ) ||
    !["unverified", "verified", "insufficient", "incompatible"].includes(
      r.rights,
    ) ||
    !["pending", "eligible", "hold", "rejected"].includes(r.decision) ||
    !Array.isArray(r.queries) ||
    !Array.isArray(r.candidates) ||
    !Array.isArray(r.notChecked) ||
    typeof r.comparisonCompleted !== "boolean" ||
    typeof r.worldComparisonCompleted !== "boolean" ||
    typeof r.declarationChecked !== "boolean"
  )
    fail("INVALID_CONTENT_REVIEW");
  text(r.reason, 4000, "REVIEW_REASON");
  text(r.publicSummary, 1000, "PUBLIC_SUMMARY");
  if (
    r.queries.length > 50 ||
    r.candidates.length > 50 ||
    r.notChecked.length > 30
  )
    fail("REVIEW_TOO_LARGE");
  for (const q of r.queries) {
    if (
      !q ||
      !Array.isArray(q.keywords) ||
      !Array.isArray(q.candidateUrls) ||
      !["world", "episode"].includes(q.scope) ||
      !["completed", "failed"].includes(q.outcome) ||
      !q.keywords.length ||
      q.keywords.length > 6 ||
      !Number.isFinite(q.searchedAt) ||
      q.searchedAt <= 0
    )
      fail("INVALID_SEARCH_LOG");
    q.keywords.forEach((k) => text(k, 100, "SEARCH_KEYWORD"));
    text(q.service, 100, "SEARCH_SERVICE");
    if (q.candidateUrls.length > 30) fail("REVIEW_TOO_LARGE");
    q.candidateUrls.forEach(publicUrl);
  }
  for (const c of r.candidates) {
    if (!c) fail("INVALID_CONTENT_REVIEW");
    if (
      c.relationship !== undefined &&
      !["source_use", "comparison", "public_influence"].includes(c.relationship)
    )
      fail("INVALID_CONTENT_REVIEW");
    if (
      !["unverified", "verified", "insufficient", "incompatible"].includes(
        c.rights,
      )
    )
      fail("INVALID_CONTENT_REVIEW");
    text(c.title, 300, "SOURCE_TITLE");
    publicUrl(c.url);
    text(c.comparedPortion, 2000, "COMPARED_PORTION");
    text(c.analysis, 4000, "COMPARISON");
    if (
      c.rights === "verified" &&
      (!c.evidenceUrl ||
        !c.sourceVersion ||
        !["CC0", "PublicDomain"].includes(c.licenseType || ""))
    )
      fail("RIGHTS_EVIDENCE_REQUIRED");
    if (c.evidenceUrl) publicUrl(c.evidenceUrl);
    if (c.sourceVersion) text(c.sourceVersion, 300, "SOURCE_VERSION");
  }
  r.notChecked.forEach((x) => text(x, 300, "REVIEW_LIMIT"));
  if (
    r.decision === "eligible" &&
    (r.inspection !== "completed" ||
      r.rights !== "verified" ||
      !r.comparisonCompleted ||
      !r.worldComparisonCompleted ||
      !r.declarationChecked ||
      !r.queries.length ||
      !["world", "episode"].every((scope) =>
        r.queries.some((q) => q.scope === scope && q.outcome === "completed"),
      ) ||
      r.queries.some((q) => q.outcome !== "completed") ||
      r.candidates.some(
        (c) =>
          (c.relationship === undefined || c.relationship === "source_use") &&
          c.rights !== "verified",
      ))
  )
    fail("CONTENT_REVIEW_INCOMPLETE");
}
