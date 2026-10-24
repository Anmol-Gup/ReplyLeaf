import { getMailer } from "./email/mailer";
import { pendingUserEmail, signupNotificationEmail } from "./email/templates";
import { supabaseAdmin } from "./supabase-admin";

type PendingUser = {
  id: string;
  email?: string | null;
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
};

/**
 * Runs when a VERIFIED but unapproved user reaches the waiting page, and sends two emails once:
 *   - to the user: "you're on the list" (a separate email from the verification one)
 *   - to the admin: "new sign-up waiting for approval", with a link to the approval page
 * Doing this after verification means only real, confirmed addresses ever trigger email.
 * `pending_notified` in app_metadata (writable only with the service role) makes it once-only.
 */
export async function notifyPendingSignup(user: PendingUser): Promise<void> {
  if (!user.email || user.app_metadata?.pending_notified === true) return;

  // Claim first, so a page refresh or two tabs cannot send the emails twice.
  const { error } = await supabaseAdmin().auth.admin.updateUserById(user.id, {
    app_metadata: { ...user.app_metadata, pending_notified: true },
  });
  if (error) {
    console.error("could not record pending notification", error.message);
    return;
  }

  const mailer = getMailer();
  if (!mailer) {
    console.warn("pending-signup emails not sent (Gmail is not configured)");
    return;
  }
  const business = String(user.user_metadata?.business_name ?? "").slice(0, 100);
  try {
    await mailer.send(pendingUserEmail({ to: user.email, business }));
  } catch (e) {
    console.error("pending email to user failed", e instanceof Error ? e.message : e);
  }
  try {
    const admin = process.env.ADMIN_ALERT_EMAIL;
    if (admin) await mailer.send(signupNotificationEmail({ to: admin, email: user.email, business: business || "(no name given)", appUrl: process.env.APP_URL }));
  } catch (e) {
    console.error("admin sign-up email failed", e instanceof Error ? e.message : e);
  }
}
