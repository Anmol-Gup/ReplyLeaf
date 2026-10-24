// Helpers for the email-verification links. Pure, so they are unit-tested.

export type VerifyResult = "verified" | "expired" | "invalid";

/**
 * Supabase's DEFAULT confirmation link verifies the address and then redirects to
 * `<site>/#access_token=...&type=signup` on success, or `<site>/#error=...&error_code=otp_expired`
 * on failure. We never use that token (the address is already verified by then); we only
 * read the outcome so we can show a proper page. Returns null for any other fragment.
 */
export function parseAuthHash(hash: string): VerifyResult | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  if (params.get("error") || params.get("error_code")) {
    return params.get("error_code") === "otp_expired" ? "expired" : "invalid";
  }
  const type = params.get("type");
  if (params.get("access_token") && (type === "signup" || type === "email")) return "verified";
  return null;
}

// The link in OUR email template is  /auth/confirm?token_hash=...&type=email
export const EMAIL_OTP_TYPES = ["email", "signup"] as const;
export type EmailOtpType = (typeof EMAIL_OTP_TYPES)[number];

export const isEmailOtpType = (v: unknown): v is EmailOtpType => EMAIL_OTP_TYPES.includes(v as EmailOtpType);

/** Token hashes are URL-safe strings; anything else is rejected before it reaches Supabase. */
export const isValidTokenHash = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{10,200}$/.test(v);

/**
 * The same check as parseAuthHash, as a tiny inline script that runs in <head>, BEFORE the
 * page is drawn or React loads. It sends old-style confirmation links straight to the result
 * page with location.replace (no flash of the home page, no history entry, and the token in
 * the fragment is dropped). Plain JavaScript on purpose; a test keeps it in step with parseAuthHash.
 */
export const AUTH_HASH_SCRIPT = `(function(){var h=location.hash;if(h.length<2)return;var p=new URLSearchParams(h.slice(1));var t=p.get("type");var to=null;if(p.get("error")||p.get("error_code")){to="/verified?error="+(p.get("error_code")==="otp_expired"?"expired":"invalid")}else if(p.get("access_token")&&(t==="signup"||t==="email")){to="/verified"}if(to)location.replace(to)})();`;
