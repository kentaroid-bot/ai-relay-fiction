import { timingSafeEqual } from "node:crypto";
import {
  MODEL,
  POLICY,
  SYSTEM,
  responseSchema,
  validateInput,
  validateReading,
} from "./contract";

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export async function boundedText(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string> {
  if (!stream) throw Error("INVALID_READING_DATA");
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error("READING_TOO_LARGE");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel();
  }
}
export default {
  async fetch(request: Request, env: ReaderEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/read" || url.search || request.method !== "POST")
      return json({ error: "NOT_FOUND" }, 404);
    const supplied = request.headers.get("Authorization") || "";
    const expected = "Bearer " + env.READER_TOKEN;
    if (
      !env.READER_TOKEN ||
      !/^Bearer [A-Za-z0-9_-]{43}$/.test(supplied) ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    )
      return json({ error: "UNAUTHORIZED" }, 401);
    if (!(await env.READING_LIMIT.limit({ key: "relay-reader" })).success)
      return json({ error: "READING_RATE_LIMIT" }, 429);
    try {
      const input = validateInput(
        JSON.parse(await boundedText(request.body, 30000)),
      );
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(input.manuscript),
      );
      const contentHash = Array.from(new Uint8Array(digest), (x) =>
        x.toString(16).padStart(2, "0"),
      ).join("");
      if (contentHash !== input.episode.contentHash)
        return json({ error: "CONTENT_HASH_MISMATCH" }, 400);
      // Only these two messages reach inference. No tools, bindings, keys, history, URLs to fetch, or privileged context.
      const response = await env.AI.run(MODEL, {
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: JSON.stringify(input) },
        ],
        response_format: { type: "json_schema", json_schema: responseSchema },
        temperature: 0,
        max_tokens: 2000,
        stream: false,
      });
      if (
        !response ||
        typeof response !== "object" ||
        response instanceof ReadableStream ||
        !("response" in response) ||
        ("tool_calls" in response && response.tool_calls?.length)
      )
        throw Error("INVALID_READING_DATA");
      const raw: unknown = response.response;
      if (typeof raw === "string" && raw.length > 12000)
        throw Error("INVALID_READING_DATA");
      let decoded: unknown = raw;
      if (typeof raw === "string") {
        try {
          decoded = JSON.parse(raw);
        } catch {
          throw Error("INVALID_READING_DATA");
        }
      }
      const reading = validateReading(decoded);
      return json({
        policy: POLICY,
        model: MODEL,
        episode: input.episode,
        reading,
      });
    } catch (e) {
      // Never expose model text, exception messages, keys, or manuscripts.
      if (
        e instanceof Error &&
        [
          "INVALID_READING_DATA",
          "READING_TOO_LARGE",
          "WORK_CONSENT_REQUIRED",
        ].includes(e.message)
      )
        return json({ error: e.message }, 422);
      return json({ error: "READING_UNAVAILABLE" }, 503);
    }
  },
} satisfies ExportedHandler<ReaderEnv>;
