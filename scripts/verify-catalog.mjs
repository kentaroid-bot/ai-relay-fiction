#!/usr/bin/env node
// Anonymous public metadata only. Never fetch manuscripts or use editor keys.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "https://exciting-peccary-307.convex.site/v1";
const SITE = "https://relay.monku.ai";
const canonical = (value) =>
  JSON.stringify(value, (_, v) =>
    v && !Array.isArray(v) && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
const sorted = (rows) => rows.map(canonical).sort();

async function body(fetcher, url, limit = 1000000) {
  const response = await fetcher(url, {
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.body) throw Error("SITE_UNAVAILABLE");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw Error("PUBLIC_RESPONSE_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function pages(fetcher, base, route) {
  const rows = [],
    seen = new Set();
  let cursor, version;
  for (let i = 0; i < 1000; i++) {
    const data = JSON.parse(
      await body(
        fetcher,
        base +
          route +
          (cursor
            ? (route.includes("?") ? "&" : "?") +
              "cursor=" +
              encodeURIComponent(cursor)
            : ""),
      ),
    );
    if (!Array.isArray(data.page) || typeof data.isDone !== "boolean")
      throw Error("INVALID_PUBLIC_PAGE");
    if (i === 0) version = data.version;
    if (data.version !== version) throw Error("PUBLIC_VERSION_CHANGED");
    rows.push(...data.page);
    if (data.isDone) return { rows: sorted(rows), data: rows, version };
    cursor = data.continueCursor;
    if (typeof cursor !== "string" || !cursor || seen.has(cursor))
      throw Error("INVALID_PUBLIC_CURSOR");
    seen.add(cursor);
  }
  throw Error("PUBLIC_CATALOG_TOO_LARGE");
}

export async function verifyCatalog(fetcher = fetch) {
  const api = SITE + "/api/v1";
  async function compare(route, version) {
    const [source, visible] = await Promise.all([
      pages(fetcher, SOURCE, route),
      pages(fetcher, api, route),
    ]);
    if (
      canonical(source.rows) !== canonical(visible.rows) ||
      source.version !== visible.version
    )
      throw Error("SITE_CATALOG_MISMATCH");
    if (version !== undefined && source.version !== version)
      throw Error("PUBLIC_VERSION_CHANGED");
    return source;
  }
  const [branches, mains, html, js, home, reader, readerJs] = await Promise.all(
    [
      compare("/catalog"),
      compare("/mains"),
      body(fetcher, SITE + "/branches/", 500000),
      body(fetcher, SITE + "/branches.js", 100000),
      body(fetcher, SITE + "/", 500000),
      body(fetcher, SITE + "/read/main/", 100000),
      body(fetcher, SITE + "/main-reader.js", 100000),
    ],
  );
  const empty = branches.data.length === 0 && mains.data.length === 0;
  if (empty) {
    const state = JSON.parse(
      await body(fetcher, SITE + "/.well-known/ai-relay.json"),
    );
    if (
      state.contentStatus !== "reset" ||
      state.seedWork !== null ||
      state.registrationOpen !== false
    )
      throw Error("EMPTY_FOREST_NOT_DECLARED");
    const [world, join] = await Promise.all([
      body(fetcher, SITE + "/world/", 500000),
      body(fetcher, SITE + "/join/", 500000),
    ]);
    for (const page of [home, html, reader, world, join]) {
      if (
        !page.includes("つづきの森") ||
        !page.includes("旧作品") ||
        !page.includes("公開を終了") ||
        !page.includes("受付") ||
        !page.includes("停止")
      )
        throw Error("SITE_RESET_NOTICE_MISSING");
    }
    if (
      !html.includes("旧作品と旧世界設定の公開を終了") ||
      !reader.includes("旧作品と旧世界設定の公開を終了")
    )
      throw Error("SITE_RESET_NOTICE_MISSING");
    for (const route of [
      "/read/ep-001/",
      "/read/ep-002/",
      "/texts/ep-001.md",
      "/texts/ep-002.md",
    ]) {
      const response = await fetcher(SITE + route, {
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
      await response.body?.cancel();
      if (response.status !== 404) throw Error("WITHDRAWN_ROUTE_STILL_PUBLIC");
    }
  } else if (
    !html.includes('id="live-branches"') ||
    !html.includes('src="../branches.js"') ||
    !js.includes("/api/v1/catalog") ||
    !js.includes("/read/main/?id=") ||
    !home.includes('id="main-list"') ||
    !home.includes("つづきの森") ||
    !reader.includes('id="main-reader"') ||
    !reader.includes('src="../../main-reader.js"') ||
    !readerJs.includes("/api/v1/main?id=") ||
    !readerJs.includes("SHA-256")
  )
    throw Error("SITE_READING_ROUTE_MISMATCH");
  if (!empty && !branches.data.some((b) => b.branchId === "origin"))
    throw Error("PUBLIC_ROOT_MISSING");
  for (const b of branches.data) {
    if (
      !/^[a-z0-9][a-z0-9-]*$/.test(b.branchId) ||
      !/^[a-f0-9]{40}$/.test(b.revision)
    )
      throw Error("INVALID_PUBLIC_REFERENCE");
    const url = new URL(b.readingUrl);
    if (
      url.origin !== "https://github.com" ||
      url.username ||
      url.password ||
      !url.pathname.includes("/blob/" + b.revision + "/")
    )
      throw Error("INVALID_PUBLIC_REFERENCE");
  }
  for (const main of mains.data) {
    await compare("/main?id=" + encodeURIComponent(main.mainId), main.version);
    await compare(
      "/candidates?id=" + encodeURIComponent(main.mainId),
      main.version,
    );
  }
  // A concurrent listing or withdrawal must be retried, not certified against a stale view.
  const again = await compare("/catalog", branches.version);
  if (
    canonical(again.rows) !== canonical(branches.rows) ||
    again.version !== branches.version
  )
    throw Error("PUBLIC_VERSION_CHANGED");
  const mainsAgain = await compare("/mains", mains.version);
  if (
    canonical(mainsAgain.rows) !== canonical(mains.rows) ||
    mainsAgain.version !== mains.version
  )
    throw Error("PUBLIC_VERSION_CHANGED");
  return {
    outcome: "confirmed",
    mode: empty ? "reset" : "published",
    url: SITE + "/branches/",
    checkedAt: new Date().toISOString(),
    catalogHash: createHash("sha256")
      .update(canonical(branches.rows))
      .digest("hex"),
    branches: branches.data.map((b) => ({
      branchId: b.branchId,
      revision: b.revision,
    })),
    mains: mains.data.length,
  };
}

async function run() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--state"))
    throw Error("INVALID_ARGUMENTS");
  const state = args.length ? resolve(args[1]) : null;
  let result;
  try {
    result = await verifyCatalog();
  } catch (e) {
    result = {
      outcome: "retry",
      checkedAt: new Date().toISOString(),
      error: /^[A-Z_]+$/.test(e.message || "")
        ? e.message
        : "SITE_CHECK_FAILED",
    };
  }
  if (state) {
    await mkdir(state, { recursive: true, mode: 0o700 });
    const dest = resolve(state, "site-publication.json");
    let previous;
    try {
      previous = JSON.parse(await readFile(dest, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const record = {
      latest: result,
      lastConfirmed:
        result.outcome === "confirmed"
          ? result
          : previous?.lastConfirmed || null,
    };
    const temp = dest + "." + process.pid + ".next";
    await writeFile(temp, JSON.stringify(record, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, dest);
  }
  console.log(JSON.stringify(result));
  if (result.outcome !== "confirmed") process.exitCode = 1;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run().catch(() => {
    console.error("SITE_CHECK_FAILED");
    process.exitCode = 1;
  });
}
