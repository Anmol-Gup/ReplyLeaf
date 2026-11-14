import { z } from "zod";
import { getMailer } from "../email/mailer";
import { supabaseAdmin } from "../supabase-admin";
import { billingEmailMessage, type BillingEmail } from "./emails";
import { startCheckout, type CheckoutDeps } from "./checkout";
import { syncSubscription, type ApplyResult, type BillingDeps, type ReconcileDeps, type StaleRow } from "./service";
import { stripeClient, type StripeClient, type SubscriptionSnapshot } from "./stripe";

// The production implementations of the billing dependencies: Postgres through the server-only functions of
// migration 0013, plus the Stripe client. Server only.

const uuid = z.string().uuid();
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function billingDeps(): ReconcileDeps & { stripe: StripeClient } {
  const db = supabaseAdmin();
  const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
    if (r.error) throw new Error(`${what} failed: ${r.error.message}`);
    return r.data;
  };

  const deps: ReconcileDeps & { stripe: StripeClient } = {
    stripe: stripeClient(),
    now: () => new Date(),
    renewalEmails: process.env.BILLING_RENEWAL_EMAILS === "true",

    claimEvent: async (id, type) => must(await db.rpc("claim_stripe_event", { p_event_id: id, p_type: type }), "claim_stripe_event") as "new" | "retry" | "duplicate",
    finishEvent: async (id, status, error) => { must(await db.rpc("finish_stripe_event", { p_event_id: id, p_status: status, p_error: error ?? null }), "finish_stripe_event"); },

    clientExists: async (clientId) => {
      if (!uuid.safeParse(clientId).success) return false; // metadata is text: never feed it to a uuid column unchecked
      return Boolean(must(await db.from("clients").select("id").eq("id", clientId).maybeSingle(), "client lookup"));
    },
    clientIdForCustomer: async (customerId) => {
      const row = must(await db.from("subscriptions").select("client_id").eq("stripe_customer_id", customerId).maybeSingle(), "customer lookup");
      return (row?.client_id as string | undefined) ?? null;
    },
    storedCustomerId: async (clientId) => {
      const row = must(await db.from("subscriptions").select("stripe_customer_id").eq("client_id", clientId).maybeSingle(), "customer lookup");
      return (row?.stripe_customer_id as string | null | undefined) ?? null;
    },

    applySnapshot: async (clientId, s: SubscriptionSnapshot, observedAt, graceStart): Promise<ApplyResult> => {
      const data = must(await db.rpc("apply_subscription_snapshot", {
        p_client_id: clientId, p_customer_id: s.customerId, p_subscription_id: s.subscriptionId, p_price_id: s.priceId, p_status: s.status,
        p_period_start: iso(s.periodStart), p_period_end: iso(s.periodEnd), p_cancel_at_period_end: s.cancelAtPeriodEnd,
        p_cancel_at: iso(s.cancelAt), p_canceled_at: iso(s.canceledAt), p_ended_at: iso(s.endedAt),
        p_observed_at: observedAt.toISOString(), p_grace_start: iso(graceStart),
      }), "apply_subscription_snapshot");
      const r = (Array.isArray(data) ? data[0] : data) as { out_applied: boolean; out_reason: string; out_prev_status: string | null; out_status: string; out_grace_ends_at: string | null };
      return { applied: r.out_applied, reason: r.out_reason, prevStatus: r.out_prev_status, status: r.out_status, graceEndsAt: r.out_grace_ends_at ? new Date(r.out_grace_ends_at) : null };
    },

    upsertInvoice: async (clientId, i, eventCreated) => {
      must(await db.rpc("upsert_invoice", {
        p_client_id: clientId, p_invoice_id: i.invoiceId, p_subscription_id: i.subscriptionId, p_status: i.status, p_billing_reason: i.billingReason,
        p_amount_due: i.amountDue, p_amount_paid: i.amountPaid, p_currency: i.currency, p_attempt_count: i.attemptCount,
        p_hosted_url: i.hostedUrl, p_pdf: i.pdf, p_period_start: iso(i.periodStart), p_period_end: iso(i.periodEnd), p_paid_at: iso(i.paidAt),
        p_event_created: eventCreated,
      }), "upsert_invoice");
    },

    claimEmail: async (clientId, key) => must(await db.rpc("claim_billing_email", { p_client_id: clientId, p_key: key }), "claim_billing_email") === true,
    releaseEmail: async (clientId, key) => { must(await db.rpc("release_billing_email", { p_client_id: clientId, p_key: key }), "release_billing_email"); },

    sendBillingEmail: async (clientId, email: BillingEmail) => {
      const [client, settings] = await Promise.all([
        db.from("clients").select("name, owner_email").eq("id", clientId).single(),
        db.from("notification_settings").select("primary_email").eq("client_id", clientId).maybeSingle(),
      ]);
      const to = settings.data?.primary_email ?? client.data?.owner_email ?? null;
      const mailer = getMailer();
      if (!to || !mailer) { console.warn("billing email not sent (no owner address or GMAIL_* not set)", email.kind); return; }
      await mailer.send(billingEmailMessage(email, { to, businessName: client.data?.name ?? "your business", appUrl: process.env.APP_URL }));
    },

    audit: async (clientId, event, detail, stripeEventId) => {
      must(await db.rpc("write_billing_audit", { p_client_id: clientId, p_event: event, p_detail: detail, p_stripe_event_id: stripeEventId ?? null }), "write_billing_audit");
    },

    listStale: async (now, limit): Promise<StaleRow[]> => {
      const soon = new Date(now.getTime() + 3 * 86_400_000).toISOString();
      const old = new Date(now.getTime() - 3 * 86_400_000).toISOString();
      const data = must(await db.from("subscriptions")
        .select("client_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end, grace_ends_at")
        .not("stripe_subscription_id", "is", null)
        .not("status", "in", "(canceled,incomplete_expired,none)")
        .or(`status.in.(past_due,incomplete,unpaid,paused),current_period_end.lt.${soon},synced_at.is.null,synced_at.lt.${old}`)
        .order("synced_at", { ascending: true, nullsFirst: true }).limit(limit), "stale subscriptions");
      return (data ?? []) as StaleRow[];
    },
    businessName: async (clientId) => (must(await db.from("clients").select("name").eq("id", clientId).single(), "client lookup")?.name as string | undefined) ?? "your business",
  };
  return deps;
}

