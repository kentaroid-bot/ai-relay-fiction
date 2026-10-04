import { v, ConvexError } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  identity,
  limit,
  executeCommand,
  storeCheckedSource,
  setBranchPublication,
} from "./desk";
import { contentCommand } from "./contentCommands";
import { fingerprint, reviewValidator, targetValidator } from "./contentSafety";
import {
  currentReview,
  episodeTarget,
  requireLineage,
  getLineage,
} from "./lineage";
import { applyDeclaredMain } from "./forest";
import { fail, text, revision, repo } from "./policy";
import { gateValidator } from "./safety";
import { parentRef } from "./schema";

const ACTIVE_WORK = ["checking", "reading"];
const MAX_ATTEMPTS = 3;
// Up to 20 bounded source fetches, each with a 10 second timeout.
const LEASE_MS = 300_000;
type Ctx = QueryCtx | MutationCtx;
async function branchFor(ctx: Ctx, c: Doc<"intakes">) {
  return ctx.db
    .query("branches")
    .withIndex("branchId", (q) => q.eq("branchId", c.branchId))
    .unique();
}
async function current(ctx: Ctx, c: Doc<"intakes">) {
  const b = await branchFor(ctx, c);
  if (
    !b ||
    b.revision !== c.revision ||
    b.version !== c.branchVersion ||
    b.owner !== c.owner
  )
    fail("INTAKE_SUPERSEDED");
  if ((await ctx.db.get(c.owner))?.status !== "active") fail("FORBIDDEN");
  await requireLineage(ctx, b.lineageId);
  return b;
}
async function access(ctx: Ctx, hash: string, intakeId: Id<"intakes">) {
  const { agent } = await identity(ctx, hash);
  const c = await ctx.db.get(intakeId);
  if (
    !c ||
    (agent._id !== c.owner && !["editor", "auditor"].includes(agent.role))
  )
    fail("FORBIDDEN");
  return { agent, c };
}
async function event(
  ctx: MutationCtx,
  c: Doc<"intakes">,
  kind: string,
  message: string,
) {
  const owner = await ctx.db.get(c.owner);
  const id = await ctx.db.insert("intakeEvents", {
    intakeId: c._id,
    kind,
    text: message,
    version: c.version,
    recipient: owner!.repository,
    delivery: "pending",
    attempts: 0,
    generation: 0,
    leaseUntil: 0,
    ...(c.githubPr ? { githubPr: c.githubPr } : {}),
    ...(kind === "needs_author" ? { questions: c.questions } : {}),
  });
  await ctx.scheduler.runAfter(0, internal.intakeWorker.notify, {
    eventId: id,
  });
}
async function transition(
  ctx: MutationCtx,
  c: Doc<"intakes">,
  status: string,
  message: string,
  patch: Partial<Doc<"intakes">> = {},
) {
  const update = {
    ...patch,
    status,
    version: c.version + 1,
    updatedAt: Date.now(),
  };
  await ctx.db.patch(c._id, update);
  const next = { ...c, ...update };
  await event(ctx, next, status, message);
  return next;
}
async function receipt(
  ctx: MutationCtx,
  actor: string,
  requestId: string,
  value: unknown,
) {
  text(requestId, 100, "REQUEST_ID");
  const fp = await fingerprint(value);
  const old = await ctx.db
    .query("receipts")
    .withIndex("request", (q) =>
      q.eq("actor", actor).eq("requestId", requestId),
    )
    .unique();
  if (old && old.fingerprint !== fp) fail("REQUEST_ID_REUSED");
  return { old, fp };
}
async function saveReceipt(
  ctx: MutationCtx,
  actor: string,
  requestId: string,
  fp: string,
  result: any,
) {
  await ctx.db.insert("receipts", {
    actor,
    requestId,
    fingerprint: fp,
    result,
  });
  return result;
}
export const submitContext = internalMutation({
  args: { hash: v.string() },
  handler: async (ctx, { hash }) => {
    if (process.env.INTAKE_OPEN !== "true") fail("INTAKE_CLOSED");
    const { agent } = await identity(ctx, hash);
    if (agent.role === "auditor") fail("FORBIDDEN");
    await limit(ctx, "intake-fetch:" + agent._id, 20);
    return { repository: agent.repository };
  },
});
export const submit = internalMutation({
  args: {
    hash: v.string(),
    requestId: v.string(),
    manifest: v.any(),
    revision: v.string(),
    license: v.any(),
    expectedVersion: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (process.env.INTAKE_OPEN !== "true") fail("INTAKE_CLOSED");
    const { agent } = await identity(ctx, args.hash);
    if (agent.role === "auditor") fail("FORBIDDEN");
    const m = args.manifest;
    if (m.schemaVersion !== 1 || repo(m.repository) !== agent.repository)
      fail("MANIFEST_MISMATCH");
    revision(args.revision);
    const branchId = text(m.branchId, 80, "BRANCH_ID");
    const actor = "intake:" + agent._id;
    const { old, fp } = await receipt(ctx, actor, args.requestId, {
      ...args,
      hash: undefined,
    });
    if (old) return old.result;
    const b = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", branchId))
      .unique();
    if (b && b.owner !== agent._id) fail("FORBIDDEN");
    // An unchanged fixed edition already has a case; changing transport request IDs does not duplicate it.
    const cases = await ctx.db
      .query("intakes")
      .withIndex("branch", (q) => q.eq("branchId", branchId))
      .order("desc")
      .take(50);
    const existing = await ctx.db
      .query("intakes")
      .withIndex("edition", (q) =>
        q.eq("branchId", branchId).eq("revision", args.revision),
      )
      .unique();
    if (existing)
      return saveReceipt(ctx, actor, args.requestId, fp, {
        intakeId: existing._id,
        status: existing.status,
        version: existing.version,
      });
    if (b && args.expectedVersion !== b.version) fail("VERSION_CONFLICT");
    if (
      m.license !== args.license?.id ||
      m.termsVersion !== args.license?.termsVersion
    )
      fail("WORK_LICENSE_MISMATCH");
    const result = await executeCommand(ctx, {
      hash: args.hash,
      operation: b ? "branch.update" : "branch.create",
      requestId: "intake:" + args.requestId,
      fingerprint: fp,
      body: {
        ...m,
        revision: args.revision,
        license: args.license,
        readingUrl: agent.repository,
        expectedVersion: args.expectedVersion,
      },
    });
    for (const oldCase of cases.filter(
      (c) => !["published", "rejected", "superseded"].includes(c.status),
    ))
      await transition(
        ctx,
        oldCase,
        "superseded",
        "新しい版を受け付けました。この版の処理を終了します。",
        { generation: oldCase.generation + 1 },
      );
    const id = await ctx.db.insert("intakes", {
      owner: agent._id,
      branchId,
      revision: args.revision,
      branchVersion: result.version,
      version: 1,
      status: "checking",
      manifest: JSON.stringify(m),
      questions: [],
      readings: [],
      attempts: 0,
      generation: 0,
      leaseUntil: 0,
      updatedAt: Date.now(),
    });
    await event(
      ctx,
      (await ctx.db.get(id))!,
      "received",
      "原稿を受け付けました。固定版の確認と読書を進めます。返信は不要です。",
    );
    await ctx.scheduler.runAfter(0, internal.intakeWorker.process, {
      intakeId: id,
    });
    return saveReceipt(ctx, actor, args.requestId, fp, {
      intakeId: id,
      status: "checking",
      version: 1,
    });
  },
});
export const get = internalQuery({
  args: { hash: v.string(), intakeId: v.id("intakes") },
  handler: async (ctx, { hash, intakeId }) => {
    const { c } = await access(ctx, hash, intakeId);
    const b = await branchFor(ctx, c);
    const lineage = await getLineage(ctx, b?.lineageId);
    const episodes = await ctx.db
      .query("episodes")
      .withIndex("branchRevision", (q) =>
        q.eq("branchId", c.branchId).eq("revision", c.revision),
      )
      .take(21);
    const evidence = b
      ? await Promise.all(
          episodes.map(async (ep) => ({
            target: episodeTarget(b, ep),
            provenance: ep.provenance,
            readingUrl: b.repository + "/blob/" + ep.revision + "/" + ep.path,
            review: (await currentReview(ctx, b, ep))?.review ?? null,
          })),
        )
      : [];
    const events = await ctx.db
      .query("intakeEvents")
      .withIndex("intake", (q) => q.eq("intakeId", intakeId))
      .order("desc")
      .take(100);
    return {
      ...c,
      evidence,
      events,
      worldUrl: lineage
        ? lineage.worldRepository +
          "/blob/" +
          lineage.worldRevision +
          "/world.md"
        : null,
      current:
        !!b && b.revision === c.revision && b.version === c.branchVersion,
    };
  },
});
export const list = internalQuery({
  args: {
    hash: v.string(),
    cursor: v.optional(v.string()),
    status: v.optional(v.string()),
  },
  handler: async (ctx, { hash, cursor, status }) => {
    const { agent } = await identity(ctx, hash);
    const q =
      agent.role === "writer"
        ? ctx.db
            .query("intakes")
            .withIndex("owner", (q) => q.eq("owner", agent._id))
        : status
          ? ctx.db
              .query("intakes")
              .withIndex("status", (q) => q.eq("status", status))
          : ctx.db.query("intakes");
    const page = await q
      .order("desc")
      .paginate({ numItems: 20, cursor: cursor ?? null });
    return { ...page, page: page.page.map(({ manifest, ...c }) => c) };
  },
});
export const review = internalMutation({
  args: {
    hash: v.string(),
    intakeId: v.id("intakes"),
    expectedVersion: v.number(),
    requestId: v.string(),
    reviews: v.array(
      v.object({ target: targetValidator, review: reviewValidator }),
    ),
    questions: v.array(v.string()),
    findingsAcknowledged: v.boolean(),
    readingAcknowledged: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { agent, c } = await access(ctx, args.hash, args.intakeId);
    if (agent.role !== "auditor" || agent._id === c.owner) fail("FORBIDDEN");
    const actor = "intake-review:" + agent._id;
    const { old, fp } = await receipt(ctx, actor, args.requestId, {
      ...args,
      hash: undefined,
    });
    if (old) return old.result;
    const b = await current(ctx, c);
    if (agent.repository === b.repository) fail("REVIEWER_NOT_INDEPENDENT");
    if (c.version !== args.expectedVersion) fail("VERSION_CONFLICT");
    if (c.status !== "reviewing") fail("INVALID_TRANSITION");
    await limit(ctx, "intake-review:" + agent._id, 100);
    if (
      args.questions.length > 20 ||
      args.reviews.length < 1 ||
      args.reviews.length > 20
    )
      fail("INVALID_REVIEW_BATCH");
    const questions = args.questions.map((q) => text(q, 2000, "QUESTION"));
    if (
      questions.length &&
      args.reviews.every((r) => r.review.decision === "eligible")
    )
      fail("QUESTIONS_REQUIRE_HOLD");
    const episodes = await ctx.db
      .query("episodes")
      .withIndex("branchRevision", (q) =>
        q.eq("branchId", c.branchId).eq("revision", c.revision),
      )
      .take(21);
    if (args.reviews.length !== episodes.length)
      fail("REVIEW_BATCH_INCOMPLETE");
    const seen = new Set<string>();
    for (const r of args.reviews) {
      if (
        r.target.branchId !== c.branchId ||
        r.target.revision !== c.revision ||
        seen.has(r.target.episodeId) ||
        !episodes.some((ep) => ep.episodeId === r.target.episodeId)
      )
        fail("REVIEW_TARGET_MISMATCH");
      seen.add(r.target.episodeId);
      if (
        r.review.decision === "eligible" &&
        b.provenance?.influences?.some(
          (influence) =>
            !r.review.candidates.some(
              (candidate) =>
                candidate.title === influence.title &&
                ["public_influence", "comparison"].includes(
                  candidate.relationship ?? "",
                ),
            ),
        )
      )
        fail("DECLARED_INFLUENCE_NOT_CHECKED");
      await contentCommand(ctx, agent, "review.record", r);
    }
    let next;
    if (args.reviews.some((r) => r.review.decision === "rejected")) {
      next = await transition(
        ctx,
        c,
        "rejected",
        "この版は掲載を見送りました。案件の審査記録をご確認ください。",
        { questions },
      );
    } else if (questions.length) {
      next = await transition(
        ctx,
        c,
        "needs_author",
        "審査の確認事項をまとめました。案件に一度の返信で回答できます。",
        { questions },
      );
    } else {
      // Incomplete comparisons cannot become an implicit approval.
      let ready = true;
      for (const ep of episodes) {
        const r = await currentReview(ctx, b, ep);
        if (
          r?.review.inspection !== "completed" ||
          r.review.rights !== "verified" ||
          r.review.decision !== "eligible"
        )
          ready = false;
      }
      if (!ready) {
        next = await transition(
          ctx,
          c,
          "reviewing",
          "比較審査を継続しています。現時点で作者への回答依頼はありません。",
        );
        return saveReceipt(ctx, actor, args.requestId, fp, {
          intakeId: c._id,
          status: next.status,
          version: next.version,
        });
      }
      if (
        c.readings.some(
          (r) =>
            r.status !== "completed" ||
            !r.result?.complete ||
            r.result?.concerns?.length ||
            r.result?.rightsEvidence !== "declared",
        ) &&
        !args.readingAcknowledged
      )
        fail("READING_REVIEW_REQUIRED");
      const published = await setBranchPublication(ctx, agent, {
        branchId: b.branchId,
        expectedVersion: b.version,
        status: "verified",
        findingsAcknowledged: args.findingsAcknowledged,
        complianceNote: "案件の独立比較審査と読書結果を確認し掲載",
      });
      await event(
        ctx,
        c,
        "review_passed",
        "審査を通過しました。掲載へ進みます。返信は不要です。",
      );
      next = await transition(
        ctx,
        c,
        "published",
        "読書カタログへ掲載しました。",
        { branchVersion: published.version, questions: [] },
      );
      if (JSON.parse(c.manifest).main !== undefined) {
        try {
          // Nested mutation rollback keeps an invalid main selection from undoing publication.
          await ctx.runMutation(internal.intake.selectMain, {
            intakeId: c._id,
          });
          await ctx.db.patch(c._id, { mainSelection: { status: "completed" } });
        } catch (e) {
          const code =
            e instanceof ConvexError &&
            typeof e.data === "string" &&
            /^[A-Z_]+$/.test(e.data)
              ? e.data
              : "MAIN_SELECTION_FAILED";
          await ctx.db.patch(c._id, {
            mainSelection: { status: "failed", error: code },
          });
          await event(
            ctx,
            next,
            "main_selection_failed",
            "掲載は完了しましたが、宣言されたmainへの接続を確認してください。",
          );
        }
      }
    }
    return saveReceipt(ctx, actor, args.requestId, fp, {
      intakeId: c._id,
      status: next.status,
      version: next.version,
    });
  },
});
export const reply = internalMutation({
  args: {
    hash: v.string(),
    intakeId: v.id("intakes"),
    expectedVersion: v.number(),
    requestId: v.string(),
    answer: v.string(),
  },
  handler: async (ctx, args) => {
    const { agent, c } = await access(ctx, args.hash, args.intakeId);
    if (agent._id !== c.owner) fail("FORBIDDEN");
    const actor = "intake-reply:" + agent._id;
    const { old, fp } = await receipt(ctx, actor, args.requestId, {
      ...args,
      hash: undefined,
    });
    if (old) return old.result;
    await current(ctx, c);
    if (c.version !== args.expectedVersion) fail("VERSION_CONFLICT");
    if (c.status !== "needs_author") fail("INVALID_TRANSITION");
    await limit(ctx, actor, 30);
    // Reply text is evidence, never an instruction and never a change to provenance.
    await event(ctx, c, "author_reply", text(args.answer, 8000, "ANSWER"));
    const next = await transition(
      ctx,
      c,
      "reviewing",
      "回答を受け付けました。審査を再開します。返信は不要です。",
    );
    return saveReceipt(ctx, actor, args.requestId, fp, {
      intakeId: c._id,
      version: next.version,
      status: next.status,
    });
  },
});

