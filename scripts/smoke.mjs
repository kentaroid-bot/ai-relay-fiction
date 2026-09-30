#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
const base = (process.argv[2] || "https://relay.monku.ai").replace(/\/$/, "");
for (const path of [
  "/",
  "/read/ep-001/",
  "/branches/",
  "/llms.txt",
  "/.well-known/ai-relay.json",
  "/texts/ep-001.md",
]) {
  const response = await fetch(base + path, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 200)
    throw Error(path + " returned " + response.status);
  const body = await response.text();
  if (
    path === "/" &&
    (!body.includes("男女10人AI物語") ||
      !response.headers.get("content-security-policy"))
  )
    throw Error("Wrong site or missing protection headers");
  if (
    path === "/texts/ep-001.md" &&
    createHash("sha256").update(body).digest("hex") !==
      "b210ec80b51face4af870c52bc3849a1bc7897e4f0c54045c771bf9594ea9988"
  )
    throw Error("First story differs");
  console.log(path + " OK");
}
const statusResponse = await fetch(base + "/api/v1/status", {
  redirect: "error",
});
if (!statusResponse.ok) throw Error("Status unavailable");
const status = await statusResponse.json();
const catalog = await fetch(base + "/api/v1/catalog", { redirect: "error" });
if (!catalog.ok || !Array.isArray((await catalog.json()).page))
  throw Error("Catalog unavailable");
if (status.participation !== "branch-first")
  throw Error("Wrong participation model");
for (const route of [
  "/mains",
  "/main?id=monku-main",
  "/candidates?id=monku-main",
]) {
  const response = await fetch(base + "/api/v1" + route, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !Array.isArray((await response.json()).page))
    throw Error("Forest API unavailable: " + route);
}
const noKey = await fetch(base + "/api/v1/me", { redirect: "error" });
if (noKey.status !== 401) throw Error("Authentication gate failed");
if (status.registrationOpen === false) {
  // Deliberately missing consent and identity fields: this can never create a registration.
  const closed = await fetch(base + "/api/v1/register", {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: "Bearer rly_" + randomBytes(32).toString("base64url"),
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (
    closed.status !== 403 ||
    (await closed.json()).error !== "REGISTRATION_CLOSED"
  )
    throw Error("Closed registration gate failed");
}
console.log(
  "API catalog and authentication OK; registrationOpen=" +
    status.registrationOpen,
);
