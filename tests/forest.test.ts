import { expect, it, vi } from "vitest";
// @ts-expect-error Browser module is JavaScript.
import * as reader from "../site/main-reader.js";
const {
  rawSource,
  boundedText,
  validatePath,
  renderStory,
  findBranchCandidates,
  isSameRef,
  renderBranchCandidates,
  fetchLiveCandidates,
} = reader;
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
  renderStory(
    document,
    target,
    "# 作品名\n\n## 第1話：カロリーゼロの夜に\n\n本文。\n\n## 第1話：カロリーゼロの夜に\n\n後半。",
    "カロリーゼロの夜に",
  );
  expect(nodes.map((n) => n.textContent)).toEqual([
    "本文。",
    "第1話：カロリーゼロの夜に",
    "後半。",
  ]);
  renderStory(document, target, "## 別の節\n\n本文。", "カロリーゼロの夜に");
  expect(nodes[0].textContent).toBe("別の節");
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
  expect(
    isSameRef(ref, { branchId: "origin", episodeId: "ep-001", revision: sha }),
  ).toBe(true);
  expect(
    isSameRef(ref, {
      branch_id: "origin",
      episode_id: "ep-001",
      revision: sha,
    }),
  ).toBe(true);
  expect(
    isSameRef(ref, {
      branchId: "origin",
      episodeId: "ep-001",
      revision: "b".repeat(40),
    }),
  ).toBe(false);
  expect(
    isSameRef(ref, { branchId: "origin", episodeId: "ep-002", revision: sha }),
  ).toBe(false);
  expect(
    isSameRef(ref, { branchId: "other", episodeId: "ep-001", revision: sha }),
  ).toBe(false);
  expect(isSameRef(ref, null)).toBe(false);
});

it("finds branch and tree candidate pills with strict revision, status, and provenance checks", () => {
  const ep1 = {
    branchId: "origin",
    episodeId: "ep-001",
    revision: sha,
    title: "第1話",
  };
  const ep2a = {
    branchId: "branch-a",
    episodeId: "ep-002",
    revision: "1".repeat(40),
    title: "第2話A",
    parent: ep1,
  };
  const ep2b = {
    branchId: "branch-b",
    episodeId: "ep-002",
    revision: "2".repeat(40),
    title: "第2話B",
    parent: ep1,
  };
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
        reading_url:
          "https://github.com/a/relay/blob/" +
          "1".repeat(40) +
          "/manuscript/02.md",
      },
      {
        id: "branch-b",
        title: "枝B",
        maintainer: "作者B",
        status: "active",
        fork_point: ep1,
        reading_url:
          "https://github.com/b/relay/blob/" +
          "2".repeat(40) +
          "/manuscript/02.md",
      },
      {
        id: "branch-c",
        title: "枝C",
        maintainer: "作者C",
        status: "active",
        fork_point: ep1,
        reading_url:
          "https://github.com/c/relay/blob/" +
          "3".repeat(40) +
          "/manuscript/02.md",
      },
      // Excluded: branch with different revision
      {
        id: "branch-diff-rev",
        title: "別版の枝",
        maintainer: "作者D",
        status: "active",
        fork_point: { ...ep1, revision: "c".repeat(40) },
        reading_url:
          "https://github.com/d/relay/blob/" +
          "4".repeat(40) +
          "/manuscript/02.md",
      },
      // Excluded: paused branch
      {
        id: "branch-paused",
        title: "休止中の枝",
        maintainer: "作者E",
        status: "paused",
        fork_point: ep1,
        reading_url:
          "https://github.com/e/relay/blob/" +
          "5".repeat(40) +
          "/manuscript/02.md",
      },
      // Excluded: invalid reading URL
      {
        id: "branch-invalid-url",
        title: "不正URLの枝",
        maintainer: "作者F",
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
          {
            position: 1,
            available: true,
            episode: { ...ep2b, parent: { ...ep1, revision: "z".repeat(40) } },
          },
        ],
      },
    ],
  };

  // When reading ep1 on tree-1:
  // - branch-a and tree-1 are the current next step -> excluded
  // - tree-2 (with ep2b) is a valid alternate tree -> included
  // - branch-b is deduplicated because tree-2 already provides its reading path -> excluded
  // - branch-c is an independent branch not in any tree -> included
  // - branch-diff-rev, branch-paused, branch-invalid-url, tree-bad-parent -> excluded
  const candidates = findBranchCandidates(
    "tree-1",
    ep1,
    steps,
    0,
    branchesData,
  );
  expect(candidates).toEqual([
    {
      title: "🌲 木2（第2話へ）",
      author: "by 管理人2",
      href: "?id=tree-2&v=1&at=1",
      isExternal: false,
    },
    {
      title: "🌱 枝C",
      author: "by 作者C",
      href:
        "https://github.com/c/relay/blob/" +
        "3".repeat(40) +
        "/manuscript/02.md",
      isExternal: true,
    },
  ]);

  // Safe against null/empty
  expect(findBranchCandidates("tree-1", null, steps, 0, branchesData)).toEqual(
    [],
  );
  expect(findBranchCandidates("tree-1", ep1, steps, 0, null)).toEqual([]);
  expect(
    findBranchCandidates(
      "tree-1",
      { ...ep1, revision: null },
      steps,
      0,
      branchesData,
    ),
  ).toEqual([]);
});

