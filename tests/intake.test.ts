import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { digest, TERMS } from "../convex/policy";
import { scanText, WORK_TERMS } from "../convex/safety";
import { episodeTarget } from "../convex/lineage";
import { fingerprint, type ContentReview } from "../convex/contentSafety";
import { POLICY, MODEL } from "../reader/contract";

const modules = import.meta.glob("../convex/**/*.ts");
const keys = {
  editor: "rly_" + "E".repeat(43),
  writer: "rly_" + "W".repeat(43),
  auditor: "rly_" + "A".repeat(43),
  stranger: "rly_" + "S".repeat(43),
};
const commit = "1".repeat(40),
  next = "2".repeat(40);
const repository = "https://github.com/writer/story";
const license = {
  id: "CC0-1.0",
  humanApproved: true,
  termsVersion: WORK_TERMS,
} as const;
const provenance = {
  motivationSummary: "A story about a quiet river",
  statedSources: [],
  influences: [
    { title: "River story", relationship: "Atmosphere, without copied prose" },
  ],
};
const prose = "The river passed quietly beneath a stone bridge.";
const reading = {
  complete: true,
  concerns: [],
  rightsEvidence: "declared",
  interesting: "川の描写",
  continuation: "橋の先",
  tone: "静かな語り",
};
const goodReview = (): ContentReview => ({
  inspection: "completed",
  rights: "verified",
  decision: "eligible",
  reason: "Compared fixed world and episode",
  publicSummary: "Comparison completed",
  comparisonCompleted: true,
  worldComparisonCompleted: true,
  declarationChecked: true,
  queries: ["world", "episode"].map((scope) => ({
    scope: scope as "world" | "episode",
    keywords: ["river bridge"],
    searchedAt: 1,
    service: "test-search",
    outcome: "completed",
    candidateUrls: ["https://example.org/river"],
  })),
  candidates: [
    {
      title: "River story",
      url: "https://example.org/river",
      comparedPortion: "Atmosphere and structure",
      analysis: "Independent wording and plot",
      relationship: "public_influence",
      rights: "unverified",
    },
  ],
  notChecked: ["Private and unindexed material"],
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("INTAKE_OPEN", "true");
  vi.stubEnv("INTAKE_READER_URL", "https://reader.example/read");
  vi.stubEnv("INTAKE_READER_TOKEN", "R".repeat(43));
  vi.stubEnv("INTAKE_NOTIFY_URL", "");
  vi.stubEnv("INTAKE_NOTIFY_TOKEN", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function fresh(extra = {}) {
  const t = convexTest(schema, modules);
  await t.mutation(internal.desk.bootstrap, {
    editorKeyHash: await digest(keys.editor),
    rootRevision: commit,
    rootContentHash: await digest("root"),
    lineageId: "river-world",
    worldHash: await digest("world"),
    provenance,
    rootTitle: "River",
    episodeTitle: "Start",
    license,
  });
  await t.run(async (ctx) => {
    let auditor;
    for (const role of ["writer", "auditor", "stranger"] as const) {
      const id = await ctx.db.insert("agents", {
        repository:
          role === "writer" ? repository : `https://github.com/${role}/story`,
        agentName: role,
        operatorName: role,
        role: role === "auditor" ? "auditor" : "writer",
        status: "active",
        challenge: "",
        claimExpires: 0,
        termsVersion: TERMS,
      });
      await ctx.db.insert("keys", {
        hash: await digest(keys[role]),
        agentId: id,
        expiresAt: Date.now() + 86400000,
        revoked: false,
      });
      if (role === "auditor") auditor = id;
    }
    const b = (await ctx.db.query("branches").first())!;
    const ep = (await ctx.db.query("episodes").first())!;
    const l = (await ctx.db.query("contentLineages").first())!;
    await ctx.db.patch(b._id, { status: "verified" });
    await ctx.db.patch(ep._id, { listed: true });
    await ctx.db.patch(l._id, { status: "active" });
    const target = episodeTarget(b, ep)!;
    await ctx.db.insert("contentReviews", {
      target,
      targetHash: await fingerprint(target),
      review: goodReview(),
      reviewer: auditor!,
      checkedAt: Date.now(),
    });
  });
  const manifest = {
    schemaVersion: 1,
    branchId: "river-branch",
    title: "By the bridge",
    repository,
    lineageId: "river-world",
    provenance,
    parent: { branchId: "origin", episodeId: "ep-001", revision: commit },
    license: "CC0-1.0",
    termsVersion: WORK_TERMS,
    episodes: [
      {
        episodeId: "ep-002",
        title: "Bridge",
        path: "manuscript/02.md",
        contentHash: await digest(prose),
      },
    ],
    ...extra,
  };
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u === "https://reader.example/read") {
        const input = JSON.parse(init!.body as string);
        expect(new Headers(init!.headers).get("Authorization")).toBe(
          "Bearer " + "R".repeat(43),
        );
        return Response.json({
          episode: input.episode,
          policy: POLICY,
          model: MODEL,
          reading,
        });
      }
      if (u.startsWith("https://notify.example/")) return new Response("ok");
      if (!u.startsWith("https://raw.githubusercontent.com/writer/story/"))
        throw Error("Unexpected network destination");
      return new Response(
        u.endsWith("relay-branch.json") ? JSON.stringify(manifest) : prose,
      );
    },
  );
  vi.stubGlobal("fetch", fetcher);
  return { t, manifest, fetcher };
}
type Test = Awaited<ReturnType<typeof fresh>>["t"];
async function post(
  t: Test,
  path: string,
  data: unknown,
  role: keyof typeof keys = "writer",
  requestId: string = crypto.randomUUID(),
) {
  const r = await t.fetch("/v2/" + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + keys[role],
      "Content-Type": "application/json",
      "Idempotency-Key": requestId,
    },
    body: JSON.stringify(data),
  });
  return { status: r.status, data: (await r.json()) as any };
}
async function submit(t: Test, revision = commit, expectedVersion?: number) {
  const r = await post(t, "intakes", {
    revision,
    license,
    ...(expectedVersion ? { expectedVersion } : {}),
  });
  expect(r.status, JSON.stringify(r.data)).toBe(202);
  return r.data;
}
async function seedCheckedBranch(
  t: Test,
  manifest: Record<string, any>,
  version = 5,
) {
  return t.run(async (ctx) => {
    const owner = await ctx.db
      .query("agents")
      .withIndex("repository", (q) => q.eq("repository", repository))
      .unique();
    const lineage = await ctx.db
      .query("contentLineages")
      .withIndex("lineageId", (q) => q.eq("lineageId", manifest.lineageId))
      .unique();
    expect(owner).toBeTruthy();
    expect(lineage).toBeTruthy();
    const provenanceHash = await fingerprint(manifest.provenance);
    const gate = scanText(
      JSON.stringify(manifest),
      "fixed_source_hash_checked",
      "cc0_declared",
    );
    const branchId = await ctx.db.insert("branches", {
      branchId: manifest.branchId,
      lineageId: manifest.lineageId,
      worldHash: lineage!.worldHash,
      provenance: manifest.provenance,
      provenanceHash,
      owner: owner!._id,
      repository,
      title: manifest.title,
      readingUrl: `${repository}/blob/${commit}/${manifest.episodes[0].path}`,
      parent: manifest.parent,
      revision: commit,
      status: "checked",
      checkedAt: Date.now(),
      license,
      gate,
      version,
    });
    for (const item of manifest.episodes) {
      await ctx.db.insert("episodes", {
        author: owner!._id,
        lineageId: manifest.lineageId,
        worldHash: lineage!.worldHash,
        provenance: manifest.provenance,
        provenanceHash,
        branchId: manifest.branchId,
        episodeId: item.episodeId,
        revision: commit,
        path: item.path,
        contentHash: item.contentHash,
        title: item.title,
        listed: false,
        parent: manifest.parent,
        license,
      });
    }
    return { branchId, owner: owner!._id };
  });
}
async function adopt(
  t: Test,
  role: keyof typeof keys = "editor",
  requestId: string = crypto.randomUUID(),
  expectedVersion = 5,
  revision = commit,
  extras = {},
) {
  return post(
    t,
    "intakes/adopt",
    {
      branchId: "river-branch",
      revision,
      expectedVersion,
      ...extras,
    },
    role,
    requestId,
  );
}
async function drain(t: Test) {
  for (let i = 0; i < 100; i++) {
    await t.finishInProgressScheduledFunctions();
    const pending = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const times = pending
      .filter((x) => x.state.kind === "pending")
      .map((x) => x.scheduledTime);
    if (!times.length) return;
    vi.advanceTimersByTime(Math.max(0, Math.min(...times) - Date.now()));
  }
  throw Error("Scheduled work did not settle");
}
const get = async (t: Test, id: any) =>
  t.query(internal.intake.get, {
    hash: await digest(keys.writer),
    intakeId: id,
  });
