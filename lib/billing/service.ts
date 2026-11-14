import { computeAccess, GRACE_DAYS, type SubscriptionStatus } from "./access";
import type { BillingEmail } from "./emails";
import {
  invoiceFields, snapshotFromSubscription, StripeError, type InvoiceFields, type StripeClient, type StripeObj, type SubscriptionSnapshot,
} from "./stripe";

// Webhook processing and reconciliation. Everything that touches the database or Stripe goes through BillingDeps,
// so the logic (idempotency, out-of-order events, grace period, one email per event) is unit-tested with fakes.
// RULES: Stripe is the source of truth. Subscription state is always re-read from Stripe's API instead of trusted
// from an event payload; a checkout redirect or anything from the browser never grants access.

export type ApplyResult = { applied: boolean; reason: string; prevStatus: string | null; status: string; graceEndsAt: Date | null };

export interface BillingDeps {
  stripe: Pick<StripeClient, "retrieveSubscription">;
  now(): Date;
  /** Send renewal receipts too (off by default: they are noisy). */
  renewalEmails: boolean;
  claimEvent(id: string, type: string): Promise<"new" | "retry" | "duplicate">;
  finishEvent(id: string, status: "processed" | "ignored" | "failed", error?: string): Promise<void>;
  clientExists(clientId: string): Promise<boolean>;
  clientIdForCustomer(customerId: string): Promise<string | null>;
  storedCustomerId(clientId: string): Promise<string | null>;
  applySnapshot(clientId: string, s: SubscriptionSnapshot, observedAt: Date, graceStart: Date | null): Promise<ApplyResult>;
  upsertInvoice(clientId: string, inv: InvoiceFields, eventCreated: number): Promise<void>;
  claimEmail(clientId: string, key: string): Promise<boolean>;
  releaseEmail(clientId: string, key: string): Promise<void>;
  sendBillingEmail(clientId: string, email: BillingEmail): Promise<void>;
  audit(clientId: string, event: string, detail: Record<string, unknown>, stripeEventId?: string): Promise<void>;
}

export type StripeEvent = { id: string; type: string; created: number; data: { object: StripeObj } };
export type EventOutcome = "processed" | "ignored" | "duplicate";

const idOf = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as StripeObj).id === "string" ? (v as StripeObj).id : null);

/** Send an email at most once per key. If sending fails, the claim is released so a retry can send it. */
async function emailOnce(deps: BillingDeps, clientId: string, key: string, email: BillingEmail) {
  if (!(await deps.claimEmail(clientId, key))) return;
  try {
    await deps.sendBillingEmail(clientId, email);
  } catch (e) {
    await deps.releaseEmail(clientId, key);
    console.warn("billing email not sent", email.kind, e instanceof Error ? e.message : "error"); // no addresses, no bodies
  }
}

/** Re-read the subscription from Stripe and apply it. The tenant must match Stripe's own metadata (set by us at checkout). */
export async function syncSubscription(
  clientId: string, subscriptionId: string, deps: BillingDeps,
  opts: { snapshot?: SubscriptionSnapshot; graceStart?: Date | null; stripeEventId?: string } = {},
): Promise<{ snapshot: SubscriptionSnapshot; result: ApplyResult } | null> {
  const observedAt = deps.now(); // taken BEFORE the API call, so a later snapshot always wins a race
  const snapshot = opts.snapshot ?? snapshotFromSubscription(await deps.stripe.retrieveSubscription(subscriptionId));

  if (snapshot.clientId !== clientId) {
    await deps.audit(clientId, "tenant_mismatch", { subscription: subscriptionId, reason: "metadata" }, opts.stripeEventId);
    return null;
  }
  const stored = await deps.storedCustomerId(clientId);
  if (stored && snapshot.customerId && stored !== snapshot.customerId) {
    await deps.audit(clientId, "tenant_mismatch", { subscription: subscriptionId, reason: "customer" }, opts.stripeEventId);
    return null;
  }
  const result = await deps.applySnapshot(clientId, snapshot, observedAt, opts.graceStart ?? null);
  if (!result.applied) await deps.audit(clientId, "snapshot_ignored", { subscription: subscriptionId, reason: result.reason }, opts.stripeEventId);
  return { snapshot, result };
}

