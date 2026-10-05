import { notifyGithub } from "./intakeNotifications";
import { v, ConvexError } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { inspectSource } from "./sourceCheck";
import { digest, githubText, readBounded } from "./policy";
import {
  POLICY,
  MODEL,
  validateInput,
  validateReading,
} from "../reader/contract";

function endpoint(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw Error("INVALID_SERVICE_CONFIG");
  return url.href;
}
function errorCode(e: unknown) {
  return e instanceof ConvexError &&
    typeof e.data === "string" &&
    /^[A-Z_]+$/.test(e.data)
    ? e.data
    : "WORK_FAILED";
}
export const process = internalAction({
  args: { intakeId: v.id("intakes") },
  handler: async (ctx, { intakeId }): Promise<void> => {
    const work = await ctx.runMutation(internal.intake.claim, { intakeId });
    if (!work) return;
    const generation = work.generation;
    try {
      if (work.status === "checking") {
        await ctx.runMutation(internal.intake.checked, {
          intakeId,
          generation,
          ...(await inspectSource(work.branch)),
        });
        return;
      }
      const ep = work.episodes[work.readings.length];
      if (!ep) throw Error("READING_TARGET_MISSING");
      let result;
      let status = "unconfigured";
      const url = globalThis.process.env.INTAKE_READER_URL;
      const token = globalThis.process.env.INTAKE_READER_TOKEN;
      if (url && token) {
        const manuscript = await githubText(
          work.branch.repository,
          work.revision,
          ep.path,
        );
        if ((await digest(manuscript)) !== ep.contentHash)
          throw Error("CONTENT_HASH_MISMATCH");
        const episode = {
          branchId: ep.branchId,
          episodeId: ep.episodeId,
          revision: ep.revision,
          contentHash: ep.contentHash,
        };
        // Use the existing reader contract. Oversized works go to review explicitly; never silently truncate.
        let input;
        try {
          input = validateInput({
            episode,
            license: work.branch.license,
            manifest: work.manifest,
            manuscript,
          });
        } catch {
          status = "manual_required";
        }
        if (input) {
          const response = await fetch(endpoint(url), {
            method: "POST",
            redirect: "manual",
            signal: AbortSignal.timeout(30_000),
            headers: {
              Authorization: "Bearer " + token,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(input),
          });
          const value = JSON.parse(await readBounded(response, 16000));
          if (
            value.policy !== POLICY ||
            value.model !== MODEL ||
            Object.entries(episode).some(([k, x]) => value.episode?.[k] !== x)
          )
            throw Error("READING_TARGET_MISMATCH");
          result = validateReading(value.reading);
          status = "completed";
        }
      }
      await ctx.runMutation(internal.intake.read, {
        intakeId,
        generation,
        episodeId: ep.episodeId,
        status,
        ...(result ? { result } : {}),
      });
    } catch (e) {
      await ctx.runMutation(internal.intake.workFailed, {
        intakeId,
        generation,
        code: errorCode(e),
      });
    }
  },
});
export const notify = internalAction({
  args: { eventId: v.id("intakeEvents") },
  handler: async (ctx, { eventId }): Promise<void> => {
    const e = await ctx.runMutation(internal.intake.claimNotification, {
      eventId,
    });
    if (!e) return;
    let outcome: "unconfigured" | "delivered" | "failed" = "unconfigured";
    const url = globalThis.process.env.INTAKE_NOTIFY_URL;
    const token = globalThis.process.env.INTAKE_NOTIFY_TOKEN;
    const githubToken = globalThis.process.env.INTAKE_GITHUB_TOKEN;
    const githubLogin = globalThis.process.env.INTAKE_GITHUB_LOGIN;
    if (e.githubPr && githubToken && githubLogin && !(url && token)) {
      try {
        await notifyGithub(e, githubToken, githubLogin);
        outcome = "delivered";
      } catch {
        outcome = "failed";
      }
    } else if (url && token) {
      try {
        // Destination and credential are operator settings, never submitted manuscript data.
        // Only progress metadata is sent; questions, answers and private provenance stay behind authentication.
        const response = await fetch(endpoint(url), {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
            "Idempotency-Key": e._id,
          },
          body: JSON.stringify({
            eventId: e._id,
            intakeId: e.intakeId,
            recipient: e.recipient,
            kind: e.kind,
            version: e.version,
            occurredAt: e._creationTime,
          }),
        });
        outcome = response.ok ? "delivered" : "failed";
        await response.body?.cancel();
      } catch {
        outcome = "failed";
      }
    }
    await ctx.runMutation(internal.intake.notificationResult, {
      eventId,
      generation: e.generation,
      outcome,
    });
  },
});
