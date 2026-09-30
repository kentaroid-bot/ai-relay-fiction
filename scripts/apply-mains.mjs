#!/usr/bin/env node
// Apply the owner's fixed PR declaration only after independent branch listing.
import { readFile, writeFile, rename, mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const API = "https://exciting-peccary-307.convex.site";
const retryable = new Set([
  "SOURCE_UNAVAILABLE",
  "GITHUB_RATE_LIMITED",
  "REQUEST_FAILED",
  "MAIN_REQUEST_FAILED",
  "RATE_LIMITED",
]);
export async function applyCandidates(
  pulls,
  state,
  send,
  save,
  now = Date.now(),
) {
  const outcomes = [];
  let processed = 0;
  for (const pr of Object.values(pulls)) {
    if (pr.status !== "received" || pr.mainDeclared !== true) continue;
    if (
      !Number.isSafeInteger(pr.number) ||
      !/^[a-f0-9]{40}$/.test(pr.revision) ||
      !/^[a-z0-9][a-z0-9-]{1,79}$/.test(pr.branchId)
    )
      throw Error("INVALID_MAIN_LEDGER");
    const id = pr.number + ":" + pr.revision,
      prior = state[id];
    if (
      ["applied", "held", "superseded"].includes(prior?.status) ||
      prior?.nextAttempt > now
    )
      continue;
    if (processed++ >= 10) break;
    try {
      const { branch } = await send(
        "/v1/branch?id=" + encodeURIComponent(pr.branchId),
      );
      if (branch.revision !== pr.revision) {
        state[id] = {
          status: "superseded",
          branchId: pr.branchId,
          revision: pr.revision,
        };
        await save(state);
        continue;
      }
      if (branch.status !== "verified") continue;
      const result = await send("/v1/branches/main", {
        number: pr.number,
        revision: pr.revision,
        branchId: pr.branchId,
        expectedVersion: branch.version,
      });
      if (
        !["created", "appended", "already_applied", "no_declaration"].includes(
          result.outcome,
        )
      )
        throw Error("MAIN_REQUEST_FAILED");
      state[id] = {
        status: "applied",
        branchId: pr.branchId,
        revision: pr.revision,
        branchVersion: branch.version,
        ...result,
        completedAt: new Date(now).toISOString(),
      };
    } catch (error) {
      const code = /^[A-Z_]+$/.test(error.message || "")
        ? error.message
        : "MAIN_REQUEST_FAILED";
      state[id] = {
        status: retryable.has(code) ? "retry" : "held",
        branchId: pr.branchId,
        revision: pr.revision,
        error: code,
        observedAt: new Date(now).toISOString(),
        ...(retryable.has(code) ? { nextAttempt: now + 4 * 3600000 } : {}),
      };
    }
    await save(state);
    outcomes.push(state[id]);
  }
  return outcomes;
}
async function main() {
  const args = process.argv.slice(2),
    option = (n) => args[args.indexOf(n) + 1];
  for (const name of ["--profile", "--state", "--github-ledger"])
    if (!args.includes(name)) throw Error("MISSING_OPTION");
  const profile = resolve(option("--profile")),
    folder = resolve(option("--state"));
  if ((await stat(profile)).mode & 0o077)
    throw Error("PRIVATE_PROFILE_REQUIRED");
  const config = JSON.parse(await readFile(profile, "utf8"));
  if (config.api !== API || !/^rly_[A-Za-z0-9_-]{43}$/.test(config.key))
    throw Error("WRONG_INTAKE");
  const send = async (route, payload) => {
    try {
      const r = await fetch(API + route, {
        method: payload === undefined ? "GET" : "POST",
        headers: {
          Authorization: "Bearer " + config.key,
          "Content-Type": "application/json",
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        redirect: "error",
        signal: AbortSignal.timeout(60000),
      });
      const data = await r.json();
      if (!r.ok)
        throw Error(
          /^[A-Z_]+$/.test(data.error || "")
            ? data.error
            : "MAIN_REQUEST_FAILED",
        );
      return data;
    } catch (e) {
      throw Error(
        /^[A-Z_]+$/.test(e.message || "") ? e.message : "MAIN_REQUEST_FAILED",
      );
    }
  };
  if (
    (await send("/v1/status")).mode !== "test" ||
    (await send("/v1/me")).role !== "editor"
  )
    throw Error("WRONG_INTAKE");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const lock = resolve(folder, "main.lock");
  try {
    await mkdir(lock);
  } catch (e) {
    if (e.code === "EEXIST") {
      console.log(JSON.stringify({ busy: true, outcomes: [] }));
      return;
    }
    throw e;
  }
  try {
    await writeFile(
      resolve(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    const file = resolve(folder, "main-actions.json");
    let state = {};
    try {
      state = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw Error("INVALID_MAIN_LEDGER");
    }
    const ledger = JSON.parse(
      await readFile(resolve(option("--github-ledger")), "utf8"),
    );
    if (
      ledger.schemaVersion !== 1 ||
      !ledger.pulls ||
      Array.isArray(ledger.pulls) ||
      !state ||
      Array.isArray(state)
    )
      throw Error("INVALID_MAIN_LEDGER");
    const save = async (value) => {
      await writeFile(file + ".next", JSON.stringify(value, null, 2) + "\n", {
        mode: 0o600,
      });
      await rename(file + ".next", file);
    };
    const outcomes = await applyCandidates(ledger.pulls, state, send, save);
    console.log(JSON.stringify({ outcomes }));
  } finally {
    await rm(lock, { recursive: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((e) => {
    console.error(
      /^[A-Z_]+$/.test(e.message || "") ? e.message : "MAIN_PASS_FAILED",
    );
    process.exitCode = 1;
  });
