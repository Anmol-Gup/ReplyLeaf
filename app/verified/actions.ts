"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { anonClient } from "../../lib/auth/anon";

// Sends a fresh verification email. The answer is always the same, whether or not the
// address has an account, so this cannot be used to find out who is registered.
// Supabase rate-limits resends.
export async function resendVerification(formData: FormData) {
  const email = z.string().trim().toLowerCase().email().max(200).safeParse(formData.get("email"));
  if (email.success) {
    const appUrl = process.env.APP_URL?.replace(/\/$/, "");
    const { error } = await anonClient().auth.resend({
      type: "signup", email: email.data,
      options: { emailRedirectTo: appUrl ? `${appUrl}/login` : undefined },
    });
    if (error) console.error("resend failed", error.status, error.code);
  }
  redirect("/verified?resent=1");
}
