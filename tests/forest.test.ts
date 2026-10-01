import { expect, it, vi } from "vitest";
// @ts-expect-error Browser module is JavaScript.
import * as reader from "../site/main-reader.js";
const { rawSource, boundedText, validatePath, renderStory, findBranchCandidates, isSameRef, renderBranchCandidates, fetchLiveCandidates } = reader;
// @ts-expect-error Operational CLI is JavaScript.
import { applyCandidates } from "../scripts/apply-mains.mjs";
const sha = "a".repeat(40);
it("fetches only fixed GitHub Markdown, never links or alternate hosts", () => {
  expect(
    rawSource(
      "https://github.com/writer/story/blob/" + sha + "/manuscript/02.md",
    ),
  ).toBe(
    "https://raw.githubusercontent.com/writer/story/" +
      sha +
      "/manuscript/02.md",
  );
  for (const url of [
    "https://example.com/story.md",
    "https://github.com/writer/story/blob/main/story.md",
    "https://github.com/writer/story/blob/" + sha + "/story.html",
    "https://github.com/writer/story/blob/" + sha + "/story.md?token=secret",
  ])
    expect(() => rawSource(url)).toThrow();
});
it("bounds source bytes even without Content-Length and rejects changed versions and gaps", async () => {
  await expect(
    boundedText(new Response("x".repeat(18001)), 18000),
  ).rejects.toThrow("Too large");
  const a = { branchId: "origin", episodeId: "ep-001", revision: sha },
    b = { branchId: "branch", episodeId: "ep-002", revision: sha, parent: a };
  const steps = [
    { position: 0, available: true, episode: a },
    { position: 1, available: true, episode: b },
  ];
  expect(() => validatePath({ count: 2, version: 1 }, steps, 1)).not.toThrow();
  expect(() => validatePath({ count: 2, version: 2 }, steps, 1)).toThrow();
  expect(() =>
    validatePath(
      { count: 2, version: 1 },
      [steps[0], { ...steps[1], position: 3 }],
      1,
    ),
  ).toThrow();
  expect(() =>
    validatePath(
      { count: 2, version: 1 },
      [steps[0], { ...steps[1], episode: { ...b, parent: null } }],
      1,
    ),
  ).toThrow();
});
it("renders malicious markup and Markdown links as literal text", () => {
  const nodes: any[] = [];
  const document = {
    createElement: (tag: string) => ({ tag, textContent: "", className: "" }),
  };
  const target = {
    replaceChildren: () => {
      nodes.length = 0;
    },
    append: (n: any) => nodes.push(n),
  };
  renderStory(
    document,
    target,
    "# Title\n\n<script>steal()</script>\n\n[run](javascript:steal())",
  );
  expect(nodes.map((n) => n.tag)).toEqual(["p", "p"]);
  expect(nodes.map((n) => n.textContent)).toEqual([
    "<script>steal()</script>",
    "[run](javascript:steal())",
  ]);
  renderStory(document, target, "```\n[思考ログ]\n入力: ◎\n```\n\n普通の段落");
  expect(nodes.map((n) => n.tag)).toEqual(["pre", "p"]);
  expect(nodes[0].textContent).toBe("[思考ログ]\n入力: ◎");
});
it("retries a lost main response after the wait, never duplicates a completed or held declaration", async () => {
  const pr = {
    number: 6,
    revision: sha,
    branchId: "my-branch",
    status: "received",
    mainDeclared: true,
  };
  const state: any = {},
    save = vi.fn();
  let fail = true;
  const send = vi.fn(async (route: string) => {
    if (route.startsWith("/v1/branch?"))
      return { branch: { revision: sha, status: "verified", version: 3 } };
    if (fail) throw Error("MAIN_REQUEST_FAILED");
    return { outcome: "already_applied", mainId: "my-tree", version: 1 };
  });
  expect(
    (await applyCandidates({ 6: pr }, state, send, save, 0))[0].status,
  ).toBe("retry");
  expect(await applyCandidates({ 6: pr }, state, send, save, 1000)).toEqual([]);
  fail = false;
  expect(
    (await applyCandidates({ 6: pr }, state, send, save, 4 * 3600000))[0]
      .status,
  ).toBe("applied");
  expect(
    await applyCandidates({ 6: pr }, state, send, save, 5 * 3600000),
  ).toEqual([]);
  state["6:" + sha] = { status: "held" };
  expect(
    await applyCandidates({ 6: pr }, state, send, save, 6 * 3600000),
  ).toEqual([]);
});
it("does not let older unlisted declarations starve listed trees and records overflow for retry", async () => {
  const pulls = Object.fromEntries(
    Array.from({ length: 15 }, (_, i) => [
      i + 1,
      {
        number: i + 1,
        revision: sha,
        branchId: "branch-" + (i + 1),
        status: "received",
        mainDeclared: true,
      },
    ]),
  );
  const state: any = {};
  let applied = 0;
  const send = async (route: string, input: any) => {
    if (route.startsWith("/v1/branch?")) {
      const number = Number(route.split("branch-")[1]);
      return {
        branch: {
          revision: sha,
          status: number <= 3 ? "checked" : "verified",
          version: 3,
        },
      };
    }
    applied++;
    return { outcome: "created", mainId: "tree-" + input.number, version: 1 };
  };
  const outcomes = await applyCandidates(pulls, state, send, async () => {}, 0);
  expect(applied).toBe(10);
  expect(outcomes.filter((r: any) => r.status === "retry")).toHaveLength(2);
  expect(
    outcomes
      .filter((r: any) => r.status === "retry")
      .every(
        (r: any) =>
          r.error === "MAIN_BATCH_DEFERRED" && r.nextAttempt === 4 * 3600000,
      ),
  ).toBe(true);
  expect(state["1:" + sha]).toBeUndefined();
});

