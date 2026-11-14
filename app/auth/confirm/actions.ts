"use server";

import { redirect } from "next/navigation";
import { anonClient } from "../../../lib/auth/anon";
import { isEmailOtpType, isValidTokenHash } from "../../../lib/auth-links";

// Verifies the email on the SERVER from the link in our email. It runs when the confirm page
// submits itself in a real browser (AutoConfirm), so link scanners that only fetch the HTML cannot use up the one-time link.
// We do not log them in: they verified their address, now they sign in with their password.
export async function confirmEmail(formData: FormData) {
  const tokenHash = formData.get("token_hash");
  const type = formData.get("type");
  if (!isValidTokenHash(tokenHash) || !isEmailOtpType(type)) redirect("/verified?error=invalid");

  let failure: "expired" | "invalid" | "server" | null = null;
  try {
    const { error } = await anonClient().auth.verifyOtp({ type, token_hash: tokenHash });
    if (error) {
      console.error("email verification failed", error.status, error.code); // never the token
      // Supabase answers "expired" for a link that is old OR already used; 5xx / no status = our side or the network.
      failure = error.code === "otp_expired" ? "expired" : (error.status ?? 0) >= 500 || !error.status ? "server" : "invalid";
    }
  } catch {
    console.error("email verification request failed"); // network error; never the token
    failure = "server";
  }
  // redirect() works by throwing, so it stays outside the try block.
  redirect(failure ? `/verified?error=${failure}` : "/verified");
}
