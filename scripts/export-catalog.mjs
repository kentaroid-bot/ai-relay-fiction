#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
const branches = [],
  cursors = new Set();
let cursor = "";
do {
  const response = await fetch(
    "https://relay.monku.ai/api/v1/catalog" +
      (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
    { redirect: "error", signal: AbortSignal.timeout(15000) },
  );
  if (!response.ok)
    throw Error("Catalog unavailable; existing snapshot was not changed");
  const page = await response.json();
  if (!Array.isArray(page.page)) throw Error("Invalid catalog");
  branches.push(...page.page);
  if (page.isDone) break;
  if (!page.continueCursor || cursors.has(page.continueCursor))
    throw Error("Invalid pagination");
  cursor = page.continueCursor;
  cursors.add(cursor);
} while (true);
const byId = new Map(branches.map((b) => [b.branchId, b]));
const output = {
  schema_version: 1,
  root_branch_id: "origin",
  discovery_status: "registered_branches",
  source_api: "https://relay.monku.ai/api/v1/catalog",
  snapshot_at: new Date().toISOString(),
  branches: branches.map((b) => ({
    id: b.branchId,
    title: b.title,
    parent_branch_id: b.parent?.branchId ?? null,
    fork_point: b.parent
      ? {
          repository_url: byId.get(b.parent.branchId)?.repository ?? null,
          episode_id: b.parent.episodeId,
          revision: b.parent.revision,
        }
      : null,
    repository_url: b.repository,
    reading_url: b.readingUrl,
    maintainer: b.maintainer,
    status: b.branchId === "origin" ? "preparing" : "active",
    last_checked_at: b.checkedAt ? new Date(b.checkedAt).toISOString() : null,
  })),
};
// A suspended/absent parent requires editorial treatment before this static format can represent it.
if (
  output.branches.some(
    (b) => b.parent_branch_id && !byId.has(b.parent_branch_id),
  )
)
  throw Error(
    "A parent is not in the public catalog; retain the existing snapshot and ask the desk to record its unavailable state",
  );
await writeFile(
  process.argv[2] || "branches.json",
  JSON.stringify(output, null, 2) + "\n",
);
console.log("Saved " + branches.length + " verified branch records");
