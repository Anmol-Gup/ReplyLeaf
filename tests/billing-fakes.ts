import type { BillingEmail } from "../lib/billing/emails";
import type { CheckoutDeps, SubRowLite } from "../lib/billing/checkout";
import { GRACE_MS } from "../lib/billing/access";
import type { ApplyResult, ReconcileDeps, StaleRow, StripeEvent } from "../lib/billing/service";
import { StripeError, type InvoiceFields, type StripeObj, type SubscriptionSnapshot } from "../lib/billing/stripe";

// In-memory stand-ins for Stripe and the database. The database rules mirror migration 0013 (and are tested against
// the real SQL in supabase/tests/billing_smoke.sql), so these tests exercise the actual service logic.

export type FakeRow = {
  clientId: string; customerId: string | null; subscriptionId: string | null; status: string;
  periodStart: Date | null; periodEnd: Date | null; cancelAtPeriodEnd: boolean; graceEndsAt: Date | null; syncedAt: Date | null;
  checkoutSessionId: string | null; checkoutCreatedAt: Date | null;
};

const unix = (d: Date) => Math.floor(d.getTime() / 1000);
export const day = (n: number, from = new Date("2026-11-14T10:00:00Z")) => new Date(from.getTime() + n * 86_400_000);

/** A Stripe subscription object as the API returns it. */
export function subObj(o: { id?: string; client?: string | null; customer?: string; status: string; start?: Date; end: Date; cancelAtPeriodEnd?: boolean; endedAt?: Date | null }): StripeObj {
  return {
    id: o.id ?? "sub_1", customer: o.customer ?? "cus_1", status: o.status,
    current_period_start: unix(o.start ?? day(-30, o.end)), current_period_end: unix(o.end),
    cancel_at_period_end: o.cancelAtPeriodEnd ?? false, cancel_at: null, canceled_at: null, ended_at: o.endedAt ? unix(o.endedAt) : null,
    items: { data: [{ price: { id: "price_1" } }] },
    metadata: o.client === null ? {} : { client_id: o.client ?? "c1" },
  };
}

export function invObj(o: { id: string; sub?: string | null; customer?: string; status: string; reason?: string; paid?: number; due?: number; attempt?: number; newShape?: boolean }): StripeObj {
  const base: StripeObj = {
    id: o.id, customer: o.customer ?? "cus_1", status: o.status, billing_reason: o.reason ?? "subscription_cycle",
    amount_due: o.due ?? 99900, amount_paid: o.paid ?? 0, currency: "inr", attempt_count: o.attempt ?? 1,
    hosted_invoice_url: `https://invoice.stripe.com/i/${o.id}`, invoice_pdf: `https://pay.stripe.com/${o.id}/pdf`,
    lines: { data: [{ period: { start: 1_700_000_000, end: 1_702_592_000 } }] }, status_transitions: { paid_at: o.status === "paid" ? 1_700_000_100 : null },
  };
  const sub = o.sub === undefined ? "sub_1" : o.sub;
  if (o.newShape) base.parent = { subscription_details: { subscription: sub } };  // newer API versions
  else base.subscription = sub;
  return base;
}

export const evt = (id: string, type: string, object: StripeObj, created = unix(new Date("2026-11-14T10:00:00Z"))): StripeEvent => ({ id, type, created, data: { object } });

export class FakeBilling implements ReconcileDeps, CheckoutDeps {
  current = new Date("2026-11-14T10:00:00Z");
  clients = new Set(["c1", "c2"]);
  rows = new Map<string, FakeRow>();
  invoices = new Map<string, { status: string; eventCreated: number; amountPaid: number }>();
  events = new Map<string, "processing" | "processed" | "failed" | "ignored">();
  emailKeys = new Set<string>();
  sent: BillingEmail[] = [];
  audits: { clientId: string; event: string; detail: Record<string, unknown> }[] = [];
  stripeSubs = new Map<string, StripeObj>();            // what Stripe currently says
  sessions = new Map<string, { id: string; status: string; url: string | null; subscription: string | null }>();
  retrieveCalls = 0;
  failRetrieve: StripeError | Error | null = null;
  failSend = false;
  renewalEmails = false;
  customersCreated = 0;
  checkoutsCreated = 0;
  cancelCalls: string[] = [];
  appUrl = "https://app.example.com";
  priceId = "price_1";

  now = () => this.current;

  stripe = {
    retrieveSubscription: async (id: string) => {
      this.retrieveCalls++;
      if (this.failRetrieve) throw this.failRetrieve;
      const s = this.stripeSubs.get(id);
      if (!s) throw new StripeError("No such subscription", 404, "resource_missing");
      return structuredClone(s);
    },
    createCustomer: async () => { this.customersCreated++; return { id: `cus_${this.customersCreated}` }; },
    createCheckoutSession: async () => { this.checkoutsCreated++; const id = `cs_${this.checkoutsCreated}`; const s = { id, status: "open", url: `https://checkout.stripe.com/${id}`, subscription: null }; this.sessions.set(id, s); return { id, url: s.url }; },
    retrieveCheckoutSession: async (id: string) => { const s = this.sessions.get(id); if (!s) throw new StripeError("No such session", 404); return { ...s }; },
    createPortalSession: async () => ({ url: "https://billing.stripe.com/p/session" }),
    setCancelAtPeriodEnd: async (id: string, cancel: boolean) => {
      this.cancelCalls.push(id);
      const s = this.stripeSubs.get(id)!;
      s.cancel_at_period_end = cancel;
      return structuredClone(s);
    },
  };

