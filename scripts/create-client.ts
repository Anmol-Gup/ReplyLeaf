// Creates a client row + its encrypted WhatsApp token. Use it to register
// Meta's test number for Stage 1:
//
//   CLIENT_NAME="Test Biz" WA_PHONE_NUMBER_ID=123 WA_ACCESS_TOKEN=EAAG... \
//     npm run create-client
//
//   (optional) OWNER_EMAIL=owner@example.com   # where lead/booking/handoff alerts go
//
// The token comes from an env var (not a CLI flag) so it stays out of shell history.
import { encryptSecret } from "../lib/crypto";
import { env } from "../lib/env";
import { supabaseAdmin } from "../lib/supabase-admin";

async function main() {
  const name = process.env.CLIENT_NAME;
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
  const token = process.env.WA_ACCESS_TOKEN;
  if (!name || !phoneNumberId || !token) {
    throw new Error("Set CLIENT_NAME, WA_PHONE_NUMBER_ID and WA_ACCESS_TOKEN");
  }

  const db = supabaseAdmin();
  const { data: client, error } = await db
    .from("clients")
    .insert({ name, wa_phone_number_id: phoneNumberId, wa_waba_id: process.env.WA_WABA_ID ?? null, owner_email: process.env.OWNER_EMAIL ?? null })
    .select("id")
    .single();
  if (error) throw new Error(`creating client failed: ${error.message}`);

  const { error: secretErr } = await db.from("client_secrets").insert({
    client_id: client.id,
    wa_access_token_enc: encryptSecret(token, env().ENCRYPTION_KEY),
  });
  if (secretErr) throw new Error(`storing token failed: ${secretErr.message}`);

  console.log(`Created client ${client.id} for phone_number_id ${phoneNumberId}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
