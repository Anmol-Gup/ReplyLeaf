"use server";

import { redirect } from "next/navigation";
import { anonClient } from "../../../lib/auth/anon";
import { isEmailOtpType, isValidTokenHash } from "../../../lib/auth-links";

// Verifies the email on the SERVER from the link in our email. It runs only when the person
// presses the button, so link scanners that pre-open emails cannot use up the one-time link.
// We do not log them in: they verified their address, now they sign in with their password.
export async function confirmEmail(formData: FormData) {
  const tokenHash = formData.get("token_hash");
  const type = formData.get("type");
  if (!isValidTokenHash(tokenHash) || !isEmailOtpType(type)) redirect("/verified?error=invalid");

  const { error } = await anonClient().auth.verifyOtp({ type, token_hash: tokenHash });
  if (error) {
    console.error("email verification failed", error.status, error.code); // never the token
    redirect(`/verified?error=${error.code === "otp_expired" ? "expired" : "invalid"}`);
  }
  redirect("/verified");
}
