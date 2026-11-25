"use server";

import { redirect } from "next/navigation";
import { anonClient } from "../../lib/auth/anon";
import { isValidTokenHash } from "../../lib/auth-links";
import { supabaseAdmin } from "../../lib/supabase-admin";

// Sets the new password. The one-time token is only used here, when the form is submitted, so mail
// scanners that merely open the link cannot use it up. Afterwards every existing session of that
// account is signed out, and the person signs in again with the new password.
export async function resetPassword(formData: FormData) {
  const tokenHash = formData.get("token_hash");
  const password = formData.get("password");
  const confirm = formData.get("confirm");
  if (!isValidTokenHash(tokenHash)) redirect("/reset-password?error=invalid");
  const back = (e: string) => redirect(`/reset-password?token_hash=${encodeURIComponent(tokenHash)}&error=${e}`);
  if (typeof password !== "string" || password.length < 10 || password.length > 72) back("password");
  if (password !== confirm) back("mismatch");

  let failure: "expired" | "server" | null = null;
  try {
    const { data, error } = await anonClient().auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
    if (error || !data.user || !data.session) {
      console.error("password reset verify failed", error?.status, error?.code); // never the token
      failure = error && ((error.status ?? 0) >= 500 || !error.status) ? "server" : "expired";
    } else {
      const admin = supabaseAdmin();
      // Sign out everywhere first (best effort, needs the session just created): anyone holding the old password loses their session.
      const { error: soErr } = await admin.auth.admin.signOut(data.session.access_token, "global");
      if (soErr) console.error("sign-out after reset failed", soErr.status, soErr.code);
      const { error: upErr } = await admin.auth.admin.updateUserById(data.user.id, { password: password as string });
      // Setting the same password again is harmless: treat it as success.
      if (upErr && upErr.code !== "same_password") {
        console.error("password update failed", upErr.status, upErr.code);
        failure = "server";
      }
    }
  } catch (e) {
    if ((e as { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) throw e; // back() above, only reached before this try
    console.error("password reset request failed");
    failure = "server";
  }
  // redirect() works by throwing, so it stays outside the try block.
  if (failure) redirect(`/reset-password?error=${failure}`);
  redirect("/login?reset=1");
}
