import { expect, it, vi } from "vitest";
// @ts-expect-error Browser module is JavaScript.
import * as reader from "../site/main-reader.js";
const { rawSource, boundedText, validatePath, renderStory, findBranchCandidates } = reader;
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

it("finds branch and tree candidate pills for exploring alternate story paths", () => {
  const ep1 = { branchId: "origin", episodeId: "ep-001", title: "第1話" };
  const ep2a = { branchId: "branch-a", episodeId: "ep-002", title: "第2話A" };
  const ep2b = { branchId: "branch-b", episodeId: "ep-002", title: "第2話B" };
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
        fork_point: { branch_id: "origin", episode_id: "ep-001" },
        reading_url: "https://github.com/a/relay/blob/1111111111111111111111111111111111111111/manuscript/02.md",
      },
      {
        id: "branch-b",
        title: "枝B",
        maintainer: "作者B",
        fork_point: { branch_id: "origin", episode_id: "ep-001" },
        reading_url: "https://github.com/b/relay/blob/2222222222222222222222222222222222222222/manuscript/02.md",
      },
    ],
    mains: [
      {
        id: "tree-1",
        title: "木1",
        maintainer: "管理人1",
        version: 1,
        path: [
          { position: 0, available: true, episode: { branch_id: "origin", episode_id: "ep-001" } },
          { position: 1, available: true, episode: { branch_id: "branch-a", episode_id: "ep-002" } },
        ],
      },
      {
        id: "tree-2",
        title: "木2",
        maintainer: "管理人2",
        version: 1,
        path: [
          { position: 0, available: true, episode: { branch_id: "origin", episode_id: "ep-001" } },
          { position: 1, available: true, episode: { branch_id: "branch-b", episode_id: "ep-002" } },
        ],
      },
    ],
  };

  // tree-1のep1を読んでいる場合：
  // 次の話（ep2a / branch-a）は通常進行なので、木2（ep2b）と枝Bが候補として現れる
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
      href: "https://github.com/b/relay/blob/2222222222222222222222222222222222222222/manuscript/02.md",
      isExternal: true,
    },
  ]);

  // 空データや不正データでもクラッシュしないこと
  expect(findBranchCandidates("tree-1", null, steps, 0, branchesData)).toEqual([]);
  expect(findBranchCandidates("tree-1", ep1, steps, 0, null)).toEqual([]);
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
