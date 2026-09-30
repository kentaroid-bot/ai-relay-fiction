import { ConvexError } from "convex/values";
export const TERMS = "relay-2026-09-30-draft";
export const GITHUB_BASE = "kentaroid-bot/ai-relay-fiction";
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
function checkGithubResponse(
  response: Response,
  stage: "pull" | "fork" | "text",
) {
  if (response.ok && response.body) return;
  const numberHeader = (name: string) => {
    const value = response.headers.get(name);
    return value !== null && /^\d{1,12}$/.test(value) ? Number(value) : null;
  };
  // Diagnose upstream failures without logging URLs, response bodies or secrets.
  console.warn(
    "GITHUB_SOURCE_FAILURE",
    JSON.stringify({
      stage,
      status: response.status,
      remaining: numberHeader("x-ratelimit-remaining"),
      reset: numberHeader("x-ratelimit-reset"),
    }),
  );
  fail("SOURCE_UNAVAILABLE");
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
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
    headers: { Accept: "text/plain" },
  });
  checkGithubResponse(response, "text");
  return readBounded(response, max);
}

// Only GitHub's metadata binds a PR author to its public, personally owned fork.
// PR prose, links, titles and repository code never select a host or grant rights.
export async function githubPull(number: number, expectedRevision: string) {
  if (!Number.isSafeInteger(number) || number < 1) fail("INVALID_PR_NUMBER");
  revision(expectedRevision);
  const get = async (route: string, stage: "pull" | "fork") => {
    const response = await fetch("https://api.github.com/repos/" + route, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ai-relay-fiction-intake",
      },
    });
    checkGithubResponse(response, stage);
    return JSON.parse(await readBounded(response, 100000));
  };
  const pr = await get(`${GITHUB_BASE}/pulls/${number}`, "pull");
  if (
    pr.number !== number ||
    pr.state !== "open" ||
    pr.draft !== false ||
    pr.base?.repo?.full_name?.toLowerCase() !== GITHUB_BASE ||
    pr.base?.ref !== "main"
  )
    fail("PR_NOT_ELIGIBLE");
  if (pr.head?.sha !== expectedRevision) fail("PR_HEAD_CONFLICT");
  const repository = repo(pr.head?.repo?.html_url);
  const fork = await get(
    repository.slice("https://github.com/".length),
    "fork",
  );
  const login = text(pr.user?.login, 80, "GITHUB_LOGIN").toLowerCase();
  if (
    fork.private !== false ||
    fork.fork !== true ||
    (fork.parent?.full_name?.toLowerCase() !== GITHUB_BASE &&
      fork.source?.full_name?.toLowerCase() !== GITHUB_BASE) ||
    fork.owner?.type !== "User" ||
    fork.owner?.login?.toLowerCase() !== login ||
    !Number.isSafeInteger(pr.user?.id) ||
    pr.user.id !== fork.owner?.id ||
    repo(fork.html_url) !== repository ||
    pr.head.repo.owner?.id !== fork.owner.id
  )
    fail("PR_OWNERSHIP_REQUIRED");
  return { number, repository, login, revision: expectedRevision };
}