// Only internal scheduled functions can claim or complete server work. No participant keys are persisted.
export const claim = internalMutation({
  args: { intakeId: v.id("intakes") },
  handler: async (ctx, { intakeId }) => {
    const c = await ctx.db.get(intakeId);
    if (!c || !ACTIVE_WORK.includes(c.status) || c.leaseUntil > Date.now())
      return null;
    let b;
    try {
      b = await current(ctx, c);
    } catch {
      await transition(
        ctx,
        c,
        "superseded",
        "対象の版または受付条件が変わったため処理を停止しました。",
      );
      return null;
    }
    if (c.attempts >= MAX_ATTEMPTS) {
      if (c.status === "reading") {
        const episodes = await ctx.db
          .query("episodes")
          .withIndex("branchRevision", (q) =>
            q.eq("branchId", c.branchId).eq("revision", c.revision),
          )
          .take(21);
        const ep = episodes[c.readings.length];
        if (ep) {
          await ctx.runMutation(internal.intake.read, {
            intakeId,
            generation: c.generation,
            episodeId: ep.episodeId,
            status: "failed",
          });
          return null;
        }
      }
      await transition(
        ctx,
        c,
        "failed",
        "サーバー処理に失敗しました。再実行できます。",
        { error: c.error ?? "WORK_TIMEOUT", leaseUntil: 0 },
      );
      return null;
    }
    const generation = c.generation + 1;
    await ctx.db.patch(c._id, {
      generation,
      attempts: c.attempts + 1,
      leaseUntil: Date.now() + LEASE_MS,
    });
    await ctx.scheduler.runAfter(LEASE_MS + 1, internal.intakeWorker.process, {
      intakeId,
    });
    const episodes = await ctx.db
      .query("episodes")
      .withIndex("branchRevision", (q) =>
        q.eq("branchId", c.branchId).eq("revision", c.revision),
      )
      .take(21);
    return {
      ...c,
      generation,
      branch: { ...b, isLineageRoot: false },
      episodes,
    };
  },
});
export const checked = internalMutation({
  args: {
    intakeId: v.id("intakes"),
    generation: v.number(),
    episodes: v.array(
      v.object({
        episodeId: v.string(),
        path: v.string(),
        contentHash: v.string(),
        title: v.string(),
        parent: v.union(parentRef, v.null()),
        sourceRef: v.optional(parentRef),
      }),
    ),
    characters: v.array(
      v.object({
        characterId: v.string(),
        name: v.string(),
        origin: parentRef,
        description: v.string(),
      }),
    ),
    gate: gateValidator,
  },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.intakeId);
    if (!c || c.status !== "checking" || c.generation !== args.generation)
      return;
    await current(ctx, c);
    const owner = (await ctx.db.get(c.owner))!;
    const checked = await storeCheckedSource(ctx, owner, {
      ...args,
      branchId: c.branchId,
      version: c.branchVersion,
    });
    await transition(
      ctx,
      c,
      "reading",
      "固定版の確認が完了しました。読書と比較審査へ進みます。返信は不要です。",
      {
        branchVersion: checked.version,
        attempts: 0,
        leaseUntil: 0,
        error: undefined,
      },
    );
    await ctx.scheduler.runAfter(0, internal.intakeWorker.process, {
      intakeId: c._id,
    });
  },
});
export const read = internalMutation({
  args: {
    intakeId: v.id("intakes"),
    generation: v.number(),
    episodeId: v.string(),
    status: v.string(),
    result: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.intakeId);
    if (!c || c.status !== "reading" || c.generation !== args.generation)
      return;
    await current(ctx, c);
    const episodes = await ctx.db
      .query("episodes")
      .withIndex("branchRevision", (q) =>
        q.eq("branchId", c.branchId).eq("revision", c.revision),
      )
      .take(21);
    const ep = episodes[c.readings.length];
    if (!ep || ep.episodeId !== args.episodeId) fail("READING_TARGET_MISMATCH");
    const readings = [
      ...c.readings,
      {
        episodeId: args.episodeId,
        status: args.status,
        ...(args.result ? { result: args.result } : {}),
      },
    ];
    const patch = { readings, attempts: 0, leaseUntil: 0, error: undefined };
    if (readings.length === episodes.length)
      await transition(
        ctx,
        c,
        "reviewing",
        "比較審査を受け付けています。結果または確認事項を通知します。",
        patch,
      );
    else {
      await ctx.db.patch(c._id, patch);
      await ctx.scheduler.runAfter(0, internal.intakeWorker.process, {
        intakeId: c._id,
      });
    }
  },
});
export const workFailed = internalMutation({
  args: { intakeId: v.id("intakes"), generation: v.number(), code: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.intakeId);
    if (
      !c ||
      !ACTIVE_WORK.includes(c.status) ||
      c.generation !== args.generation
    )
      return;
    await ctx.db.patch(c._id, { error: args.code, leaseUntil: 0 });
    await ctx.scheduler.runAfter(
      1000 * 2 ** c.attempts,
      internal.intakeWorker.process,
      { intakeId: c._id },
    );
  },
});
export const retry = internalMutation({
  args: { hash: v.string(), intakeId: v.id("intakes") },
  handler: async (ctx, { hash, intakeId }) => {
    const { agent, c } = await access(ctx, hash, intakeId);
    if (agent.role === "auditor") fail("FORBIDDEN");
    const b = await current(ctx, c);
    if (c.status !== "failed") fail("INVALID_TRANSITION");
    await limit(ctx, "intake-retry:" + agent._id, 10);
    const next = await transition(
      ctx,
      c,
      b.status === "pending" ? "checking" : "reading",
      "サーバー処理を再開しました。",
      {
        attempts: 0,
        generation: c.generation + 1,
        leaseUntil: 0,
        error: undefined,
      },
    );
    await ctx.scheduler.runAfter(0, internal.intakeWorker.process, {
      intakeId,
    });
    return { intakeId, version: next.version, status: next.status };
  },
});
export const claimNotification = internalMutation({
  args: { eventId: v.id("intakeEvents") },
  handler: async (ctx, { eventId }) => {
    const e = await ctx.db.get(eventId);
    if (!e || e.delivery !== "pending" || e.leaseUntil > Date.now())
      return null;
    if (e.attempts >= MAX_ATTEMPTS) {
      await ctx.db.patch(e._id, {
        delivery: "failed",
        error: e.error ?? "DELIVERY_TIMEOUT",
      });
      return null;
    }
    const generation = e.generation + 1;
    await ctx.db.patch(e._id, {
      attempts: e.attempts + 1,
      generation,
      leaseUntil: Date.now() + LEASE_MS,
    });
    await ctx.scheduler.runAfter(LEASE_MS + 1, internal.intakeWorker.notify, {
      eventId,
    });
    return { ...e, generation };
  },
});
export const notificationResult = internalMutation({
  args: {
    eventId: v.id("intakeEvents"),
    generation: v.number(),
    outcome: v.union(
      v.literal("delivered"),
      v.literal("unconfigured"),
      v.literal("failed"),
    ),
  },
  handler: async (ctx, args) => {
    const e = await ctx.db.get(args.eventId);
    if (!e || e.delivery !== "pending" || e.generation !== args.generation)
      return;
    if (args.outcome === "failed") {
      await ctx.db.patch(e._id, { error: "DELIVERY_FAILED", leaseUntil: 0 });
      await ctx.scheduler.runAfter(
        1000 * 2 ** e.attempts,
        internal.intakeWorker.notify,
        { eventId: e._id },
      );
    } else
      await ctx.db.patch(e._id, {
        delivery: args.outcome,
        leaseUntil: 0,
        error: undefined,
      });
  },
});
export const retryNotifications = internalMutation({
  args: { hash: v.string(), intakeId: v.id("intakes") },
  handler: async (ctx, { hash, intakeId }) => {
    const { agent } = await access(ctx, hash, intakeId);
    if (agent.role !== "editor") fail("FORBIDDEN");
    const events = await ctx.db
      .query("intakeEvents")
      .withIndex("intake", (q) => q.eq("intakeId", intakeId))
      .collect();
    let count = 0;
    for (const e of events.filter((e) =>
      ["failed", "unconfigured"].includes(e.delivery),
    )) {
      await ctx.db.patch(e._id, {
        delivery: "pending",
        attempts: 0,
        generation: e.generation + 1,
        leaseUntil: 0,
        error: undefined,
      });
      await ctx.scheduler.runAfter(0, internal.intakeWorker.notify, {
        eventId: e._id,
      });
      count++;
    }
    return { queued: count };
  },
});

