"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { anonClient } from "../../lib/auth/anon";
import { setSessionCookies } from "../../lib/auth/session";

const credentials = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

export async function login(formData: FormData) {
  const parsed = credentials.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) redirect("/login?error=invalid");

  const { data, error } = await anonClient().auth.signInWithPassword(parsed.data);
  // One generic message: never reveal whether the account exists.
  if (error || !data.session) redirect("/login?error=invalid");

  await setSessionCookies(data.session);
  redirect(data.user?.app_metadata?.is_admin === true ? "/admin/signups" : "/dashboard");
}