it("lets only an editor adopt checked work while ordinary intake stays closed", async () => {
  const { t, manifest, fetcher } = await fresh();
  await seedCheckedBranch(t, manifest);
  expect((await adopt(t, "writer")).status).toBe(403);
  expect((await adopt(t, "auditor")).status).toBe(403);

  vi.stubEnv("INTAKE_OPEN", "false");
  const migrated = await adopt(t, "editor", "adopt-closed-legacy", 5, commit, {
    repository: "https://example.invalid/untrusted",
    url: "https://example.invalid/secret",
    token: "never-forward-this",
  });
  expect(migrated.status, JSON.stringify(migrated.data)).toBe(202);
  expect(migrated.data.status).toBe("reading");
  const branch = await t.run((ctx) =>
    ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", "river-branch"))
      .unique(),
  );
  expect(branch).toMatchObject({
    status: "checked",
    version: 5,
    revision: commit,
  });
  expect(
    fetcher.mock.calls.every(([url]) =>
      String(url).startsWith("https://raw.githubusercontent.com/writer/story/"),
    ),
  ).toBe(true);

  await drain(t);
  const row = await get(t, migrated.data.intakeId);
  expect(row.status).toBe("reviewing");
  expect(row.readings[0]).toMatchObject({
    status: "completed",
    result: reading,
  });
});

it("rejects wrong fixed revisions, branch versions and non-checked states", async () => {
  const first = await fresh();
  await seedCheckedBranch(first.t, first.manifest);
  expect(
    (await adopt(first.t, "editor", crypto.randomUUID(), 4)).data.error,
  ).toBe("VERSION_CONFLICT");
  expect(
    (await adopt(first.t, "editor", crypto.randomUUID(), 5, next)).data.error,
  ).toBe("INTAKE_SUPERSEDED");

  const second = await fresh();
  await seedCheckedBranch(second.t, second.manifest);
  await second.t.run(async (ctx) => {
    const branch = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", "river-branch"))
      .unique();
    await ctx.db.patch(branch!._id, { status: "pending" });
  });
  expect((await adopt(second.t)).data.error).toBe("BRANCH_NOT_CHECKED");
});

