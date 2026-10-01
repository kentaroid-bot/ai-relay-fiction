import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyRelease } from "../scripts/site-release.mjs";

const revision = "a".repeat(40);
const content = Buffer.from("published asset");
const digest = createHash("sha256").update(content).digest("hex");
const routes = [
  "/",
  "/forest.css",
  "/forest.js",
  "/branches/",
  "/branches.js",
  "/read/main/",
  "/main-reader.js",
];
const receipt = {
  schema: 1,
  revision,
  files: Object.fromEntries(routes.map((r) => [r, digest])),
};
function mock(published = receipt, changedRoute = null) {
  return async (url, options) => {
    expect(options.credentials).toBe("omit");
    expect(options.redirect).toBe("error");
    const path = new URL(url).pathname;
    return new Response(
      path === "/release.json"
        ? JSON.stringify(published)
        : path === changedRoute
          ? "stale bytes"
          : content,
    );
  };
}

describe("public release verification", () => {
  it("accepts the expected commit with matching served assets", async () => {
    await expect(verifyRelease(receipt, mock())).resolves.toBeUndefined();
  });
  it("rejects a healthy but older deployment", async () => {
    await expect(
      verifyRelease(receipt, mock({ ...receipt, revision: "b".repeat(40) })),
    ).rejects.toThrow("RELEASE_REVISION_MISMATCH");
  });
  it("rejects stale assets even when the release stamp is current", async () => {
    await expect(
      verifyRelease(receipt, mock(receipt, "/forest.js")),
    ).rejects.toThrow("RELEASE_ASSET_MISMATCH");
  });
  it("rejects a receipt that names different built assets", async () => {
    await expect(
      verifyRelease(receipt, mock({ ...receipt, files: {} })),
    ).rejects.toThrow("RELEASE_RECEIPT_MISMATCH");
  });
});
