import { getClientOrNull } from "../../../../lib/auth/session";
import { billingEnforced } from "../../../../lib/billing/access";
import { startCheckout } from "../../../../lib/billing/checkout";
import { billingLimiter, checkPost } from "../../../../lib/billing/http";
import { checkoutDeps } from "../../../../lib/billing/supabase-billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/billing/checkout: start a Stripe Checkout for THIS business. The business comes from the signed-in
// session, never from the request. The body is ignored.
export async function POST(req: Request) {
  const bad = checkPost(req);
  if (bad) return bad;
  const me = await getClientOrNull();
  if (!me) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!billingEnforced()) return Response.json({ error: "billing_not_configured" }, { status: 503 });
  if (!billingLimiter.allow(`checkout:${me.clientId}`)) return Response.json({ error: "too_many_requests" }, { status: 429 });

  try {
    const result = await startCheckout({ clientId: me.clientId, email: me.user.email ?? null, businessName: me.clientName }, checkoutDeps());
    if (result.kind === "url") return Response.json({ url: result.url });
    if (result.kind === "already_subscribed") return Response.json({ error: "already_subscribed", redirect: "/dashboard/billing" }, { status: 409 });
    return Response.json({ status: "processing", redirect: "/dashboard/billing?checkout=success" }, { status: 202 });
  } catch (e) {
    console.error("checkout failed", e instanceof Error ? e.message : "error"); // message only
    return Response.json({ error: "checkout_failed" }, { status: 502 });
  }
}