  row(clientId: string): FakeRow {
    let r = this.rows.get(clientId);
    if (!r) { r = { clientId, customerId: null, subscriptionId: null, status: "none", periodStart: null, periodEnd: null, cancelAtPeriodEnd: false, graceEndsAt: null, syncedAt: null, checkoutSessionId: null, checkoutCreatedAt: null }; this.rows.set(clientId, r); }
    return r;
  }

  // ---- BillingDeps
  claimEvent = async (id: string) => {
    const st = this.events.get(id);
    if (!st) { this.events.set(id, "processing"); return "new" as const; }
    if (st === "processed" || st === "ignored" || st === "processing") return "duplicate" as const;
    this.events.set(id, "processing");
    return "retry" as const;
  };
  finishEvent = async (id: string, status: "processed" | "ignored" | "failed") => { this.events.set(id, status); };
  clientExists = async (id: string) => this.clients.has(id);
  clientIdForCustomer = async (customerId: string) => [...this.rows.values()].find((r) => r.customerId === customerId)?.clientId ?? null;
  storedCustomerId = async (clientId: string) => this.rows.get(clientId)?.customerId ?? null;

  applySnapshot = async (clientId: string, s: SubscriptionSnapshot, observedAt: Date, graceStart: Date | null): Promise<ApplyResult> => {
    const r = this.row(clientId);
    const prev = r.status;
    const live = ["active", "trialing", "past_due", "incomplete"];
    if (r.syncedAt && observedAt < r.syncedAt) return { applied: false, reason: "stale", prevStatus: prev, status: r.status, graceEndsAt: r.graceEndsAt };
    if (r.subscriptionId && r.subscriptionId !== s.subscriptionId) {
      if (live.includes(r.status) && !live.includes(s.status)) return { applied: false, reason: "older_subscription", prevStatus: prev, status: r.status, graceEndsAt: r.graceEndsAt };
      if (live.includes(r.status) && live.includes(s.status)) return { applied: false, reason: "duplicate_subscription", prevStatus: prev, status: r.status, graceEndsAt: r.graceEndsAt };
    }
    if (s.status === "past_due") r.graceEndsAt = r.graceEndsAt ?? new Date((graceStart ?? observedAt).getTime() + GRACE_MS);
    else if (s.status === "active" || s.status === "trialing") r.graceEndsAt = null;
    Object.assign(r, { customerId: s.customerId ?? r.customerId, subscriptionId: s.subscriptionId, status: s.status, periodStart: s.periodStart, periodEnd: s.periodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd, syncedAt: observedAt });
    return { applied: true, reason: "applied", prevStatus: prev, status: s.status, graceEndsAt: r.graceEndsAt };
  };

  upsertInvoice = async (_c: string, i: InvoiceFields, eventCreated: number) => {
    const old = this.invoices.get(i.invoiceId);
    if (old && old.eventCreated > eventCreated) return;
    this.invoices.set(i.invoiceId, { status: i.status, eventCreated, amountPaid: i.amountPaid });
  };
  claimEmail = async (clientId: string, key: string) => { const k = `${clientId}|${key}`; if (this.emailKeys.has(k)) return false; this.emailKeys.add(k); return true; };
  releaseEmail = async (clientId: string, key: string) => { this.emailKeys.delete(`${clientId}|${key}`); };
  sendBillingEmail = async (_c: string, email: BillingEmail) => { if (this.failSend) throw new Error("smtp down"); this.sent.push(email); };
  audit = async (clientId: string, event: string, detail: Record<string, unknown>) => { this.audits.push({ clientId, event, detail }); };

  // ---- ReconcileDeps
  listStale = async (): Promise<StaleRow[]> => [...this.rows.values()].filter((r) => r.subscriptionId && !["canceled", "incomplete_expired", "none"].includes(r.status)).map((r) => ({
    client_id: r.clientId, stripe_subscription_id: r.subscriptionId!, status: r.status as StaleRow["status"],
    current_period_end: r.periodEnd?.toISOString() ?? null, cancel_at_period_end: r.cancelAtPeriodEnd, grace_ends_at: r.graceEndsAt?.toISOString() ?? null,
  }));
  businessName = async () => "Biz";

  // ---- CheckoutDeps
  getRow = async (clientId: string): Promise<SubRowLite> => {
    const r = this.rows.get(clientId);
    return r ? { status: r.status as never, stripe_customer_id: r.customerId, stripe_subscription_id: r.subscriptionId, checkout_session_id: r.checkoutSessionId, checkout_created_at: r.checkoutCreatedAt?.toISOString() ?? null, cancel_at_period_end: r.cancelAtPeriodEnd } : null;
  };
  recordCheckout = async (clientId: string, customerId: string | null, sessionId: string | null) => {
    const r = this.row(clientId);
    r.customerId = customerId ?? r.customerId;
    if (sessionId) { r.checkoutSessionId = sessionId; r.checkoutCreatedAt = this.current; }
  };
  sync = async (clientId: string, subscriptionId: string, snapshot?: SubscriptionSnapshot) => {
    const { snapshotFromSubscription } = await import("../lib/billing/stripe");
    const snap = snapshot ?? snapshotFromSubscription(await this.stripe.retrieveSubscription(subscriptionId));
    return (await this.applySnapshot(clientId, snap, this.current, null)).status;
  };
  emailOnce = async (clientId: string, key: string, email: BillingEmail) => { if (await this.claimEmail(clientId, key)) this.sent.push(email); };
}
