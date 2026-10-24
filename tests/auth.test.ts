import { test } from "node:test";
import assert from "node:assert/strict";
import { cookieOptions, jwtExp } from "../lib/auth/anon";
import { NOTICES } from "../lib/dashboard";
import { normalizePhone } from "../lib/privacy";

const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

test("jwtExp reads exp and returns 0 for garbage (so we refresh)", () => {
  assert.equal(jwtExp(jwt({ exp: 1234 })), 1234);
  assert.equal(jwtExp("not-a-jwt"), 0);
  assert.equal(jwtExp(jwt({ nope: 1 })), 0);
});

test("session cookies are httpOnly and lax", () => {
  const o = cookieOptions(60);
  assert.equal(o.httpOnly, true);
  assert.equal(o.sameSite, "lax");
  assert.equal(o.maxAge, 60);
});

test("phone numbers are normalised to digits for deletion lookups", () => {
  assert.equal(normalizePhone("+91 98765-43210"), "919876543210");
});

test("every notice code used by the actions has a message", () => {
  for (const code of ["saved", "window_closed", "take_over_first", "send_failed", "invalid", "deleted", "not_found"]) {
    assert.ok(NOTICES[code], code);
  }
});