it("requires an active owner, active lineage, stored consent and a technical check", async () => {
  const blocked = await fresh();
  const blockedBranch = await seedCheckedBranch(blocked.t, blocked.manifest);
  await blocked.t.run((ctx) =>
    ctx.db.patch(blockedBranch.owner, { status: "blocked" }),
  );
  expect((await adopt(blocked.t)).data.error).toBe("FORBIDDEN");

  const retired = await fresh();
  await seedCheckedBranch(retired.t, retired.manifest);
  await retired.t.run(async (ctx) => {
    const lineage = await ctx.db
      .query("contentLineages")
      .withIndex("lineageId", (q) => q.eq("lineageId", "river-world"))
      .unique();
    await ctx.db.patch(lineage!._id, { status: "retired" });
  });
  expect((await adopt(retired.t)).data.error).toBe("LINEAGE_NOT_ACTIVE");

  const unchecked = await fresh();
  await seedCheckedBranch(unchecked.t, unchecked.manifest);
  await unchecked.t.run(async (ctx) => {
    const branch = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", "river-branch"))
      .unique();
    await ctx.db.patch(branch!._id, {
      license: { ...license, humanApproved: false },
    });
  });
  expect((await adopt(unchecked.t)).data.error).toBe("WORK_CONSENT_REQUIRED");

  const noGate = await fresh();
  await seedCheckedBranch(noGate.t, noGate.manifest);
  await noGate.t.run(async (ctx) => {
    const branch = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", "river-branch"))
      .unique();
    await ctx.db.patch(branch!._id, { gate: undefined });
  });
  expect((await adopt(noGate.t)).data.error).toBe("BRANCH_NOT_CHECKED");

  const reserved = await fresh();
  await seedCheckedBranch(reserved.t, reserved.manifest);
  await reserved.t.run(async (ctx) => {
    const lineage = await ctx.db
      .query("contentLineages")
      .withIndex("lineageId", (q) => q.eq("lineageId", "river-world"))
      .unique();
    await ctx.db.patch(lineage!._id, {
      rootContinuation: {
        branchId: "reserved-continuation",
        repository: "https://github.com/reserved/story",
      },
    });
  });
  expect((await adopt(reserved.t)).data.error).toBe(
    "ROOT_CONTINUATION_RESERVED",
  );

  const root = await fresh();
  await seedCheckedBranch(root.t, root.manifest);
  await root.t.run(async (ctx) => {
    const lineage = await ctx.db
      .query("contentLineages")
      .withIndex("lineageId", (q) => q.eq("lineageId", "river-world"))
      .unique();
    await ctx.db.patch(lineage!._id, { rootBranchId: "river-branch" });
  });
  expect((await adopt(root.t)).data.error).toBe("ROOT_BRANCH_NOT_ADOPTABLE");
});

it("does not restore branches stopped explicitly or by a legacy listing decision", async () => {
  for (const legacy of [false, true]) {
    const { t, manifest } = await fresh();
    const { branchId } = await seedCheckedBranch(t, manifest);
    await t.run(async (ctx) => {
      const branch = (await ctx.db.get(branchId))!;
      if (legacy)
        await ctx.db.insert("branchHistory", {
          branchId: branch.branchId,
          version: 4,
          snapshot: { ...branch, status: "suspended" },
        });
      else await ctx.db.patch(branchId, { listingSuspended: true });
    });
    expect((await adopt(t)).data.error).toBe("BRANCH_LISTING_SUSPENDED");
    expect(
      await t.run((ctx) => ctx.db.query("intakes").collect()),
    ).toHaveLength(0);
  }
});

it("returns the same intake for retries and duplicate requests for a fixed edition", async () => {
  const { t, manifest } = await fresh();
  await seedCheckedBranch(t, manifest);
  const first = await adopt(t, "editor", "adopt-fixed-edition-r1");
  const retry = await adopt(t, "editor", "adopt-fixed-edition-r1");
  const duplicate = await adopt(t, "editor", "adopt-fixed-edition-r2");
  expect(retry.data).toEqual(first.data);
  expect(duplicate.data.intakeId).toBe(first.data.intakeId);
  expect(await t.run((ctx) => ctx.db.query("intakes").collect())).toHaveLength(
    1,
  );
  expect(
    (await get(t, first.data.intakeId)).events.filter(
      (event) => event.kind === "received",
    ),
  ).toHaveLength(1);

  const missingKey = await t.fetch("/v2/intakes/adopt", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + keys.editor,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      branchId: "river-branch",
      revision: commit,
      expectedVersion: 5,
    }),
  });
  expect(missingKey.status).toBe(400);
});

