"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { anonClient } from "../../../lib/auth/anon";
import { setSessionCookies } from "../../../lib/auth/session";
import { safeNext } from "../../../lib/auth-links";

const credentials = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

// Administrators only. A correct password for a NON-admin account does not log them in: no
// session cookie is set, so this page can never be used to get a session as a normal user.
export async function adminLogin(formData: FormData) {
  const wanted = safeNext(formData.get("next"));
  const next = wanted?.startsWith("/admin") ? wanted : null; // stay inside the admin area
  const keep = next ? `&next=${encodeURIComponent(next)}` : "";

  const parsed = credentials.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) redirect(`/admin/login?error=invalid${keep}`);

  const { data, error } = await anonClient().auth.signInWithPassword(parsed.data);
  if (error || !data.session) redirect(`/admin/login?error=invalid${keep}`);
  if (data.user?.app_metadata?.is_admin !== true) redirect(`/admin/login?error=notadmin${keep}`);

  await setSessionCookies(data.session);
  redirect(next ?? "/admin/signups");
}