it("strictly compares branch references using branchId, episodeId, and revision", () => {
  const ref = { branchId: "origin", episodeId: "ep-001", revision: sha };
  expect(isSameRef(ref, { branchId: "origin", episodeId: "ep-001", revision: sha })).toBe(true);
  expect(isSameRef(ref, { branch_id: "origin", episode_id: "ep-001", revision: sha })).toBe(true);
  expect(isSameRef(ref, { branchId: "origin", episodeId: "ep-001", revision: "b".repeat(40) })).toBe(false);
  expect(isSameRef(ref, { branchId: "origin", episodeId: "ep-002", revision: sha })).toBe(false);
  expect(isSameRef(ref, { branchId: "other", episodeId: "ep-001", revision: sha })).toBe(false);
  expect(isSameRef(ref, null)).toBe(false);
});

it("finds branch and tree candidate pills with strict revision, status, and provenance checks", () => {
  const ep1 = { branchId: "origin", episodeId: "ep-001", revision: sha, title: "第1話" };
  const ep2a = { branchId: "branch-a", episodeId: "ep-002", revision: "1".repeat(40), title: "第2話A", parent: ep1 };
  const ep2b = { branchId: "branch-b", episodeId: "ep-002", revision: "2".repeat(40), title: "第2話B", parent: ep1 };
  const steps = [
    { position: 0, available: true, episode: ep1 },
    { position: 1, available: true, episode: ep2a },
  ];
  const branchesData = {
    branches: [
      {
        id: "branch-a",
        title: "枝A",
        maintainer: "作者A",
        status: "active",
        fork_point: ep1,
        reading_url: "https://github.com/a/relay/blob/" + "1".repeat(40) + "/manuscript/02.md",
      },
      {
        id: "branch-b",
        title: "枝B",
        maintainer: "作者B",
        status: "active",
        fork_point: ep1,
        reading_url: "https://github.com/b/relay/blob/" + "2".repeat(40) + "/manuscript/02.md",
      },
      // Excluded: branch with different revision
      {
        id: "branch-diff-rev",
        title: "別版の枝",
        maintainer: "作者C",
        status: "active",
        fork_point: { ...ep1, revision: "c".repeat(40) },
        reading_url: "https://github.com/c/relay/blob/" + "3".repeat(40) + "/manuscript/02.md",
      },
      // Excluded: paused branch
      {
        id: "branch-paused",
        title: "休止中の枝",
        maintainer: "作者D",
        status: "paused",
        fork_point: ep1,
        reading_url: "https://github.com/d/relay/blob/" + "4".repeat(40) + "/manuscript/02.md",
      },
      // Excluded: invalid reading URL
      {
        id: "branch-invalid-url",
        title: "不正URLの枝",
        maintainer: "作者E",
        status: "active",
        fork_point: ep1,
        reading_url: "javascript:alert(1)",
      },
    ],
    mains: [
      {
        id: "tree-1",
        title: "木1",
        maintainer: "管理人1",
        version: 1,
        path: [
          { position: 0, available: true, episode: ep1 },
          { position: 1, available: true, episode: ep2a },
        ],
      },
      {
        id: "tree-2",
        title: "木2",
        maintainer: "管理人2",
        version: 1,
        path: [
          { position: 0, available: true, episode: ep1 },
          { position: 1, available: true, episode: ep2b },
        ],
      },
      // Excluded: discontinuous tree (parent doesn't match ep1)
      {
        id: "tree-bad-parent",
        title: "不連続な木",
        maintainer: "管理人3",
        version: 1,
        path: [
          { position: 0, available: true, episode: ep1 },
          { position: 1, available: true, episode: { ...ep2b, parent: { ...ep1, revision: "z".repeat(40) } } },
        ],
      },
    ],
  };

  // When reading ep1 on tree-1:
  // - branch-a and tree-1 are the current next step -> excluded
  // - tree-2 (with ep2b) and branch-b are valid alternate continuations -> included
  // - branch-diff-rev, branch-paused, branch-invalid-url, tree-bad-parent -> excluded
  const candidates = findBranchCandidates("tree-1", ep1, steps, 0, branchesData);
  expect(candidates).toEqual([
    {
      title: "🌲 木2（第2話へ）",
      author: "by 管理人2",
      href: "?id=tree-2&v=1&at=1",
      isExternal: false,
    },
    {
      title: "🌱 枝B",
      author: "by 作者B",
      href: "https://github.com/b/relay/blob/" + "2".repeat(40) + "/manuscript/02.md",
      isExternal: true,
    },
  ]);

  // Safe against null/empty
  expect(findBranchCandidates("tree-1", null, steps, 0, branchesData)).toEqual([]);
  expect(findBranchCandidates("tree-1", ep1, steps, 0, null)).toEqual([]);
  expect(findBranchCandidates("tree-1", { ...ep1, revision: null }, steps, 0, branchesData)).toEqual([]);
});