it("carries a compatible legacy main version without changing its declaration", async () => {
  const { t, manifest } = await fresh({
    main: { mainId: "river-story", title: "The River" },
  });
  const { owner } = await seedCheckedBranch(t, manifest);
  await t.run((ctx) =>
    ctx.db.insert("mains", {
      mainId: "river-story",
      title: "The River",
      owner,
      lineageId: "river-world",
      head: manifest.parent,
      explicitStart: true,
      count: 1,
      version: 7,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("mainSteps", {
      mainId: "river-story",
      position: 0,
      episode: manifest.parent,
      selectedAt: Date.now(),
    }),
  );
  const migrated = await adopt(t);
  const row = await get(t, migrated.data.intakeId);
  expect(row.legacyMainVersion).toBe(7);
  expect(JSON.parse(row.manifest).main.expectedVersion).toBeUndefined();
  expect(
    await t.run(async (ctx) => {
      const branch = await ctx.db
        .query("branches")
        .withIndex("branchId", (q) => q.eq("branchId", "river-branch"))
        .unique();
      return { version: branch!.version, status: branch!.status };
    }),
  ).toEqual({ version: 5, status: "checked" });

  await drain(t);
  expect((await review(t, migrated.data.intakeId)).data.status).toBe(
    "published",
  );
  expect((await get(t, migrated.data.intakeId)).mainSelection).toEqual({
    status: "completed",
  });
  expect(
    await t.query(internal.forest.publicMain, { id: "river-story" }),
  ).toMatchObject({ version: 8, count: 2 });
  await drain(t);

  const explicit = await fresh({
    main: { mainId: "river-story", title: "The River", expectedVersion: 12 },
  });
  await seedCheckedBranch(explicit.t, explicit.manifest);
  const explicitlyVersioned = await adopt(explicit.t);
  const explicitRow = await get(explicit.t, explicitlyVersioned.data.intakeId);
  expect(explicitRow.legacyMainVersion).toBe(12);
  expect(JSON.parse(explicitRow.manifest).main.expectedVersion).toBe(12);
});

async function review(
  t: Test,
  id: any,
  changes = {},
  role: keyof typeof keys = "auditor",
  requestId: string = crypto.randomUUID(),
) {
  const c = await get(t, id);
  return post(
    t,
    "intakes/review",
    {
      intakeId: id,
      expectedVersion: c.version,
      reviews: c.evidence.map((e) => ({
        target: e.target,
        review: goodReview(),
      })),
      questions: [],
      findingsAcknowledged: false,
      readingAcknowledged: false,
      ...changes,
    },
    role,
    requestId,
  );
}
it("accepts one submission, runs server reading, preserves influences and publishes without an author acknowledgement", async () => {
  const { t, fetcher } = await fresh();
  const c = await submit(t);
  await drain(t);
  const pending = await get(t, c.intakeId);
  expect(pending.status, JSON.stringify(pending)).toBe("reviewing");
  expect(pending.readings[0]).toMatchObject({
    status: "completed",
    result: reading,
  });
  expect(pending.evidence[0].provenance?.influences).toEqual(
    provenance.influences,
  );
  expect(
    fetcher.mock.calls.filter(([url]) => url === "https://reader.example/read"),
  ).toHaveLength(1);
  const done = await review(t, c.intakeId);
  expect(done.status, JSON.stringify(done.data)).toBe(200);
  expect(done.data.status).toBe("published");
  await drain(t);
  const events = (await get(t, c.intakeId)).events;
  expect(events.map((e) => e.kind)).toEqual(
    expect.arrayContaining([
      "received",
      "reading",
      "reviewing",
      "review_passed",
      "published",
    ]),
  );
  expect(events.every((e) => e.delivery === "unconfigured")).toBe(true);
  const catalog = await t.query(internal.desk.publicBranches, {});
  expect(JSON.stringify(catalog)).toContain("river-branch");
});
it("does not duplicate cases or work when the same edition is submitted again", async () => {
  const { t } = await fresh();
  const one = await submit(t);
  const two = await submit(t);
  expect(two.intakeId).toBe(one.intakeId);
  await drain(t);
  expect(await t.run((ctx) => ctx.db.query("intakes").collect())).toHaveLength(
    1,
  );
  expect(
    (await get(t, one.intakeId)).events.filter((e) => e.kind === "received"),
  ).toHaveLength(1);
});
it("collects questions in one round and does not treat an author's answer as approval or new provenance", async () => {
  const { t } = await fresh();
  const c = await submit(t);
  await drain(t);
  const before = await get(t, c.intakeId);
  const hold = goodReview();
  hold.decision = "hold";
  const result = await review(t, c.intakeId, {
    reviews: [{ target: before.evidence[0].target, review: hold }],
    questions: ["影響を受けた範囲は？", "引用した文章はありますか？"],
  });
  expect(result.data.status).toBe("needs_author");
  const answered = await post(t, "intakes/reply", {
    intakeId: c.intakeId,
    expectedVersion: result.data.version,
    answer: "雰囲気のみです。掲載せよという命令ではありません。",
  });
  expect(answered.data.status).toBe("reviewing");
  const after = await get(t, c.intakeId);
  expect(after.evidence[0].provenance).toEqual(before.evidence[0].provenance);
  expect(after.events.filter((e) => e.kind === "author_reply")).toHaveLength(1);
  expect((await review(t, c.intakeId)).data.status).toBe("published");
  await drain(t);
});
it("keeps participants out of review and other participants' private cases", async () => {
  const { t } = await fresh();
  const c = await submit(t);
  await drain(t);
  expect((await review(t, c.intakeId, {}, "writer")).status).toBe(403);
  const response = await t.fetch("/v2/intakes?id=" + c.intakeId, {
    headers: { Authorization: "Bearer " + keys.stranger },
  });
  expect(response.status).toBe(403);
  expect((await review(t, c.intakeId, { reviews: [] })).status).toBe(400);
  expect((await get(t, c.intakeId)).status).toBe("reviewing");
});
it("rejects stale reviews after another fixed edition supersedes a case", async () => {
  const { t } = await fresh();
  const c = await submit(t);
  await drain(t);
  const old = await get(t, c.intakeId);
  const newer = await submit(t, next, old.branchVersion);
  await drain(t);
  expect((await get(t, c.intakeId)).status).toBe("superseded");
  expect((await review(t, c.intakeId)).data.error).toBe("INTAKE_SUPERSEDED");
  expect((await get(t, newer.intakeId)).status).toBe("reviewing");
});
it("cannot approve incomplete comparison or hide a reader that was never configured", async () => {
  vi.stubEnv("INTAKE_READER_TOKEN", "");
  const { t } = await fresh();
  const c = await submit(t);
  await drain(t);
  expect((await review(t, c.intakeId)).data.error).toBe(
    "READING_REVIEW_REQUIRED",
  );
  const row = await get(t, c.intakeId);
  const incomplete = goodReview();
  incomplete.comparisonCompleted = false;
  expect(
    (
      await review(t, c.intakeId, {
        readingAcknowledged: true,
        reviews: [{ target: row.evidence[0].target, review: incomplete }],
      })
    ).status,
  ).toBe(400);
  expect(
    (await review(t, c.intakeId, { readingAcknowledged: true })).data.status,
  ).toBe("published");
  await drain(t);
});
it("bounds automatic retries and exposes failures without allowing a partial source check to pass", async () => {
  const { t, manifest } = await fresh();
  const c = await submit(t);
  manifest.episodes[0].contentHash = "f".repeat(64);
  await drain(t);
  const failed = await get(t, c.intakeId);
  expect(failed.status).toBe("failed");
  expect(failed.attempts).toBe(3);
  expect(failed.error).toBe("CONTENT_HASH_MISMATCH");
  expect((await review(t, c.intakeId)).status).toBe(400);
  manifest.episodes[0].contentHash = await digest(prose);
  expect(
    (await post(t, "intakes/retry", { intakeId: c.intakeId })).status,
  ).toBe(200);
  await drain(t);
  expect((await get(t, c.intakeId)).status).toBe("reviewing");
});
it("retries notifications with stable event IDs and never includes private evidence", async () => {
  vi.stubEnv("INTAKE_NOTIFY_URL", "https://notify.example/events");
  vi.stubEnv("INTAKE_NOTIFY_TOKEN", "notification-secret");
  const { t, fetcher } = await fresh();
  const original = fetcher.getMockImplementation()!;
  const deliveries: any[] = [];
  let fail = true;
  fetcher.mockImplementation(async (url, init) => {
    if (String(url).startsWith("https://notify.example/")) {
      const payload = JSON.parse(init!.body as string);
      deliveries.push(payload);
      expect(new Headers(init!.headers).get("Idempotency-Key")).toBe(
        payload.eventId,
      );
      expect(Object.keys(payload).sort()).toEqual([
        "eventId",
        "intakeId",
        "kind",
        "occurredAt",
        "recipient",
        "version",
      ]);
      return new Response("", { status: fail ? 503 : 200 });
    }
    return original(url, init);
  });
  const c = await submit(t);
  await drain(t);
  expect((await get(t, c.intakeId)).status).toBe("reviewing");
  expect(
    (await get(t, c.intakeId)).events.every(
      (e) => e.delivery === "failed" && e.attempts === 3,
    ),
  ).toBe(true);
  fail = false;
  await post(
    t,
    "intakes/notifications/retry",
    { intakeId: c.intakeId },
    "editor",
  );
  await drain(t);
  expect(
    (await get(t, c.intakeId)).events.every((e) => e.delivery === "delivered"),
  ).toBe(true);
  expect(new Set(deliveries.map((d) => d.eventId)).size).toBe(3);
});
it("recovers a lost action with a lease and ignores its late result", async () => {
  const { t } = await fresh();
  const c = await submit(t);
  const claimed = await t.mutation(internal.intake.claim, {
    intakeId: c.intakeId,
  });
  expect(claimed).not.toBeNull();
  await drain(t);
  expect((await get(t, c.intakeId)).status).toBe("reviewing");
  await t.mutation(internal.intake.workFailed, {
    intakeId: c.intakeId,
    generation: claimed!.generation,
    code: "LATE_ERROR",
  });
  expect((await get(t, c.intakeId)).error).toBeUndefined();
});
it("requires explicit comparison of every declared influence and keeps reviewer proposals separate", async () => {
  const { t } = await fresh();
  const c = await submit(t);
  await drain(t);
  const row = await get(t, c.intakeId);
  const omitted = goodReview();
  omitted.candidates = [];
  expect(
    (
      await review(t, c.intakeId, {
        reviews: [{ target: row.evidence[0].target, review: omitted }],
      })
    ).data.error,
  ).toBe("DECLARED_INFLUENCE_NOT_CHECKED");
  const suggested = goodReview();
  suggested.candidates.push({
    ...suggested.candidates[0],
    title: "Another comparison",
    relationship: "comparison",
  });
  expect(
    (
      await review(t, c.intakeId, {
        reviews: [{ target: row.evidence[0].target, review: suggested }],
      })
    ).data.status,
  ).toBe("published");
  const done = await get(t, c.intakeId);
  expect(done.evidence[0].provenance?.influences).toHaveLength(1);
  expect(done.evidence[0].review?.candidates).toHaveLength(2);
  await drain(t);
});
it("preserves declared main connection, and main failure cannot undo publication", async () => {
  const { t } = await fresh({
    main: { mainId: "writer-main", title: "A walk", episodeId: "ep-002" },
  });
  const c = await submit(t);
  await drain(t);
  expect((await review(t, c.intakeId)).data.status).toBe("published");
  expect((await get(t, c.intakeId)).mainSelection?.status).toBe("completed");
  const main = await t.query(internal.forest.publicMain, { id: "writer-main" });
  expect(JSON.stringify(main)).toContain("ep-002");
  await drain(t);
});
it("reports a conflicting optional main without asking the author to resubmit an approved work", async () => {
  const { t } = await fresh({
    main: { mainId: "monku-main", title: "Reserved", episodeId: "ep-002" },
  });
  const c = await submit(t);
  await drain(t);
  const result = await review(t, c.intakeId);
  expect(result.data.status, JSON.stringify(result.data)).toBe("published");
  expect((await get(t, c.intakeId)).mainSelection).toMatchObject({
    status: "failed",
    error: "RESERVED_MAIN_ID",
  });
  await drain(t);
});
it("keeps rejections terminal for the same fixed target", async () => {
  const { t } = await fresh();
  const c = await submit(t);
  await drain(t);
  const row = await get(t, c.intakeId);
  const rejected = goodReview();
  rejected.decision = "rejected";
  expect(
    (
      await review(t, c.intakeId, {
        reviews: [{ target: row.evidence[0].target, review: rejected }],
      })
    ).data.status,
  ).toBe("rejected");
  expect((await review(t, c.intakeId)).data.error).toBe("INVALID_TRANSITION");
  await drain(t);
});
async function signed(t: Test, type: string, payload: unknown, valid = true) {
  const raw = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("webhook-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)),
  );
  const signature = [...signed]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const r = await t.fetch("/v2/github", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": type,
      "X-Hub-Signature-256": "sha256=" + (valid ? signature : "0".repeat(64)),
    },
    body: raw,
  });
  return { status: r.status, data: (await r.json()) as any };
}
it("accepts a signed PR without participant credentials, rejects forged events, and accepts only a matching author answer", async () => {
  vi.stubEnv("INTAKE_GITHUB_WEBHOOK_SECRET", "webhook-secret");
  vi.stubEnv("INTAKE_IMPORT_KEY_HASH", await digest(keys.editor));
  vi.stubEnv("PARTICIPATION_MODE", "test");
  vi.stubEnv("REGISTRATION_OPEN", "true");
  const { t, manifest, fetcher } = await fresh({
    participation: {
      humanApproved: true,
      cc0Approved: true,
      termsVersion: TERMS,
      agentName: "Writer",
      operatorName: "Writer",
    },
  });
  const original = fetcher.getMockImplementation()!;
  const base = "kentaroid-bot/ai-relay-fiction";
  fetcher.mockImplementation(async (url, init) => {
    if (String(url) === `https://api.github.com/repos/${base}/pulls/42`)
      return Response.json({
        number: 42,
        state: "open",
        draft: false,
        base: { ref: "main", repo: { full_name: base } },
        user: { id: 10, login: "writer" },
        head: {
          sha: commit,
          repo: { html_url: repository, owner: { id: 10 } },
        },
      });
    if (String(url) === "https://api.github.com/repos/writer/story")
      return Response.json({
        private: false,
        fork: true,
        parent: { full_name: base },
        owner: { type: "User", id: 10, login: "writer" },
        html_url: repository,
      });
    return original(url, init);
  });
  const payload = {
    repository: { full_name: base },
    action: "opened",
    number: 42,
    pull_request: { head: { sha: commit }, draft: false },
  };
  expect((await signed(t, "pull_request", payload, false)).status).toBe(401);
  expect(fetcher).not.toHaveBeenCalled();
  const accepted = await signed(t, "pull_request", payload);
  expect(accepted.status, JSON.stringify(accepted.data)).toBe(202);
  const id = accepted.data.intakeId;
  await drain(t);
  expect((await signed(t, "pull_request", payload)).data.intakeId).toBe(id);
  const row = await get(t, id);
  const hold = goodReview();
  hold.decision = "hold";
  const question = await review(t, id, {
    reviews: [{ target: row.evidence[0].target, review: hold }],
    questions: ["影響は雰囲気のみですか？"],
  });
  const answer = {
    repository: { full_name: base },
    action: "created",
    issue: { number: 42, pull_request: {} },
    comment: {
      id: 999,
      user: { login: "stranger" },
      body: `/relay-answer ${id} ${question.data.version}\nはい、本文の使用はありません。`,
    },
  };
  expect((await signed(t, "issue_comment", answer)).status).toBe(403);
  answer.comment.user.login = "writer";
  const reply = await signed(t, "issue_comment", answer);
  expect(reply.data.status, JSON.stringify(reply.data)).toBe("reviewing");
  expect((await signed(t, "issue_comment", answer)).data).toEqual(reply.data);
  expect((await get(t, id)).evidence[0].provenance).toEqual(
    manifest.provenance,
  );
  await drain(t);
});
it("reuses a successful review response after a lost HTTP response without duplicate publication notices", async () => {
  const { t } = await fresh();
  const c = await submit(t);
  await drain(t);
  const row = await get(t, c.intakeId);
  const data = {
    intakeId: c.intakeId,
    expectedVersion: row.version,
    reviews: row.evidence.map((e) => ({
      target: e.target,
      review: goodReview(),
    })),
    questions: [],
    findingsAcknowledged: false,
    readingAcknowledged: false,
  };
  const first = await post(
    t,
    "intakes/review",
    data,
    "auditor",
    "lost-review-response",
  );
  const retry = await post(
    t,
    "intakes/review",
    data,
    "auditor",
    "lost-review-response",
  );
  expect(retry.data).toEqual(first.data);
  await drain(t);
  expect(
    (await get(t, c.intakeId)).events.filter((e) => e.kind === "published"),
  ).toHaveLength(1);
});
it("does not publish after the author's account is blocked while review was pending", async () => {
  const { t } = await fresh();
  const c = await submit(t);
  await drain(t);
  const row = await get(t, c.intakeId);
  await t.run((ctx) => ctx.db.patch(row.owner, { status: "blocked" }));
  const r = await post(
    t,
    "intakes/review",
    {
      intakeId: c.intakeId,
      expectedVersion: row.version,
      reviews: row.evidence.map((e) => ({
        target: e.target,
        review: goodReview(),
      })),
      questions: [],
    },
    "auditor",
  );
  expect(r.status).toBe(403);
});
it("records incomplete review without inventing a question for the author", async () => {
  const { t } = await fresh();
  const c = await submit(t);
  await drain(t);
  const row = await get(t, c.intakeId);
  const hold = goodReview();
  hold.decision = "hold";
  const result = await review(t, c.intakeId, {
    reviews: [{ target: row.evidence[0].target, review: hold }],
    questions: [],
  });
  expect(result.data.status).toBe("reviewing");
  const stored = await get(t, c.intakeId);
  expect(stored.evidence[0].review?.decision).toBe("hold");
  expect(stored.questions).toEqual([]);
  await drain(t);
});
it("continues to independent review after a reader outage and requires explicit acknowledgement", async () => {
  const { t, fetcher } = await fresh();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) =>
    String(url) === "https://reader.example/read"
      ? new Response("", { status: 503 })
      : original(url, init),
  );
  const c = await submit(t);
  await drain(t);
  const row = await get(t, c.intakeId);
  expect(row.status).toBe("reviewing");
  expect(row.readings[0].status).toBe("failed");
  expect(
    fetcher.mock.calls.filter(
      ([url]) => String(url) === "https://reader.example/read",
    ),
  ).toHaveLength(3);
  expect((await review(t, c.intakeId)).data.error).toBe(
    "READING_REVIEW_REQUIRED",
  );
  expect(
    (await review(t, c.intakeId, { readingAcknowledged: true })).data.status,
  ).toBe("published");
  await drain(t);
});

