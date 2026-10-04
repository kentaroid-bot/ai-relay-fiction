import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { digest } from "../convex/policy";
import {
  fingerprint,
  validateProvenance,
  validateTarget,
} from "../convex/contentSafety";
import { workLicense } from "../convex/safety";

const read = (path: string) =>
  readFileSync(new URL("../" + path, import.meta.url), "utf8");
const registration = JSON.parse(
  read("trees/echo-archive-pebble/registration.json"),
);
const manifest = JSON.parse(read("relay-branch.json"));

it("binds the first-tree registration to the exact submitted text, world, and provenance", async () => {
  const target = registration.target;
  validateTarget(target);
  expect(await digest(read("manuscript/01.md"))).toBe(target.contentHash);
  expect(await digest(read("world.md"))).toBe(target.worldHash);
  expect(await fingerprint(validateProvenance(manifest.provenance))).toBe(
    target.provenanceHash,
  );
  expect(read("manuscript/01.md")).toBe(
    read("trees/echo-archive-pebble/01-draft.md"),
  );
});

it("keeps the root manifest and the editor preparation on the same fixed target", () => {
  const { input, operation } = registration.prepare;
  expect(operation).toBe("editor.lineage.prepare");
  for (const field of [
    "lineageId",
    "branchId",
    "episodeId",
    "revision",
    "contentHash",
    "worldHash",
  ])
    expect(input[field]).toBe(registration.target[field]);
  expect(input.path).toBe(manifest.episodes[0].path);
  expect(input.lineageId).toBe(manifest.lineageId);
  expect(input.branchId).toBe(manifest.branchId);
  expect(input.contentHash).toBe(manifest.episodes[0].contentHash);
  expect(registration.target.parent).toBeNull();
  expect(input.provenance).toEqual(
    JSON.parse(read("trees/echo-archive-pebble/provenance.json")),
  );
  expect(workLicense(input.license)).toEqual(
    JSON.parse(read("trees/echo-archive-pebble/license.json")),
  );
});

it("does not present a prepared submission as a live catalog or active lineage", () => {
  expect(registration.state).toBe("prepared_not_applied");
  expect(registration.sharedDatabaseApplied).toBe(false);
  expect(JSON.parse(read("episodes.json")).episodes).toEqual([]);
  expect(JSON.parse(read("branches.json")).branches).toEqual([]);
});
