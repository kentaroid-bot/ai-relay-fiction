import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error Browser module is native JavaScript.
import { fetchLiveCandidates, readTree, readStaticCandidates, renderBranchCandidates } from "../site/main-reader.js";

const sha = "a".repeat(40);
const ep = { branchId: "origin", episodeId: "ep-001", revision: sha, title: "起点" };
const next = { branchId: "healthy-branch", episodeId: "ep-002", revision: sha, parent: ep };
const path = { version: 1, count: 2, isDone: true, page: [
  { position: 0, available: true, episode: ep },
  { position: 1, available: true, episode: next },
] };
const mains = { isDone: true, page: [
  { mainId: "healthy-tree", title: "正常な木", version: 1 },
  { mainId: "broken-tree", title: "不調の木", version: 1 },
] };
afterEach(() => vi.unstubAllGlobals());

it("keeps a confirmed candidate after another tree fails, and still checks the catalog", async () => {
  const calls: string[] = [];
  const result = await fetchLiveCandidates(async (url: string) => {
    calls.push(url);
    if (url === "/api/v1/mains") return Response.json(mains);
    if (url.includes("healthy-tree")) return Response.json(path);
    if (url.includes("broken-tree")) return new Response("Unavailable", { status: 503 });
    return Response.json({ isDone: true, page: [{ branchId: "independent", parent: ep,
      readingUrl: `https://github.com/another/story/blob/${sha}/story.md` }] });
  }, "current-tree", ep, [], 0);
  expect(result).toMatchObject({ ok: true, partial: true });
  expect(result.candidates.map((c: any) => c.href)).toEqual([
    "?id=healthy-tree&v=1&at=1", `https://github.com/another/story/blob/${sha}/story.md`,
  ]);
  expect(calls).toContain("/api/v1/catalog");
});

it("retains verified candidates at the shared request limit without making more requests", async () => {
  let calls = 0;
  const result = await fetchLiveCandidates(async (url: string) => {
    calls++;
    if (url === "/api/v1/mains") return Response.json(mains);
    return Response.json(path);
  }, "current-tree", ep, [], 0, { maxTotalRequests: 2 });
  expect(calls).toBe(2);
  expect(result).toMatchObject({ ok: true, partial: true });
  expect(result.candidates[0].href).toBe("?id=healthy-tree&v=1&at=1");
});

it("uses a received mains page and a received catalog page even when later pages fail", async () => {
  const result = await fetchLiveCandidates(async (url: string) => {
    if (url === "/api/v1/mains") return Response.json({ ...mains, isDone: false, continueCursor: "m2" });
    if (url.includes("cursor=")) return new Response("Unavailable", { status: 503 });
    if (url.includes("healthy-tree")) return Response.json(path);
    if (url.includes("broken-tree")) return new Response("Unavailable", { status: 503 });
    return Response.json({ isDone: false, continueCursor: "c2", page: [{ branchId: "independent", parent: ep,
      readingUrl: `https://github.com/another/story/blob/${sha}/story.md` }] });
  }, "current-tree", ep, [], 0);
  expect(result).toMatchObject({ ok: true, partial: true });
  expect(result.candidates).toHaveLength(2);
});

function documentFixture() {
  const elements: Record<string, any> = {};
  const doc: any = {
    getElementById: (id: string) => elements[id],
    createElement: (tag: string) => {
      const node: any = { tag, textContent: "", children: [], attributes: {} };
      node.append = (...children: any[]) => node.children.push(...children);
      node.replaceChildren = (...children: any[]) => { node.children = children; node.textContent = ""; };
      node.setAttribute = (key: string, value: string) => node.attributes[key] = value;
      node.getAttribute = (key: string) => node.attributes[key];
      return node;
    },
  };
  for (const id of ["reading-status", "refresh-tree", "tree-title", "tree-credit", "tree-path",
    "episode-title", "episode-source", "tree-story", "tree-navigation", "branch-candidates",
    "branch-candidates-title", "candidate-pills", "branch-candidates-empty"]) {
    elements[id] = doc.createElement("div");
  }
  return { doc, elements };
}

