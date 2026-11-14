import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyKey } from "../lib/ai-key-verify";
import { aiUsable, checkKeyFormat, isAuthFailure, keyProblem, lastFour, maskedKey, shouldEmailKeyProblem, KEY_EMAIL_INTERVAL_MS } from "../lib/ai-keys";

const OPENAI = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
const GEMINI = "AIzaSyA1234567890abcdefghijklmnopqrstuvw";

test("key format: right shape for the right provider, trimmed, nothing odd accepted", () => {
  assert.deepEqual(checkKeyFormat("openai", `  ${OPENAI}\n`), { ok: true, key: OPENAI });
  assert.deepEqual(checkKeyFormat("gemini", GEMINI), { ok: true, key: GEMINI });
  assert.deepEqual(checkKeyFormat("openai", GEMINI), { ok: false, reason: "format" }); // a Gemini key given for OpenAI
  assert.deepEqual(checkKeyFormat("gemini", OPENAI), { ok: false, reason: "format" });
  assert.deepEqual(checkKeyFormat("openai", ""), { ok: false, reason: "empty" });
  assert.deepEqual(checkKeyFormat("openai", undefined), { ok: false, reason: "empty" });
  assert.deepEqual(checkKeyFormat("openai", "sk-short"), { ok: false, reason: "format" });
  assert.deepEqual(checkKeyFormat("openai", `${OPENAI} extra words`), { ok: false, reason: "format" });
  assert.deepEqual(checkKeyFormat("openai", `sk-${"a".repeat(400)}`), { ok: false, reason: "format" }); // too long
});

test("only the last four characters are ever shown", () => {
  assert.equal(lastFour(OPENAI), "6789");
  assert.equal(maskedKey("6789"), "····6789");
  assert.equal(maskedKey(null), "");
  assert.ok(!maskedKey(lastFour(OPENAI)).includes("sk-"));
});

test("usability and problems: platform always works; BYOK needs a key that is not known-bad", () => {
  assert.equal(aiUsable("platform", false, "none"), true);
  assert.equal(aiUsable("byok", true, "valid"), true);
  assert.equal(aiUsable("byok", true, "unverified"), true);   // saved but not checked yet: try it
  assert.equal(aiUsable("byok", true, "invalid"), false);
  assert.equal(aiUsable("byok", false, "none"), false);
  assert.equal(keyProblem("byok", false, "none"), "missing");
  assert.equal(keyProblem("byok", true, "invalid"), "invalid");
  assert.equal(keyProblem("byok", true, "valid"), null);
  assert.equal(keyProblem("platform", false, "none"), null);
});

test("auth failures are recognised; quota, outages and bad requests are not", () => {
  assert.equal(isAuthFailure(Object.assign(new Error("x"), { status: 401 })), true);
  assert.equal(isAuthFailure(Object.assign(new Error("x"), { status: 403 })), true);
  assert.equal(isAuthFailure(new Error("API key not valid. Please pass a valid API key.")), true);        // Gemini
  assert.equal(isAuthFailure(new Error('{"error":{"code":"invalid_api_key","message":"Incorrect API key provided"}}')), true); // OpenAI
  assert.equal(isAuthFailure(Object.assign(new Error("quota exceeded"), { status: 429 })), false);
  assert.equal(isAuthFailure(new Error("RESOURCE_EXHAUSTED: quota exceeded for this API key")), false);
  assert.equal(isAuthFailure(Object.assign(new Error("overloaded"), { status: 503 })), false);
  assert.equal(isAuthFailure(new Error("Model output failed validation")), false);
  assert.equal(isAuthFailure(null), false);
});

test("owner emails about a key problem at most once a day", () => {
  const now = new Date("2026-01-02T12:00:00Z");
  assert.equal(shouldEmailKeyProblem(null, now), true);
  assert.equal(shouldEmailKeyProblem(new Date(now.getTime() - 3600_000), now), false);
  assert.equal(shouldEmailKeyProblem(new Date(now.getTime() - KEY_EMAIL_INTERVAL_MS), now), true);
});

test("verifying a key: valid, refused (including Gemini's 400), or unknown; the key travels in a header, never the URL", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fake = (status: number, body = "") => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(body, { status });
  }) as typeof fetch;
  assert.equal(await verifyKey("openai", OPENAI, fake(200)), "valid");
  assert.equal(await verifyKey("openai", OPENAI, fake(401)), "invalid");
  assert.equal(await verifyKey("gemini", GEMINI, fake(200)), "valid");
  assert.equal(await verifyKey("gemini", GEMINI, fake(400, '{"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}')), "invalid");
  assert.equal(await verifyKey("gemini", GEMINI, fake(400, '{"error":{"message":"some other bad request"}}')), "unverified");
  assert.equal(await verifyKey("openai", OPENAI, fake(503)), "unverified");
  assert.equal(await verifyKey("openai", OPENAI, fake(429)), "unverified");
  assert.equal(await verifyKey("openai", OPENAI, (async () => { throw new Error("network"); }) as typeof fetch), "unverified");
  for (const c of calls) {
    assert.ok(!c.url.includes(OPENAI) && !c.url.includes(GEMINI), "the key must never be in the URL");
  }
  assert.equal(calls[0].headers.authorization, `Bearer ${OPENAI}`);
  assert.equal(calls.find((c) => c.url.includes("googleapis"))?.headers["x-goog-api-key"], GEMINI);
});

test("source guard: no console call in the files that handle a business's AI key mentions the key", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const files = ["lib/supabase-batch.ts", "app/dashboard/settings/actions.ts", "lib/ai-key-verify.ts", "lib/ai-keys.ts", "lib/batch.ts"];
  for (const f of files) {
    const src = readFileSync(join(process.cwd(), f), "utf8");
    for (const line of src.split("\n")) {
      if (/console\.(log|warn|error|info|debug)/.test(line)) {
        assert.doesNotMatch(line.replace(/\{ clientId \}/, "").replace(/never the value/, "").replace(/stored AI credential/, ""), /apiKey|ai_key|ai_api_key|\bkey\b|checked\.key|secret/i, `${f}: ${line.trim()}`);
      }
    }
  }
});
