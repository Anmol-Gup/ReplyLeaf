"use server";

import { redirect } from "next/navigation";
import { anonClient } from "../../lib/auth/anon";
import { getMailer } from "../../lib/email/mailer";
import { signupNotificationEmail } from "../../lib/email/templates";
import { signupMode, signupSchema } from "../../lib/signup";

export async function signUp(formData: FormData) {
  const mode = signupMode();
  if (mode === "off") redirect("/login");

  const raw = Object.fromEntries(formData);
  // Honeypot: only bots fill the hidden field. Pretend it worked and do nothing.
  if (String(raw.website ?? "") !== "") redirect("/signup/check-email");

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
  if (error) {
    console.error("sign-up failed", error.status, error.code); // never the email or password
    redirect(`/signup?error=${error.status === 429 ? "busy" : "failed"}`);
  }

  // Tell the admin about a genuinely NEW account. For an address that already exists Supabase
  // returns an empty identities list, and we say nothing either way, so the form cannot be
  // used to discover which emails are registered.
  if (data.user?.identities?.length) {
    try {
      const to = process.env.ADMIN_ALERT_EMAIL;
      const mailer = getMailer();
      if (to && mailer) await mailer.send(signupNotificationEmail({ to, email, business, mode }));
    } catch (e) {
      console.error("sign-up notification failed", e instanceof Error ? e.message : e);
    }
  }
  redirect("/signup/check-email");
}