it("renders candidate pills safely and directs to branches catalog on load failure", () => {
  const elements: Record<string, any> = {};
  const doc = {
    getElementById: (id: string) => elements[id],
    createElement: (tag: string) => {
      const node: any = { tag, textContent: "", className: "", children: [] };
      node.append = (...children: any[]) => {
        node.children.push(...children);
      };
      node.replaceChildren = (...children: any[]) => {
        node.children = [...children];
        node.textContent = "";
      };
      return node;
    },
    createTextNode: (text: string) => ({ textContent: text }),
  };
  elements["branch-candidates"] = doc.createElement("div");
  elements["branch-candidates-title"] = doc.createElement("div");
  elements["candidate-pills"] = doc.createElement("div");
  elements["branch-candidates-empty"] = doc.createElement("p");

  const ep = {
    branchId: "origin",
    episodeId: "ep-001",
    revision: sha,
    title: "三割の午後",
  };

  // 1. Success with candidates
  const data = {
    mains: [
      {
        mainId: "tree-2",
        title: "木2",
        maintainer: "管理2",
        version: 1,
        steps: [
          { position: 0, available: true, episode: ep },
          {
            position: 1,
            available: true,
            episode: {
              branchId: "b2",
              episodeId: "ep-2",
              revision: sha,
              parent: ep,
            },
          },
        ],
      },
    ],
    branches: [],
  };
  renderBranchCandidates(
    doc as any,
    "tree-1",
    ep,
    [{ position: 0, available: true, episode: ep }],
    0,
    {
      ok: true,
      candidates: [{ title: "木2", author: "by 管理2", href: "?id=tree-2" }],
    },
  );
  expect(elements["candidate-pills"].children).toHaveLength(1);
  expect(elements["candidate-pills"].children[0].className).toBe(
    "candidate-pill",
  );
  expect(elements["candidate-pills"].hidden).toBe(false);
  expect(elements["branch-candidates-empty"].hidden).toBe(true);

  // 2. Error / failure state: directs to branches catalog rather than falsely reporting "no candidates"
  renderBranchCandidates(doc as any, "tree-1", ep, [], 0, {
    ok: false,
    error: "Network failed",
  });
  expect(elements["candidate-pills"].hidden).toBe(true);
  expect(elements["branch-candidates-empty"].hidden).toBe(false);
  const emptyChildren = elements["branch-candidates-empty"].children;
  expect(
    emptyChildren.some(
      (c: any) => c.tag === "a" && c.href === "../../branches/",
    ),
  ).toBe(true);
  expect(
    emptyChildren.some((c: any) =>
      c.textContent?.includes("読み込めませんでした"),
    ),
  ).toBe(true);
});

