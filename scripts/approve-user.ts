// Approves a sign-up so they can use the dashboard (SIGNUP_MODE=approval).
//
//   npm run approve-user -- someone@example.com
//
// Sets app_metadata.approved on their login (users cannot change this themselves) and
// emails them if Gmail is configured. Safe to run twice.
import { getMailer } from "../lib/email/mailer";
import { approvedEmail } from "../lib/email/templates";
import { supabaseAdmin } from "../lib/supabase-admin";

async function findUser(email: string) {
  const db = supabaseAdmin();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listing users failed: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) throw new Error("Usage: npm run approve-user -- someone@example.com");
  const user = await findUser(email);
  if (!user) throw new Error(`No account found for ${email}`);

  const { error } = await supabaseAdmin().auth.admin.updateUserById(user.id, { app_metadata: { ...user.app_metadata, approved: true } });
  if (error) throw new Error(`approving failed: ${error.message}`);
  console.log(`Approved ${email}`);

  const mailer = getMailer();
  if (!mailer) return console.log("(No email sent: Gmail is not configured. Tell them yourself.)");
  await mailer.send(approvedEmail({ to: email, appUrl: process.env.APP_URL }));
  console.log("Approval email sent.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
