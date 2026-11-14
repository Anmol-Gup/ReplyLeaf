import { summarizeDailyCheck, type CheckRow } from "../../../../lib/checks";
import { paidClientIds } from "../../../../lib/billing/gate";
import { isCronAuthorized } from "../../../../lib/cron";
import { supabaseAdmin } from "../../../../lib/supabase-admin";
import { raiseAlert } from "../../../../lib/supabase-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Daily check: per client, messages received vs replies sent over the last 24h,
// plus unreplied conversations, failed sends and stuck batches. Emails the admin
// (through the normal alert path) only when something looks wrong.
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin().rpc("daily_reply_check", { p_since: since });
  if (error) {
    console.error("daily check failed", error.message);
    await raiseAlert(null, "daily_check_failed", error.message).catch(() => {});
    return Response.json({ ok: false }, { status: 500 });
  }
  // Businesses without an active subscription have automation switched off on purpose: not a problem to alert on.
  const all = (data ?? []) as CheckRow[];
  const paid = await paidClientIds(all.map((r) => r.out_client_id));
  const summary = summarizeDailyCheck(all.filter((r) => paid.has(r.out_client_id)));
  console.log(summary.text);
  if (summary.hasIssues) await raiseAlert(null, "daily_check_issues", summary.text);
  return Response.json({ ok: true, clients: paid.size, skipped_unpaid: all.length - paid.size, issues: summary.issueCount });
}