it("handles live API fetch with strict error isolation, pagination, and version checking", async () => {
  const ep = {
    branchId: "origin",
    episodeId: "ep-001",
    revision: sha,
    title: "第1話",
  };
  const epNext = {
    branchId: "tree-b-branch",
    episodeId: "ep-002",
    revision: "b".repeat(40),
    parent: ep,
  };

  const validMains = {
    isDone: true,
    page: [
      { mainId: "tree-a", title: "木A", version: 1, count: 1 },
      {
        mainId: "tree-b",
        title: "木B",
        version: 2,
        count: 2,
        maintainer: "作者B",
        agentName: "AI-B",
      },
    ],
  };
  const validTreeBPath = {
    version: 2,
    count: 2,
    isDone: true,
    page: [
      { position: 0, available: true, episode: ep },
      { position: 1, available: true, episode: epNext },
    ],
  };
  const validCatalog = {
    isDone: true,
    page: [
      {
        branchId: "branch-x",
        title: "枝X",
        maintainer: "作者X",
        parent: ep,
        status: "verified",
        readingUrl: "https://github.com/x/r/blob/" + sha + "/manuscript/02.md",
      },
    ],
  };

  // 1. /mains returns 503 -> fails closed (ok: false)
  const fetchMains503 = async (url: string) => {
    if (url.startsWith("/api/v1/mains"))
      return new Response("Service Unavailable", { status: 503 });
    return Response.json({ page: [], isDone: true });
  };
  const res1 = await fetchLiveCandidates(
    fetchMains503,
    "tree-a",
    ep,
    [{ episode: ep }],
    0,
  );
  expect(res1.ok).toBe(false);

  // 2. An unavailable tree does not remove the independent catalog candidate
  const fetchMain503 = async (url: string) => {
    if (url.startsWith("/api/v1/mains")) return Response.json(validMains);
    if (url.startsWith("/api/v1/main?id=tree-b"))
      return new Response("Unavailable", { status: 503 });
    if (url.startsWith("/api/v1/catalog")) return Response.json(validCatalog);
    return new Response("Not found", { status: 404 });
  };
  const res2 = await fetchLiveCandidates(
    fetchMain503,
    "tree-a",
    ep,
    [{ episode: ep }],
    0,
  );
  expect(res2.ok).toBe(true);
  expect(res2.partial).toBe(true);
  expect(res2.candidates).toHaveLength(1);

  // 3. Incomplete catalog keeps the complete, verified tree candidate
  const fetchIncompleteCatalog = async (url: string) => {
    if (url.startsWith("/api/v1/mains")) return Response.json(validMains);
    if (url.startsWith("/api/v1/main?id=tree-b"))
      return Response.json(validTreeBPath);
    if (url.startsWith("/api/v1/catalog"))
      return Response.json({
        page: [{ branchId: "b" }],
        isDone: false,
        continueCursor: "next",
      });
    return new Response("Not found", { status: 404 });
  };
  const res3 = await fetchLiveCandidates(
    fetchIncompleteCatalog,
    "tree-a",
    ep,
    [{ episode: ep }],
    0,
    { maxCatalogPages: 2 },
  );
  expect(res3.ok).toBe(true);
  expect(res3.partial).toBe(true);
  expect(res3.candidates[0].href).toBe("?id=tree-b&v=2&at=1");

  // 4. Version mismatch: mains has version 1, path returns version 2 -> fails closed
  const fetchVersionMismatch = async (url: string) => {
    if (url.startsWith("/api/v1/mains"))
      return Response.json({
        isDone: true,
        page: [{ mainId: "tree-b", version: 1 }],
      });
    if (url.startsWith("/api/v1/main?id=tree-b"))
      return Response.json({ version: 2, count: 0, isDone: true, page: [] });
    if (url.startsWith("/api/v1/catalog"))
      return Response.json({ page: [], isDone: true });
    return new Response("Not found", { status: 404 });
  };
  const res4 = await fetchLiveCandidates(
    fetchVersionMismatch,
    "tree-a",
    ep,
    [{ episode: ep }],
    0,
  );
  expect(res4.ok).toBe(false);

  // 5. Successful live fetch with all pages complete -> ok: true and valid candidate pills
  const fetchSuccess = async (url: string) => {
    if (url.startsWith("/api/v1/mains")) return Response.json(validMains);
    if (url.startsWith("/api/v1/main?id=tree-b"))
      return Response.json(validTreeBPath);
    if (url.startsWith("/api/v1/catalog")) return Response.json(validCatalog);
    return new Response("Not found", { status: 404 });
  };
  const res5 = await fetchLiveCandidates(
    fetchSuccess,
    "tree-a",
    ep,
    [{ episode: ep }],
    0,
  );
  expect(res5.ok).toBe(true);
  expect(res5.candidates).toHaveLength(2);
  expect(res5.candidates[0]).toMatchObject({
    title: "🌲 木B（第2話へ）",
    href: "?id=tree-b&v=2&at=1",
  });
  expect(res5.candidates[1]).toMatchObject({
    title: "🌱 枝X",
    href: validCatalog.page[0].readingUrl,
  });
});

