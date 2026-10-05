import type { Doc } from "./_generated/dataModel";
import { ConvexError } from "convex/values";
import {
  fingerprint,
  validateProvenance,
  episodeProvenance,
} from "./contentSafety";
import {
  digest,
  fail,
  githubText,
  keyHash,
  path,
  revision,
  text,
} from "./policy";
import { scanText } from "./safety";
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_OBJECT");
  return value as Record<string, any>;
}
export function parseManifest(source: string) {
  try {
    return object(JSON.parse(source));
  } catch (e) {
    if (e instanceof ConvexError) throw e;
    fail("INVALID_SOURCE_JSON");
  }
}
function sameParent(a: any, b: any) {
  return (
    (a === null && b === null) ||
    (a &&
      b &&
      a.branchId === b.branchId &&
      a.episodeId === b.episodeId &&
      a.revision === b.revision)
  );
}
export async function inspectSource(
  branch: Doc<"branches"> & { isLineageRoot: boolean },
  fixedManifest?: Record<string, any>,
) {
  const manifest =
    fixedManifest ??
    parseManifest(
      await githubText(
        branch.repository,
        branch.revision,
        "relay-branch.json",
        20000,
      ),
    );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.branchId !== branch.branchId ||
    manifest.repository !== branch.repository ||
    manifest.title !== branch.title ||
    manifest.lineageId !== branch.lineageId ||
    (await fingerprint(validateProvenance(manifest.provenance))) !==
      branch.provenanceHash ||
    !sameParent(manifest.parent, branch.parent)
  )
    fail("MANIFEST_MISMATCH");
  if (
    !Array.isArray(manifest.episodes) ||
    !manifest.episodes.length ||
    manifest.episodes.length > 20
  )
    fail("INVALID_EPISODES");
  if (
    branch.license &&
    (manifest.license !== branch.license.id ||
      manifest.termsVersion !== branch.license.termsVersion)
  )
    fail("WORK_LICENSE_MISMATCH");
  const worldMarkdown = branch.isLineageRoot
    ? await githubText(branch.repository, branch.revision, "world.md")
    : null;
  if (
    worldMarkdown !== null &&
    (await digest(worldMarkdown)) !== branch.worldHash
  )
    fail("WORLD_HASH_MISMATCH");
  const signals = scanText(
    JSON.stringify(manifest),
    "fixed_source_hash_checked",
    branch.license ? "cc0_declared" : "legacy_unconfirmed",
  );
  const findings = new Set(signals.findings);
  if (worldMarkdown !== null)
    for (const code of scanText(worldMarkdown, signals.source, signals.terms)
      .findings)
      findings.add(code);
  const seen = new Set<string>();
  const episodes = [];
  let previous = branch.parent;
  // Only these fixed-commit Markdown files are fetched. Links inside them are never followed.
  for (const item of manifest.episodes) {
    const ep = object(item),
      episodeId = text(ep.episodeId, 80, "EPISODE_ID");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(episodeId) || seen.has(episodeId))
      fail("INVALID_EPISODE_ID");
    seen.add(episodeId);
    const file = path(ep.path),
      contentHash = keyHash(ep.contentHash);
    const markdown = await githubText(branch.repository, branch.revision, file);
    if ((await digest(markdown)) !== contentHash) fail("CONTENT_HASH_MISMATCH");
    for (const code of scanText(markdown, signals.source, signals.terms)
      .findings)
      findings.add(code);
    const declared = ep.parent ? object(ep.parent) : previous;
    if (!declared && (!branch.isLineageRoot || episodes.length !== 0))
      fail("INVALID_PARENT");
    const parent = declared
      ? {
          branchId: text(declared.branchId, 80, "BRANCH_ID"),
          episodeId: text(declared.episodeId, 80, "EPISODE_ID"),
          revision:
            declared.revision === "self"
              ? branch.revision
              : revision(declared.revision),
        }
      : null;
    episodes.push({
      episodeId,
      path: file,
      contentHash,
      title: text(ep.title, 200, "TITLE"),
      ...(ep.influences === undefined
        ? {}
        : {
            influences: episodeProvenance(branch.provenance!, ep.influences)
              .influences!,
          }),
      parent,
      ...(ep.sourceRef === undefined
        ? {}
        : {
            sourceRef: {
              branchId: text(object(ep.sourceRef).branchId, 80, "BRANCH_ID"),
              episodeId: text(object(ep.sourceRef).episodeId, 80, "EPISODE_ID"),
              revision: revision(object(ep.sourceRef).revision),
            },
          }),
    });
    previous = {
      branchId: branch.branchId,
      episodeId,
      revision: branch.revision,
    };
  }
  const characters = manifest.characters ?? [];
  if (!Array.isArray(characters) || characters.length > 50)
    fail("INVALID_CHARACTERS");
  const characterIds = new Set<string>();
  const checkedCharacters = characters.map((item) => {
    const c = object(item),
      origin = object(c.origin),
      characterId = text(c.characterId, 80, "CHARACTER_ID");
    if (
      !/^[a-z0-9][a-z0-9-]*$/.test(characterId) ||
      characterIds.has(characterId)
    )
      fail("INVALID_CHARACTER_ID");
    characterIds.add(characterId);
    return {
      characterId,
      name: text(c.name, 100, "CHARACTER_NAME"),
      description: text(c.description, 2000, "CHARACTER_DESCRIPTION"),
      origin: {
        branchId: text(origin.branchId, 80, "BRANCH_ID"),
        episodeId: text(origin.episodeId, 80, "EPISODE_ID"),
        revision:
          origin.revision === "self"
            ? branch.revision
            : revision(origin.revision),
      },
    };
  });
  return {
    episodes,
    characters: checkedCharacters,
    gate: { ...signals, findings: [...findings] },
  };
}
