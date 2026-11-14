import { z } from "zod";

// Sign-up rules, kept pure so they are unit-tested.
//
//   SIGNUP_MODE=open (default)  anyone can sign up; after confirming their email they connect their own
//                               WhatsApp through Embedded Signup. No manual approval.
//   SIGNUP_MODE=approval        anyone can create an account, but sees only a "waiting for approval"
//                               page until the admin approves it (an optional gate; the admin page stays)
//   SIGNUP_MODE=off             no public sign-up; owners are created by the admin
//
// "Approved" is a flag in the login's app_metadata. Only the service role can write it
// (users cannot edit app_metadata), and no database change is needed. Anyone already
// linked to a business counts as approved.
export type SignupMode = "approval" | "open" | "off";

export function signupMode(raw: string | undefined = process.env.SIGNUP_MODE): SignupMode {
  const v = (raw ?? "open").trim().toLowerCase();
  // Unset or unrecognised: the default (open). "approval" and "off" are only used when written exactly.
  return v === "approval" || v === "off" ? v : "open";
}

export type UserLike = { app_metadata?: Record<string, unknown> | null };

export const hasApprovedFlag = (u: UserLike) => u.app_metadata?.approved === true;

export function isApproved(u: UserLike, o: { mode: SignupMode; hasMembership: boolean }): boolean {
  return o.hasMembership || hasApprovedFlag(u) || o.mode === "open";
}

export const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  // 72 bytes is the most bcrypt (used by Supabase) will read.
  password: z.string().min(10, "password_short").max(72, "password_long"),
  business: z.string().trim().min(1).max(100),
  // Honeypot: hidden from people, filled in by bots. Must stay empty.
  website: z.string().max(0).optional(),
});

export type SignupInput = z.infer<typeof signupSchema>;

/**
 * Did this sign-up hit an address that already has an account?
 * With "Confirm email" ON, Supabase answers an existing address with success but an EMPTY
 * identities list (and sends nothing). With it OFF, it returns a user_already_exists error.
 * Showing this is a product choice: it tells visitors whether an email is registered.
 */
export function isExistingAccount(
  data: { user?: { identities?: unknown[] | null } | null } | null | undefined,
  error: { code?: string } | null | undefined,
): boolean {
  if (error) return error.code === "user_already_exists" || error.code === "email_exists";
  return Array.isArray(data?.user?.identities) && data.user.identities.length === 0;
}
