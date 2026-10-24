import { createClient } from "@supabase/supabase-js";
import { REALTIME_STUB } from "../supabase-options";

// Supabase Auth with plain supabase-js (no extra package): the login action
// stores the session in httpOnly cookies, proxy.ts refreshes it, and every
// dashboard read uses a client carrying the owner's own JWT, so Row Level
// Security applies. Safe to import from proxy.ts (no next/headers here).

export const ACCESS_COOKIE = "wa_at";
export const REFRESH_COOKIE = "wa_rt";
export const REFRESH_MAX_AGE = 60 * 60 * 24 * 30;

/** Supabase client using the public key, optionally acting as the signed-in user. */
export function anonClient(accessToken?: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: REALTIME_STUB,
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
  });
}

export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true, // JS in the page can never read the tokens
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

/** Reads `exp` (seconds) from a JWT WITHOUT verifying it. Only used to decide when to refresh. */
export function jwtExp(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}
