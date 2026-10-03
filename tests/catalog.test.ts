import { expect, it, vi } from "vitest";
// @ts-expect-error The read-only operational CLI is JavaScript.
import { verifyCatalog } from "../scripts/verify-catalog.mjs";

const revision = "a".repeat(40);
const origin = {
  branchId: "origin",
  revision,
  readingUrl: "https://github.com/example/story/blob/" + revision + "/01.md",
};
const branch = {
  branchId: "second",
  revision,
  readingUrl: "https://github.com/example/branch/blob/" + revision + "/02.md",
};
function fixture(override?: (url: URL, count: number) => Response | undefined) {
  const counts = new Map<string, number>();
  return vi.fn(async (value: string, options: RequestInit) => {
    expect(options.credentials).toBe("omit");
    expect(options.redirect).toBe("error");
    expect(options.headers).toBeUndefined();
    const url = new URL(value);
    const count = (counts.get(value) || 0) + 1;
    counts.set(value, count);
    const response = override?.(url, count);
    if (response) return response;
    const path = url.pathname.replace("/api", "");
    if (path === "/v1/catalog") {
      return Response.json(
        url.searchParams.has("cursor")
          ? { page: [branch], isDone: true, continueCursor: "" }
          : { page: [origin], isDone: false, continueCursor: "page-2" },
      );
    }
    if (path === "/v1/mains")
      return Response.json({
        page: [{ mainId: "monku-main", version: 1 }],
        isDone: true,
      });
    if (path === "/v1/main")
      return Response.json({
        page: [{ position: 0, episode: origin }],
        isDone: true,
        version: 1,
      });
    if (path === "/v1/candidates")
      return Response.json({ page: [branch], isDone: true, version: 1 });
    if (path === "/branches/")
      return new Response(
        '<div id="live-branches"></div><script src="../branches.js"></script>',
      );
    if (path === "/branches.js")
      return new Response("fetch('/api/v1/catalog'); '/read/main/?id='");
    if (path === "/")
      return new Response('つづきの森<div id="main-list"></div>');
    if (path === "/read/main/")
      return new Response(
        '<article id="main-reader"></article><script src="../../main-reader.js"></script>',
      );
    if (path === "/main-reader.js")
      return new Response("'/api/v1/main?id='; 'SHA-256'");
    throw Error("Unexpected route");
  });
}
it("confirms the visible, paginated branch catalog and each main's path and candidates without credentials or manuscript reads", async () => {
  const fetcher = fixture();
  const result = await verifyCatalog(fetcher);
  expect(result.outcome).toBe("confirmed");
  expect(result.branches).toEqual([
    { branchId: "origin", revision },
    { branchId: "second", revision },
  ]);
  expect(result.mains).toBe(1);
  expect(
    fetcher.mock.calls.some((c) => c[0].includes("/candidates?id=monku-main")),
  ).toBe(true);
  expect(fetcher.mock.calls.every((c) => !c[0].includes("github.com"))).toBe(
    true,
  );
});
it("does not mark publication complete when a listed branch is absent from the site", async () => {
  const fetcher = fixture((url) =>
    url.hostname === "relay.monku.ai" && url.pathname === "/api/v1/catalog"
      ? Response.json({ page: [origin], isDone: true })
      : undefined,
  );
  await expect(verifyCatalog(fetcher)).rejects.toThrow("SITE_CATALOG_MISMATCH");
});
it("retries when a branch is withdrawn during verification", async () => {
  const fetcher = fixture((url, count) =>
    url.hostname !== "relay.monku.ai" &&
    url.pathname === "/v1/catalog" &&
    !url.search &&
    count > 1
      ? Response.json({ page: [origin], isDone: true })
      : undefined,
  );
  await expect(verifyCatalog(fetcher)).rejects.toThrow(
    /PUBLIC_VERSION_CHANGED|SITE_CATALOG_MISMATCH/,
  );
});
it("rejects an invisible candidate, repeated pagination cursor, and changed main version", async () => {
  for (const fetcher of [
    fixture((url) =>
      url.hostname === "relay.monku.ai" && url.pathname === "/api/v1/candidates"
        ? Response.json({ page: [], isDone: true, version: 1 })
        : undefined,
    ),
    fixture((url) =>
      url.pathname.endsWith("/catalog")
        ? Response.json({ page: [], isDone: false, continueCursor: "loop" })
        : undefined,
    ),
    fixture((url) =>
      url.pathname.endsWith("/main")
        ? Response.json({ page: [], isDone: true, version: 2 })
        : undefined,
    ),
  ])
    await expect(verifyCatalog(fetcher)).rejects.toThrow();
});

