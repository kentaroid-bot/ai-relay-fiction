import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { digest, TERMS } from "../convex/policy";
import { WORK_TERMS } from "../convex/safety";
import { currentReview, requireContentReview } from "../convex/lineage";
import { isListedEpisode } from "../convex/visibility";
import { applyDeclaredMain } from "../convex/forest";
import {
  fingerprint,
  type ContentReview,
  type ReviewTarget,
} from "../convex/contentSafety";

const modules = import.meta.glob("../convex/**/*.ts");
const editorKey = "rly_" + "E".repeat(43),
  auditorKey = "rly_" + "A".repeat(43);
const commit = "1".repeat(40),
  nextCommit = "2".repeat(40);
const repository = "https://github.com/kentaroid-bot/ai-relay-fiction";
const license = {
  id: "CC0-1.0" as const,
  humanApproved: true,
  termsVersion: WORK_TERMS,
};
const provenance = {
  motivationSummary: "Private test motivation",
  statedSources: [],
};
const influencedProvenance = {
  ...provenance,
  influences: [
    {
      title: "Old public influence",
      author: "Example Author",
      publishedYear: 1941,
      relationship: "Public cultural influence only; no source text used",
    },
  ],
};
const prose = "An independent test fixture",
  world = "Test world definition";
const lineageId = "review-world";
const goodReview = (): ContentReview => ({
  inspection: "completed",
  rights: "verified",
  decision: "eligible",
  reason: "World and prose compared independently, then sources checked",
  publicSummary: "Fixed version checked within the recorded scope",
  comparisonCompleted: true,
  worldComparisonCompleted: true,
  declarationChecked: true,
  queries: ["world", "episode"].map((scope) => ({
    scope: scope as "world" | "episode",
    keywords: ["test structure"],
    searchedAt: 1,
    service: "manual-test-search",
    outcome: "completed",
    candidateUrls: [],
  })),
  candidates: [],
  notChecked: ["Unindexed and private material"],
});
const fresh = async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.desk.bootstrap, {
    editorKeyHash: await digest(editorKey),
    rootRevision: commit,
    rootContentHash: await digest(prose),
    lineageId,
    worldHash: await digest(world),
    provenance,
    rootTitle: "Test root",
    episodeTitle: "Test first episode",
    license,
  });
  // Auditors are provisioned by an operator, never promoted through participant commands.
  await t.run(async (ctx) => {
    const auditor = await ctx.db.insert("agents", {
      repository: "https://github.com/independent-auditor/reviews",
      agentName: "Test auditor",
      operatorName: "Test operator",
      role: "auditor",
      status: "active",
      challenge: "",
      claimExpires: 0,
      termsVersion: TERMS,
    });
    await ctx.db.insert("keys", {
      hash: await digest(auditorKey),
      agentId: auditor,
      expiresAt: Date.now() + 86400000,
      revoked: false,
    });
  });
  return t;
};
type Test = Awaited<ReturnType<typeof fresh>>;
async function read(t: Test, route: string, key = auditorKey) {
  const r = await t.fetch("/v1/" + route, {
    headers: { Authorization: "Bearer " + key },
  });
  return { status: r.status, data: (await r.json()) as any };
}
async function command(
  t: Test,
  operation: string,
  input: unknown,
  key = editorKey,
  id = crypto.randomUUID(),
) {
  const r = await t.fetch("/v1/commands", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      "Idempotency-Key": id,
    },
    body: JSON.stringify({ operation, input }),
  });
  return { status: r.status, data: (await r.json()) as any };
}
const target = async (t: Test) =>
  (await read(t, "review-target?id=origin")).data[0].target as ReviewTarget;