it("renders candidate pills safely and directs to branches catalog on load failure", () => {
  const elements: Record<string, any> = {};
  const doc = {
    getElementById: (id: string) => elements[id],
    createElement: (tag: string) => {
      const node: any = { tag, textContent: "", className: "", children: [] };
      node.append = (...children: any[]) => { node.children.push(...children); };
      node.replaceChildren = (...children: any[]) => { node.children = [...children]; node.textContent = ""; };
      return node;
    },
    createTextNode: (text: string) => ({ textContent: text }),
  };
  elements["branch-candidates"] = doc.createElement("div");
  elements["branch-candidates-title"] = doc.createElement("div");
  elements["candidate-pills"] = doc.createElement("div");
  elements["branch-candidates-empty"] = doc.createElement("p");

  const ep = { branchId: "origin", episodeId: "ep-001", revision: sha, title: "三割の午後" };

  // 1. Success with candidates
  const data = {
    mains: [{ mainId: "tree-2", title: "木2", maintainer: "管理2", version: 1, steps: [
      { position: 0, available: true, episode: ep },
      { position: 1, available: true, episode: { branchId: "b2", episodeId: "ep-2", revision: sha, parent: ep } },
    ]}],
    branches: [],
  };
  renderBranchCandidates(doc as any, "tree-1", ep, [{ position: 0, available: true, episode: ep }], 0, { ok: true, candidates: [{ title: "木2", author: "by 管理2", href: "?id=tree-2" }] });
  expect(elements["candidate-pills"].children).toHaveLength(1);
  expect(elements["candidate-pills"].children[0].className).toBe("candidate-pill");
  expect(elements["candidate-pills"].hidden).toBe(false);
  expect(elements["branch-candidates-empty"].hidden).toBe(true);

  // 2. Error / failure state: directs to branches catalog rather than falsely reporting "no candidates"
  renderBranchCandidates(doc as any, "tree-1", ep, [], 0, { ok: false, error: "Network failed" });
  expect(elements["candidate-pills"].hidden).toBe(true);
  expect(elements["branch-candidates-empty"].hidden).toBe(false);
  const emptyChildren = elements["branch-candidates-empty"].children;
  expect(emptyChildren.some((c: any) => c.tag === "a" && c.href === "../../branches/")).toBe(true);
  expect(emptyChildren.some((c: any) => c.textContent?.includes("読み込めませんでした"))).toBe(true);
});

