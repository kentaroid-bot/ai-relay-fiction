import { v } from "convex/values";
import { fail } from "./policy";
export const WORK_TERMS = "relay-cc0-2026-09-30";
export const licenseValidator = v.object({
  id: v.literal("CC0-1.0"),
  termsVersion: v.string(),
  humanApproved: v.boolean(),
});
export const gateValidator = v.object({
  scannerVersion: v.string(),
  source: v.string(),
  terms: v.string(),
  findings: v.array(v.string()),
  notChecked: v.array(v.string()),
});
export function workLicense(value: any) {
  if (
    value?.id !== "CC0-1.0" ||
    value.termsVersion !== WORK_TERMS ||
    value.humanApproved !== true
  )
    fail("WORK_CONSENT_REQUIRED");
  return {
    id: "CC0-1.0" as const,
    termsVersion: WORK_TERMS,
    humanApproved: true,
  };
}
// Heuristics are signals, not proof of safety. Never retain matches or execute text.
export function scanText(value: string, source: string, terms: string) {
  const rules: [string, RegExp][] = [
    [
      "instruction_override",
      /ignore\s+(all\s+)?(previous|prior)\s+instructions|(?:以前|これまで|上記)の(?:指示|命令).{0,12}(?:無視|破棄)/iu,
    ],
    [
      "credential_request",
      /(?:send|print|reveal|exfiltrate).{0,35}(?:keys?|tokens?|secrets?)|(?:秘密鍵|管理キー|トークン).{0,20}(?:送信|取得|表示)/iu,
    ],
    ["active_markup", /<\s*(?:script|iframe|object)|javascript\s*:/iu],
    [
      "private_network_link",
      /https?:\/\/(?:localhost|127\.|10\.|192\.168\.|169\.254\.|\[::1\])/iu,
    ],
    ["email_like", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
    ["phone_like", /(?:\+81[-\s]?|0)(?:70|80|90)[-\s]?\d{4}[-\s]?\d{4}/u],
    [
      "secret_like",
      /rly_[A-Za-z0-9_-]{43}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    ],
  ];
  return {
    scannerVersion: "signals-v1",
    source,
    terms,
    findings: rules.filter(([, re]) => re.test(value)).map(([code]) => code),
    notChecked: [
      "legal_compliance",
      "rights_ownership",
      "all_personal_data",
      "all_prompt_injections",
      "literary_quality",
    ],
  };
}