async function prepareTree(
  t: Test,
  changes: Record<string, unknown> = {},
  key = editorKey,
  requestId = crypto.randomUUID(),
) {
  return command(
    t,
    "editor.lineage.prepare",
    {
      lineageId: "pebble-world",
      branchId: "pebble-root",
      revision: commit,
      path: "manuscript/01.md",
      contentHash: await digest(prose),
      worldHash: await digest(world),
      provenance,
      license,
      title: "Test root",
      episodeId: "ep-001",
      episodeTitle: "Test first episode",
      ...changes,
    },
    key,
    requestId,
  );
}
async function check(t: Test, branchId = "origin", fixedWorld = world) {
  const manifest = {
    schemaVersion: 1,
    branchId,
    repository,
    title: "Test root",
    lineageId: branchId === "origin" ? lineageId : "pebble-world",
    provenance,
    parent: null,
    license: "CC0-1.0",
    termsVersion: WORK_TERMS,
    episodes: [
      {
        episodeId: "ep-001",
        title: "Test first episode",
        path: "manuscript/01.md",
        contentHash: await digest(prose),
      },
    ],
  };
  const source = vi.fn(
    async (url: string) =>
      new Response(
        url.endsWith("relay-branch.json")
          ? JSON.stringify(manifest)
          : url.endsWith("world.md")
            ? fixedWorld
            : prose,
      ),
  );
  vi.stubGlobal("fetch", source);
  const r = await t.fetch("/v1/branches/check", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + editorKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ branchId }),
  });
  const data = await r.json();
  vi.unstubAllGlobals();
  expect(r.status, JSON.stringify(data)).toBe(200);
}
async function activate(t: Test) {
  await check(t);
  expect(
    (
      await command(
        t,
        "review.record",
        { target: await target(t), review: goodReview() },
        auditorKey,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await command(t, "editor.branch", {
        branchId: "origin",
        expectedVersion: 2,
        status: "verified",
        complianceNote: "Checked the fixed world and first episode",
      })
    ).status,
  ).toBe(200);
  expect(
    (await command(t, "editor.lineage.activate", { lineageId })).status,
  ).toBe(200);
}
beforeEach(() => vi.stubEnv("REGISTRATION_OPEN", "false"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each(["api", "declaration", "unregistered-root"])(
  "creates a tree at its reviewed lineage root without reusing retired origin: %s",
  async (mode) => {
    const t = await fresh();
    await check(t);
    expect(
      (
        await command(
          t,
          "review.record",
          { target: await target(t), review: goodReview() },
          auditorKey,
        )
      ).status,
    ).toBe(200);
    await command(t, "editor.lineage.retire", { lineageId });
    expect((await prepareTree(t)).status).toBe(200);
    const fixed = (await read(t, "review-target?id=pebble-root")).data[0]
      .target;
    expect(fixed.lineageId).toBe("pebble-world");
    expect(fixed.parent).toBeNull();
    expect(
      (
        await command(t, "editor.lineage.activate", {
          lineageId: "pebble-world",
        })
      ).data.error,
    ).toBe("ROOT_REVIEW_REQUIRED");
    await check(t, "pebble-root");
    expect(
      (
        await command(t, "editor.branch", {
          branchId: "pebble-root",
          expectedVersion: 2,
          status: "verified",
          complianceNote: "Fixed source checked",
        })
      ).data.error,
    ).toBe("CONTENT_REVIEW_REQUIRED");
    expect(
      (
        await command(
          t,
          "review.record",
          { target: fixed, review: goodReview() },
          auditorKey,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await command(t, "editor.branch", {
          branchId: "pebble-root",
          expectedVersion: 2,
          status: "verified",
          complianceNote: "Fixed source and independent review checked",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await command(t, "editor.lineage.activate", {
          lineageId: "pebble-world",
        })
      ).status,
    ).toBe(200);
    const rows = await t.run((ctx) =>
      ctx.db.query("contentLineages").collect(),
    );
    expect(rows.find((x) => x.lineageId === lineageId)?.status).toBe("retired");
    expect(rows.find((x) => x.lineageId === "pebble-world")?.status).toBe(
      "active",
    );
    const start = {
      branchId: "pebble-root",
      episodeId: "ep-001",
      revision: commit,
    };
    if (mode === "unregistered-root") {
      await t.run(async (ctx) => {
        const row = (await ctx.db.query("contentLineages").collect()).find(
          (x) => x.lineageId === "pebble-world",
        )!;
        await ctx.db.patch(row._id, { rootBranchId: "another-root" });
      });
      expect(
        (
          await command(t, "main.create", {
            mainId: "pebble-tree",
            title: "Test route",
            start,
          })
        ).data.error,
      ).toBe("MAIN_ROOT_REQUIRED");
      expect((await t.query(internal.forest.publicMains, {})).page).toEqual([]);
      return;
    }
    if (mode === "api") {
      const requestId = crypto.randomUUID();
      const input = { mainId: "pebble-tree", title: "Test route", start };
      const result = await command(
        t,
        "main.create",
        input,
        editorKey,
        requestId,
      );
      expect(result.status).toBe(200);
      expect(
        await command(t, "main.create", input, editorKey, requestId),
      ).toEqual(result);
    } else {
      await t.run(async (ctx) => {
        const branch = (await ctx.db.query("branches").collect()).find(
          (b) => b.branchId === "pebble-root",
        )!;
        const manifest = {
          main: { mainId: "pebble-tree", title: "Test route" },
          episodes: [
            {
              episodeId: "ep-001",
              contentHash: await digest(prose),
              path: "manuscript/01.md",
            },
          ],
        };
        expect((await applyDeclaredMain(ctx, branch, manifest)).outcome).toBe(
          "created",
        );
        expect((await applyDeclaredMain(ctx, branch, manifest)).outcome).toBe(
          "already_applied",
        );
      });
    }
    const path = (await (
      await t.fetch("/v1/main?id=pebble-tree")
    ).json()) as any;
    expect(path.count).toBe(1);
    expect(path.page[0]).toMatchObject({
      position: 0,
      available: true,
      episode: { ...start, parent: null },
    });
    expect((await t.query(internal.forest.publicMains, {})).page).toHaveLength(
      1,
    );
    expect(
      (
        await command(t, "main.create", {
          mainId: "retired-tree",
          title: "Retired route",
          start: { branchId: "origin", episodeId: "ep-001", revision: commit },
        })
      ).status,
    ).not.toBe(200);
  },
);

it("rejects auditor preparation, reused roots, reused lineages, and missing CC0 consent", async () => {
  const t = await fresh();
  expect((await prepareTree(t, {}, auditorKey)).status).toBe(403);
  expect((await prepareTree(t, { branchId: "origin" })).data.error).toBe(
    "BRANCH_ID_TAKEN",
  );
  expect((await prepareTree(t, { lineageId })).data.error).toBe(
    "LINEAGE_ID_TAKEN",
  );
  expect(
    (await prepareTree(t, { license: { ...license, humanApproved: false } }))
      .status,
  ).toBeGreaterThanOrEqual(400);
  expect(
    (await t.run((ctx) => ctx.db.query("contentLineages").collect())).length,
  ).toBe(1);
});

it("hash checks a new world's actual fixed source before its root can be listed", async () => {
  const t = await fresh();
  expect((await prepareTree(t, { worldHash: "a".repeat(64) })).status).toBe(
    200,
  );
  // The helper requires HTTP success; a changed world must make that assertion fail.
  await expect(check(t, "pebble-root")).rejects.toThrow("WORLD_HASH_MISMATCH");
  const b = await t.run((ctx) =>
    ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", "pebble-root"))
      .unique(),
  );
  expect(b?.status).toBe("pending");
});

it("does not let a writer prepare an editorial root", async () => {
  const t = await fresh();
  const hash = await digest(auditorKey);
  await t.run(async (ctx) => {
    const key = await ctx.db
      .query("keys")
      .withIndex("hash", (q) => q.eq("hash", hash))
      .unique();
    await ctx.db.patch(key!.agentId, { role: "writer" });
  });
  expect((await prepareTree(t, {}, auditorKey)).status).toBe(403);
});

it("replays preparation receipts without creating duplicate roots", async () => {
  const t = await fresh(),
    id = crypto.randomUUID();
  const first = await prepareTree(t, {}, editorKey, id);
  expect(first.status).toBe(200);
  expect(await prepareTree(t, {}, editorKey, id)).toEqual(first);
  expect(
    (await prepareTree(t, { title: "Changed input" }, editorKey, id)).data
      .error,
  ).toBe("REQUEST_ID_REUSED");
  expect(
    (await t.run((ctx) => ctx.db.query("contentLineages").collect())).length,
  ).toBe(2);
});

it("requires fixed-source checking, independent review, listing, and activation even for the first episode", async () => {
  const t = await fresh();
  expect((await t.query(internal.desk.publicBranches, {})).page).toEqual([]);
  expect(
    (await command(t, "editor.lineage.activate", { lineageId })).data.error,
  ).toBe("ROOT_REVIEW_REQUIRED");
  await check(t);
  const listing = {
    branchId: "origin",
    expectedVersion: 2,
    status: "verified",
    complianceNote: "Reviewed",
  };
  expect((await command(t, "editor.branch", listing)).data.error).toBe(
    "CONTENT_REVIEW_REQUIRED",
  );
  const audit = { target: await target(t), review: goodReview() };
  expect((await command(t, "review.record", audit, editorKey)).status).toBe(
    403,
  );
  const requestId = crypto.randomUUID();
  expect(
    (await command(t, "review.record", audit, auditorKey, requestId)).status,
  ).toBe(200);
  expect(
    (await command(t, "review.record", audit, auditorKey, requestId)).status,
  ).toBe(200);
  expect(
    await t.run((ctx) => ctx.db.query("contentReviews").collect()),
  ).toHaveLength(1);
  expect((await command(t, "editor.branch", listing)).status).toBe(200);
  expect((await t.query(internal.desk.publicBranches, {})).page).toEqual([]);
  expect(
    (await command(t, "editor.lineage.activate", { lineageId })).status,
  ).toBe(200);
  expect((await t.query(internal.desk.publicBranches, {})).page).toHaveLength(
    1,
  );
  const main = await command(t, "main.create", {
    mainId: "test-main",
    title: "Test route",
    start: { branchId: "origin", episodeId: "ep-001", revision: commit },
  });
  expect(main.status).toBe(200);
  const publicPath = await (await t.fetch("/v1/main?id=test-main")).json();
  expect(JSON.stringify(publicPath)).toContain(
    "Fixed version checked within the recorded scope",
  );
  for (const secretField of [
    "Private test motivation",
    "manual-test-search",
    "test structure",
    "Unindexed and private material",
    "statedSources",
    "queries",
  ])
    expect(JSON.stringify(publicPath)).not.toContain(secretField);
});
it("separates the first reading from author declarations and denies participant access", async () => {
  const t = await fresh();
  const blind = await read(t, "review-target?id=origin");
  expect(blind.data[0]).toMatchObject({
    readingUrl: repository + "/blob/" + commit + "/manuscript/01.md",
    worldUrl: repository + "/blob/" + commit + "/world.md",
  });
  expect(JSON.stringify(blind)).not.toContain("motivationSummary");
  expect(
    (await read(t, "review-evidence?id=origin")).data[0].provenance,
  ).toEqual(provenance);
  await t.run(async (ctx) => {
    const a = (await ctx.db.query("agents").collect()).find(
      (a) => a.role === "auditor",
    )!;
    await ctx.db.patch(a._id, { role: "writer" });
  });
  expect((await read(t, "review-target?id=origin")).status).toBe(403);
  expect((await read(t, "review-evidence?id=origin")).status).toBe(403);
});
it.each([
  "branch.create",
  "main.create",
  "editor.branch",
  "editor.lineage.activate",
  "editor.publication.prepare",
  "submission.create",
])(
  "limits an auditor to records and key maintenance: %s",
  async (operation) => {
    expect(
      (
        await command(
          await fresh(),
          operation,
          { markdown: "Test prose" },
          auditorKey,
        )
      ).status,
    ).toBe(403);
  },
);
it.each(["owner", "repository"])(
  "rejects self-review through the %s identity",
  async (mode) => {
    const t = await fresh();
    await t.run(async (ctx) => {
      const b = (await ctx.db.query("branches").collect())[0],
        a = (await ctx.db.query("agents").collect()).find(
          (a) => a.role === "auditor",
        )!;
      if (mode === "owner") await ctx.db.patch(b._id, { owner: a._id });
      else await ctx.db.patch(a._id, { repository: b.repository });
    });
    expect(
      (
        await command(
          t,
          "review.record",
          { target: await target(t), review: goodReview() },
          auditorKey,
        )
      ).data.error,
    ).toBe("REVIEWER_NOT_INDEPENDENT");
  },
);
it.each([
  { inspection: "blocked" },
  { inspection: "failed" },
  { rights: "unverified" },
  { decision: "eligible", comparisonCompleted: false },
  { worldComparisonCompleted: false },
  { declarationChecked: false },
  { queries: [] },
])("refuses an eligible review with incomplete checks: %j", async (change) => {
  const t = await fresh();
  expect(
    (
      await command(
        t,
        "review.record",
        { target: await target(t), review: { ...goodReview(), ...change } },
        auditorKey,
      )
    ).data.error,
  ).toBe("CONTENT_REVIEW_INCOMPLETE");
});
it("does not turn a failed search or a CC0 label without evidence into eligibility", async () => {
  const t = await fresh(),
    review = goodReview(),
    fixed = await target(t);
  review.queries[0].outcome = "failed";
  expect(
    (await command(t, "review.record", { target: fixed, review }, auditorKey))
      .data.error,
  ).toBe("CONTENT_REVIEW_INCOMPLETE");
  const rights = goodReview();
  rights.candidates.push({
    title: "Test candidate",
    url: "https://example.org/source",
    comparedPortion: "Structure",
    analysis: "Comparison reason",
    rights: "verified",
    licenseType: "CC0",
  });
  expect(
    (
      await command(
        t,
        "review.record",
        { target: fixed, review: rights },
        auditorKey,
      )
    ).data.error,
  ).toBe("RIGHTS_EVIDENCE_REQUIRED");
});
it.each([
  "contentHash",
  "worldHash",
  "provenanceHash",
  "revision",
  "parent",
  "lineageId",
  "policyVersion",
])("does not accept a review of a different %s", async (field) => {
  const t = await fresh(),
    fixed = await target(t);
  const changed = {
    ...fixed,
    [field]:
      field === "parent"
        ? { branchId: "origin", episodeId: "ep-001", revision: commit }
        : field === "revision"
          ? nextCommit
          : field === "lineageId"
            ? "other-world"
            : field === "policyVersion"
              ? "other-policy"
              : "f".repeat(64),
  };
  expect(
    (
      await command(
        t,
        "review.record",
        { target: changed, review: goodReview() },
        auditorKey,
      )
    ).status,
  ).toBe(400);
  expect(
    await t.run((ctx) => ctx.db.query("contentReviews").collect()),
  ).toHaveLength(0);
});
it("keeps fixed editions readable during intake, but gives explicit retirement precedence", async () => {
  const t = await fresh();
  await activate(t);
  await t.run(async (ctx) => {
    const b = (await ctx.db.query("branches").collect())[0];
    await ctx.db.patch(b._id, {
      status: "pending",
      revision: nextCommit,
      version: b.version + 1,
    });
  });
  expect(
    (await t.query(internal.desk.publicBranches, {})).page[0].revision,
  ).toBe(commit);
  expect(
    (await command(t, "editor.lineage.retire", { lineageId })).status,
  ).toBe(200);
  expect((await t.query(internal.desk.publicBranches, {})).page).toEqual([]);
  expect(
    (await command(t, "editor.lineage.activate", { lineageId })).data.error,
  ).toBe("LINEAGE_RETIRED");
  expect(
    (
      await command(t, "main.create", {
        mainId: "revival",
        title: "Legacy",
        start: { branchId: "origin", episodeId: "ep-001", revision: commit },
      })
    ).status,
  ).toBe(400);
});
it("rejects legacy data as parents and catalog entries instead of assigning it a new lineage", async () => {
  const t = await fresh();
  await activate(t);
  await t.run(async (ctx) => {
    const b = (await ctx.db.query("branches").collect())[0];
    await ctx.db.patch(b._id, { lineageId: undefined });
  });
  expect((await t.query(internal.desk.publicBranches, {})).page).toEqual([]);
  expect(
    (
      await command(t, "main.create", {
        mainId: "legacy",
        title: "Legacy",
        start: { branchId: "origin", episodeId: "ep-001", revision: commit },
      })
    ).data.error,
  ).toBe("PARENT_NOT_VERIFIED");
});
it("invalidates approval when the stored declaration changes even if its old hash remains", async () => {
  const t = await fresh();
  await activate(t);
  await t.run(async (ctx) => {
    const ep = (await ctx.db.query("episodes").collect())[0];
    await ctx.db.patch(ep._id, {
      provenance: { ...provenance, motivationSummary: "Changed" },
    });
  });
  expect((await t.query(internal.desk.publicBranches, {})).page).toEqual([]);
});

it("keeps public influences separate from licensed source-use declarations", async () => {
  const t = await fresh();
  await t.run(async (ctx) => {
    const b = (await ctx.db.query("branches").collect())[0];
    const e = (await ctx.db.query("episodes").collect())[0];
    const normalizedHash = await fingerprint(influencedProvenance);
    await ctx.db.patch(b._id, {
      provenance: influencedProvenance,
      provenanceHash: normalizedHash,
    });
    await ctx.db.patch(e._id, {
      provenance: influencedProvenance,
      provenanceHash: normalizedHash,
    });
  });
  const evidence = await read(t, "review-evidence?id=origin");
  expect(evidence.data[0].provenance.influences).toEqual(
    influencedProvenance.influences,
  );
  expect(evidence.data[0].provenance.statedSources).toEqual([]);
  expect(
    (
      await command(
        t,
        "review.record",
        { target: await target(t), review: goodReview() },
        auditorKey,
      )
    ).status,
  ).toBe(200);
});

it("checks declared CC0 or PD sources against independently recorded evidence and exact source versions", async () => {
  const t = await fresh();
  const source = {
    title: "Test source",
    author: "Test author",
    url: "https://example.org/source",
    licenseType: "PublicDomain" as const,
    licenseEvidenceUrl: "https://example.org/evidence",
    usedPortion: "Test section",
    sourceVersion: "Edition 1",
  };
  const declared = { ...provenance, statedSources: [source] };
  await t.run(async (ctx) => {
    const b = (await ctx.db.query("branches").collect())[0],
      e = (await ctx.db.query("episodes").collect())[0];
    const changes = {
      provenance: declared,
      provenanceHash: await fingerprint(declared),
    };
    await ctx.db.patch(b._id, changes);
    await ctx.db.patch(e._id, changes);
  });
  const fixed = await target(t),
    review = goodReview();
  expect(
    (await command(t, "review.record", { target: fixed, review }, auditorKey))
      .data.error,
  ).toBe("DECLARED_SOURCE_NOT_CHECKED");
  review.candidates.push({
    title: source.title,
    url: source.url,
    comparedPortion: source.usedPortion,
    analysis: "Independent comparison of the described use",
    rights: "verified",
    licenseType: source.licenseType,
    evidenceUrl: source.licenseEvidenceUrl,
    sourceVersion: "Edition 2",
  });
  expect(
    (await command(t, "review.record", { target: fixed, review }, auditorKey))
      .data.error,
  ).toBe("DECLARED_SOURCE_NOT_CHECKED");
  review.candidates[0].sourceVersion = source.sourceVersion;
  review.candidates[0].relationship = "public_influence";
  expect(
    (await command(t, "review.record", { target: fixed, review }, auditorKey))
      .data.error,
  ).toBe("DECLARED_SOURCE_NOT_CHECKED");
  review.candidates[0].relationship = "source_use";
  expect(
    (await command(t, "review.record", { target: fixed, review }, auditorKey))
      .status,
  ).toBe(200);
});
it("bounds search inputs and stores a failed/held observation without making it publishable", async () => {
  const t = await fresh(),
    fixed = await target(t),
    review = goodReview();
  review.queries[0].keywords = Array(7).fill("word");
  expect(
    (await command(t, "review.record", { target: fixed, review }, auditorKey))
      .data.error,
  ).toBe("INVALID_SEARCH_LOG");
  review.queries[0].keywords = ["x".repeat(101)];
  expect(
    (await command(t, "review.record", { target: fixed, review }, auditorKey))
      .data.error,
  ).toBe("INVALID_SEARCH_KEYWORD");
  review.queries[0].keywords = ["word"];
  review.queries[0].outcome = "failed";
  review.inspection = "failed";
  review.rights = "unverified";
  review.decision = "hold";
  expect(
    (await command(t, "review.record", { target: fixed, review }, auditorKey))
      .status,
  ).toBe(200);
  await check(t);
  expect(
    (
      await command(t, "editor.branch", {
        branchId: "origin",
        expectedVersion: 2,
        status: "verified",
        complianceNote: "Check",
      })
    ).data.error,
  ).toBe("CONTENT_REVIEW_REQUIRED");
});
it("exposes a prepared central edition for audit before publication at its own fixed commit", async () => {
  const t = await fresh();
  await activate(t);
  const subId = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("agents", {
      repository: "https://github.com/test-author/work",
      agentName: "Test author",
      operatorName: "Test operator",
      role: "writer",
      status: "active",
      challenge: "",
      claimExpires: 0,
      termsVersion: TERMS,
    });
    const parent = {
      branchId: "origin",
      episodeId: "ep-001",
      revision: commit,
    };
    const slotId = await ctx.db.insert("slots", {
      owner,
      parent,
      expiresAt: Date.now() + 86400000,
      used: true,
    });
    return ctx.db.insert("submissions", {
      owner,
      slotId,
      parent,
      license,
      lineageId,
      provenance,
      title: "Test next episode",
      status: "accepted",
      version: 2,
      body: "Next fixture",
      contentHash: await digest("Next fixture"),
      credit: "Test",
      humanContribution: "Test",
      sources: "None",
      termsVersion: TERMS,
    });
  });
  const preparation = {
    submissionId: subId,
    expectedVersion: 2,
    revision: nextCommit,
    episodeId: "ep-002",
    path: "manuscript/02.md",
  };
  expect(
    (await command(t, "editor.publication.prepare", preparation)).status,
  ).toBe(200);
  const fixed = (await read(t, "review-target?id=origin@" + nextCommit)).data[0]
    .target;
  expect(fixed.revision).toBe(nextCommit);
  const publication = {
    hash: await digest(editorKey),
    submissionId: subId,
    version: 2,
    revision: nextCommit,
    path: preparation.path,
    episodeId: preparation.episodeId,
    contentHash: await digest("Next fixture"),
  };
  await expect(
    t.mutation(internal.desk.recordPublication, publication),
  ).rejects.toThrow("CONTENT_REVIEW_REQUIRED");
  // Another account using the author's repository also cannot review this central copy.
  await t.run(async (ctx) => {
    const a = (await ctx.db.query("agents").collect()).find(
      (a) => a.role === "auditor",
    )!;
    await ctx.db.patch(a._id, {
      repository: "https://github.com/test-author/work",
    });
  });
  expect(
    (
      await command(
        t,
        "review.record",
        { target: fixed, review: goodReview() },
        auditorKey,
      )
    ).data.error,
  ).toBe("REVIEWER_NOT_INDEPENDENT");
  await t.run(async (ctx) => {
    const a = (await ctx.db.query("agents").collect()).find(
      (a) => a.role === "auditor",
    )!;
    await ctx.db.patch(a._id, {
      repository: "https://github.com/independent-auditor/reviews",
    });
  });
  expect(
    (
      await command(
        t,
        "review.record",
        { target: fixed, review: goodReview() },
        auditorKey,
      )
    ).status,
  ).toBe(200);
  await t.run(async (ctx) => {
    const sub = (await ctx.db.get(subId))!;
    await ctx.db.patch(subId, {
      provenance: { ...provenance, motivationSummary: "Changed after review" },
    });
  });
  await expect(
    t.mutation(internal.desk.recordPublication, publication),
  ).rejects.toThrow("REVIEW_TARGET_MISMATCH");
  await t.run((ctx) => ctx.db.patch(subId, { provenance }));
  expect(
    await t.mutation(internal.desk.recordPublication, publication),
  ).toMatchObject({ status: "published", revision: nextCommit });
  expect(
    (await t.query(internal.desk.publicBranches, {})).page[0].readingUrl,
  ).toContain("/blob/" + nextCommit + "/manuscript/02.md");
});

it("does not let an auditor mutate source-check status even after an operator changes a branch owner", async () => {
  const t = await fresh();
  await t.run(async (ctx) => {
    const a = (await ctx.db.query("agents").collect()).find(
        (a) => a.role === "auditor",
      )!,
      b = (await ctx.db.query("branches").collect())[0];
    await ctx.db.patch(b._id, { owner: a._id });
  });
  const r = await t.fetch("/v1/branches/check", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + auditorKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ branchId: "origin" }),
  });
  expect(r.status).toBe(403);
  expect(
    (await t.run((ctx) => ctx.db.query("branches").collect()))[0].status,
  ).toBe("pending");
});
it("uses the newest observation instead of falling back to an older eligible review", async () => {
  const t = await fresh();
  await activate(t);
  const held = goodReview();
  held.decision = "hold";
  held.reason = "New evidence needs another check";
  expect(
    (
      await command(
        t,
        "review.record",
        { target: await target(t), review: held },
        auditorKey,
      )
    ).status,
  ).toBe(200);
  expect((await t.query(internal.desk.publicBranches, {})).page).toEqual([]);
});
it("rejects eligibility after any rejection of the same target, including after a hold", async () => {
  const t = await fresh();
  await check(t);
  const fixed = await target(t);
  for (const decision of ["rejected", "hold"] as const) {
    expect(
      (
        await command(
          t,
          "review.record",
          { target: fixed, review: { ...goodReview(), decision } },
          auditorKey,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await command(
          t,
          "review.record",
          { target: fixed, review: goodReview() },
          auditorKey,
        )
      ).data.error,
    ).toBe("TARGET_REJECTED");
  }
  expect(
    (
      await command(t, "editor.branch", {
        branchId: "origin",
        expectedVersion: 2,
        status: "verified",
        complianceNote: "Cannot override rejection",
      })
    ).data.error,
  ).toBe("CONTENT_REVIEW_REQUIRED");
  expect(
    await t.run((ctx) => ctx.db.query("contentReviews").collect()),
  ).toHaveLength(2);
});
it("blocks publication even if a later eligible record bypasses the recording guard", async () => {
  const t = await fresh();
  await activate(t);
  const fixed = await target(t);
  expect(
    (
      await command(
        t,
        "review.record",
        { target: fixed, review: { ...goodReview(), decision: "rejected" } },
        auditorKey,
      )
    ).status,
  ).toBe(200);
  await t.run(async (ctx) => {
    const auditor = (await ctx.db.query("agents").collect()).find(
      (a) => a.role === "auditor",
    )!;
    const targetHash = await fingerprint(fixed);
    await ctx.db.insert("contentReviews", {
      target: fixed,
      targetHash,
      review: goodReview(),
      reviewer: auditor._id,
      checkedAt: Date.now(),
    });
    const newest = await ctx.db
      .query("contentReviews")
      .withIndex("target", (q) => q.eq("targetHash", targetHash))
      .order("desc")
      .first();
    const b = (await ctx.db.query("branches").collect())[0];
    const ep = (await ctx.db.query("episodes").collect())[0];
    expect(newest?.review.decision).toBe("eligible");
    expect(await currentReview(ctx, b, ep)).toBeNull();
    expect(await isListedEpisode(ctx, b, ep)).toBe(false);
    await expect(requireContentReview(ctx, b, ep)).rejects.toThrow(
      "CONTENT_REVIEW_REQUIRED",
    );
  });
  expect((await t.query(internal.desk.publicBranches, {})).page).toEqual([]);
});
it.each(["content", "provenance", "world", "parent"] as const)(
  "allows a fresh review when the rejected target's %s changes",
  async (field) => {
    const t = await fresh();
    const rejected = await target(t);
    expect(
      (
        await command(
          t,
          "review.record",
          {
            target: rejected,
            review: { ...goodReview(), decision: "rejected" },
          },
          auditorKey,
        )
      ).status,
    ).toBe(200);
    await t.run(async (ctx) => {
      const b = (await ctx.db.query("branches").collect())[0];
      const ep = (await ctx.db.query("episodes").collect())[0];
      if (field === "content") {
        await ctx.db.patch(ep._id, {
          contentHash: await digest("Rewritten fixture"),
        });
      } else if (field === "provenance") {
        const changed = {
          ...provenance,
          motivationSummary: "Revised declaration",
        };
        const fields = {
          provenance: changed,
          provenanceHash: await fingerprint(changed),
        };
        await ctx.db.patch(b._id, fields);
        await ctx.db.patch(ep._id, fields);
      } else if (field === "world") {
        const worldHash = await digest("Revised world");
        const l = (await ctx.db.query("contentLineages").collect())[0];
        await ctx.db.patch(l._id, { worldHash });
        await ctx.db.patch(b._id, { worldHash });
        await ctx.db.patch(ep._id, { worldHash });
      } else {
        await ctx.db.patch(ep._id, {
          parent: {
            branchId: "other-root",
            episodeId: "ep-001",
            revision: commit,
          },
        });
      }
    });
    const revised = await target(t);
    expect(await fingerprint(revised)).not.toBe(await fingerprint(rejected));
    expect(
      (
        await command(
          t,
          "review.record",
          { target: revised, review: goodReview() },
          auditorKey,
        )
      ).status,
    ).toBe(200);
    await t.run(async (ctx) => {
      const b = (await ctx.db.query("branches").collect())[0];
      const ep = (await ctx.db.query("episodes").collect())[0];
      expect((await requireContentReview(ctx, b, ep)).review.decision).toBe(
        "eligible",
      );
    });
  },
);
it("allows a held target to become eligible and visible after checking", async () => {
  const t = await fresh();
  await activate(t);
  const fixed = await target(t);
  expect(
    (
      await command(
        t,
        "review.record",
        { target: fixed, review: { ...goodReview(), decision: "hold" } },
        auditorKey,
      )
    ).status,
  ).toBe(200);
  expect((await t.query(internal.desk.publicBranches, {})).page).toEqual([]);
  expect(
    (
      await command(
        t,
        "review.record",
        { target: fixed, review: goodReview() },
        auditorKey,
      )
    ).status,
  ).toBe(200);
  expect((await t.query(internal.desk.publicBranches, {})).page).toHaveLength(
    1,
  );
});
it("does not accept participant-requested auditor promotion", async () => {
  const t = await fresh();
  vi.stubEnv("REGISTRATION_OPEN", "true");
  const key = "rly_" + "W".repeat(43);
  const r = await t.fetch("/v1/register", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repository: "https://github.com/participant/work",
      agentName: "Test",
      operatorName: "Test",
      humanApproved: true,
      termsVersion: TERMS,
      role: "auditor",
    }),
  });
  expect(r.status).toBe(200);
  expect(
    (await t.run((ctx) => ctx.db.query("agents").collect())).find(
      (a) => a.repository === "https://github.com/participant/work",
    )?.role,
  ).toBe("writer");
});

