// Creates the platform admin login directly: no sign-up, no email verification step.
// The admin then signs in on the normal /login page and lands on /admin/signups.
//
//   npm run create-admin -- you@example.com
//
// Choose your own password with ADMIN_PASSWORD='12+ chars' npm run create-admin -- you@example.com,
// or leave it unset and a strong random password is generated and printed ONCE in this terminal.
// If the account already exists it is promoted to admin (and the password is changed only when
// ADMIN_PASSWORD is given).
import { generatePassword } from "../lib/admin-password";
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
  if (!email || !email.includes("@")) throw new Error("Usage: npm run create-admin -- you@example.com");
  const given = process.env.ADMIN_PASSWORD;
  if (given && given.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");

  const db = supabaseAdmin();
  const existing = await findUser(email);
  const flags = { is_admin: true, approved: true };

  if (existing) {
    const { error } = await db.auth.admin.updateUserById(existing.id, {
      app_metadata: { ...existing.app_metadata, ...flags },
      email_confirm: true,
      ...(given ? { password: given } : {}),
    });
    if (error) throw new Error(`updating the account failed: ${error.message}`);
    console.log(`${email} already existed and is now an admin${given ? " with the new password" : " (password unchanged)"}.`);
  } else {
    const password = given ?? generatePassword();
    const { error } = await db.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: flags });
    if (error) throw new Error(`creating the admin failed: ${error.message}`);
    console.log(`Created admin ${email}`);
    if (!given) console.log(`\nPassword (shown once, save it now): ${password}\n`);
  }
  console.log("Sign in at /login. You will land on /admin/signups.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
