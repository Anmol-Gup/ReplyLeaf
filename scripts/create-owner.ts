// Creates an owner login and links it to a client. There is no public sign-up:
// owners are created by you.
//
//   CLIENT_ID=<uuid> OWNER_LOGIN_EMAIL=owner@example.com OWNER_PASSWORD='long-random-password' \
//     npm run create-owner
import { supabaseAdmin } from "../lib/supabase-admin";

async function main() {
  const clientId = process.env.CLIENT_ID;
  const email = process.env.OWNER_LOGIN_EMAIL;
  const password = process.env.OWNER_PASSWORD;
  if (!clientId || !email || !password) throw new Error("Set CLIENT_ID, OWNER_LOGIN_EMAIL and OWNER_PASSWORD");
  if (password.length < 12) throw new Error("Use a password of at least 12 characters");

  const db = supabaseAdmin();
  const { data: client } = await db.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!client) throw new Error(`No client with id ${clientId}`);

  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { approved: true } });
  if (error || !data.user) throw new Error(`creating user failed: ${error?.message}`);

  const { error: linkErr } = await db.from("client_users").insert({ client_id: clientId, user_id: data.user.id, role: "owner" });
  if (linkErr) throw new Error(`linking user failed: ${linkErr.message}`);
  console.log(`Created owner ${email} for client ${clientId}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