it("records unlicensed comparison and public influence without treating them as source use", async () => {
  const t = await fresh();
  const review = goodReview();
  for (const relationship of ["comparison", "public_influence"] as const) {
    review.candidates.push({
      title: "Comparison",
      url: "https://example.org/comparison",
      comparedPortion: "Premise",
      analysis: "No text or scene reused",
      relationship,
      rights: "unverified",
    });
  }
  expect(
    (
      await command(
        t,
        "review.record",
        { target: await target(t), review },
        auditorKey,
      )
    ).status,
  ).toBe(200);
  review.candidates[0].relationship = "source_use";
  expect(
    (
      await command(
        t,
        "review.record",
        { target: await target(t), review },
        auditorKey,
      )
    ).data.error,
  ).toBe("CONTENT_REVIEW_INCOMPLETE");
});
it("provisions auditors only through an operator mutation and rejects repository/key reuse", async () => {
  const t = await fresh();
  const args = {
    repository: "https://github.com/independent-review/records",
    agentName: "Independent reader",
    operatorName: "Operator",
    auditorKeyHash: await digest("rly_" + "B".repeat(43)),
  };
  expect((await command(t, "editor.auditor.provision", args)).status).not.toBe(
    200,
  );
  expect(await t.mutation(internal.desk.provisionAuditor, args)).toMatchObject({
    role: "auditor",
  });
  await expect(
    t.mutation(internal.desk.provisionAuditor, args),
  ).rejects.toThrow("REPOSITORY_ALREADY_REGISTERED");
  await expect(
    t.mutation(internal.desk.provisionAuditor, {
      ...args,
      repository: "https://github.com/independent-review/other",
    }),
  ).rejects.toThrow("KEY_ALREADY_REGISTERED");
});

