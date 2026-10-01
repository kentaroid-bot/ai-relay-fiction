import { expect, it } from "vitest";
// @ts-expect-error Browser module is native JavaScript.
import * as forest from "../site/forest.js";
const {
  readingLink,
  treeArtwork,
  clampPosition,
  validateEpisodePage,
  treeLabelTitle,
  treeMaintainer,
} = forest;

it("normalizes tree maintainer names to GitHub account handles", () => {
  expect(treeMaintainer("Monku_AI")).toBe("kentaroid-bot");
  expect(treeMaintainer("ケンタロウ")).toBe("kentaroid-bot");
  expect(treeMaintainer("けんたろー")).toBe("super-morphist-sukezo");
  expect(treeMaintainer("Agy")).toBe("agy-monku-ai");
  expect(treeMaintainer("agy-monku-ai")).toBe("agy-monku-ai");
  expect(treeMaintainer("super-morphist-sukezo")).toBe("super-morphist-sukezo");
  expect(treeMaintainer("octocat")).toBe("octocat");
  expect(treeMaintainer("")).toBe("");
});

it("formats tree badge titles cleanly up to 12 chars and removes subtitles", () => {
  expect(treeLabelTitle("男女10人AI物語 〜三割の午後〜")).toBe(
    "男女10人AI物語",
  );
  expect(treeLabelTitle("短いタイトル")).toBe("短いタイトル");
  expect(treeLabelTitle("これはとても長くて十三文字以上あるタイトルです")).toBe(
    "これはとても長くて十三…",
  );
  expect(treeLabelTitle("")).toBe("");
  expect(treeLabelTitle("🌳".repeat(13))).toBe("🌳".repeat(11) + "…");
});

it("keeps reading links on the selected local tree/version and refuses URL-like identifiers", () => {
  expect(readingLink("agy-dreaming-ai", 3, 2)).toBe(
    "/read/main/?id=agy-dreaming-ai&v=3&at=2",
  );
  for (const id of [
    "javascript:alert(1)",
    "../join",
    "a&v=999",
    "<img>",
    "https://example.test",
  ]) {
    expect(() => readingLink(id, 1)).toThrow();
    expect(() => treeArtwork(id)).toThrow();
  }
  for (const [version, position] of [
    [0, 0],
    [1, -1],
    [1, 1000],
    [1, NaN],
    [1.5, 0],
  ])
    expect(() => readingLink("monku-main", version, position)).toThrow();
  expect(treeArtwork("monku-main")).toBe("tree_emerald.png");
  expect(treeArtwork("agy-dreaming-ai")).toMatch(
    /^tree_(emerald|blue|round|olive)\.png$/,
  );
});
it("keeps dragged trees inside narrow fields, including an item larger than the field", () => {
  expect(clampPosition(-100, 358, 180)).toBe(0);
  expect(clampPosition(800, 358, 180)).toBe(178);
  expect(clampPosition(200, 150, 180)).toBe(0);
});
it("rejects a changed version, missing step, or truncated final page before showing its links", () => {
  const main = { version: 2, count: 2 };
  const steps = [0, 1].map((position) => ({
    position,
    available: true,
    episode: { title: "A story", branchId: "example-branch" },
  }));
  const page = { version: 2, count: 2, isDone: true, page: steps };
  expect(() => validateEpisodePage(main, page, 0)).not.toThrow();
  expect(() => validateEpisodePage(main, { ...page, version: 3 }, 0)).toThrow(
    "Path changed",
  );
  expect(() =>
    validateEpisodePage(main, { ...page, page: steps.slice(1) }, 0),
  ).toThrow();
  expect(() =>
    validateEpisodePage(main, { ...page, page: steps.slice(0, 1) }, 0),
  ).toThrow();
  expect(() =>
    validateEpisodePage(main, { ...page, page: [steps[1]] }, 1),
  ).not.toThrow();
  expect(() =>
    validateEpisodePage(
      main,
      { ...page, page: [{ position: 0, available: true }] },
      0,
    ),
  ).toThrow();
});
