"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { clearSessionCookies, requireAdmin } from "../../lib/auth/session";
import { getMailer } from "../../lib/email/mailer";
import { approvedEmail } from "../../lib/email/templates";
import { supabaseAdmin } from "../../lib/supabase-admin";

// SECURITY: every action re-checks requireAdmin() (layouts don't protect server actions),
// and only touches one user by id. The admin flag cannot be set from the browser.
const uuid = z.string().uuid();
const back = (notice: string): never => redirect(`/admin/signups?notice=${notice}`);

export async function approveSignup(formData: FormData) {
  await requireAdmin();
  const id = uuid.parse(formData.get("id"));
  const db = supabaseAdmin();

  const { data, error } = await db.auth.admin.getUserById(id);
  if (error || !data.user) return back("not_found");
  const user = data.user;
  if (!user.email_confirmed_at) return back("not_verified"); // they could not sign in anyway

  const { error: upErr } = await db.auth.admin.updateUserById(id, { app_metadata: { ...user.app_metadata, approved: true } });
  if (upErr) return back("failed");

  // Tell them. If email isn't configured the approval still stands; the notice says so.
  try {
    const mailer = getMailer();
    if (!mailer || !user.email) return back("approved_no_email");
    await mailer.send(approvedEmail({ to: user.email, appUrl: process.env.APP_URL }));
  } catch (e) {
    console.error("approval email failed", e instanceof Error ? e.message : e);
    return back("approved_no_email");
  }
  return back("approved");
}

export async function rejectSignup(formData: FormData) {
  await requireAdmin();
  const id = uuid.parse(formData.get("id"));
  if (formData.get("confirm") !== "yes") return back("invalid");
  const db = supabaseAdmin();

  const { data } = await db.auth.admin.getUserById(id);
  if (!data.user) return back("not_found");
  if (data.user.app_metadata?.is_admin === true) return back("failed"); // never delete an admin here

  // Never delete someone who already has a business: that would destroy a customer's data.
  const { data: link } = await db.from("client_users").select("client_id").eq("user_id", id).limit(1);
  if (link?.length) return back("has_business");

  const { error } = await db.auth.admin.deleteUser(id);
  return back(error ? "failed" : "rejected");
}

export async function logoutAdmin() {
  await clearSessionCookies();
  redirect("/admin/login");
}
