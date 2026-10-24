import { test } from "node:test";
import assert from "node:assert/strict";
import { isEmailOtpType, isValidTokenHash, parseAuthHash } from "../lib/auth-links";

test("a successful old-style confirmation link is recognised (the token is never used)", () => {
  assert.equal(parseAuthHash("#access_token=abc.def.ghi&expires_in=3600&refresh_token=x&token_type=bearer&type=signup"), "verified");
  assert.equal(parseAuthHash("access_token=abc&type=email"), "verified");
});

test("expired and invalid links are told apart", () => {
  assert.equal(parseAuthHash("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired"), "expired");
  assert.equal(parseAuthHash("#error=access_denied&error_code=something_else"), "invalid");
  assert.equal(parseAuthHash("#error=server_error"), "invalid");
});

test("other fragments are ignored, including logins that are not a signup confirmation", () => {
  assert.equal(parseAuthHash(""), null);
  assert.equal(parseAuthHash("#section-2"), null);
  assert.equal(parseAuthHash("#access_token=abc&type=recovery"), null); // not a sign-up confirmation
  assert.equal(parseAuthHash("#access_token=abc"), null);
  assert.equal(parseAuthHash("#type=signup"), null);
});

test("token hashes: only URL-safe strings of a sensible length reach Supabase", () => {
  assert.equal(isValidTokenHash("a1b2c3d4e5f6g7h8i9j0"), true);
  assert.equal(isValidTokenHash("abc-DEF_123456"), true);
  for (const bad of ["", "short", "has space in it 12345", "semi;colon-injection1", "x".repeat(201), "../../etc/passwd1", null, undefined, 123]) {
    assert.equal(isValidTokenHash(bad), false, String(bad));
  }
});

test("only the email-confirmation OTP types are accepted", () => {
  assert.equal(isEmailOtpType("email"), true);
  assert.equal(isEmailOtpType("signup"), true);
  for (const bad of ["recovery", "magiclink", "invite", "email_change", "", null, undefined]) assert.equal(isEmailOtpType(bad), false, String(bad));
});

// The inline <head> script must make exactly the same decision as parseAuthHash.
import { AUTH_HASH_SCRIPT } from "../lib/auth-links";

function runInlineScript(hash: string): string | null {
  let target: string | null = null;
  new Function("location", "URLSearchParams", AUTH_HASH_SCRIPT)({ hash, replace: (u: string) => { target = u; } }, URLSearchParams);
  return target;
}

test("inline head script agrees with parseAuthHash for every kind of fragment", () => {
  const cases = [
    "#access_token=abc.def&type=signup&expires_in=3600",
    "#access_token=abc&type=email",
    "#error=access_denied&error_code=otp_expired&error_description=x",
    "#error=access_denied&error_code=something_else",
    "#error=server_error",
    "#access_token=abc&type=recovery",
    "#access_token=abc",
    "#section-2",
    "",
    "#",
  ];
  const expected = (r: ReturnType<typeof parseAuthHash>) => (r === "verified" ? "/verified" : r ? `/verified?error=${r}` : null);
  for (const hash of cases) assert.equal(runInlineScript(hash), expected(parseAuthHash(hash)), hash || "(empty)");
});

test("inline head script never navigates for an ordinary page load", () => {
  assert.equal(runInlineScript(""), null);
  assert.equal(runInlineScript("#top"), null);
});
