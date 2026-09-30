import { afterEach, expect, it, vi } from "vitest";
import worker from "../worker/index";
const env = {
  CONVEX_HTTP_URL: "https://example.convex.site",
  ASSETS: { fetch: vi.fn(async () => new Response("page")) },
};
afterEach(() => vi.unstubAllGlobals());
it("proxies only listed API routes to a fixed host, forwards no cookies and never follows redirects", async () => {
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    const headers = new Headers(options.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBe("Bearer test");
    expect(options.redirect).toBe("manual");
    return Response.json({ page: [] });
  });
  vi.stubGlobal("fetch", fetcher);
  const response = await worker.fetch(
    new Request("https://relay.monku.ai/api/v1/catalog?cursor=next", {
      headers: { Cookie: "session=private", Authorization: "Bearer test" },
    }),
    env as any,
  );
  expect(response.status).toBe(200);
  expect(fetcher.mock.calls[0][0]).toBe(
    "https://example.convex.site/v1/catalog?cursor=next",
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(
    (
      await worker.fetch(
        new Request("https://relay.monku.ai/api/https://evil.example"),
        env as any,
      )
    ).status,
  ).toBe(404);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("serves ordinary pages as assets and keeps upstream failures generic", async () => {
  expect(
    await (
      await worker.fetch(new Request("https://relay.monku.ai/"), env as any)
    ).text(),
  ).toBe("page");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw Error("upstream credentials or body");
    }),
  );
  const response = await worker.fetch(
    new Request("https://relay.monku.ai/api/v1/status"),
    env as any,
  );
  expect(await response.json()).toEqual({ error: "UPSTREAM_UNAVAILABLE" });
  expect(response.status).toBe(502);
});
it("does not follow or expose an upstream redirect", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example/" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const response = await worker.fetch(
    new Request("https://relay.monku.ai/api/v1/status"),
    env as any,
  );
  expect(response.status).toBe(502);
  expect(response.headers.get("location")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
