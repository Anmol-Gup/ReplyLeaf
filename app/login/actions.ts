"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { anonClient } from "../../lib/auth/anon";
import { setSessionCookies } from "../../lib/auth/session";
import { safeNext } from "../../lib/auth-links";

const credentials = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

export async function login(formData: FormData) {
  const next = safeNext(formData.get("next")); // validated: only our own pages
  const keep = next ? `&next=${encodeURIComponent(next)}` : "";
  const parsed = credentials.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) redirect(`/login?error=invalid${keep}`);

  const { data, error } = await anonClient().auth.signInWithPassword(parsed.data);
  // Supabase only reports "email not confirmed" after the password was right, so saying so
  // reveals nothing to a stranger. Every other failure gets one generic message.
  if (error?.code === "email_not_confirmed") redirect("/login?error=unverified");
  if (error || !data.session) redirect(`/login?error=invalid${keep}`);

  await setSessionCookies(data.session);
  redirect(next ?? (data.user?.app_metadata?.is_admin === true ? "/admin/signups" : "/dashboard"));
}
