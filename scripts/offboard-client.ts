// Marks a client as having left. From that moment the assistant stops replying
// to their customers; the retention job wipes their WhatsApp token and, 12 months
// later, deletes their contacts and conversations.
//
//   CLIENT_ID=<uuid> npm run offboard-client
import { supabaseAdmin } from "../lib/supabase-admin";

async function main() {
  const id = process.env.CLIENT_ID;
  if (!id) throw new Error("Set CLIENT_ID");
  const { data, error } = await supabaseAdmin().from("clients")
    .update({ status: "left", left_at: new Date().toISOString() }).eq("id", id).select("id");
  if (error) throw new Error(`update failed: ${error.message}`);
  if (!data?.length) throw new Error(`No client with id ${id}`);
  console.log(`Client ${id} marked as left.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
