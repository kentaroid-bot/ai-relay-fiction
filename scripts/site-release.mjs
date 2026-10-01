#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCatalog } from "./verify-catalog.mjs";

const SITE = "https://relay.monku.ai";
const assets = [
  ["/", "index.html"],
  ["/forest.css", "forest.css"],
  ["/forest.js", "forest.js"],
  ["/branches/", "branches/index.html"],
  ["/branches.js", "branches.js"],
  ["/read/main/", "read/main/index.html"],
  ["/main-reader.js", "main-reader.js"],
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validRevision = (revision) => /^[a-f0-9]{40}$/.test(revision);

export async function writeRelease(revision, directory = "site/dist") {
  if (!validRevision(revision)) throw Error("INVALID_RELEASE_REVISION");
  const files = {};
  for (const [route, path] of assets)
    files[route] = hash(await readFile(resolve(directory, path)));
  const receipt = { schema: 1, revision, files };
  await writeFile(
    resolve(directory, "release.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  return receipt;
}

async function get(fetcher, route) {
  const response = await fetcher(SITE + route, {
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("RELEASE_UNAVAILABLE");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 1000000) throw Error("RELEASE_RESPONSE_TOO_LARGE");
  return Buffer.from(bytes);
}

export async function verifyRelease(expected, fetcher = fetch) {
  if (!validRevision(expected.revision))
    throw Error("INVALID_RELEASE_REVISION");
  const published = JSON.parse(await get(fetcher, "/release.json"));
  if (published.schema !== 1 || published.revision !== expected.revision)
    throw Error("RELEASE_REVISION_MISMATCH");
  for (const [route] of assets) {
    if (published.files?.[route] !== expected.files[route])
      throw Error("RELEASE_RECEIPT_MISMATCH");
    if (hash(await get(fetcher, route)) !== expected.files[route])
      throw Error("RELEASE_ASSET_MISMATCH");
  }
}

async function run() {
  const [command, revision, ...extra] = process.argv.slice(2);
  if (extra.length || !validRevision(revision))
    throw Error("INVALID_ARGUMENTS");
  if (command === "write") {
    await writeRelease(revision);
    console.log("Built release " + revision);
    return;
  }
  if (command !== "verify") throw Error("INVALID_ARGUMENTS");
  const expected = JSON.parse(await readFile("site/dist/release.json", "utf8"));
  if (expected.revision !== revision) throw Error("LOCAL_RELEASE_MISMATCH");
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await verifyRelease(expected);
      const catalog = await verifyCatalog();
      console.log(JSON.stringify({ revision, ...catalog }));
      return;
    } catch (error) {
      if (attempt === 5) throw error;
      console.log("Public verification pending; retry " + attempt + "/5");
      await new Promise((done) => setTimeout(done, 10000));
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  run().catch((error) => {
    console.error(
      /^[A-Z_]+$/.test(error.message || "")
        ? error.message
        : "RELEASE_CHECK_FAILED",
    );
    process.exitCode = 1;
  });
