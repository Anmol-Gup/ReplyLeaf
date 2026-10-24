// Loads business settings into a client from a text/markdown file. A stand-in
// for the Stage 4 dashboard editor:
//
//   CLIENT_ID=<uuid> KB_FILE=eval/sample-kb.md npm run set-kb
//   (optional) BOOKING_LINK=https://... BUSINESS_HOURS="Mon-Fri 9-5" AI_PROVIDER=gemini|openai
import { readFileSync } from "node:fs";
import { supabaseAdmin } from "../lib/supabase-admin";

async function main() {
  const clientId = process.env.CLIENT_ID;
  const file = process.env.KB_FILE;
  if (!clientId || !file) throw new Error("Set CLIENT_ID and KB_FILE");

  const patch: Record<string, string> = { kb_text: readFileSync(file, "utf8") };
  if (process.env.BOOKING_LINK) patch.booking_link = process.env.BOOKING_LINK;
  if (process.env.BUSINESS_HOURS) patch.business_hours = process.env.BUSINESS_HOURS;
  if (process.env.AI_PROVIDER) {
    if (!["gemini", "openai"].includes(process.env.AI_PROVIDER)) throw new Error("AI_PROVIDER must be gemini or openai");
    patch.ai_provider = process.env.AI_PROVIDER;
  }

  const { data, error } = await supabaseAdmin().from("clients").update(patch).eq("id", clientId).select("id");
  if (error) throw new Error(`update failed: ${error.message}`);
  if (!data?.length) throw new Error(`No client with id ${clientId}`);
  console.log(`Updated ${Object.keys(patch).join(", ")} for client ${clientId}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
