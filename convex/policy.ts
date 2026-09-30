import { ConvexError } from "convex/values";
export const TERMS = "relay-2026-09-30-draft";
export function fail(code: string): never {
  throw new ConvexError(code);
}
export function text(value: unknown, max: number, field: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    fail("INVALID_" + field);
  return value;
}
export function repo(value: unknown): string {
  const s = text(value, 200, "REPOSITORY");
  if (
    !/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(
      s,
    ) ||
    s.endsWith("/.") ||
    s.endsWith("/..")
  )
    fail("INVALID_REPOSITORY");
  return s.toLowerCase();
}
export function revision(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value))
    fail("FIXED_COMMIT_REQUIRED");
  return value;
}
export function path(value: unknown): string {
  const s = text(value, 200, "PATH");
  if (
    !/^manuscript\/[A-Za-z0-9_/-]+\.md$/.test(s) ||
    s.split("/").some((x) => x === ".." || x === "." || !x)
  )
    fail("INVALID_PATH");
  return s;
}
export function readingUrl(value: unknown, repository: string): string {
  const s = text(value, 500, "READING_URL");
  if (s !== repository && !s.startsWith(repository + "/blob/"))
    fail("READING_URL_MUST_BE_OWN_REPOSITORY");
  const u = new URL(s);
  if (
    u.search ||
    u.hash ||
    u.username ||
    u.password ||
    u.origin !== "https://github.com" ||
    u.href !== s ||
    (s !== repository &&
      !u.pathname.startsWith(new URL(repository).pathname + "/blob/"))
  )
    fail("INVALID_READING_URL");
  return s;
}
export async function digest(s: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return Array.from(new Uint8Array(bytes), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
export function keyHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    fail("INVALID_KEY_HASH");
  return value;
}
export async function readBounded(
  response: Response,
  max: number,
): Promise<string> {
  if (!response.ok || !response.body) fail("SOURCE_UNAVAILABLE");
  if (Number(response.headers.get("content-length") || 0) > max)
    fail("SOURCE_TOO_LARGE");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) fail("SOURCE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}
// No caller-supplied host, credentials, redirects, scripts or recursive link following.
export async function githubText(
  repository: string,
  commit: string,
  file: string,
  max = 120_000,
): Promise<string> {
  const base = repo(repository).slice("https://github.com/".length);
  revision(commit);
  if (
    !/^[A-Za-z0-9_./-]+$/.test(file) ||
    file.split("/").some((x) => x === ".." || x === "." || !x)
  )
    fail("INVALID_PATH");
  const url = `https://raw.githubusercontent.com/${base}/${commit}/${file}`;
  return readBounded(
    await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: { Accept: "text/plain" },
    }),
    max,
  );
}