it("handles live API fetch with strict error isolation, pagination, and version checking", async () => {
  const ep = { branchId: "origin", episodeId: "ep-001", revision: sha, title: "第1話" };
  const epNext = { branchId: "tree-b-branch", episodeId: "ep-002", revision: "b".repeat(40), parent: ep };

  const validMains = { isDone: true, page: [
    { mainId: "tree-a", title: "木A", version: 1, count: 1 },
    { mainId: "tree-b", title: "木B", version: 2, count: 2, maintainer: "作者B", agentName: "AI-B" },
  ]};
  const validTreeBPath = { version: 2, isDone: true, page: [
    { position: 0, available: true, episode: ep },
    { position: 1, available: true, episode: epNext },
  ]};
  const validCatalog = { isDone: true, page: [
    { branchId: "branch-x", title: "枝X", maintainer: "作者X", parent: ep, status: "verified", readingUrl: "https://github.com/x/r/blob/" + sha + "/manuscript/02.md" },
  ]};

  // 1. /mains returns 503 -> fails closed (ok: false)
  const fetchMains503 = async (url: string) => {
    if (url.startsWith("/api/v1/mains")) return new Response("Service Unavailable", { status: 503 });
    return Response.json({ page: [], isDone: true });
  };
  const res1 = await fetchLiveCandidates(fetchMains503, "tree-a", ep, [{ episode: ep }], 0);
  expect(res1.ok).toBe(false);

  // 2. Individual /main?id=tree-b returns 503 -> fails closed (ok: false)
  const fetchMain503 = async (url: string) => {
    if (url.startsWith("/api/v1/mains")) return Response.json(validMains);
    if (url.startsWith("/api/v1/main?id=tree-b")) return new Response("Unavailable", { status: 503 });
    if (url.startsWith("/api/v1/catalog")) return Response.json(validCatalog);
    return new Response("Not found", { status: 404 });
  };
  const res2 = await fetchLiveCandidates(fetchMain503, "tree-a", ep, [{ episode: ep }], 0);
  expect(res2.ok).toBe(false);

  // 3. /catalog incomplete pagination (page limit exceeded while isDone: false) -> fails closed
  const fetchIncompleteCatalog = async (url: string) => {
    if (url.startsWith("/api/v1/mains")) return Response.json(validMains);
    if (url.startsWith("/api/v1/main?id=tree-b")) return Response.json(validTreeBPath);
    if (url.startsWith("/api/v1/catalog")) return Response.json({ page: [{ branchId: "b" }], isDone: false, continueCursor: "next" });
    return new Response("Not found", { status: 404 });
  };
  const res3 = await fetchLiveCandidates(fetchIncompleteCatalog, "tree-a", ep, [{ episode: ep }], 0, { maxCatalogPages: 2 });
  expect(res3.ok).toBe(false);

  // 4. Version mismatch: mains has version 1, path returns version 2 -> fails closed
  const fetchVersionMismatch = async (url: string) => {
    if (url.startsWith("/api/v1/mains")) return Response.json({ isDone: true, page: [{ mainId: "tree-b", version: 1 }] });
    if (url.startsWith("/api/v1/main?id=tree-b")) return Response.json({ version: 2, isDone: true, page: [] });
    if (url.startsWith("/api/v1/catalog")) return Response.json({ page: [], isDone: true });
    return new Response("Not found", { status: 404 });
  };
  const res4 = await fetchLiveCandidates(fetchVersionMismatch, "tree-a", ep, [{ episode: ep }], 0);
  expect(res4.ok).toBe(false);

  // 5. Successful live fetch with all pages complete -> ok: true and valid candidate pills
  const fetchSuccess = async (url: string) => {
    if (url.startsWith("/api/v1/mains")) return Response.json(validMains);
    if (url.startsWith("/api/v1/main?id=tree-b")) return Response.json(validTreeBPath);
    if (url.startsWith("/api/v1/catalog")) return Response.json(validCatalog);
    return new Response("Not found", { status: 404 });
  };
  const res5 = await fetchLiveCandidates(fetchSuccess, "tree-a", ep, [{ episode: ep }], 0);
  expect(res5.ok).toBe(true);
  expect(res5.candidates).toHaveLength(2);
  expect(res5.candidates[0]).toMatchObject({ title: "🌲 木B（第2話へ）", href: "?id=tree-b&v=2&at=1" });
  expect(res5.candidates[1]).toMatchObject({ title: "🌱 枝X", href: validCatalog.page[0].readingUrl });
});



it("shows literal provenance credits with fixed source links, and clears withdrawn references", () => {
  const nodes: any[] = [];
  const document = {
    createElement: (tag: string) => ({
      tag,
      textContent: "",
      href: "",
      rel: "",
    }),
  };
  const target = {
    hidden: false,
    textContent: "",
    replaceChildren: () => {
      nodes.length = 0;
    },
    append: (n: any) => nodes.push(n),
  };
  const episode: any = {
    sourceRef: {
      available: true,
      title: "<script>run()</script>",
      maintainer: "書き手",
      agentName: "元AI",
      readingUrl:
        "https://github.com/source/story/blob/" + sha + "/manuscript/02.md",
    },
    author: { maintainer: "編者", agentName: "翻案AI" },
  };
  reader.renderProvenance(document, target, episode);
  expect(nodes[0]).toMatchObject({
    tag: "a",
    textContent: "出典：「<script>run()</script>」 · 書き手 / 元AI",
    href: episode.sourceRef.readingUrl,
  });
  expect(nodes[1].textContent).toContain("翻案AI");
  episode.sourceRef.readingUrl = "javascript:run()";
  expect(() => reader.renderProvenance(document, target, episode)).toThrow();
  episode.sourceRef = { available: false };
  reader.renderProvenance(document, target, episode);
  expect(nodes).toHaveLength(0);
  expect(target.textContent).toContain("案内を停止");
  reader.renderProvenance(document, target, {});
  expect(target.hidden).toBe(true);
});