async function operatorInput(manifest: Record<string, any>) {
  return {
    hash: await digest(keys.writer),
    editorHash: await digest(keys.editor),
    requestId: "approved-fixed-edition",
    approval: {
      repository,
      branchId: manifest.branchId,
      revision: commit,
      manifestHash: await digest(JSON.stringify(manifest)),
      license,
    },
  };
}
it("admits one operator-approved edition with all public gates closed and keeps normal review", async () => {
  const { t, manifest } = await fresh();
  vi.stubEnv("INTAKE_OPEN", "false");
  vi.stubEnv("REGISTRATION_OPEN", "false");
  vi.stubEnv("GITHUB_INTAKE_OPEN", "false");
  const args = await operatorInput(manifest);
  const c = await t.action(internal.intakeWorker.submitOperator, args);
  expect(c.status).toBe("checking");
  await drain(t);
  const row = await get(t, c.intakeId);
  expect(row.status).toBe("reviewing");
  await t.run(async (ctx) => {
    const stored = (await ctx.db.query("intakes").collect())[0];
    expect(JSON.parse(stored.manifest)).toEqual(manifest);
    const owner = await ctx.db.get(stored.owner);
    expect(owner!.repository).toBe(repository);
    expect(owner!.role).toBe("writer");
    expect(
      (await ctx.db.query("mains").collect()).some(
        (m) => m.mainId === manifest.branchId,
      ),
    ).toBe(false);
    const receipt = (await ctx.db.query("receipts").collect()).find(
      (r) => r.actor === "operator-intake",
    )!;
    expect(receipt.result.author).toBe(stored.owner);
    const editor = await ctx.db
      .query("agents")
      .filter((q) => q.eq(q.field("_id"), receipt.result.operator))
      .first();
    expect(editor!.role).toBe("editor");
    const events = (await ctx.db.query("audits").collect()).filter((a) =>
      a.event.startsWith("intake.operator."),
    );
    expect(events.map((a) => a.event)).toEqual([
      "intake.operator.approved",
      "intake.operator.received",
    ]);
    expect(events.every((a) => a.actor === receipt.result.operator)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain(args.hash);
    expect(JSON.stringify(receipt)).not.toContain(args.editorHash);
  });
  const r = await post(t, "intakes", {
    ...args,
    revision: commit,
    license,
    operatorProvisioning: true,
  });
  expect(r.data.error).toBe("INTAKE_CLOSED");
  expect(process.env.INTAKE_OPEN).toBe("false");
});
it("retries an operator case without fetching or creating it again", async () => {
  const { t, manifest, fetcher } = await fresh();
  vi.stubEnv("INTAKE_OPEN", "false");
  const args = await operatorInput(manifest);
  const first = await t.action(internal.intakeWorker.submitOperator, args);
  await drain(t);
  fetcher.mockRejectedValue(new Error("offline"));
  expect(await t.action(internal.intakeWorker.submitOperator, args)).toEqual(
    first,
  );
  await t.run(async (ctx) => {
    expect(await ctx.db.query("intakes").collect()).toHaveLength(1);
  });
});
it("pins the original approval before network failure and resumes with the same request", async () => {
  const { t, manifest, fetcher } = await fresh();
  vi.stubEnv("INTAKE_OPEN", "false");
  const args = await operatorInput(manifest);
  fetcher.mockRejectedValueOnce(new Error("offline"));
  await expect(
    t.action(internal.intakeWorker.submitOperator, args),
  ).rejects.toThrow();
  await expect(
    t.action(internal.intakeWorker.submitOperator, {
      ...args,
      approval: { ...args.approval, revision: next },
    }),
  ).rejects.toThrow("REQUEST_ID_REUSED");
  const c = await t.action(internal.intakeWorker.submitOperator, args);
  await drain(t);
  expect((await get(t, c.intakeId)).status).toBe("reviewing");
});
it.each(["parent", "influences", "contentHash"])(
  "rejects a changed manifest %s against the approved bytes",
  async (field) => {
    const { t, manifest, fetcher } = await fresh({
      provenance: {
        ...provenance,
        influences: [
          ...provenance.influences,
          { title: "Second classic", relationship: "A separate motif" },
        ],
      },
    });
    const args = await operatorInput(manifest);
    const altered = structuredClone(manifest);
    if (field === "parent") altered.parent.revision = next;
    if (field === "influences") altered.provenance.influences.reverse();
    if (field === "contentHash")
      altered.episodes[0].contentHash = "0".repeat(64);
    fetcher.mockResolvedValue(new Response(JSON.stringify(altered)));
    await expect(
      t.action(internal.intakeWorker.submitOperator, args),
    ).rejects.toThrow("APPROVED_MANIFEST_MISMATCH");
    await t.run(async (ctx) => {
      expect(await ctx.db.query("intakes").collect()).toHaveLength(0);
    });
  },
);

it.each(["writer", "auditor"] as const)(
  "rejects %s as operator even through the internal action",
  async (role) => {
    const { t, manifest, fetcher } = await fresh();
    const args = await operatorInput(manifest);
    await expect(
      t.action(internal.intakeWorker.submitOperator, {
        ...args,
        editorHash: await digest(keys[role]),
      }),
    ).rejects.toThrow("FORBIDDEN");
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each(["pending", "blocked", "revoked", "expired", "pendingClaim"])(
  "rejects an author who is %s",
  async (condition) => {
    const { t, manifest, fetcher } = await fresh();
    const args = await operatorInput(manifest);
    await t.run(async (ctx) => {
      const key = (await ctx.db
        .query("keys")
        .withIndex("hash", (q) => q.eq("hash", args.hash))
        .unique())!;
      if (["pending", "blocked"].includes(condition))
        await ctx.db.patch(key.agentId, { status: condition });
      else if (condition === "revoked")
        await ctx.db.patch(key._id, { revoked: true });
      else if (condition === "expired")
        await ctx.db.patch(key._id, { expiresAt: Date.now() - 1 });
      else
        await ctx.db.patch(key._id, {
          pendingClaim: {
            challenge: "proof",
            expiresAt: Date.now() + 10000,
            agentName: "writer",
            operatorName: "writer",
          },
        });
    });
    await expect(
      t.action(internal.intakeWorker.submitOperator, args),
    ).rejects.toThrow("UNAUTHORIZED");
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it("rechecks authorization after fetching and before creating the case", async () => {
  const { t, manifest, fetcher } = await fresh();
  const args = await operatorInput(manifest);
  fetcher.mockImplementationOnce(async () => {
    await t.run(async (ctx) => {
      const key = (await ctx.db
        .query("keys")
        .withIndex("hash", (q) => q.eq("hash", args.editorHash))
        .unique())!;
      await ctx.db.patch(key._id, { revoked: true });
    });
    return new Response(JSON.stringify(manifest));
  });
  await expect(
    t.action(internal.intakeWorker.submitOperator, args),
  ).rejects.toThrow("UNAUTHORIZED");
  await t.run(async (ctx) => {
    expect(await ctx.db.query("intakes").collect()).toHaveLength(0);
  });
});
it("rejects another repository and missing consent before fetching", async () => {
  const { t, manifest, fetcher } = await fresh();
  const args = await operatorInput(manifest);
  await expect(
    t.action(internal.intakeWorker.submitOperator, {
      ...args,
      approval: {
        ...args.approval,
        repository: "https://github.com/stranger/story",
      },
    }),
  ).rejects.toThrow("MANIFEST_MISMATCH");
  await expect(
    t.action(internal.intakeWorker.submitOperator, {
      ...args,
      approval: {
        ...args.approval,
        license: { ...license, humanApproved: false },
      },
    }),
  ).rejects.toThrow("WORK_CONSENT_REQUIRED");
  expect(fetcher).not.toHaveBeenCalled();
});
it("rejects a mismatching approved branch and preserves normal version conflicts", async () => {
  const { t, manifest } = await fresh();
  const args = await operatorInput(manifest);
  await expect(
    t.action(internal.intakeWorker.submitOperator, {
      ...args,
      approval: { ...args.approval, branchId: "different-branch" },
    }),
  ).rejects.toThrow("MANIFEST_MISMATCH");
  await seedCheckedBranch(t, manifest, 5);
  await expect(
    t.action(internal.intakeWorker.submitOperator, {
      ...args,
      requestId: "stale-version",
      approval: { ...args.approval, expectedVersion: 4 },
    }),
  ).rejects.toThrow("VERSION_CONFLICT");
});
it("preserves parent and lineage restrictions for operator admission", async () => {
  const { t, manifest } = await fresh();
  const args = await operatorInput(manifest);
  await t.run(async (ctx) => {
    const lineage = (await ctx.db.query("contentLineages").first())!;
    await ctx.db.patch(lineage._id, { status: "draft" });
  });
  await expect(
    t.action(internal.intakeWorker.submitOperator, args),
  ).rejects.toThrow();
  await t.run(async (ctx) => {
    expect(await ctx.db.query("intakes").collect()).toHaveLength(0);
  });
});
it("coalesces concurrent operator submissions and new request IDs for the same fixed edition", async () => {
  const { t, manifest } = await fresh();
  const args = await operatorInput(manifest);
  const [a, b] = await Promise.all([
    t.action(internal.intakeWorker.submitOperator, args),
    t.action(internal.intakeWorker.submitOperator, {
      ...args,
      requestId: "duplicate-receipt",
    }),
  ]);
  expect(a.intakeId).toBe(b.intakeId);
  await drain(t);
  await t.run(async (ctx) => {
    expect(await ctx.db.query("intakes").collect()).toHaveLength(1);
  });
});
it("does not publish an approved manifest whose fetched manuscript hash is wrong", async () => {
  const { t, manifest, fetcher } = await fresh();
  const args = await operatorInput(manifest);
  const normal = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) =>
    String(url).endsWith("manuscript/02.md")
      ? new Response("changed text")
      : normal(url, init),
  );
  const c = await t.action(internal.intakeWorker.submitOperator, args);
  await drain(t);
  const row = await get(t, c.intakeId);
  expect(row.status).toBe("failed");
  expect(row.error).toBe("CONTENT_HASH_MISMATCH");
});
it("keeps a fixed listed parent usable when its branch has advanced", async () => {
  const { t, manifest } = await fresh();
  await t.run(async (ctx) => {
    const root = (await ctx.db.query("branches").first())!;
    await ctx.db.patch(root._id, { revision: next, version: root.version + 1 });
  });
  const c = await t.action(
    internal.intakeWorker.submitOperator,
    await operatorInput(manifest),
  );
  await drain(t);
  expect((await get(t, c.intakeId)).status).toBe("reviewing");
});
it("rejects a withdrawn fixed parent rather than replacing it with a newer edition", async () => {
  const { t, manifest } = await fresh();
  await t.run(async (ctx) => {
    const parent = (await ctx.db.query("episodes").first())!;
    await ctx.db.patch(parent._id, {
      lifecycle: "withdrawn",
      withdrawnAt: Date.now(),
    });
  });
  await expect(
    t.action(
      internal.intakeWorker.submitOperator,
      await operatorInput(manifest),
    ),
  ).rejects.toThrow();
  await t.run(async (ctx) => {
    expect(await ctx.db.query("intakes").collect()).toHaveLength(0);
  });
});