it("enforces strict cursor presence when incomplete, validates path continuity, catches limits on final page, and bounds empty pages", async () => {
  const ep = {
    branchId: "origin",
    episodeId: "ep-001",
    revision: sha,
    title: "第1話",
  };
  const epNext = {
    branchId: "tree-b-branch",
    episodeId: "ep-002",
    revision: "b".repeat(40),
    parent: ep,
  };

  const validMains = {
    isDone: true,
    page: [
      { mainId: "tree-a", title: "木A", version: 1, count: 1 },
      {
        mainId: "tree-b",
        title: "木B",
        version: 2,
        count: 2,
        maintainer: "作者B",
        agentName: "AI-B",
      },
    ],
  };
  const validTreeBPath = {
    version: 2,
    count: 2,
    isDone: true,
    page: [
      { position: 0, available: true, episode: ep },
      { position: 1, available: true, episode: epNext },
    ],
  };
  const validCatalog = {
    isDone: true,
    page: [
      {
        branchId: "branch-x",
        title: "枝X",
        maintainer: "作者X",
        parent: ep,
        status: "verified",
        readingUrl: "https://github.com/x/r/blob/" + sha + "/manuscript/02.md",
      },
    ],
  };

  // Case 1: 未完了なのにカーソル欠落 (Missing continueCursor on incomplete response)
  const fetchMissingCursor = async (url: string) => {
    if (url.startsWith("/api/v1/mains"))
      return Response.json({
        isDone: false,
        page: [{ mainId: "tree-b", version: 1 }],
      }); // continueCursor missing
    return Response.json({ page: [], isDone: true });
  };
  expect(
    (
      await fetchLiveCandidates(
        fetchMissingCursor,
        "tree-a",
        ep,
        [{ episode: ep }],
        0,
      )
    ).ok,
  ).toBe(false);

  // Case 2: 道順件数/position不一致 (Path count mismatch or position discontinuity)
  const fetchCountMismatch = async (url: string) => {
    if (url.startsWith("/api/v1/mains")) return Response.json(validMains);
    if (url.startsWith("/api/v1/main?id=tree-b")) {
      // count: 3 なのに 2件しかない
      return Response.json({
        version: 2,
        count: 3,
        isDone: true,
        page: validTreeBPath.page,
      });
    }
    if (url.startsWith("/api/v1/catalog")) return Response.json(validCatalog);
    return new Response("Not found", { status: 404 });
  };
  const countResult = await fetchLiveCandidates(
    fetchCountMismatch,
    "tree-a",
    ep,
    [{ episode: ep }],
    0,
  );
  expect(countResult.partial).toBe(true);
  expect(countResult.candidates.map((c: any) => c.href)).toEqual([
    validCatalog.page[0].readingUrl,
  ]);

  const fetchPositionMismatch = async (url: string) => {
    if (url.startsWith("/api/v1/mains")) return Response.json(validMains);
    if (url.startsWith("/api/v1/main?id=tree-b")) {
      // position が 0 の次が 2 (不連続)
      return Response.json({
        version: 2,
        count: 2,
        isDone: true,
        page: [
          { position: 0, available: true, episode: ep },
          { position: 2, available: true, episode: epNext },
        ],
      });
    }
    if (url.startsWith("/api/v1/catalog")) return Response.json(validCatalog);
    return new Response("Not found", { status: 404 });
  };
  const positionResult = await fetchLiveCandidates(
    fetchPositionMismatch,
    "tree-a",
    ep,
    [{ episode: ep }],
    0,
  );
  expect(positionResult.partial).toBe(true);
  expect(positionResult.candidates.map((c: any) => c.href)).toEqual([
    validCatalog.page[0].readingUrl,
  ]);

  // Case 3: 最終ページで件数超過 (Limit exceeded on final page with isDone: true)
  const fetchFinalPageOverflow = async (url: string) => {
    if (url.startsWith("/api/v1/mains")) {
      return Response.json({
        isDone: true,
        page: [
          { mainId: "tree-a", version: 1 },
          { mainId: "tree-b", version: 1 },
        ],
      });
    }
    return Response.json({ page: [], isDone: true });
  };
  // maxMains: 1 に対して 2件入りで isDone: true
  expect(
    (
      await fetchLiveCandidates(
        fetchFinalPageOverflow,
        "tree-a",
        ep,
        [{ episode: ep }],
        0,
        { maxMains: 1 },
      )
    ).ok,
  ).toBe(false);

  // Case 4: 空ページが続く (Consecutive empty pages caught by page limit or request budget)
  let mainsRequests = 0;
  const fetchEmptyMainsPages = async (url: string) => {
    if (url.startsWith("/api/v1/mains")) {
      mainsRequests++;
      return Response.json({
        isDone: false,
        continueCursor: "cursor-" + mainsRequests,
        page: [],
      });
    }
    return Response.json({ page: [], isDone: true });
  };
  const resEmpty = await fetchLiveCandidates(
    fetchEmptyMainsPages,
    "tree-a",
    ep,
    [{ episode: ep }],
    0,
    { maxMainsPages: 3 },
  );
  expect(resEmpty.ok).toBe(false);
  expect(mainsRequests).toBe(3); // maxMainsPages に達して安全に停止
});

