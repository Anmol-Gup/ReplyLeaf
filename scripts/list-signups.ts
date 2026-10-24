// Lists accounts waiting for approval: signed up, not approved, not linked to a business.
//
//   npm run list-signups
import { supabaseAdmin } from "../lib/supabase-admin";

async function main() {
  const db = supabaseAdmin();
  const { data: links } = await db.from("client_users").select("user_id");
  const linked = new Set((links ?? []).map((l) => l.user_id as string));

  let waiting = 0;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listing users failed: ${error.message}`);
    for (const u of data.users) {
      if (u.app_metadata?.approved === true || linked.has(u.id)) continue;
      waiting++;
      const business = (u.user_metadata?.business_name as string | undefined) ?? "(not given)";
      console.log(`${u.email}  |  ${business}  |  signed up ${u.created_at?.slice(0, 10)}  |  email ${u.email_confirmed_at ? "confirmed" : "NOT confirmed yet"}`);
    }
    if (data.users.length < 200) break;
  }
  console.log(waiting ? `\n${waiting} waiting. Approve with: npm run approve-user -- <email>` : "No one is waiting for approval.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
