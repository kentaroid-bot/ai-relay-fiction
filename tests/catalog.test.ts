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
      return new Response("fetch('/api/v1/catalog')");
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
    "PUBLIC_VERSION_CHANGED",
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
