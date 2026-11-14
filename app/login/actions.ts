"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { anonClient } from "../../lib/auth/anon";
import { setSessionCookies } from "../../lib/auth/session";
import { safeNext } from "../../lib/auth-links";

const credentials = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

export type LoginState = { error: string | null; email: string };

// Returns the failure as state (instead of redirecting back) so the form keeps the email the person typed.
export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const next = safeNext(formData.get("next")); // validated: only our own pages
  const typed = typeof formData.get("email") === "string" ? String(formData.get("email")).slice(0, 200) : "";
  const parsed = credentials.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: "invalid", email: typed };

  const { data, error } = await anonClient().auth.signInWithPassword(parsed.data);
  // Supabase only reports "email not confirmed" after the password was right, so saying so
  // reveals nothing to a stranger. Every other failure gets one generic message.
  if (error?.code === "email_not_confirmed") return { error: "unverified", email: typed };
  if (error || !data.session) return { error: "invalid", email: typed };

  await setSessionCookies(data.session);
  redirect(next ?? (data.user?.app_metadata?.is_admin === true ? "/admin/signups" : "/dashboard"));
}