/** The tenant for an invoice: from the subscription's metadata (trusted), else from a customer we created. */
async function clientForInvoice(inv: InvoiceFields, deps: BillingDeps): Promise<string | null> {
  if (inv.subscriptionId) {
    try {
      const sub = snapshotFromSubscription(await deps.stripe.retrieveSubscription(inv.subscriptionId));
      if (sub.clientId && (await deps.clientExists(sub.clientId))) return sub.clientId;
    } catch (e) {
      if (!(e instanceof StripeError && e.status === 404)) throw e; // a real outage: let Stripe retry the event
    }
  }
  return inv.customerId ? deps.clientIdForCustomer(inv.customerId) : null;
}

export async function handleStripeEvent(event: StripeEvent, deps: BillingDeps): Promise<EventOutcome> {
  if ((await deps.claimEvent(event.id, event.type)) === "duplicate") return "duplicate";
  try {
    const outcome = await dispatch(event, deps);
    await deps.finishEvent(event.id, outcome);
    return outcome;
  } catch (e) {
    await deps.finishEvent(event.id, "failed", e instanceof Error ? e.message : "error");
    throw e; // a 5xx makes Stripe retry later; the claim lets that retry through
  }
}

async function dispatch(event: StripeEvent, deps: BillingDeps): Promise<"processed" | "ignored"> {
  const obj = event.data.object;
  switch (event.type) {
    case "checkout.session.completed": {
      if (obj.mode !== "subscription") return "ignored";
      const clientId = (typeof obj.client_reference_id === "string" && obj.client_reference_id) || obj.metadata?.client_id;
      const subscriptionId = idOf(obj.subscription);
      if (!clientId || !subscriptionId || !(await deps.clientExists(clientId))) return "ignored";
      // NOT granted because the checkout completed: the subscription's real status comes from Stripe.
      await syncSubscription(clientId, subscriptionId, deps, { stripeEventId: event.id });
      await deps.audit(clientId, "checkout_completed", { subscription: subscriptionId, payment_status: obj.payment_status ?? null }, event.id);
      return "processed";
    }

    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.payment_action_required": {
      const inv = invoiceFields(obj);
      const clientId = await clientForInvoice(inv, deps);
      if (!clientId) return "ignored";
      await deps.upsertInvoice(clientId, inv, event.created);

      if (event.type === "invoice.payment_action_required") {
        await emailOnce(deps, clientId, `action:${inv.invoiceId}`, { kind: "payment_action_required", hostedUrl: inv.hostedUrl });
        return "processed";
      }
      if (!inv.subscriptionId) return "processed";

      const synced = await syncSubscription(clientId, inv.subscriptionId, deps, { stripeEventId: event.id, graceStart: event.type === "invoice.payment_failed" ? new Date(event.created * 1000) : null });
      if (!synced) return "processed";
      const { snapshot, result } = synced;

      if (event.type === "invoice.payment_failed") {
        await deps.audit(clientId, "payment_failed", { invoice: inv.invoiceId, attempt: inv.attemptCount, status: result.status }, event.id);
        await emailOnce(deps, clientId, `failed:${inv.invoiceId}`, { kind: "payment_failed", graceEndsAt: result.status === "past_due" ? result.graceEndsAt : null, hostedUrl: inv.hostedUrl });
        return "processed";
      }
      // invoice.paid
      await deps.audit(clientId, "payment_succeeded", { invoice: inv.invoiceId, amount: inv.amountPaid }, event.id);
      if (inv.billingReason === "subscription_create") {
        await emailOnce(deps, clientId, `subscribed:${inv.subscriptionId}`, { kind: "subscribed", periodEnd: snapshot.periodEnd });
      } else if (result.prevStatus === "past_due" && snapshot.status === "active") {
        await emailOnce(deps, clientId, `recovered:${inv.invoiceId}`, { kind: "recovered", periodEnd: snapshot.periodEnd });
      } else if (deps.renewalEmails && inv.billingReason === "subscription_cycle") {
        await emailOnce(deps, clientId, `renewed:${inv.invoiceId}`, { kind: "renewed", periodEnd: snapshot.periodEnd, amount: null });
      }
      return "processed";
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const claimed = snapshotFromSubscription(obj);
      const clientId = claimed.clientId;
      if (!clientId || !(await deps.clientExists(clientId))) return "ignored";
      let fresh: SubscriptionSnapshot;
      try {
        fresh = snapshotFromSubscription(await deps.stripe.retrieveSubscription(claimed.subscriptionId)); // the latest, not the event's possibly stale copy
      } catch (e) {
        if (event.type === "customer.subscription.deleted" && e instanceof StripeError && e.status === 404) fresh = claimed;
        else throw e;
      }
      const synced = await syncSubscription(clientId, claimed.subscriptionId, deps, { snapshot: fresh, stripeEventId: event.id });
      if (!synced) return "processed";
      if (event.type === "customer.subscription.deleted" && synced.result.applied) {
        await emailOnce(deps, clientId, `ended:${claimed.subscriptionId}`, { kind: "ended" });
      } else if (fresh.cancelAtPeriodEnd && fresh.status === "active") {
        await emailOnce(deps, clientId, `cancel_scheduled:${claimed.subscriptionId}:${fresh.periodEnd?.getTime() ?? 0}`, { kind: "canceled_scheduled", paidThrough: fresh.periodEnd });
      }
      return "processed";
    }

    default:
      return "ignored"; // acknowledged and recorded, nothing to do
  }
}

