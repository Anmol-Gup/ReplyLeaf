import type { SubscriptionStatus } from "./access";
import type { BillingEmail } from "./emails";
import { snapshotFromSubscription, type StripeClient, type StripeObj } from "./stripe";

// Starting a subscription, cancelling it, opening the customer portal. The tenant is ALWAYS the one resolved on the
// server from the signed-in session: nothing here accepts a tenant id from the browser. Stripe does the payment.

export type SubRowLite = {
  status: SubscriptionStatus; stripe_customer_id: string | null; stripe_subscription_id: string | null;
  checkout_session_id: string | null; checkout_created_at: string | null; cancel_at_period_end: boolean;
} | null;

export interface CheckoutDeps {
  stripe: Pick<StripeClient, "createCustomer" | "createCheckoutSession" | "retrieveCheckoutSession" | "retrieveSubscription" | "setCancelAtPeriodEnd" | "createPortalSession">;
  now(): Date;
  appUrl: string;
  priceId: string;
  getRow(clientId: string): Promise<SubRowLite>;
  recordCheckout(clientId: string, customerId: string | null, sessionId: string | null): Promise<void>;
  /** Re-read the subscription from Stripe and apply it (see syncSubscription). Returns the stored status. */
  sync(clientId: string, subscriptionId: string, snapshot?: ReturnType<typeof snapshotFromSubscription>): Promise<string | null>;
  emailOnce(clientId: string, key: string, email: BillingEmail): Promise<void>;
}

const LIVE: SubscriptionStatus[] = ["active", "trialing", "past_due"];
export const PENDING_CHECKOUT_MS = 24 * 60 * 60 * 1000;

export type CheckoutResult =
  | { kind: "url"; url: string }
  | { kind: "already_subscribed" }
  | { kind: "processing" };   // the payment went through at Stripe; our records catch up through the webhook

export async function startCheckout(input: { clientId: string; email: string | null; businessName: string }, deps: CheckoutDeps): Promise<CheckoutResult> {
  const row = await deps.getRow(input.clientId);

  // 1) Never a second subscription.
  if (row && LIVE.includes(row.status)) return { kind: "already_subscribed" };

  // 2) A pending checkout: reuse it while it is open instead of creating another one.
  if (row?.checkout_session_id && row.checkout_created_at && deps.now().getTime() - new Date(row.checkout_created_at).getTime() < PENDING_CHECKOUT_MS) {
    try {
      const s = await deps.stripe.retrieveCheckoutSession(row.checkout_session_id);
      if (s.status === "open" && s.url) return { kind: "url", url: s.url };
      if (s.status === "complete" && s.subscription) {
        const status = await deps.sync(input.clientId, s.subscription);
        return status && LIVE.includes(status as SubscriptionStatus) ? { kind: "already_subscribed" } : { kind: "processing" };
      }
    } catch { /* an unknown or expired session: fall through and create a new one */ }
  }

  // 3) A Stripe customer for this business, created once and reused.
  let customerId = row?.stripe_customer_id ?? null;
  if (!customerId) {
    customerId = (await deps.stripe.createCustomer({ email: input.email, name: input.businessName, clientId: input.clientId })).id;
    await deps.recordCheckout(input.clientId, customerId, null);
  }

  // 4) The Checkout Session: subscription mode, the one price, quantity 1, the tenant in the metadata.
  const base = deps.appUrl.replace(/\/$/, "");
  const session = await deps.stripe.createCheckoutSession({
    customerId, priceId: deps.priceId, clientId: input.clientId,
    successUrl: `${base}/dashboard/billing?checkout=success`,
    cancelUrl: `${base}/dashboard/billing?checkout=cancelled`,
    idempotencyKey: `checkout:${input.clientId}:${Math.floor(deps.now().getTime() / 60_000)}`, // a double click within a minute returns the same session
  });
  if (!session.url) throw new Error("Stripe returned no checkout URL");
  await deps.recordCheckout(input.clientId, customerId, session.id);
  return { kind: "url", url: session.url };
}

/** The customer page is only available once there is a Stripe customer (i.e. they started checkout at least once). */
export async function openPortal(clientId: string, deps: CheckoutDeps): Promise<{ url: string } | null> {
  const row = await deps.getRow(clientId);
  if (!row?.stripe_customer_id) return null;
  return deps.stripe.createPortalSession({ customerId: row.stripe_customer_id, returnUrl: `${deps.appUrl.replace(/\/$/, "")}/dashboard/billing` });
}

export type CancelResult = { kind: "scheduled"; paidThrough: Date | null } | { kind: "nothing_to_cancel" };

/** Cancel at the END of the paid period: access continues until then. Idempotent. */
export async function cancelAtPeriodEnd(clientId: string, deps: CheckoutDeps): Promise<CancelResult> {
  const row = await deps.getRow(clientId);
  if (!row?.stripe_subscription_id || !LIVE.includes(row.status)) return { kind: "nothing_to_cancel" };
  const updated = (await deps.stripe.setCancelAtPeriodEnd(row.stripe_subscription_id, true)) as StripeObj;
  const snapshot = snapshotFromSubscription(updated);
  await deps.sync(clientId, row.stripe_subscription_id, snapshot);
  await deps.emailOnce(clientId, `cancel_scheduled:${row.stripe_subscription_id}:${snapshot.periodEnd?.getTime() ?? 0}`, { kind: "canceled_scheduled", paidThrough: snapshot.periodEnd });
  return { kind: "scheduled", paidThrough: snapshot.periodEnd };
}