// Called only after GitHub's signed webhook and the existing ownership/consent import.
export const adoptGithub = internalMutation({
  args: {
    hash: v.string(),
    branchId: v.string(),
    revision: v.string(),
    manifest: v.any(),
    number: v.number(),
    login: v.string(),
  },
  handler: async (ctx, args) => {
    if (process.env.INTAKE_OPEN !== "true") fail("INTAKE_CLOSED");
    const { agent } = await identity(ctx, args.hash);
    if (agent.role !== "editor") fail("FORBIDDEN");
    const b = await ctx.db
      .query("branches")
      .withIndex("branchId", (q) => q.eq("branchId", args.branchId))
      .unique();
    if (
      !b ||
      b.revision !== args.revision ||
      b.githubPr?.number !== args.number
    )
      fail("INTAKE_SUPERSEDED");
    await ctx.db.patch(b.owner, { githubPrOwner: args.login });
    const cases = await ctx.db
      .query("intakes")
      .withIndex("branch", (q) => q.eq("branchId", args.branchId))
      .order("desc")
      .take(50);
    const existing = await ctx.db
      .query("intakes")
      .withIndex("edition", (q) =>
        q.eq("branchId", args.branchId).eq("revision", args.revision),
      )
      .unique();
    if (existing)
      return {
        intakeId: existing._id,
        status: existing.status,
        version: existing.version,
      };
    if (b.status !== "pending") fail("CHECK_NOT_PENDING");
    for (const c of cases.filter(
      (c) => !["published", "rejected", "superseded"].includes(c.status),
    ))
      await transition(ctx, c, "superseded", "新しいPRの版を受け付けました。", {
        generation: c.generation + 1,
      });
    const id = await ctx.db.insert("intakes", {
      owner: b.owner,
      branchId: b.branchId,
      revision: b.revision,
      branchVersion: b.version,
      version: 1,
      status: "checking",
      manifest: JSON.stringify(args.manifest),
      questions: [],
      readings: [],
      attempts: 0,
      generation: 0,
      leaseUntil: 0,
      updatedAt: Date.now(),
      githubPr: args.number,
    });
    await event(
      ctx,
      (await ctx.db.get(id))!,
      "received",
      "PRの固定版を受け付けました。APIへの再提出は不要です。",
    );
    await ctx.scheduler.runAfter(0, internal.intakeWorker.process, {
      intakeId: id,
    });
    return { intakeId: id, status: "checking", version: 1 };
  },
});
export const githubReply = internalMutation({
  args: {
    hash: v.string(),
    number: v.number(),
    login: v.string(),
    commentId: v.string(),
    answer: v.string(),
    intakeId: v.id("intakes"),
    expectedVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const { agent } = await identity(ctx, args.hash);
    if (agent.role !== "editor") fail("FORBIDDEN");
    // Webhook content cannot select an arbitrary case or owner.
    const branches = await ctx.db
      .query("branches")
      .filter((q) => q.eq(q.field("githubPr.number"), args.number))
      .take(2);
    if (branches.length !== 1) fail("PR_CASE_AMBIGUOUS");
    const b = branches[0],
      owner = await ctx.db.get(b.owner);
    if (owner?.githubPrOwner !== args.login) fail("FORBIDDEN");
    const c = await ctx.db
      .query("intakes")
      .withIndex("branch", (q) => q.eq("branchId", b.branchId))
      .order("desc")
      .first();
    if (!c || c.githubPr !== args.number) fail("NOT_FOUND");
    const actor = "github-answer:" + args.number;
    const { old, fp } = await receipt(ctx, actor, args.commentId, {
      answer: args.answer,
      login: args.login,
    });
    if (old) return old.result;
    if (c._id !== args.intakeId || c.version !== args.expectedVersion)
      fail("VERSION_CONFLICT");
    await current(ctx, c);
    if (c.status !== "needs_author") fail("INVALID_TRANSITION");
    await limit(ctx, actor, 30);
    await event(ctx, c, "author_reply", text(args.answer, 8000, "ANSWER"));
    const next = await transition(
      ctx,
      c,
      "reviewing",
      "回答を受け付けました。審査を再開します。",
    );
    return saveReceipt(ctx, actor, args.commentId, fp, {
      intakeId: c._id,
      status: next.status,
      version: next.version,
    });
  },
});

export const selectMain = internalMutation({
  args: { intakeId: v.id("intakes") },
  handler: async (ctx, { intakeId }): Promise<void> => {
    const c = await ctx.db.get(intakeId);
    if (!c || c.status !== "published") fail("INVALID_TRANSITION");
    const b = await current(ctx, c);
    await applyDeclaredMain(ctx, b, JSON.parse(c.manifest));
  },
});
