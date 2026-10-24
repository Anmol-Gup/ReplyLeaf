import { test } from "node:test";
import assert from "node:assert/strict";
import { anonClient } from "../lib/auth/anon";

// Regression: on Node 20, createClient() used to throw "Node.js 20 detected without
// native WebSocket support" before any query could run.
test("supabase clients can be created without a native WebSocket", () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  assert.doesNotThrow(() => anonClient());
  assert.doesNotThrow(() => anonClient("some-jwt"));
});
