import { createHmac, timingSafeEqual } from "node:crypto";

// A small Stripe client over Stripe's REST API (no SDK dependency), plus webhook signature verification and
// tolerant readers for subscription and invoice objects. The secret key only ever lives on the server.
// Nothing in here logs a key, a secret, or a card detail.

export const STRIPE_API = "https://api.stripe.com/v1";
/** Pinned so responses keep one shape. Webhook payload versions can differ, so events are always re-read from the API. */
export const STRIPE_VERSION = "2024-06-20";

type Json = Record<string, unknown>;

/** Stripe wants form encoding with bracketed keys: line_items[0][price]=price_123, metadata[client_id]=abc. */
export function encodeForm(obj: Json, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === "object") parts.push(encodeForm(item as Json, `${key}[${i}]`));
        else parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === "object") parts.push(encodeForm(v as Json, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.filter(Boolean).join("&");
}

export class StripeError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

export type StripeClient = {
  createCustomer(input: { email?: string | null; name?: string | null; clientId: string }): Promise<{ id: string }>;
  createCheckoutSession(input: { customerId: string; priceId: string; clientId: string; successUrl: string; cancelUrl: string; idempotencyKey: string }): Promise<{ id: string; url: string | null }>;
  retrieveCheckoutSession(id: string): Promise<{ id: string; status: string; url: string | null; subscription: string | null; payment_status?: string }>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  retrieveSubscription(id: string): Promise<Json>;
  setCancelAtPeriodEnd(id: string, cancel: boolean): Promise<Json>;
};

export function stripeClient(secret: string | undefined = process.env.STRIPE_SECRET_KEY, doFetch: typeof fetch = fetch): StripeClient {
  if (!secret) throw new Error("STRIPE_SECRET_KEY is not set");

  async function call<T>(method: "GET" | "POST", path: string, body?: Json, idempotencyKey?: string): Promise<T> {
    const res = await doFetch(`${STRIPE_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        "stripe-version": STRIPE_VERSION,
        ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: body ? encodeForm(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: Json = {};
    try { json = JSON.parse(text) as Json; } catch { /* not JSON */ }
    if (!res.ok) {
      const err = (json.error ?? {}) as { message?: string; code?: string };
      throw new StripeError(err.message ?? `Stripe returned ${res.status}`, res.status, err.code); // message only: never the request body
    }
    return json as T;
  }

  return {
    createCustomer: ({ email, name, clientId }) =>
      call("POST", "/customers", { email: email ?? undefined, name: name ?? undefined, metadata: { client_id: clientId } }),
    createCheckoutSession: ({ customerId, priceId, clientId, successUrl, cancelUrl, idempotencyKey }) =>
      call("POST", "/checkout/sessions", {
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: clientId,
        metadata: { client_id: clientId },
        subscription_data: { metadata: { client_id: clientId } },
        success_url: successUrl,
        cancel_url: cancelUrl,
      }, idempotencyKey),
    retrieveCheckoutSession: (id) => call("GET", `/checkout/sessions/${encodeURIComponent(id)}`),
    createPortalSession: ({ customerId, returnUrl }) =>
      call("POST", "/billing_portal/sessions", { customer: customerId, return_url: returnUrl }),
    retrieveSubscription: (id) => call("GET", `/subscriptions/${encodeURIComponent(id)}`),
    setCancelAtPeriodEnd: (id, cancel) => call("POST", `/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: cancel }),
  };
}

// ---------------------------------------------------------------- webhook signature
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Verifies "Stripe-Signature: t=...,v1=..." over the RAW body. Constant-time compare, 5 minute replay window. */
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string | undefined, nowSeconds = Math.floor(Date.now() / 1000), tolerance = SIGNATURE_TOLERANCE_SECONDS): boolean {
  if (!header || !secret) return false;
  let t: string | undefined;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") v1.push(v);
  }
  const ts = Number(t);
  if (!t || !Number.isFinite(ts) || v1.length === 0) return false;
  if (Math.abs(nowSeconds - ts) > tolerance) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return v1.some((sig) => {
    if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
    return timingSafeEqual(expected, Buffer.from(sig, "hex"));
  });
}

/** Test helper and local-dev helper: the header Stripe would send for this body. */
export function signStripePayload(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

// ---------------------------------------------------------------- tolerant readers (API versions move fields around)
export type StripeObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type SubscriptionSnapshot = {
  subscriptionId: string; customerId: string | null; priceId: string | null; status: string;
  periodStart: Date | null; periodEnd: Date | null; cancelAtPeriodEnd: boolean;
  cancelAt: Date | null; canceledAt: Date | null; endedAt: Date | null; clientId: string | null;
};

const toDate = (sec: unknown) => (typeof sec === "number" && Number.isFinite(sec) ? new Date(sec * 1000) : null);
const idOf = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as StripeObj).id === "string" ? (v as StripeObj).id : null);

export function snapshotFromSubscription(sub: StripeObj): SubscriptionSnapshot {
  const item = sub.items?.data?.[0];
  return {
    subscriptionId: String(sub.id),
    customerId: idOf(sub.customer),
    priceId: item?.price?.id ?? sub.plan?.id ?? null,
    status: String(sub.status),
    // Older API versions keep the period on the subscription; newer ones on its items.
    periodStart: toDate(sub.current_period_start ?? item?.current_period_start),
    periodEnd: toDate(sub.current_period_end ?? item?.current_period_end),
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    cancelAt: toDate(sub.cancel_at),
    canceledAt: toDate(sub.canceled_at),
    endedAt: toDate(sub.ended_at),
    clientId: typeof sub.metadata?.client_id === "string" ? sub.metadata.client_id : null,
  };
}

/** The subscription an invoice belongs to, in either API shape. */
export function invoiceSubscriptionId(inv: StripeObj): string | null {
  return idOf(inv.subscription) ?? idOf(inv.parent?.subscription_details?.subscription) ?? null;
}

export type InvoiceFields = {
  invoiceId: string; subscriptionId: string | null; customerId: string | null; status: string; billingReason: string | null;
  amountDue: number; amountPaid: number; currency: string; attemptCount: number; hostedUrl: string | null; pdf: string | null;
  periodStart: Date | null; periodEnd: Date | null; paidAt: Date | null;
};

export function invoiceFields(inv: StripeObj): InvoiceFields {
  const line = inv.lines?.data?.[0];
  return {
    invoiceId: String(inv.id), subscriptionId: invoiceSubscriptionId(inv), customerId: idOf(inv.customer),
    status: String(inv.status ?? "open"), billingReason: typeof inv.billing_reason === "string" ? inv.billing_reason : null,
    amountDue: Number(inv.amount_due ?? 0), amountPaid: Number(inv.amount_paid ?? 0), currency: String(inv.currency ?? "inr"),
    attemptCount: Number(inv.attempt_count ?? 0), hostedUrl: inv.hosted_invoice_url ?? null, pdf: inv.invoice_pdf ?? null,
    periodStart: toDate(line?.period?.start ?? inv.period_start), periodEnd: toDate(line?.period?.end ?? inv.period_end),
    paidAt: toDate(inv.status_transitions?.paid_at),
  };
}
