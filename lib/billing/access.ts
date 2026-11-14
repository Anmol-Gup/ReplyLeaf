// The single place that decides whether a business may use the paid features. Pure and unit-tested; the server
// loads the subscription row from the database (kept in step with Stripe by webhooks and the daily reconciliation)
// and calls this. Nothing here trusts the browser, and nothing calls Stripe.

export const GRACE_DAYS = 7;
export const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;
/** A plain "active" subscription whose period end has just passed is still treated as paid for this long: the renewal
 *  invoice is being paid and the webhook is on its way. Past this, only Stripe's confirmation (or a missed-webhook
 *  reconciliation) can keep it alive. Not applied to a subscription that is set to cancel at period end. */
export const RENEWAL_SLACK_MS = 24 * 60 * 60 * 1000;

export type SubscriptionStatus = "none" | "incomplete" | "incomplete_expired" | "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "paused";

export type SubscriptionRow = {
  status: SubscriptionStatus;
  current_period_end: string | Date | null;
  cancel_at_period_end: boolean;
  grace_ends_at: string | Date | null;
} | null;

export type AccessReason =
  | "billing_off" | "exempt"
  | "active" | "grace" | "canceled_paid_through"
  | "grace_expired" | "canceled" | "unpaid" | "incomplete" | "none";

export type Access = {
  /** May the paid features run (AI replies, workflows, background automation, paid API endpoints)? */
  allowed: boolean;
  reason: AccessReason;
  /** The banner the dashboard shows, if any. */
  banner: "none" | "past_due_grace" | "inactive" | "cancel_scheduled";
  graceEndsAt: Date | null;
  paidThrough: Date | null;
};

const d = (v: string | Date | null | undefined) => (v ? new Date(v) : null);

export function computeAccess(sub: SubscriptionRow, o: { exempt: boolean; enforced: boolean; now: Date }): Access {
  const base = { graceEndsAt: null, paidThrough: null, banner: "none" as const };
  if (!o.enforced) return { ...base, allowed: true, reason: "billing_off" };
  if (o.exempt) return { ...base, allowed: true, reason: "exempt" };
  if (!sub || sub.status === "none") return { ...base, allowed: false, reason: "none", banner: "inactive" };

  const now = o.now.getTime();
  const end = d(sub.current_period_end);
  const grace = d(sub.grace_ends_at);
  const info = { graceEndsAt: grace, paidThrough: end };

  switch (sub.status) {
    case "active":
    case "trialing": {
      if (!end) return { ...info, allowed: false, reason: "incomplete", banner: "inactive" }; // never confirmed a paid period
      const slack = sub.cancel_at_period_end ? 0 : RENEWAL_SLACK_MS;
      if (now <= end.getTime() + slack) {
        return { ...info, allowed: true, reason: sub.cancel_at_period_end ? "canceled_paid_through" : "active", banner: sub.cancel_at_period_end ? "cancel_scheduled" : "none" };
      }
      return { ...info, allowed: false, reason: "canceled", banner: "inactive" }; // paid period over and nothing renewed it
    }
    case "past_due": {
      // The grace period was fixed when the first renewal failed; retries do not extend it.
      if (grace && now < grace.getTime()) return { ...info, allowed: true, reason: "grace", banner: "past_due_grace" };
      return { ...info, allowed: false, reason: "grace_expired", banner: "inactive" };
    }
    case "canceled":
    case "incomplete_expired":
      return { ...info, allowed: false, reason: "canceled", banner: "inactive" };
    case "unpaid":
    case "paused":
      return { ...info, allowed: false, reason: "unpaid", banner: "inactive" };
    case "incomplete":
      return { ...info, allowed: false, reason: "incomplete", banner: "inactive" };
    default:
      return { ...info, allowed: false, reason: "none", banner: "inactive" };
  }
}

/** Billing is enforced once Stripe is configured. Without the keys (local development) the app behaves as before. */
export function billingEnforced(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY?.trim() && env.STRIPE_PRICE_ID?.trim());
}

/** Whole days left, rounded up, for "x days left" messages. */
export const daysLeft = (until: Date | null, now: Date) => (until ? Math.max(0, Math.ceil((until.getTime() - now.getTime()) / 86_400_000)) : 0);
