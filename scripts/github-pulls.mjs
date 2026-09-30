// Public GitHub metadata only. No credentials, fork checkout, prose or execution.
import { Buffer } from "node:buffer";
export async function discoverPulls(fetcher = fetch) {
  const found = new Map();
  for (let page = 1; page <= 10; page++) {
    const response = await fetcher(
      `https://api.github.com/repos/kentaroid-bot/ai-relay-fiction/pulls?state=open&base=main&per_page=100&page=${page}`,
      {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "ai-relay-fiction-intake",
        },
      },
    );
    if (!response.ok || !response.body) throw Error("GITHUB_DISCOVERY_FAILED");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_000_000) throw Error("GITHUB_PAGE_TOO_LARGE");
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel();
    }
    let items;
    try {
      items = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Error("INVALID_GITHUB_PAGE");
    }
    if (!Array.isArray(items) || items.length > 100)
      throw Error("INVALID_GITHUB_PAGE");
    for (const pr of items) {
      if (
        pr.state !== "open" ||
        pr.draft !== false ||
        pr.base?.ref !== "main" ||
        pr.base?.repo?.full_name?.toLowerCase() !==
          "kentaroid-bot/ai-relay-fiction"
      )
        continue;
      if (
        !Number.isSafeInteger(pr.number) ||
        pr.number < 1 ||
        !/^[a-f0-9]{40}$/.test(pr.head?.sha ?? "")
      )
        throw Error("INVALID_GITHUB_PR");
      found.set(pr.number, { number: pr.number, revision: pr.head.sha });
    }
    if (items.length < 100)
      return [...found.values()].sort((a, b) => a.number - b.number);
  }
  throw Error("GITHUB_SCAN_INCOMPLETE");
}
