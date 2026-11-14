import { isCronAuthorized } from "../../../../lib/cron";
import { billingEnforced } from "../../../../lib/billing/access";
import { reconcileSubscriptions } from "../../../../lib/billing/service";
import { billingDeps } from "../../../../lib/billing/supabase-billing";
import { raiseAlert } from "../../../../lib/supabase-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Daily: protects against missed webhooks. Re-reads stale, past-due and soon-to-renew subscriptions from Stripe,
// fixes any difference, and sends the grace-period reminder and expiry emails (which depend on the clock, not on a
// webhook). Safe to run twice. Access itself is computed from stored timestamps, so a grace period ends on time
// even if this job runs late.
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  if (!billingEnforced()) return Response.json({ ok: true, skipped: "billing not configured" });
  try {
    const summary = await reconcileSubscriptions(billingDeps());
    console.log("billing reconciliation", summary);
    if (summary.failed > 0) await raiseAlert(null, "billing_reconcile_failures", `${summary.failed} subscription(s) could not be reconciled`).catch(() => {});
    return Response.json({ ok: true, ...summary });
  } catch (e) {
    console.error("billing reconciliation failed", e instanceof Error ? e.message : "error");
    await raiseAlert(null, "billing_reconcile_failed", e instanceof Error ? e.message : "error").catch(() => {});
    return Response.json({ ok: false }, { status: 500 });
  }
}
