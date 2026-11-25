"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getMailer } from "../../lib/email/mailer";
import { passwordResetEmail } from "../../lib/email/templates";
import { supabaseAdmin } from "../../lib/supabase-admin";

// Emails a password-reset link. The answer is always the same, whether or not the address has an
// account, so this cannot be used to find out who is registered. The link carries a one-time token
// hash; nothing is used up until the person submits the new password on /reset-password.
export async function requestPasswordReset(formData: FormData) {
  // Honeypot: only bots fill the hidden field. Pretend it worked.
  if (String(formData.get("website") ?? "") !== "") redirect("/forgot-password?sent=1");
  const email = z.string().trim().toLowerCase().email().max(200).safeParse(formData.get("email"));
  const appUrl = process.env.APP_URL?.replace(/\/$/, "");
  if (email.success && appUrl) {
    try {
      const { data, error } = await supabaseAdmin().auth.admin.generateLink({ type: "recovery", email: email.data });
      const hash = data?.properties?.hashed_token;
      if (error || !hash) {
        // Most often "no such user". Logged without the address, and the person sees the same page.
        console.error("password reset link not created", error?.status, error?.code);
      } else {
        const mailer = getMailer();
        if (!mailer) console.warn("password reset requested but email is not configured (GMAIL_USER / GMAIL_APP_PASSWORD)");
        else await mailer.send(passwordResetEmail({ to: email.data, link: `${appUrl}/reset-password?token_hash=${encodeURIComponent(hash)}` }));
      }
    } catch {
      console.error("password reset request failed"); // never the address or the token
    }
  } else if (email.success) {
    console.error("password reset skipped: APP_URL is not set");
  }
  redirect("/forgot-password?sent=1");
}