// ------------------------------------------------------------------------------- reconciliation (missed webhooks)
export type StaleRow = {
  client_id: string; stripe_subscription_id: string;
  status: SubscriptionStatus;
  current_period_end: string | null; cancel_at_period_end: boolean; grace_ends_at: string | null;
};

export interface ReconcileDeps extends BillingDeps {
  /** Subscriptions that may be out of date: past due, incomplete, near or past a period end, or not synced for a few days. */
  listStale(now: Date, limit: number): Promise<StaleRow[]>;
  businessName(clientId: string): Promise<string>;
}

export type ReconcileSummary = { checked: number; changed: number; failed: number; reminders: number; expiries: number };

export async function reconcileSubscriptions(deps: ReconcileDeps, limit = 100): Promise<ReconcileSummary> {
  const now = deps.now();
  const rows = await deps.listStale(now, limit);
  const summary: ReconcileSummary = { checked: 0, changed: 0, failed: 0, reminders: 0, expiries: 0 };

  for (const row of rows) {
    summary.checked++;
    try {
      const synced = await syncSubscription(row.client_id, row.stripe_subscription_id, deps);
      if (!synced) continue;
      const { snapshot, result } = synced;
      const differs = result.applied && (
        row.status !== snapshot.status
        || row.cancel_at_period_end !== snapshot.cancelAtPeriodEnd
        || (row.current_period_end ? new Date(row.current_period_end).getTime() : 0) !== (snapshot.periodEnd?.getTime() ?? 0));
      if (differs) {
        summary.changed++;
        await deps.audit(row.client_id, "reconcile_discrepancy", { from: row.status, to: snapshot.status, subscription: row.stripe_subscription_id });
        console.warn("billing reconciliation fixed a stale subscription", { clientId: row.client_id, from: row.status, to: snapshot.status });
        if (snapshot.status === "canceled" && row.status !== "canceled") await emailOnce(deps, row.client_id, `ended:${row.stripe_subscription_id}`, { kind: "ended" });
        if (snapshot.status === "active" && row.status === "past_due") await emailOnce(deps, row.client_id, `recovered:${row.stripe_subscription_id}:${snapshot.periodEnd?.getTime() ?? 0}`, { kind: "recovered", periodEnd: snapshot.periodEnd });
      }

      // Grace-period emails depend on the clock, not on a webhook, so they are sent from here.
      if (result.status === "past_due" && result.graceEndsAt) {
        const msLeft = result.graceEndsAt.getTime() - now.getTime();
        const stamp = result.graceEndsAt.toISOString().slice(0, 10);
        if (msLeft <= 0) {
          summary.expiries++;
          await emailOnce(deps, row.client_id, `expired:${row.stripe_subscription_id}:${stamp}`, { kind: "expired" });
        } else if (msLeft <= 2 * 86_400_000) {
          summary.reminders++;
          await emailOnce(deps, row.client_id, `grace_reminder:${row.stripe_subscription_id}:${stamp}`, { kind: "grace_reminder", graceEndsAt: result.graceEndsAt, daysLeft: Math.max(1, Math.ceil(msLeft / 86_400_000)) });
        }
      }
    } catch (e) {
      summary.failed++;
      console.error("billing reconciliation failed for a subscription", { clientId: row.client_id, error: e instanceof Error ? e.message : "error" });
    }
  }
  return summary;
}

export const GRACE_NOTE = `${GRACE_DAYS} days`;
export { computeAccess };
