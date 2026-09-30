#!/usr/bin/env node
// Management broker. Manuscripts and AI prose never become commands or stdout.
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL,
  POLICY,
  validateInput,
  validateReading,
  mayList,
} from "../reader/contract.ts";

export const TEST_API = "https://exciting-peccary-307.convex.site";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const ref = (ep) => ({
  branchId: ep.branchId,
  episodeId: ep.episodeId,
  revision: ep.revision,
  contentHash: ep.contentHash,
});
export function decision(readings, findings) {
  return mayList(readings.map(validateReading), findings) ? "list" : "hold";
}
function outputSignals(reading) {
  const text = [reading.interesting, reading.continuation, reading.tone].join(
    "\n",
  );
  return /rly_[A-Za-z0-9_-]{43}|-----BEGIN .*PRIVATE KEY|https?:\/\/|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:管理キー|トークン).{0,20}(?:送信|取得|表示)|ignore\s+(all\s+)?previous/iu.test(
    text,
  );
}
export async function processBranch(data, deps) {
  const b = data.branch;
  if (
    b.status !== "checked" ||
    b.branchId === "origin" ||
    !Number.isInteger(b.version) ||
    !/^[a-z0-9-]{2,80}$/.test(b.branchId) ||
    !/^[a-f0-9]{40}$/.test(b.revision) ||
    b.gate?.source !== "fixed_source_hash_checked"
  )
    throw Error("CHECK_REQUIRED");
  if (
    !Array.isArray(data.episodes) ||
    !data.episodes.length ||
    data.episodes.length > 20
  )
    throw Error("INVALID_EPISODES");
  const license = b.license;
  if (!Array.isArray(b.gate.findings) || b.gate.terms !== "cc0_declared")
    throw Error("WORK_CONSENT_REQUIRED");
  const manifest = await deps.fetchSource(b, "relay-branch.json");
  const declaration = JSON.parse(manifest);
  if (
    declaration.branchId !== b.branchId ||
    declaration.repository !== b.repository ||
    declaration.license !== license?.id ||
    declaration.termsVersion !== license?.termsVersion
  )
    throw Error("WORK_LICENSE_MISMATCH");
  const caseId = sha(
    JSON.stringify({
      policy: POLICY,
      model: MODEL,
      branchId: b.branchId,
      version: b.version,
      revision: b.revision,
      episodes: data.episodes.map(ref),
    }),
  );
  const saved = await deps.load(caseId);
  const reports = [];
  for (const ep of data.episodes) {
    if (
      ep.branchId !== b.branchId ||
      ep.revision !== b.revision ||
      !/^manuscript\/[A-Za-z0-9_/-]+\.md$/.test(ep.path) ||
      ep.path.split("/").some((x) => !x || x === ".." || x === ".")
    )
      throw Error("INVALID_SOURCE_PATH");
    // fetchSource uses only this immutable repository/path; never authenticated.
    const manuscript = await deps.fetchSource(b, ep.path);
    if (sha(manuscript) !== ep.contentHash)
      throw Error("CONTENT_HASH_MISMATCH");
    const input = validateInput({
      episode: ref(ep),
      license,
      manifest,
      manuscript,
    });
    let report = saved?.reports?.find(
      (r) => JSON.stringify(r.episode) === JSON.stringify(input.episode),
    );
    if (!report) report = await deps.read(input);
    if (
      report.policy !== POLICY ||
      report.model !== MODEL ||
      JSON.stringify(report.episode) !== JSON.stringify(input.episode)
    )
      throw Error("READING_SOURCE_MISMATCH");
    validateReading(report.reading);
    reports.push(report);
    await deps.save(caseId, {
      caseId,
      version: b.version,
      revision: b.revision,
      reports: [...reports],
      outcome: "reading",
    });
  }
  const reportHash = sha(JSON.stringify(reports));
  const readings = reports.map((r) => r.reading);
  const outputSignal = readings.some(outputSignals);
  const outcome =
    decision(readings, b.gate.findings) === "list" && !outputSignal
      ? "listed"
      : "held";
  // Commit the review before any mutation. A restart reuses it and identical IDs.
  await deps.save(caseId, {
    caseId,
    reportHash,
    version: b.version,
    revision: b.revision,
    reports,
    outcome,
  });
  if (outcome === "listed") {
    const current = (await deps.getBranch(b.branchId)).branch;
    if (
      current.status === "checked" &&
      (current.version !== b.version || current.revision !== b.revision)
    )
      throw Error("VERSION_CONFLICT");
    if (
      current.status !== "checked" &&
      !(
        current.status === "verified" &&
        current.revision === b.revision &&
        current.compliance?.note?.includes(reportHash)
      )
    )
      throw Error("VERSION_CONFLICT");
    if (current.status === "checked") {
      await deps.command(
        "editor.branch",
        {
          branchId: b.branchId,
          expectedVersion: b.version,
          status: "verified",
          complianceNote: `${POLICY}; tool-free ${MODEL}; ${reports.length} episode(s); fixed source/hash and CC0 declaration checked; no observed concern codes; report SHA-256 ${reportHash}; not a legal or rights guarantee.`,
        },
        "reader-list-" + caseId,
      );
    }
    for (const report of reports) {
      const { contentHash, ...episode } = report.episode;
      // Prose is stored as private data only, never shown to a privileged model or executed.
      const { interesting, continuation, tone } = report.reading;
      await deps.command(
        "reading.note",
        { episode, interesting, continuation, tone },
        "reader-note-" + sha(caseId + contentHash + JSON.stringify(episode)),
      );
    }
  }
  return {
    branchId: b.branchId,
    version: b.version,
    revision: b.revision,
    outcome,
    episodes: reports.length,
    reportHash,
    concernCodes: [...new Set(readings.flatMap((r) => r.concerns))],
    sourceSignals: b.gate.findings,
    outputSignal,
    model: MODEL,
    policy: POLICY,
  };
}
async function bounded(response, limit) {
  if (!response.body) throw Error("SOURCE_UNAVAILABLE");
  const reader = response.body.getReader();
  const buffers = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error("READING_TOO_LARGE");
      buffers.push(Buffer.from(value));
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(buffers),
    );
  } finally {
    await reader.cancel();
  }
}
async function privateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path + ".next", JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(path + ".next", path);
}
async function run() {
  const args = process.argv.slice(2);
  const option = (flag, fallback) => {
    const i = args.indexOf(flag);
    if (i < 0) return fallback;
    const v = args[i + 1];
    if (!v || v.startsWith("--")) throw Error("INVALID_OPTION");
    args.splice(i, 2);
    return v;
  };
  const config = JSON.parse(
    await readFile(option("--profile", ".secrets/dev-editor.json"), "utf8"),
  );
  const readerConfig = JSON.parse(
    await readFile(option("--reader-profile", ".secrets/reader.json"), "utf8"),
  );
  const state = resolve(option("--state", ".secrets/reading-state"));
  if (
    args.length ||
    config.api !== TEST_API ||
    !/^https:\/\/ai-relay-reader\.[a-z0-9-]+\.workers\.dev$/.test(
      readerConfig.api,
    ) ||
    !/^[A-Za-z0-9_-]{43}$/.test(readerConfig.token)
  )
    throw Error("WRONG_INTAKE");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const lock = resolve(state, "reader.lock");
  try {
    await mkdir(lock);
  } catch (e) {
    if (e.code === "EEXIST") {
      console.log(JSON.stringify({ busy: true }));
      return;
    }
    throw e;
  }
  try {
    await privateJson(resolve(lock, "owner.json"), {
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    const api = async (path, operation, input, id) => {
      const response = await fetch(TEST_API + path, {
        redirect: "error",
        signal: AbortSignal.timeout(60000),
        method: operation ? "POST" : "GET",
        headers: {
          Authorization: "Bearer " + config.key,
          "Content-Type": "application/json",
          ...(id ? { "Idempotency-Key": id } : {}),
        },
        ...(operation ? { body: JSON.stringify({ operation, input }) } : {}),
      });
      const data = JSON.parse(await bounded(response, 2000000));
      if (!response.ok)
        throw Error(
          typeof data.error === "string" && /^[A-Z_]+$/.test(data.error)
            ? data.error
            : "INTAKE_UNAVAILABLE",
        );
      return data;
    };
    if (
      (await api("/v1/status")).mode !== "test" ||
      (await api("/v1/me")).role !== "editor"
    )
      throw Error("WRONG_INTAKE");
    let ledger;
    try {
      ledger = JSON.parse(
        await readFile(resolve(state, "reading-actions.json"), "utf8"),
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      ledger = {};
    }
    const branches = [];
    const cursors = new Set();
    let cursor;
    do {
      const page = await api(
        "/v1/branches" +
          (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      );
      if (!Array.isArray(page.page)) throw Error("INVALID_PAGE");
      branches.push(...page.page);
      if (page.isDone) break;
      if (
        typeof page.continueCursor !== "string" ||
        cursors.has(page.continueCursor) ||
        cursors.size >= 1000
      )
        throw Error("INVALID_CURSOR");
      cursor = page.continueCursor;
      cursors.add(cursor);
    } while (true);
    const outcomes = [];
    let runs = 0;
    for (const row of branches) {
      if (
        row.branchId === "origin" ||
        !["pending", "checked", "verified"].includes(row.status)
      )
        continue;
      const key = `${row.branchId}:${row.revision}:${row.version}`;
      const prev = ledger[key];
      const unfinishedListed =
        row.status === "verified" &&
        Object.values(ledger).some(
          (x) =>
            x.branchId === row.branchId &&
            x.revision === row.revision &&
            x.state === "working",
        );
      if (row.status === "verified" && !unfinishedListed) continue;
      if (
        prev?.state === "done" ||
        prev?.state === "held" ||
        (prev?.retryAt && Date.now() < prev.retryAt)
      )
        continue;
      if (++runs > 8) break;
      const working = unfinishedListed
        ? Object.values(ledger).find(
            (x) =>
              x.branchId === row.branchId &&
              x.revision === row.revision &&
              x.state === "working",
          )
        : undefined;
      const actionKey = working?.key || key;
      if (working?.retryAt && Date.now() < working.retryAt) continue;
      ledger[actionKey] = {
        key: actionKey,
        branchId: row.branchId,
        revision: row.revision,
        version: working?.version || row.version,
        state: "working",
      };
      await privateJson(resolve(state, "reading-actions.json"), ledger);
      try {
        if (row.status === "pending") {
          const response = await fetch(TEST_API + "/v1/branches/check", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + config.key,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ branchId: row.branchId }),
            redirect: "error",
            signal: AbortSignal.timeout(60000),
          });
          const checked = JSON.parse(await bounded(response, 30000));
          if (!response.ok)
            throw Error(
              typeof checked.error === "string" &&
                /^[A-Z_]+$/.test(checked.error)
                ? checked.error
                : "CHECK_UNAVAILABLE",
            );
        }
        const data = await api(
          "/v1/branch?id=" + encodeURIComponent(row.branchId),
        );
        if (unfinishedListed) {
          data.branch.status = "checked";
          data.branch.version = working.version;
        }
        // recordCheck increments the version; use that exact version for all operations.
        ledger[actionKey].version = data.branch.version;
        await privateJson(resolve(state, "reading-actions.json"), ledger);
        const result = await processBranch(data, {
          load: async (id) => {
            try {
              return JSON.parse(
                await readFile(resolve(state, "reports", id + ".json"), "utf8"),
              );
            } catch (e) {
              if (e.code !== "ENOENT") throw e;
              return null;
            }
          },
          save: async (id, value) =>
            privateJson(resolve(state, "reports", id + ".json"), value),
          getBranch: (id) => api("/v1/branch?id=" + encodeURIComponent(id)),
          command: (operation, input, id) =>
            api("/v1/commands", operation, input, id),
          fetchSource: async (branch, path) => {
            if (
              !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(
                branch.repository,
              )
            )
              throw Error("INVALID_REPOSITORY");
            const response = await fetch(
              "https://raw.githubusercontent.com/" +
                branch.repository.slice("https://github.com/".length) +
                "/" +
                branch.revision +
                "/" +
                path,
              { redirect: "error", signal: AbortSignal.timeout(15000) },
            );
            if (!response.ok) throw Error("SOURCE_UNAVAILABLE");
            return bounded(response, 18000);
          },
          read: async (input) => {
            const response = await fetch(readerConfig.api + "/read", {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.timeout(60000),
              headers: {
                Authorization: "Bearer " + readerConfig.token,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(input),
            });
            const data = JSON.parse(await bounded(response, 16000));
            if (!response.ok)
              throw Error(
                [
                  "INVALID_READING_DATA",
                  "READING_TOO_LARGE",
                  "WORK_CONSENT_REQUIRED",
                ].includes(data.error)
                  ? data.error
                  : "READING_UNAVAILABLE",
              );
            return data;
          },
        });
        ledger[actionKey] = {
          ...ledger[actionKey],
          state: result.outcome === "listed" ? "done" : "held",
          result,
          finishedAt: new Date().toISOString(),
        };
        // Also mark the version after a pending branch's check to suppress re-review on a hold.
        ledger[`${row.branchId}:${result.revision}:${result.version}`] =
          ledger[actionKey];
        outcomes.push(result);
      } catch (e) {
        const error = /^[A-Z_]+$/.test(e.message || "")
          ? e.message
          : "READING_FAILED";
        const attempts = (prev?.attempts || 0) + 1;
        const held = [
          "INVALID_READING_DATA",
          "READING_TOO_LARGE",
          "WORK_CONSENT_REQUIRED",
          "WORK_LICENSE_MISMATCH",
          "CONTENT_HASH_MISMATCH",
          "READING_SOURCE_MISMATCH",
          "INVALID_SOURCE_PATH",
          "INVALID_EPISODES",
        ].includes(error);
        // If listing completed but saving notes failed, preserve working for recovery.
        ledger[actionKey] = {
          ...ledger[actionKey],
          error,
          attempts,
          ...(held ? { state: "held" } : {}),
          retryAt: Date.now() + Math.min(24, 4 * attempts) * 3600000,
        };
        outcomes.push({
          branchId: row.branchId,
          version: row.version,
          outcome: held ? "held" : "retry",
          error,
        });
      }
      await privateJson(resolve(state, "reading-actions.json"), ledger);
    }
    console.log(JSON.stringify({ api: TEST_API, outcomes }, null, 2));
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run().catch((e) => {
    console.error(
      /^[A-Z_]+$/.test(e.message || "") ? e.message : "READING_FAILED",
    );
    process.exitCode = 1;
  });
}
