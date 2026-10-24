// Promotes an EXISTING login to platform admin. To create a brand-new admin login with no
// sign-up, use `npm run create-admin -- you@example.com` instead.
//
//   npm run make-admin -- you@example.com
//
// The account must already exist (sign up, or create it in Supabase Authentication).
import { supabaseAdmin } from "../lib/supabase-admin";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) throw new Error("Usage: npm run make-admin -- you@example.com");
  const db = supabaseAdmin();

  let found = null;
  for (let page = 1; page <= 50 && !found; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listing users failed: ${error.message}`);
    found = data.users.find((u) => u.email?.toLowerCase() === email) ?? null;
    if (data.users.length < 200) break;
  }
  if (!found) throw new Error(`No account found for ${email}. Create the admin with: npm run create-admin -- ${email}`);

  const { error } = await db.auth.admin.updateUserById(found.id, { app_metadata: { ...found.app_metadata, is_admin: true, approved: true } });
  if (error) throw new Error(`failed: ${error.message}`);
  console.log(`${email} is now an admin. Sign in and open /admin/signups.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
