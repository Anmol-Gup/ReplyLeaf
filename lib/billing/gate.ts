import { redirect } from "next/navigation";
import { billingEnforced, computeAccess, type Access, type SubscriptionRow } from "./access";
import { supabaseAdmin } from "../supabase-admin";

// Server-side access checks. The state comes from OUR database (kept in step with Stripe), never from the browser,
// and the tenant id always comes from the verified session or from a stored row, never from a request body.

export async function loadAccess(clientId: string, now = new Date()): Promise<Access> {
  const db = supabaseAdmin();
  const [{ data: client }, { data: sub }] = await Promise.all([
    db.from("clients").select("billing_exempt").eq("id", clientId).maybeSingle(),
    db.from("subscriptions").select("status, current_period_end, cancel_at_period_end, grace_ends_at").eq("client_id", clientId).maybeSingle(),
  ]);
  return computeAccess((sub as SubscriptionRow) ?? null, { exempt: client?.billing_exempt === true, enforced: billingEnforced(), now });
}

/** Of these businesses, the ones whose subscription currently allows automation. For scheduled jobs. */
export async function paidClientIds(ids: string[], now = new Date()): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const db = supabaseAdmin();
  const [{ data: clients }, { data: subs }] = await Promise.all([
    db.from("clients").select("id, billing_exempt").in("id", ids),
    db.from("subscriptions").select("client_id, status, current_period_end, cancel_at_period_end, grace_ends_at").in("client_id", ids),
  ]);
  const subBy = new Map((subs ?? []).map((s) => [s.client_id as string, s as unknown as SubscriptionRow]));
  const enforced = billingEnforced();
  return new Set((clients ?? []).filter((c) => computeAccess(subBy.get(c.id as string) ?? null, { exempt: c.billing_exempt === true, enforced, now }).allowed).map((c) => c.id as string));
}

/** Guard for paid dashboard actions. Billing, settings, exports and viewing data are NOT guarded. */
export async function requirePaidAccess(clientId: string): Promise<void> {
  const a = await loadAccess(clientId);
  if (!a.allowed) redirect("/dashboard/billing?notice=subscription_required");
}
