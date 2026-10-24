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
