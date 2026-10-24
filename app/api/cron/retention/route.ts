import { isCronAuthorized } from "../../../../lib/cron";
import { supabaseAdmin } from "../../../../lib/supabase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Daily privacy retention job (see run_retention in migration 0007 for the policy).
// Idempotent, so a duplicate or missed cron delivery is harmless.
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  const { data, error } = await supabaseAdmin().rpc("run_retention");
  if (error) {
    console.error("retention failed", error.message);
    return Response.json({ ok: false }, { status: 500 });
  }
  const r = (Array.isArray(data) ? data[0] : data) as Record<string, number>;
  const counts = {
    messagesBlanked: r.out_messages_blanked, questionsDeleted: r.out_questions_deleted,
    contactsDeleted: r.out_contacts_deleted, secretsWiped: r.out_secrets_wiped, alertsDeleted: r.out_alerts_deleted,
  };
  console.log("retention run", counts); // counts only, no personal data
  return Response.json({ ok: true, ...counts });
}