const resetNotice =
  "つづきの森：旧作品と旧世界設定の公開を終了しました。執筆・入稿・掲載受付は停止しています。";
function resetFixture(
  override?: (url: URL, count: number) => Response | undefined,
) {
  return fixture((url, count) => {
    const changed = override?.(url, count);
    if (changed) return changed;
    if (/\/(catalog|mains)$/.test(url.pathname))
      return Response.json({ page: [], isDone: true });
    if (url.pathname === "/.well-known/ai-relay.json")
      return Response.json({
        contentStatus: "reset",
        seedWork: null,
        registrationOpen: false,
      });
    if (
      ["/", "/world/", "/join/", "/branches/", "/read/main/"].includes(
        url.pathname,
      )
    )
      return new Response(resetNotice);
    if (
      [
        "/read/ep-001/",
        "/read/ep-002/",
        "/texts/ep-001.md",
        "/texts/ep-002.md",
      ].includes(url.pathname)
    )
      return new Response(null, { status: 404 });
  });
}
it("certifies an empty forest only with reset discovery, all five notices, and the four withdrawn routes", async () => {
  const fetcher = resetFixture();
  expect(await verifyCatalog(fetcher)).toMatchObject({
    outcome: "confirmed",
    mode: "reset",
    branches: [],
    mains: 0,
  });
  for (const route of [
    "/world/",
    "/join/",
    "/read/ep-001/",
    "/read/ep-002/",
    "/texts/ep-001.md",
    "/texts/ep-002.md",
  ])
    expect(fetcher.mock.calls.some((c) => c[0].endsWith(route))).toBe(true);
});
it.each(["/", "/world/", "/join/", "/branches/", "/read/main/"])(
  "refuses empty-state certification without a stop notice at %s",
  async (route) => {
    await expect(
      verifyCatalog(
        resetFixture((url) =>
          url.pathname === route ? new Response("つづきの森") : undefined,
        ),
      ),
    ).rejects.toThrow("SITE_RESET_NOTICE_MISSING");
  },
);
it.each([
  "/read/ep-001/",
  "/read/ep-002/",
  "/texts/ep-001.md",
  "/texts/ep-002.md",
])("refuses reset while old content at %s is reachable", async (route) => {
  await expect(
    verifyCatalog(
      resetFixture((url) =>
        url.pathname === route ? new Response("old content") : undefined,
      ),
    ),
  ).rejects.toThrow("WITHDRAWN_ROUTE_STILL_PUBLIC");
});
it.each([
  { contentStatus: "active", seedWork: null, registrationOpen: false },
  { contentStatus: "reset", seedWork: "old", registrationOpen: false },
  { contentStatus: "reset", seedWork: null, registrationOpen: true },
])("requires every discovery reset flag", async (state) => {
  await expect(
    verifyCatalog(
      resetFixture((url) =>
        url.pathname === "/.well-known/ai-relay.json"
          ? Response.json(state)
          : undefined,
      ),
    ),
  ).rejects.toThrow("EMPTY_FOREST_NOT_DECLARED");
});
it.each([
  () => new Response(null, { status: 503 }),
  () => new Response("broken JSON"),
  () => Response.json({ page: [], isDone: false }),
  () => Response.json({ page: [], isDone: "true" }),
])(
  "does not interpret retrieval or pagination failures as an empty catalog",
  async (response) => {
    await expect(
      verifyCatalog(
        resetFixture((url) =>
          url.pathname.endsWith("/catalog") ? response() : undefined,
        ),
      ),
    ).rejects.toThrow();
  },
);
it("detects a site proxy that becomes stale during the final catalog read", async () => {
  await expect(
    verifyCatalog(
      resetFixture((url, count) =>
        url.pathname === "/api/v1/catalog" && count > 1
          ? Response.json({ page: [origin], isDone: true })
          : undefined,
      ),
    ),
  ).rejects.toThrow("SITE_CATALOG_MISMATCH");
});
it("detects a main published while an empty site is being checked", async () => {
  await expect(
    verifyCatalog(
      resetFixture((url, count) =>
        url.pathname.endsWith("/mains") && count > 1
          ? Response.json({
              page: [{ mainId: "new", version: 1 }],
              isDone: true,
            })
          : undefined,
      ),
    ),
  ).rejects.toThrow("PUBLIC_VERSION_CHANGED");
});