/** Checkout, portal and cancel, wired to the real database and Stripe. */
export function checkoutDeps(): CheckoutDeps {
  const db = supabaseAdmin();
  const bd = billingDeps();
  const appUrl = process.env.APP_URL;
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!appUrl || !priceId) throw new Error("APP_URL and STRIPE_PRICE_ID must be set");
  return {
    stripe: bd.stripe,
    now: bd.now,
    appUrl,
    priceId,
    getRow: async (clientId) => {
      const { data } = await db.from("subscriptions")
        .select("status, stripe_customer_id, stripe_subscription_id, checkout_session_id, checkout_created_at, cancel_at_period_end").eq("client_id", clientId).maybeSingle();
      return (data as never) ?? null;
    },
    recordCheckout: async (clientId, customerId, sessionId) => {
      const { error } = await db.rpc("record_checkout", { p_client_id: clientId, p_customer_id: customerId, p_session_id: sessionId });
      if (error) throw new Error(`record_checkout failed: ${error.message}`);
    },
    sync: async (clientId, subscriptionId, snapshot) => {
      const r = await syncSubscription(clientId, subscriptionId, bd, { snapshot });
      return r?.result.status ?? null;
    },
    emailOnce: async (clientId, key, email) => {
      if (!(await bd.claimEmail(clientId, key))) return;
      try { await bd.sendBillingEmail(clientId, email); } catch { await bd.releaseEmail(clientId, key); }
    },
  };
}

export { startCheckout };

/** After Stripe sends the customer back from Checkout: read the session and subscription FROM STRIPE and apply them.
 *  The "?checkout=success" in the URL proves nothing and grants nothing; this only speeds up what the webhook would do. */
export async function syncAfterCheckout(clientId: string): Promise<void> {
  const db = supabaseAdmin();
  const { data: row } = await db.from("subscriptions").select("checkout_session_id, stripe_subscription_id").eq("client_id", clientId).maybeSingle();
  const deps = billingDeps();
  try {
    let subscriptionId = row?.stripe_subscription_id ?? null;
    if (!subscriptionId && row?.checkout_session_id) {
      const session = await deps.stripe.retrieveCheckoutSession(row.checkout_session_id);
      subscriptionId = session.subscription;
    }
    if (subscriptionId) await syncSubscription(clientId, subscriptionId, deps);
  } catch (e) {
    console.warn("post-checkout sync skipped", e instanceof Error ? e.message : "error"); // the webhook will catch up
  }
}
