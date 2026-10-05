import { afterEach, expect, it, vi } from "vitest";
import worker from "../worker/index";
const env = {
  CONVEX_HTTP_URL: "https://example.convex.site",
  CATALOG_HTTP_URL: "https://catalog.convex.site",
  ASSETS: { fetch: vi.fn(async () => new Response("page")) },
};
afterEach(() => vi.unstubAllGlobals());
it("proxies only listed API routes to a fixed host, forwards no cookies and never follows redirects", async () => {
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    const headers = new Headers(options.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
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
    "https://catalog.convex.site/v1/catalog?cursor=next",
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
it("keeps authenticated reads and writes on production, separate from the anonymous catalog", async () => {
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    expect(new Headers(options.headers).get("authorization")).toBe(
      "Bearer test",
    );
    return Response.json({ ok: true });
  });
  vi.stubGlobal("fetch", fetcher);
  for (const [method, path] of [
    ["GET", "/me"],
    ["POST", "/commands"],
  ]) {
    await worker.fetch(
      new Request("https://relay.monku.ai/api/v1" + path, {
        method,
        headers: { Authorization: "Bearer test" },
      }),
      env as any,
    );
  }
  expect(fetcher.mock.calls.map((c) => c[0])).toEqual([
    "https://example.convex.site/v1/me",
    "https://example.convex.site/v1/commands",
  ]);
});
it("uses the same public source for branch, main and candidate pagination, but rejects other catalog-host routes", async () => {
  const fetcher = vi.fn(async (_url: string) => Response.json({ page: [] }));
  vi.stubGlobal("fetch", fetcher);
  for (const path of [
    "/mains",
    "/main?id=monku-main&cursor=next",
    "/candidates?id=monku-main&cursor=next",
  ]) {
    await worker.fetch(
      new Request("https://relay.monku.ai/api/v1" + path),
      env as any,
    );
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe(
      "https://catalog.convex.site/v1" + path,
    );
  }
  expect(
    (
      await worker.fetch(
        new Request("https://relay.monku.ai/api/v1/catalog", {
          method: "POST",
        }),
        env as any,
      )
    ).status,
  ).toBe(404);
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
it("routes the new intake API and only forwards signature headers on the webhook route", async () => {
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    const headers = new Headers(options.headers);
    expect(headers.get("cookie")).toBeNull();
    return Response.json({ accepted: true });
  });
  vi.stubGlobal("fetch", fetcher);
  for (const path of ["/v2/intakes", "/v2/intakes/review", "/v2/github"]) {
    await worker.fetch(
      new Request("https://relay.monku.ai/api" + path, {
        method: "POST",
        headers: {
          Authorization: "Bearer participant",
          Cookie: "secret",
          "X-Hub-Signature-256": "sha256=signature",
          "X-GitHub-Event": "pull_request",
        },
        body: "{}",
      }),
      env as any,
    );
  }
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "https://example.convex.site/v2/intakes",
    "https://example.convex.site/v2/intakes/review",
    "https://example.convex.site/v2/github",
  ]);
  expect(
    new Headers(fetcher.mock.calls[0][1].headers).get("x-hub-signature-256"),
  ).toBeNull();
  expect(
    new Headers(fetcher.mock.calls[2][1].headers).get("authorization"),
  ).toBeNull();
  expect(
    new Headers(fetcher.mock.calls[2][1].headers).get("x-hub-signature-256"),
  ).toBe("sha256=signature");
});
