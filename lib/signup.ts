import { z } from "zod";

// Sign-up rules, kept pure so they are unit-tested.
//
//   SIGNUP_MODE=approval (default)  anyone can create an account, but sees only a
//                                   "waiting for approval" page until the admin approves it
//   SIGNUP_MODE=open                accounts work immediately (use once real customers can
//                                   connect WhatsApp themselves, i.e. after Tech Provider approval)
//   SIGNUP_MODE=off                 no public sign-up; owners are created by the admin
//
// "Approved" is a flag in the login's app_metadata. Only the service role can write it
// (users cannot edit app_metadata), and no database change is needed. Anyone already
// linked to a business counts as approved.
export type SignupMode = "approval" | "open" | "off";

export function signupMode(raw: string | undefined = process.env.SIGNUP_MODE): SignupMode {
  const v = (raw ?? "approval").trim().toLowerCase();
  // An unrecognised value falls back to approval, never to "open".
  return v === "open" || v === "off" ? v : "approval";
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
