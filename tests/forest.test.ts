import { expect, it, vi } from "vitest";
// @ts-expect-error Browser module is JavaScript.
import * as reader from "../site/main-reader.js";
const { rawSource, boundedText, validatePath, renderStory } = reader;
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
  renderStory(
    document,
    target,
    "```\n[思考ログ]\n入力: ◎\n```\n\n普通の段落",
  );
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