it("validates path version on every page and enforces overall timeout through final response", async () => {
  const ep = {
    branchId: "origin",
    episodeId: "ep-001",
    revision: sha,
    title: "第1話",
  };
  const epNext = {
    branchId: "tree-b-branch",
    episodeId: "ep-002",
    revision: "b".repeat(40),
    parent: ep,
  };

  const validMainsV2 = {
    isDone: true,
    page: [
      { mainId: "tree-a", title: "木A", version: 1, count: 1 },
      {
        mainId: "tree-b",
        title: "木B",
        version: 2,
        count: 2,
        maintainer: "作者B",
        agentName: "AI-B",
      },
    ],
  };
  const validCatalog = { isDone: true, page: [] };

  // 1. Path version mismatch across pages: mains is v2, first page is v1, final page is v2 -> ok: false
  const fetchVersionShiftInPath = async (url: string) => {
    if (url.startsWith("/api/v1/mains")) return Response.json(validMainsV2);
    if (url.startsWith("/api/v1/main?id=tree-b")) {
      if (!url.includes("cursor=")) {
        // 先頭ページ: version 1, isDone: false, continueCursor: "c2"
        return Response.json({
          version: 1,
          isDone: false,
          continueCursor: "c2",
          page: [{ position: 0, available: true, episode: ep }],
        });
      }
      // 最終ページ: version 2, isDone: true, count: 2
      return Response.json({
        version: 2,
        count: 2,
        isDone: true,
        page: [{ position: 1, available: true, episode: epNext }],
      });
    }
    if (url.startsWith("/api/v1/catalog")) return Response.json(validCatalog);
    return new Response("Not found", { status: 404 });
  };
  const resShift = await fetchLiveCandidates(
    fetchVersionShiftInPath,
    "tree-a",
    ep,
    [{ episode: ep }],
    0,
  );
  expect(resShift.ok).toBe(false);

  // 2. A slow final catalog page cannot discard an already verified tree
  const fetchSlowFinalCatalog = async (url: string) => {
    if (url.startsWith("/api/v1/mains")) return Response.json(validMainsV2);
    if (url.startsWith("/api/v1/main?id=tree-b")) {
      return Response.json({
        version: 2,
        count: 2,
        isDone: true,
        page: [
          { position: 0, available: true, episode: ep },
          { position: 1, available: true, episode: epNext },
        ],
      });
    }
    if (url.startsWith("/api/v1/catalog")) {
      // 最後の catalog レスポンス本文取得で全体時間を超過
      await new Promise((resolve) => setTimeout(resolve, 25));
      return Response.json(validCatalog);
    }
    return new Response("Not found", { status: 404 });
  };
  const resTimeout = await fetchLiveCandidates(
    fetchSlowFinalCatalog,
    "tree-a",
    ep,
    [{ episode: ep }],
    0,
    {
      overallTimeoutMs: 20,
      timeoutMs: 50,
    },
  );
  expect(resTimeout.ok).toBe(true);
  expect(resTimeout.partial).toBe(true);
  expect(resTimeout.candidates[0].href).toBe("?id=tree-b&v=2&at=1");
});

