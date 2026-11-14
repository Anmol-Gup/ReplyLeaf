import { getClientOrNull } from "../../../../lib/auth/session";
import { billingEnforced } from "../../../../lib/billing/access";
import { cancelAtPeriodEnd } from "../../../../lib/billing/checkout";
import { billingLimiter, checkPost } from "../../../../lib/billing/http";
import { checkoutDeps } from "../../../../lib/billing/supabase-billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/billing/cancel: cancel at the END of the paid period (access continues until then). Idempotent.
export async function POST(req: Request) {
  const bad = checkPost(req);
  if (bad) return bad;
  const me = await getClientOrNull();
  if (!me) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!billingEnforced()) return Response.json({ error: "billing_not_configured" }, { status: 503 });
  if (!billingLimiter.allow(`cancel:${me.clientId}`)) return Response.json({ error: "too_many_requests" }, { status: 429 });
  try {
    const r = await cancelAtPeriodEnd(me.clientId, checkoutDeps());
    if (r.kind === "nothing_to_cancel") return Response.json({ error: "nothing_to_cancel" }, { status: 409 });
    return Response.json({ canceled: true, paidThrough: r.paidThrough?.toISOString() ?? null });
  } catch (e) {
    console.error("cancel failed", e instanceof Error ? e.message : "error");
    return Response.json({ error: "cancel_failed" }, { status: 502 });
  }
}
