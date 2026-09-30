const allowed = new Set([
  "GET /v1/applications",
  "GET /v1/status",
  "GET /v1/catalog",
  "GET /v1/mains",
  "GET /v1/main",
  "GET /v1/candidates",
  "GET /v1/me",
  "GET /v1/reading-notes",
  "GET /v1/inbox",
  "GET /v1/slots",
  "GET /v1/submissions",
  "GET /v1/submission",
  "GET /v1/branches",
  "GET /v1/branch",
  "GET /v1/agents",
  "GET /v1/history",
  "GET /v1/characters",
  "POST /v1/register",
  "POST /v1/verify",
  "POST /v1/commands",
  "POST /v1/branches/check",
  "POST /v1/submissions/publish",
]);
// Public reading data can come from the shared trial without moving participants
// or their credentials into production. Only these anonymous GETs use it.
const catalogRoutes = new Set([
  "GET /v1/catalog",
  "GET /v1/mains",
  "GET /v1/main",
  "GET /v1/candidates",
]);
function error(code: string, status: number) {
  return Response.json(
    { error: code },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);
    if (!incoming.pathname.startsWith("/api/"))
      return env.ASSETS.fetch(request);
    const path = incoming.pathname.slice("/api".length);
    if (!allowed.has(request.method + " " + path))
      return error("NOT_FOUND", 404);
    const publicCatalog = catalogRoutes.has(request.method + " " + path);
    const base = publicCatalog ? env.CATALOG_HTTP_URL : env.CONVEX_HTTP_URL;
    if (!/^https:\/\/[a-z0-9-]+\.convex\.site$/.test(base))
      return error("SERVICE_UNAVAILABLE", 503);
    if (Number(request.headers.get("Content-Length") || 0) > 150000)
      return error("SOURCE_TOO_LARGE", 413);
    const headers = new Headers({ Accept: "application/json" });
    // Never forward cookies, arbitrary host headers or browser session credentials.
    for (const name of publicCatalog
      ? []
      : ["Authorization", "Content-Type", "Idempotency-Key"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    try {
      const upstream = await fetch(base + path + incoming.search, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
        signal: AbortSignal.timeout(60000),
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        return error("UPSTREAM_UNAVAILABLE", 502);
      }
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      // No request/response bodies or bearer values in logs.
      return error("UPSTREAM_UNAVAILABLE", 502);
    }
  },
} satisfies ExportedHandler<Env>;
