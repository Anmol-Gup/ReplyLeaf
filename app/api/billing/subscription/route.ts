import { getClientOrNull } from "../../../../lib/auth/session";
import { billingEnforced, computeAccess } from "../../../../lib/billing/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/billing/subscription: this business's subscription, access state and recent invoices. Read through the
// owner's own session (RLS), so another business's billing can never be returned. No Stripe call is made here.
export async function GET() {
  const me = await getClientOrNull();
  if (!me) return Response.json({ error: "unauthorized" }, { status: 401 });
  const [{ data: client }, { data: sub }, { data: invoices }] = await Promise.all([
    me.db.from("clients").select("billing_exempt").eq("id", me.clientId).maybeSingle(),
    me.db.from("subscriptions").select("status, stripe_price_id, current_period_start, current_period_end, cancel_at_period_end, grace_ends_at, ended_at").eq("client_id", me.clientId).maybeSingle(),
    me.db.from("invoices").select("stripe_invoice_id, status, amount_due, amount_paid, currency, hosted_invoice_url, invoice_pdf, period_start, period_end, paid_at, created_at")
      .eq("client_id", me.clientId).order("created_at", { ascending: false }).limit(24),
  ]);
  const access = computeAccess(sub ? { status: sub.status, current_period_end: sub.current_period_end, cancel_at_period_end: sub.cancel_at_period_end, grace_ends_at: sub.grace_ends_at } : null,
    { exempt: client?.billing_exempt === true, enforced: billingEnforced(), now: new Date() });
  return Response.json({ plan: { name: "WhatsApp AI Assistant", amount: 99900, currency: "inr", interval: "month" }, subscription: sub ?? null, access, invoices: invoices ?? [] });
}