it("reads a public selected episode after an unavailable ancestor, while omitting the stopped previous link", async () => {
  const { doc, elements } = documentFixture();
  const prose = "# 後続話\n\n読める本文。";
  const currentEp = { ...next, title: "後続話", readingUrl: `https://github.com/writer/story/blob/${sha}/story.md`,
    contentHash: createHash("sha256").update(prose).digest("hex") };
  const stoppedPath = { ...path, page: [
    { position: 0, available: false }, { position: 1, available: true, episode: currentEp },
  ] };
  let sourceReads = 0;
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", { search: "?id=healthy-tree&v=1&at=1", protocol: "https:" });
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.startsWith("https://raw.githubusercontent.com/")) { sourceReads++; return new Response(prose); }
    if (url.startsWith("/api/v1/main?")) return Response.json(stoppedPath);
    return Response.json({ page: [], isDone: true });
  });
  await readTree();
  expect(sourceReads).toBe(1);
  expect(elements["tree-story"].children.map((c: any) => c.textContent)).toEqual(["読める本文。"]);
  expect(elements["tree-navigation"].children.some((c: any) => c.textContent === "前の話へ")).toBe(false);
  expect(elements["reading-status"].textContent).toBe("");
  // The selected episode's own withdrawal must still prevent publication.
  vi.stubGlobal("fetch", async () => Response.json({ ...stoppedPath, page: [
    { position: 0, available: false }, { position: 1, available: false },
  ] }));
  await readTree();
  expect(elements["tree-story"].children).toHaveLength(0);
  expect(elements["reading-status"].textContent).toContain("確認できませんでした");
});

it("updates the static episode with current fixed-reference candidates and working local tree links", async () => {
  const { doc, elements } = documentFixture();
  elements["branch-candidates"].setAttribute("data-episode-ref", JSON.stringify(ep));
  const result = await readStaticCandidates(doc, async (url: string) => {
    if (url === "/api/v1/mains") return Response.json({ isDone: true, page: mains.page.slice(0, 1) });
    if (url.includes("healthy-tree")) return Response.json(path);
    // Catalog repeats the same next episode: tree link must win.
    return Response.json({ isDone: true, page: [{ branchId: next.branchId, parent: ep,
      readingUrl: `https://github.com/writer/story/blob/${sha}/story.md` }] });
  });
  expect(result.candidates).toHaveLength(1);
  expect(elements["candidate-pills"].children[0].href).toBe("../main/?id=healthy-tree&v=1&at=1");
  const html = readFileSync(new URL("../site/dist/read/ep-001/index.html", import.meta.url), "utf8");
  expect(html).toContain('id="branch-candidates"');
  expect(html).toContain('data-episode-ref="');
  expect(html).toContain("6f80549558fa227e6dd7628ac595aae62dbbc05d");
});

it.each(["changed-prose", "withdrawn-during-fetch"])("does not display selected prose when %s", async (failure) => {
  const { doc, elements } = documentFixture();
  const prose = "# 起点\n\n公開された本文。";
  const selected = { ...ep, readingUrl: `https://github.com/writer/story/blob/${sha}/story.md`,
    contentHash: createHash("sha256").update(prose).digest("hex") };
  let pathReads = 0;
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", { search: "?id=healthy-tree&v=1&at=0", protocol: "https:" });
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      return new Response(failure === "changed-prose" ? prose + "改変" : prose);
    }
    pathReads++;
    return Response.json({ version: 1, count: 1, isDone: true, page: [{
      position: 0, available: !(failure === "withdrawn-during-fetch" && pathReads > 1), episode: selected,
    }] });
  });
  await readTree();
  expect(elements["tree-story"].children).toHaveLength(0);
  expect(elements["reading-status"].textContent).toContain("確認できませんでした");
});

it("marks a partial candidate list without hiding its confirmed links or claiming completeness", () => {
  const { doc, elements } = documentFixture();
  renderBranchCandidates(doc, "current-tree", ep, [], 0, { ok: true, partial: true,
    candidates: [{ title: "正常な木", author: "編纂者", href: "?id=healthy-tree&v=1&at=1" }] });
  expect(elements["candidate-pills"].hidden).toBe(false);
  expect(elements["candidate-pills"].children).toHaveLength(1);
  expect(elements["branch-candidates-empty"].hidden).toBe(false);
  expect(elements["branch-candidates-empty"].textContent).toContain("一部");
});
