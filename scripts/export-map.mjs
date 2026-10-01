#!/usr/bin/env node
// Public, read-only snapshot. No keys or manuscript content are fetched.
import { writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
const [baseArg, output] = process.argv.slice(2);
if (!baseArg || !output)
  throw Error("Usage: node scripts/export-map.mjs API_BASE OUTPUT.json");
const base = new URL(baseArg);
if (
  base.protocol !== "https:" ||
  base.username ||
  base.password ||
  base.search ||
  base.hash
)
  throw Error("HTTPS API required");
const api = base.href.replace(/\/$/, "");
async function pages(route, expectedVersion) {
  const rows = [],
    seen = new Set();
  let cursor;
  for (let i = 0; i < 10000; i++) {
    const response = await fetch(
      api +
        route +
        (cursor
          ? (route.includes("?") ? "&" : "?") +
            "cursor=" +
            encodeURIComponent(cursor)
          : ""),
      { redirect: "error", signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) throw Error("Snapshot source unavailable");
    const data = await response.json();
    if (
      !Array.isArray(data.page) ||
      (expectedVersion !== undefined && data.version !== expectedVersion)
    )
      throw Error("Snapshot changed; retry");
    rows.push(...data.page);
    if (data.isDone === true) return rows;
    cursor = data.continueCursor;
    if (typeof cursor !== "string" || !cursor || seen.has(cursor))
      throw Error("Invalid pagination");
    seen.add(cursor);
  }
  throw Error("Snapshot too large");
}
const branches = (await pages("/v1/catalog")).map((b) => ({
  id: b.branchId,
  title: b.title,
  parent_branch_id: b.parent?.branchId || null,
  fork_point: b.parent
    ? {
        branch_id: b.parent.branchId,
        episode_id: b.parent.episodeId,
        revision: b.parent.revision,
      }
    : null,
  repository_url: b.repository,
  reading_url: b.readingUrl,
  maintainer: b.maintainer,
  status: "active",
  last_checked_at: b.checkedAt ? new Date(b.checkedAt).toISOString() : null,
  from_main: b.fromMain || null,
  license: b.license || "legacy",
}));
const mains = [];
for (const m of await pages("/v1/mains")) {
  const path = await pages(
    "/v1/main?id=" + encodeURIComponent(m.mainId),
    m.version,
  );
  const candidates = await pages(
    "/v1/candidates?id=" + encodeURIComponent(m.mainId),
    m.version,
  );
  mains.push({
    id: m.mainId,
    title: m.title,
    maintainer: m.maintainer,
    version: m.version,
    candidates: candidates.map((e) => ({
      branch_id: e.branchId,
      episode_id: e.episodeId,
      revision: e.revision,
    })),
    path: path.map((s) => ({
      position: s.position,
      available: s.available,
      episode: s.episode
        ? {
            branch_id: s.episode.branchId,
            episode_id: s.episode.episodeId,
            revision: s.episode.revision,
            ...(s.episode.sourceRef ? { sourceRef: s.episode.sourceRef } : {}),
          }
        : null,
    })),
  });
}
const dest = resolve(output),
  temp = dest + ".next";
await writeFile(
  temp,
  JSON.stringify(
    {
      schema_version: 2,
      root_branch_id: "origin",
      discovery_status: "registered_branches",
      source_api: api + "/v1/catalog",
      snapshot_at: new Date().toISOString(),
      branches,
      mains,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
await rename(temp, dest);
console.log(JSON.stringify({ branches: branches.length, mains: mains.length }));
