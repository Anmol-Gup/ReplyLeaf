import { getClientOrNull } from "../../../../lib/auth/session";
import { billingEnforced } from "../../../../lib/billing/access";
import { openPortal } from "../../../../lib/billing/checkout";
import { billingLimiter, checkPost } from "../../../../lib/billing/http";
import { checkoutDeps } from "../../../../lib/billing/supabase-billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/billing/portal: Stripe's customer portal (payment method, invoices, cancel) for THIS business.
export async function POST(req: Request) {
  const bad = checkPost(req);
  if (bad) return bad;
  const me = await getClientOrNull();
  if (!me) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!billingEnforced()) return Response.json({ error: "billing_not_configured" }, { status: 503 });
  if (!billingLimiter.allow(`portal:${me.clientId}`)) return Response.json({ error: "too_many_requests" }, { status: 429 });
  try {
    const portal = await openPortal(me.clientId, checkoutDeps());
    if (!portal) return Response.json({ error: "no_billing_account" }, { status: 404 });
    return Response.json({ url: portal.url });
  } catch (e) {
    console.error("portal failed", e instanceof Error ? e.message : "error");
    return Response.json({ error: "portal_failed" }, { status: 502 });
  }
}
