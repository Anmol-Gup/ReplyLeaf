"use server";

import { redirect } from "next/navigation";
import { anonClient } from "../../lib/auth/anon";
import { isExistingAccount, signupMode, signupSchema } from "../../lib/signup";

export async function signUp(formData: FormData) {
  const mode = signupMode();
  if (mode === "off") redirect("/login");

  const raw = Object.fromEntries(formData);
  // Honeypot: only bots fill the hidden field. Pretend it worked and do nothing.
  if (String(raw.website ?? "") !== "") redirect("/signup?sent=1");

  const parsed = signupSchema.safeParse({ email: raw.email, password: raw.password, business: raw.business });
  if (!parsed.success) {
    const weak = parsed.error.issues.some((i) => i.message === "password_short" || i.message === "password_long");
    redirect(`/signup?error=${weak ? "password" : "invalid"}`);
  }
  const { email, password, business } = parsed.data;

  const appUrl = process.env.APP_URL?.replace(/\/$/, "");
  const { data, error } = await anonClient().auth.signUp({
    email, password,
    options: { data: { business_name: business }, emailRedirectTo: appUrl ? `${appUrl}/login` : undefined },
  });
  if (isExistingAccount(data, error)) redirect("/signup?error=exists");
  if (error) {
    console.error("sign-up failed", error.status, error.code); // never the email or password
    redirect(`/signup?error=${error.status === 429 ? "busy" : "failed"}`);
  }

  // Supabase has now emailed the verification link (styled by the template you push with
  // `npm run push-email-template`). The admin is told later, once the address is VERIFIED,
  // so unverified or mistyped addresses never reach your inbox, and nobody can make us email
  // an arbitrary third party.
  redirect("/signup?sent=1");
}