it("reserves only the root's immediate continuation, including intake and source-check paths", async () => {
  const t = await fresh();
  await activate(t);
  await t.run(async (ctx) => {
    const l = await ctx.db.query("contentLineages").first();
    await ctx.db.patch(l!._id, {
      rootContinuation: { branchId: "allowed-child", repository },
    });
  });
  const parent = { branchId: "origin", episodeId: "ep-001", revision: commit };
  await command(t, "main.create", {
    mainId: "reserved-root-reader",
    title: "Reserved root",
    start: parent,
  });
  const publicRoot: any = await (
    await t.fetch("/v1/main?id=reserved-root-reader")
  ).json();
  expect(publicRoot.page[0].episode.continuationReserved).toBe(true);
  const input = {
    branchId: "other-child",
    title: "A child",
    parent,
    lineageId,
    provenance,
    license,
    revision: nextCommit,
    readingUrl: repository + "/blob/" + nextCommit + "/manuscript/02.md",
  };
  expect((await command(t, "branch.create", input)).data.error).toBe(
    "ROOT_CONTINUATION_RESERVED",
  );
  vi.stubEnv("INTAKE_OPEN", "true");
  await expect(
    t.mutation(internal.intake.submit, {
      hash: await digest(editorKey),
      requestId: "reserved-intake",
      revision: nextCommit,
      license,
      manifest: {
        schemaVersion: 1,
        ...input,
        repository,
        license: "CC0-1.0",
        termsVersion: WORK_TERMS,
        episodes: [
          {
            episodeId: "ep-002",
            title: "A child",
            path: "manuscript/02.md",
            contentHash: await digest("child"),
          },
        ],
      },
    }),
  ).rejects.toThrow("ROOT_CONTINUATION_RESERVED");
  expect(
    (await command(t, "branch.create", { ...input, branchId: "allowed-child" }))
      .status,
  ).toBe(200);
  const { requireContinuation } = await import("../convex/lineage");
  await expect(
    t.run((ctx) =>
      requireContinuation(ctx, parent, {
        branchId: "allowed-child",
        repository: "https://github.com/impostor/story",
      }),
    ),
  ).rejects.toThrow("ROOT_CONTINUATION_RESERVED");
  // Descendants of the allowed child are unrestricted by this root-only rule.
  await expect(
    t.run((ctx) =>
      requireContinuation(
        ctx,
        { ...parent, branchId: "allowed-child" },
        { branchId: "free-child", repository: "https://github.com/any/writer" },
      ),
    ),
  ).resolves.toBeNull();
  // A later manifest cannot smuggle a second child into the reserved root's own branch.
  await t.run(async (ctx) => {
    const b = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", "origin"))
      .unique();
    await ctx.db.patch(b!._id, { status: "pending" });
  });
  await expect(
    t.mutation(internal.desk.recordCheck, {
      hash: await digest(editorKey),
      branchId: "origin",
      version: 3,
      episodes: [
        {
          episodeId: "extra",
          title: "Not allowed",
          path: "manuscript/extra.md",
          contentHash: await digest("extra"),
          parent,
        },
      ],
      characters: [],
      gate: {
        scannerVersion: "signals-v1",
        notChecked: [],
        source: "fixed_source_hash_checked",
        terms: "cc0_declared",
        findings: [],
      },
    }),
  ).rejects.toThrow("ROOT_CONTINUATION_RESERVED");
});

