import { afterEach, expect, it, vi } from "vitest";
import { githubMessage, notifyGithub } from "../convex/intakeNotifications";
import type { Doc } from "../convex/_generated/dataModel";
const event = {
  _id: "event-1",
  _creationTime: 1,
  intakeId: "case-1",
  kind: "needs_author",
  text: "確認事項があります",
  version: 3,
  recipient: "repo",
  delivery: "pending",
  attempts: 0,
  generation: 0,
  leaseUntil: 0,
  githubPr: 42,
  questions: ["@someone の作品を参照しましたか？ <script>never run</script>"],
} as unknown as Doc<"intakeEvents">;
afterEach(() => vi.unstubAllGlobals());
it("renders a single question batch with a versioned reply template and inert text", () => {
  const message = githubMessage(event);
  expect(message).toContain("/relay-answer case-1 3");
  expect(message).not.toContain("@someone");
  expect(message).not.toContain("<script>");
  expect(
    githubMessage({
      ...event,
      kind: "author_reply",
      text: "private answer",
      questions: undefined,
    }),
  ).not.toContain("private answer");
});
it("reconciles an uncertain GitHub POST and ignores another user's forged marker", async () => {
  const comments: any[] = [
    { body: "<!-- relay-intake:event-1 -->", user: { login: "impostor" } },
  ];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toMatch(
      /^https:\/\/api.github.com\/repos\/kentaroid-bot\/ai-relay-fiction\/issues\/42\/comments/,
    );
    expect(init.redirect).toBe("manual");
    if (init.method === "POST") {
      comments.push({
        body: JSON.parse(init.body as string).body,
        user: { login: "relay-bot" },
      });
      throw Error("Connection lost after GitHub accepted the comment");
    }
    return Response.json(comments);
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(notifyGithub(event, "token", "relay-bot")).rejects.toThrow();
  await notifyGithub(event, "token", "relay-bot");
  expect(
    fetcher.mock.calls.filter(([, init]) => init.method === "POST"),
  ).toHaveLength(1);
});
it("does not post when a redirect prevents reconciliation", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://other.example" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(notifyGithub(event, "token", "relay-bot")).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