it("shows declared influences as plain text, links only the available exact parent, and clears absent declarations", () => {
  const elements: Record<string, any> = {};
  const doc = {
    getElementById: (id: string) => elements[id],
    createElement: (tag: string) => {
      const node: any = { tag, textContent: "", children: [] };
      node.append = (...children: any[]) => node.children.push(...children);
      node.replaceChildren = () => {
        node.children = [];
      };
      return node;
    },
  };
  const section = (elements["episode-influences"] =
    doc.createElement("section"));
  const parent = {
    branchId: "parent",
    episodeId: "ep-001",
    revision: sha,
    title: "Parent",
  };
  const episode = {
    parent,
    readingUrl:
      "https://github.com/writer/story/blob/" + sha + "/manuscript/01.md",
    influences: [
      { title: "Parent", relationship: "<img src=x onerror=run()>" },
      {
        title: "External",
        author: "Author",
        publishedYear: 1941,
        relationship: "[run](javascript:run())",
      },
    ],
  };
  const steps = [{ position: 0, available: true, episode: parent }];
  const link = vi.fn((label, position) => ({
    tag: "a",
    textContent: label,
    href: "?id=tree&v=1&at=" + position,
  }));
  reader.renderInfluences(doc, episode, steps, link);
  expect(section.hidden).toBe(false);
  expect(section.children[1].textContent).toBe("作者による影響関係の説明");
  expect(section.children[2].children[1]).toMatchObject({
    tag: "p",
    textContent: "<img src=x onerror=run()>",
  });
  expect(section.children[3].children[1].textContent).toBe(
    "[run](javascript:run())",
  );
  expect(section.children[4].href).toBe(
    "https://github.com/writer/story/blob/" + sha + "/relay-branch.json",
  );
  expect(link).toHaveBeenCalledOnce();
  link.mockClear();
  reader.renderInfluences(
    doc,
    episode,
    [{ ...steps[0], available: false }],
    link,
  );
  expect(link).not.toHaveBeenCalled();
  reader.renderInfluences(
    doc,
    episode,
    [{ ...steps[0], episode: { ...parent, revision: "b".repeat(40) } }],
    link,
  );
  expect(link).not.toHaveBeenCalled();
  reader.renderInfluences(doc, {});
  expect(section.hidden).toBe(true);
  expect(section.children).toEqual([]);
  expect(() =>
    reader.renderInfluences(doc, {
      ...episode,
      readingUrl: "javascript:run()",
    }),
  ).toThrow();
  expect(section.hidden).toBe(true);
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