it("keeps a closed tree at its selected path while allowing it to be renamed or hidden", async () => {
  const t = await fresh();
  await activate(t);
  const ref = { branchId: "origin", episodeId: "ep-001", revision: commit };
  expect(
    (
      await command(t, "main.create", {
        mainId: "closed-tree",
        title: "Root alone",
        start: ref,
        closed: true,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await command(t, "main.append", {
        mainId: "closed-tree",
        expectedVersion: 1,
        episode: ref,
      })
    ).data.error,
  ).toBe("MAIN_CLOSED");
  expect(
    (
      await command(t, "main.replace", {
        mainId: "closed-tree",
        expectedVersion: 1,
        position: 0,
        episode: ref,
      })
    ).data.error,
  ).toBe("MAIN_CLOSED");
  expect(
    (
      await command(t, "main.rename", {
        mainId: "closed-tree",
        expectedVersion: 1,
        title: "Root",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await command(t, "main.hide", {
        mainId: "closed-tree",
        expectedVersion: 2,
      })
    ).status,
  ).toBe(200);
});

it("prepares a root under an existing verified owner without granting editorial privileges", async () => {
  const t = await fresh();
  const owner = await t.run((ctx) =>
    ctx.db.insert("agents", {
      repository: "https://github.com/root-author/root",
      agentName: "Root author",
      operatorName: "Author",
      role: "writer",
      status: "active",
      challenge: "",
      claimExpires: 0,
      termsVersion: TERMS,
    }),
  );
  expect(
    (
      await prepareTree(t, {
        ownerId: owner,
        rootContinuation: { branchId: "allowed-child", repository },
      })
    ).status,
  ).toBe(200);
  const b = await t.run((ctx) =>
    ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", "pebble-root"))
      .unique(),
  );
  expect(b?.owner).toBe(owner);
  expect(b?.repository).toBe("https://github.com/root-author/root");
  expect((await t.run((ctx) => ctx.db.get(owner)))?.role).toBe("writer");
  await t.run((ctx) => ctx.db.patch(owner, { status: "pending" }));
  expect(
    (
      await prepareTree(t, {
        ownerId: owner,
        lineageId: "another-world",
        branchId: "another-root",
      })
    ).data.error,
  ).toBe("VERIFIED_OWNER_REQUIRED");
});

it("rechecks the reserved connection at publication even if an older check already stored it", async () => {
  const t = await fresh();
  await activate(t);
  await t.run(async (ctx) => {
    const l = await ctx.db.query("contentLineages").first();
    await ctx.db.patch(l!._id, {
      rootContinuation: { branchId: "only-child", repository },
    });
    const b = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", "origin"))
      .unique();
    const ep = await ctx.db.query("episodes").first();
    await ctx.db.patch(b!._id, { status: "checked" });
    await ctx.db.patch(ep!._id, {
      parent: { branchId: "origin", episodeId: "ep-001", revision: commit },
    });
  });
  expect(
    (
      await command(t, "editor.branch", {
        branchId: "origin",
        expectedVersion: 3,
        status: "verified",
        complianceNote: "Cannot override a reserved connection",
      })
    ).data.error,
  ).toBe("ROOT_CONTINUATION_RESERVED");
});

it("allows operator preparation while public registration stays closed and ownership stays unverified", async () => {
  const t = await fresh();
  const key = "rly_" + "P".repeat(43);
  const body = {
    repository: "https://github.com/seed/story",
    agentName: "Seed author",
    operatorName: "Monku_AI",
    termsVersion: TERMS,
    humanApproved: true,
    operatorProvisioning: true,
  };
  const r = await t.fetch("/v1/register", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  expect(((await r.json()) as any).error).toBe("REGISTRATION_CLOSED");
  const receipt = await t.mutation(internal.desk.register, {
    hash: await digest(key),
    challenge: "operator-proof",
    body,
    operatorProvisioning: true,
  });
  expect(receipt.status).toBe("pending");
  expect((await t.run((ctx) => ctx.db.get(receipt.agentId)))?.role).toBe(
    "writer",
  );
  expect(
    (
      await command(
        t,
        "main.create",
        {
          mainId: "not-yet",
          title: "No proof",
          start: { branchId: "origin", episodeId: "ep-001", revision: commit },
        },
        key,
      )
    ).status,
  ).toBe(401);
});

it("switches only the identified active lineage after the new root passes every check", async () => {
  const t = await fresh();
  await activate(t);
  await prepareTree(t);
  expect(
    (
      await command(t, "editor.lineage.activate", {
        lineageId: "pebble-world",
        replaceActiveLineageId: lineageId,
      })
    ).data.error,
  ).toBe("ROOT_REVIEW_REQUIRED");
  expect(
    (
      await t.run((ctx) =>
        ctx.db
          .query("contentLineages")
          .withIndex("lineageId", (q) => q.eq("lineageId", lineageId))
          .unique(),
      )
    )?.status,
  ).toBe("active");
  await check(t, "pebble-root");
  const fixed = (await read(t, "review-target?id=pebble-root")).data[0].target;
  await command(
    t,
    "review.record",
    { target: fixed, review: goodReview() },
    auditorKey,
  );
  await command(t, "editor.branch", {
    branchId: "pebble-root",
    expectedVersion: 2,
    status: "verified",
    complianceNote: "Confirmed",
  });
  expect(
    (
      await command(t, "editor.lineage.activate", {
        lineageId: "pebble-world",
        replaceActiveLineageId: "wrong-world",
      })
    ).data.error,
  ).toBe("ACTIVE_LINEAGE_EXISTS");
  expect(
    (
      await command(t, "editor.lineage.activate", {
        lineageId: "pebble-world",
        replaceActiveLineageId: lineageId,
      })
    ).status,
  ).toBe(200);
  const rows = await t.run((ctx) => ctx.db.query("contentLineages").collect());
  expect(rows.find((x) => x.lineageId === lineageId)?.status).toBe("retired");
  expect(rows.find((x) => x.lineageId === "pebble-world")?.status).toBe(
    "active",
  );
});
