import type { Doc } from "./_generated/dataModel";
import { GITHUB_BASE, readBounded } from "./policy";

const safeText = (value: string) =>
  value.replace(/@/g, "@\u200b").replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, "\\$&");
export function githubMessage(e: Doc<"intakeEvents">) {
  const summary = e.kind === "author_reply" ? "回答を受け付けました。" : e.text;
  let result = `<!-- relay-intake:${e._id} -->\n${safeText(summary)}\n\n案件: ${e.intakeId} / 版: ${e.version}`;
  if (e.questions?.length)
    result +=
      "\n\n" +
      e.questions.map((q, i) => `${i + 1}. ${safeText(q)}`).join("\n") +
      `\n\nこのPRに次の形式でまとめて回答してください。申告・本文を変更する場合は新しいコミットを提出してください。\n\n\`\`\`text\n/relay-answer ${e.intakeId} ${e.version}\n回答内容\n\`\`\``;
  return result;
}
export async function notifyGithub(
  e: Doc<"intakeEvents">,
  token: string,
  login: string,
) {
  if (!Number.isSafeInteger(e.githubPr) || e.githubPr! < 1)
    throw Error("INVALID_PR");
  const base = `https://api.github.com/repos/${GITHUB_BASE}/issues/${e.githubPr}/comments`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: "Bearer " + token,
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "relay-intake",
    "Content-Type": "application/json",
  };
  // GitHub has no idempotency header. Reconcile an uncertain previous POST before retrying.
  // Bounded pages: inability to finish reconciliation is a delivery failure, never permission to duplicate.
  let checkedAll = false;
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(base + `?per_page=100&page=${page}`, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    const comments = JSON.parse(await readBounded(response, 1_000_000));
    if (!Array.isArray(comments)) throw Error("INVALID_COMMENTS");
    if (
      comments.some(
        (c) =>
          c.user?.login?.toLowerCase() === login.toLowerCase() &&
          typeof c.body === "string" &&
          c.body.includes(`<!-- relay-intake:${e._id} -->`),
      )
    )
      return;
    if (comments.length < 100) {
      checkedAll = true;
      break;
    }
  }
  if (!checkedAll) throw Error("RECONCILIATION_LIMIT");
  const response = await fetch(base, {
    method: "POST",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ body: githubMessage(e) }),
  });
  await response.body?.cancel();
  if (!response.ok) throw Error("DELIVERY_FAILED");
}
