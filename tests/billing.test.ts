import { test } from "node:test";
import assert from "node:assert/strict";
import { billingEnforced, computeAccess, daysLeft, GRACE_MS, RENEWAL_SLACK_MS, type SubscriptionRow } from "../lib/billing/access";
import { billingEmailMessage, formatMoney } from "../lib/billing/emails";
import { cancelAtPeriodEnd, openPortal, startCheckout } from "../lib/billing/checkout";
import { checkPost, sameOrigin } from "../lib/billing/http";
import { handleStripeEvent, reconcileSubscriptions } from "../lib/billing/service";
import { encodeForm, invoiceSubscriptionId, signStripePayload, snapshotFromSubscription, StripeError, verifyStripeSignature } from "../lib/billing/stripe";
import { makeLimiter } from "../lib/rate-limit";
import { day, evt, FakeBilling, invObj, subObj } from "./billing-fakes";

const NOW = new Date("2026-11-14T10:00:00Z");
const row = (over: Partial<NonNullable<SubscriptionRow>> = {}): SubscriptionRow => ({ status: "active", current_period_end: day(30).toISOString(), cancel_at_period_end: false, grace_ends_at: null, ...over });
const access = (sub: SubscriptionRow, now = NOW, o: { exempt?: boolean; enforced?: boolean } = {}) => computeAccess(sub, { exempt: o.exempt ?? false, enforced: o.enforced ?? true, now });

// =============================================================== access rules (the table in the brief)
test("access: active and within the paid period = full access", () => {
  const a = access(row());
  assert.deepEqual([a.allowed, a.reason, a.banner], [true, "active", "none"]);
});

test("access: past due, inside the 7-day grace = full access with a warning; the grace end is exact", () => {
  const sub = row({ status: "past_due", grace_ends_at: new Date(NOW.getTime() + 6 * 86_400_000).toISOString() });
  const a = access(sub);
  assert.deepEqual([a.allowed, a.reason, a.banner], [true, "grace", "past_due_grace"]);
  assert.equal(daysLeft(a.graceEndsAt, NOW), 6);
  assert.equal(access(sub, new Date(NOW.getTime() + 6 * 86_400_000 - 1)).allowed, true);   // one ms before
  assert.equal(access(sub, new Date(NOW.getTime() + 6 * 86_400_000)).allowed, false);      // at the end: restricted
});

test("access: past due with the grace period over (or never set) = restricted", () => {
  const over = access(row({ status: "past_due", grace_ends_at: new Date(NOW.getTime() - 1000).toISOString() }));
  assert.deepEqual([over.allowed, over.reason, over.banner], [false, "grace_expired", "inactive"]);
  assert.equal(access(row({ status: "past_due", grace_ends_at: null })).allowed, false);
});

test("access: cancelled but the paid period has not ended = full access until it ends; then restricted", () => {
  const sub = row({ cancel_at_period_end: true, current_period_end: day(10).toISOString() });
  const a = access(sub);
  assert.deepEqual([a.allowed, a.reason, a.banner], [true, "canceled_paid_through", "cancel_scheduled"]);
  assert.equal(access(sub, day(10)).allowed, true);                                  // the last moment
  assert.equal(access(sub, new Date(day(10).getTime() + 1)).allowed, false);         // no slack once it is cancelled
});

test("access: cancelled and ended, unpaid, incomplete, expired checkout, paused and no subscription = restricted", () => {
  for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused", "none"] as const) {
    const a = access(row({ status }));
    assert.equal(a.allowed, false, status);
    assert.equal(a.banner, "inactive", status);
  }
  assert.equal(access(null).allowed, false);
  assert.equal(access(null).reason, "none");
});

test("access: a plain active subscription gets a short renewal slack; past that, only Stripe's confirmation keeps it", () => {
  const sub = row({ current_period_end: NOW.toISOString() });
  assert.equal(access(sub, new Date(NOW.getTime() + RENEWAL_SLACK_MS - 1)).allowed, true);
  assert.equal(access(sub, new Date(NOW.getTime() + RENEWAL_SLACK_MS + 1)).allowed, false);
  assert.equal(access(row({ current_period_end: null })).allowed, false); // never a confirmed paid period
});

test("access: exempt businesses and installations without Stripe keep working; billing is enforced only when configured", () => {
  assert.deepEqual([access(null, NOW, { exempt: true }).allowed, access(null, NOW, { exempt: true }).reason], [true, "exempt"]);
  assert.deepEqual([access(null, NOW, { enforced: false }).allowed, access(null, NOW, { enforced: false }).reason], [true, "billing_off"]);
  assert.equal(billingEnforced({}), false);
  assert.equal(billingEnforced({ STRIPE_SECRET_KEY: "sk_test_x" }), false);                       // the price is needed too
  assert.equal(billingEnforced({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ID: "price_1" }), true);
  assert.equal(GRACE_MS, 7 * 86_400_000);
});

// =============================================================== webhook signature
const SECRET = "whsec_test_secret";
test("signature: a correctly signed body passes; wrong secret, changed body, old timestamp and junk headers fail", () => {
  const body = '{"id":"evt_1"}';
  const ts = 1_800_000_000;
  const header = signStripePayload(body, SECRET, ts);
  assert.equal(verifyStripeSignature(body, header, SECRET, ts + 10), true);
  assert.equal(verifyStripeSignature(body, header, "whsec_other", ts + 10), false);       // invalid signature
  assert.equal(verifyStripeSignature(body + " ", header, SECRET, ts + 10), false);        // body re-serialised or tampered
  assert.equal(verifyStripeSignature(body, header, SECRET, ts + 301), false);             // replay outside the 5 minute window
  assert.equal(verifyStripeSignature(body, header, SECRET, ts - 301), false);
  assert.equal(verifyStripeSignature(body, null, SECRET, ts), false);
  assert.equal(verifyStripeSignature(body, "garbage", SECRET, ts), false);
  assert.equal(verifyStripeSignature(body, `t=${ts},v1=${"0".repeat(64)}`, SECRET, ts), false);
  assert.equal(verifyStripeSignature(body, `t=${ts},v1=zz`, SECRET, ts), false);
  assert.equal(verifyStripeSignature(body, header, undefined, ts), false);                // no secret configured: reject everything
  assert.equal(verifyStripeSignature(body, `${header},v1=${"1".repeat(64)}`, SECRET, ts + 1), true); // a second (rotated) signature is fine
});

test("stripe client helpers: nested form encoding, tolerant readers for both API shapes", () => {
  assert.equal(
    decodeURIComponent(encodeForm({ mode: "subscription", line_items: [{ price: "price_1", quantity: 1 }], metadata: { client_id: "c1" }, subscription_data: { metadata: { client_id: "c1" } } })),
    "mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=1&metadata[client_id]=c1&subscription_data[metadata][client_id]=c1");
  assert.equal(invoiceSubscriptionId(invObj({ id: "in_1", status: "paid" })), "sub_1");
  assert.equal(invoiceSubscriptionId(invObj({ id: "in_1", status: "paid", newShape: true })), "sub_1");
  assert.equal(invoiceSubscriptionId(invObj({ id: "in_1", status: "paid", sub: null })), null);
  const oldShape = snapshotFromSubscription(subObj({ status: "active", end: day(30) }));
  const newShape = snapshotFromSubscription({ id: "sub_1", customer: { id: "cus_1" }, status: "active", items: { data: [{ price: { id: "price_1" }, current_period_start: 1, current_period_end: 2000 }] }, metadata: { client_id: "c1" } });
  assert.equal(oldShape.priceId, "price_1");
  assert.equal(newShape.periodEnd?.getTime(), 2_000_000);
  assert.equal(newShape.customerId, "cus_1");
});

// =============================================================== scenarios 1-3: subscribe, duplicate checkout, renewal
function subscribed(f: FakeBilling) {
  f.row("c1").customerId = "cus_1";
  f.stripeSubs.set("sub_1", subObj({ status: "active", end: day(30) }));
}

test("1. a new customer subscribes and pays: access only after Stripe confirms, one welcome email", async () => {
  const f = new FakeBilling();
  f.row("c1").customerId = "cus_1"; // created at checkout
  // The checkout completes, but Stripe says the payment has not succeeded yet (3-D Secure / mandate pending).
  f.stripeSubs.set("sub_1", subObj({ status: "incomplete", end: day(30) }));
  await handleStripeEvent(evt("evt_co", "checkout.session.completed", { mode: "subscription", client_reference_id: "c1", subscription: "sub_1", payment_status: "unpaid", metadata: { client_id: "c1" } }), f);
  assert.equal(f.row("c1").status, "incomplete");
  assert.equal(access(f.row("c1") as never).allowed, false, "a completed checkout alone grants nothing");
  // The payment succeeds.
  f.stripeSubs.set("sub_1", subObj({ status: "active", end: day(30) }));
  f.current = day(0.001);
  await handleStripeEvent(evt("evt_paid", "invoice.paid", invObj({ id: "in_1", status: "paid", paid: 99900, reason: "subscription_create" })), f);
  assert.equal(f.row("c1").status, "active");
  assert.equal(computeAccess({ status: "active", current_period_end: f.row("c1").periodEnd, cancel_at_period_end: false, grace_ends_at: null }, { exempt: false, enforced: true, now: f.current }).allowed, true);
  assert.deepEqual(f.sent.map((e) => e.kind), ["subscribed"]);
  assert.equal(f.invoices.get("in_1")?.status, "paid");
});

test("2. an active customer tries to subscribe again: no second subscription, no new session", async () => {
  const f = new FakeBilling();
  subscribed(f);
  f.row("c1").status = "active"; f.row("c1").subscriptionId = "sub_1";
  const r = await startCheckout({ clientId: "c1", email: "o@x.com", businessName: "Biz" }, f);
  assert.deepEqual(r, { kind: "already_subscribed" });
  assert.equal(f.checkoutsCreated, 0);
  f.row("c1").status = "past_due";
  assert.deepEqual(await startCheckout({ clientId: "c1", email: "o@x.com", businessName: "Biz" }, f), { kind: "already_subscribed" });
});

test("checkout: a new customer gets a Stripe customer once and a session; a pending open session is reused, not duplicated", async () => {
  const f = new FakeBilling();
  const first = await startCheckout({ clientId: "c1", email: "o@x.com", businessName: "Biz" }, f);
  assert.equal(first.kind, "url");
  assert.equal(f.customersCreated, 1);
  assert.equal(f.checkoutsCreated, 1);
  const second = await startCheckout({ clientId: "c1", email: "o@x.com", businessName: "Biz" }, f);
  assert.deepEqual(second, first);                       // same open session
  assert.equal(f.checkoutsCreated, 1);
  assert.equal(f.customersCreated, 1);
  // The session expires: a fresh one is created, with the SAME customer.
  f.sessions.get("cs_1")!.status = "expired";
  await startCheckout({ clientId: "c1", email: "o@x.com", businessName: "Biz" }, f);
  assert.equal(f.checkoutsCreated, 2);
  assert.equal(f.customersCreated, 1);
});

test("checkout: a session that already completed (webhook not here yet) syncs from Stripe instead of creating another", async () => {
  const f = new FakeBilling();
  await startCheckout({ clientId: "c1", email: "o@x.com", businessName: "Biz" }, f);
  f.sessions.set("cs_1", { id: "cs_1", status: "complete", url: null, subscription: "sub_1" });
  f.stripeSubs.set("sub_1", subObj({ status: "active", end: day(30) }));
  const r = await startCheckout({ clientId: "c1", email: "o@x.com", businessName: "Biz" }, f);
  assert.deepEqual(r, { kind: "already_subscribed" });
  assert.equal(f.checkoutsCreated, 1);
  assert.equal(f.row("c1").status, "active");
});

test("checkout is bound to the metadata tenant and uses no tenant input from a request: the portal needs an existing customer", async () => {
  const f = new FakeBilling();
  assert.equal(await openPortal("c1", f), null);       // nothing to manage yet
  f.row("c1").customerId = "cus_1";
  assert.deepEqual(await openPortal("c1", f), { url: "https://billing.stripe.com/p/session" });
  assert.equal(startCheckout.length, 2);               // (input, deps): the input is { clientId, email, businessName } resolved by the server
});

test("3. a monthly renewal succeeds: invoice stored, period moved on, still active, no email unless renewal emails are on", async () => {
  const f = new FakeBilling();
  subscribed(f);
  await handleStripeEvent(evt("evt_a", "invoice.paid", invObj({ id: "in_1", status: "paid", paid: 99900, reason: "subscription_create" })), f);
  f.sent.length = 0;
  f.current = day(30);
  f.stripeSubs.set("sub_1", subObj({ status: "active", end: day(60) }));
  await handleStripeEvent(evt("evt_b", "invoice.paid", invObj({ id: "in_2", status: "paid", paid: 99900, reason: "subscription_cycle" })), f);
  assert.equal(f.row("c1").status, "active");
  assert.equal(f.row("c1").periodEnd?.getTime(), day(60).getTime());
  assert.equal(f.invoices.size, 2);
  assert.equal(f.sent.length, 0);
  f.renewalEmails = true;
  f.current = day(60);
  f.stripeSubs.set("sub_1", subObj({ status: "active", end: day(90) }));
  await handleStripeEvent(evt("evt_c", "invoice.paid", invObj({ id: "in_3", status: "paid", paid: 99900, reason: "subscription_cycle" })), f);
  assert.deepEqual(f.sent.map((e) => e.kind), ["renewed"]);
});

// =============================================================== scenarios 4-7: failure, grace, expiry, recovery
async function renewalFails(f: FakeBilling) {
  subscribed(f);
  await handleStripeEvent(evt("evt_ok", "invoice.paid", invObj({ id: "in_1", status: "paid", paid: 99900, reason: "subscription_create" })), f);
  f.sent.length = 0;
  f.current = day(30);
  f.stripeSubs.set("sub_1", subObj({ status: "past_due", end: day(30) }));
  await handleStripeEvent(evt("evt_fail", "invoice.payment_failed", invObj({ id: "in_2", status: "open", attempt: 1 }), Math.floor(day(30).getTime() / 1000)), f);
}

test("4. a monthly renewal fails: past_due, a 7-day grace period from the failure, one failure email", async () => {
  const f = new FakeBilling();
  await renewalFails(f);
  assert.equal(f.row("c1").status, "past_due");
  assert.equal(f.row("c1").graceEndsAt?.getTime(), day(30).getTime() + GRACE_MS);
  assert.deepEqual(f.sent.map((e) => e.kind), ["payment_failed"]);
  assert.equal(f.invoices.get("in_2")?.status, "open");
});

test("5. the customer stays in the grace period: full access with a warning, and a retry does not extend the deadline", async () => {
  const f = new FakeBilling();
  await renewalFails(f);
  const deadline = f.row("c1").graceEndsAt!;
  f.current = day(33);
  await handleStripeEvent(evt("evt_fail2", "invoice.payment_failed", invObj({ id: "in_2", status: "open", attempt: 2 }), Math.floor(day(33).getTime() / 1000)), f);
  assert.equal(f.row("c1").graceEndsAt?.getTime(), deadline.getTime());
  assert.equal(f.sent.filter((e) => e.kind === "payment_failed").length, 1, "one email per invoice, not per retry");
  const a = computeAccess({ status: "past_due", current_period_end: f.row("c1").periodEnd, cancel_at_period_end: false, grace_ends_at: f.row("c1").graceEndsAt }, { exempt: false, enforced: true, now: day(33) });
  assert.deepEqual([a.allowed, a.banner], [true, "past_due_grace"]);
});

test("6. the grace period expires without payment: restricted at once, even with no webhook; the daily job sends the expiry email", async () => {
  const f = new FakeBilling();
  await renewalFails(f);
  const sub = () => ({ status: "past_due" as const, current_period_end: f.row("c1").periodEnd, cancel_at_period_end: false, grace_ends_at: f.row("c1").graceEndsAt });
  assert.equal(computeAccess(sub(), { exempt: false, enforced: true, now: day(36) }).allowed, true);
  assert.equal(computeAccess(sub(), { exempt: false, enforced: true, now: day(37.001) }).allowed, false); // no webhook needed
  f.sent.length = 0;
  f.current = day(37.5);
  const s = await reconcileSubscriptions(f);
  assert.equal(s.expiries, 1);
  assert.deepEqual(f.sent.map((e) => e.kind), ["expired"]);
  await reconcileSubscriptions(f);                       // running twice never emails twice
  assert.equal(f.sent.filter((e) => e.kind === "expired").length, 1);
});

test("the grace-period reminder goes out once, when 2 days or less are left", async () => {
  const f = new FakeBilling();
  await renewalFails(f);
  f.sent.length = 0;
  f.current = day(33);                                   // 4 days left: too early
  await reconcileSubscriptions(f);
  assert.equal(f.sent.length, 0);
  f.current = day(35.5);                                 // 1.5 days left
  await reconcileSubscriptions(f);
  await reconcileSubscriptions(f);
  assert.deepEqual(f.sent.map((e) => e.kind), ["grace_reminder"]);
});

test("7. the customer pays during the grace period: active again, the grace is cleared, one recovery email", async () => {
  const f = new FakeBilling();
  await renewalFails(f);
  f.sent.length = 0;
  f.current = day(33);
  f.stripeSubs.set("sub_1", subObj({ status: "active", end: day(60) }));
  await handleStripeEvent(evt("evt_rec", "invoice.paid", invObj({ id: "in_2", status: "paid", paid: 99900 }), Math.floor(day(33).getTime() / 1000)), f);
  assert.equal(f.row("c1").status, "active");
  assert.equal(f.row("c1").graceEndsAt, null);
  assert.deepEqual(f.sent.map((e) => e.kind), ["recovered"]);
  assert.equal(f.invoices.get("in_2")?.status, "paid");
});

test("payment recovery after the grace period has expired also restores access automatically", async () => {
  const f = new FakeBilling();
  await renewalFails(f);
  f.current = day(45);
  f.stripeSubs.set("sub_1", subObj({ status: "active", end: day(75) }));
  await handleStripeEvent(evt("evt_late", "invoice.paid", invObj({ id: "in_2", status: "paid", paid: 99900 }), Math.floor(day(45).getTime() / 1000)), f);
  const a = computeAccess({ status: "active", current_period_end: f.row("c1").periodEnd, cancel_at_period_end: false, grace_ends_at: f.row("c1").graceEndsAt }, { exempt: false, enforced: true, now: f.current });
  assert.equal(a.allowed, true);
});

test("a bank asks for extra confirmation: the invoice is stored and the owner gets ONE email with the link", async () => {
  const f = new FakeBilling();
  subscribed(f);
  const e = evt("evt_sca", "invoice.payment_action_required", invObj({ id: "in_5", status: "open" }));
  await handleStripeEvent(e, f);
  await handleStripeEvent({ ...e, id: "evt_sca2" }, f);
  assert.deepEqual(f.sent.map((x) => x.kind), ["payment_action_required"]);
  assert.match((f.sent[0] as { hostedUrl: string }).hostedUrl, /invoice\.stripe\.com/);
});

// =============================================================== scenarios 8-9: cancellation
test("8. cancel at period end: access continues until the paid-through date, then stops; one email", async () => {
  const f = new FakeBilling();
  subscribed(f);
  f.row("c1").status = "active"; f.row("c1").subscriptionId = "sub_1";
  const r = await cancelAtPeriodEnd("c1", f);
  assert.equal(r.kind, "scheduled");
  assert.equal(f.row("c1").cancelAtPeriodEnd, true);
  assert.equal(f.row("c1").status, "active");
  const sub = (): SubscriptionRow => ({ status: "active", current_period_end: f.row("c1").periodEnd, cancel_at_period_end: true, grace_ends_at: null });
  assert.equal(computeAccess(sub(), { exempt: false, enforced: true, now: day(29) }).allowed, true);
  assert.equal(computeAccess(sub(), { exempt: false, enforced: true, now: day(31) }).allowed, false);
  assert.equal(f.sent.filter((e) => e.kind === "canceled_scheduled").length, 1);
  // Stripe's own subscription.updated event for the same change does not email again.
  await handleStripeEvent(evt("evt_u", "customer.subscription.updated", subObj({ status: "active", end: day(30), cancelAtPeriodEnd: true })), f);
  assert.equal(f.sent.filter((e) => e.kind === "canceled_scheduled").length, 1);
  assert.deepEqual(await cancelAtPeriodEnd("c2", f), { kind: "nothing_to_cancel" });
});

test("9. cancel immediately (portal or Stripe): access ends at once, data untouched, one 'ended' email", async () => {
  const f = new FakeBilling();
  subscribed(f);
  await handleStripeEvent(evt("evt_ok", "invoice.paid", invObj({ id: "in_1", status: "paid", paid: 99900, reason: "subscription_create" })), f);
  f.sent.length = 0;
  f.current = day(10);
  f.stripeSubs.set("sub_1", subObj({ status: "canceled", end: day(30), endedAt: day(10) }));
  const e = evt("evt_del", "customer.subscription.deleted", subObj({ status: "canceled", end: day(30), endedAt: day(10) }));
  await handleStripeEvent(e, f);
  await handleStripeEvent(e, f);                         // duplicate delivery
  assert.equal(f.row("c1").status, "canceled");
  const a = computeAccess({ status: "canceled", current_period_end: f.row("c1").periodEnd, cancel_at_period_end: false, grace_ends_at: null }, { exempt: false, enforced: true, now: f.current });
  assert.equal(a.allowed, false);
  assert.deepEqual(f.sent.map((x) => x.kind), ["ended"]);
  assert.ok(f.invoices.has("in_1"), "billing history is kept");
  assert.ok(f.rows.has("c1"), "the subscription row is kept");
});

test("a deleted event for a subscription Stripe can no longer return still ends access (falls back to the event)", async () => {
  const f = new FakeBilling();
  subscribed(f);
  await handleStripeEvent(evt("evt_ok", "invoice.paid", invObj({ id: "in_1", status: "paid", paid: 99900, reason: "subscription_create" })), f);
  f.stripeSubs.delete("sub_1");
  await handleStripeEvent(evt("evt_del", "customer.subscription.deleted", subObj({ status: "canceled", end: day(30) })), f);
  assert.equal(f.row("c1").status, "canceled");
});

// =============================================================== scenarios 10-13: duplicates, out of order, missed webhook
test("10. a duplicate webhook has no second effect: no extra writes, no extra email", async () => {
  const f = new FakeBilling();
  subscribed(f);
  const e = evt("evt_dup", "invoice.paid", invObj({ id: "in_1", status: "paid", paid: 99900, reason: "subscription_create" }));
  assert.equal(await handleStripeEvent(e, f), "processed");
  const calls = f.retrieveCalls;
  assert.equal(await handleStripeEvent(e, f), "duplicate");
  assert.equal(f.retrieveCalls, calls, "a duplicate does not even call Stripe");
  assert.equal(f.sent.length, 1);
  assert.equal(f.invoices.size, 1);
});

test("a failed event is retried (Stripe redelivers) and the email is still sent exactly once", async () => {
  const f = new FakeBilling();
  subscribed(f);
  f.failRetrieve = new Error("Stripe is down");
  const e = evt("evt_retry", "invoice.paid", invObj({ id: "in_1", status: "paid", paid: 99900, reason: "subscription_create" }));
  await assert.rejects(() => handleStripeEvent(e, f), /Stripe is down/);       // the route answers 500, Stripe retries later
  assert.equal(f.events.get("evt_retry"), "failed");
  f.failRetrieve = null;
  assert.equal(await handleStripeEvent(e, f), "processed");
  assert.deepEqual(f.sent.map((x) => x.kind), ["subscribed"]);
});

test("a failing email send does not fail the event, and a later redelivery can still send it", async () => {
  const f = new FakeBilling();
  subscribed(f);
  f.failSend = true;
  const e = evt("evt_mail", "invoice.paid", invObj({ id: "in_1", status: "paid", paid: 99900, reason: "subscription_create" }));
  assert.equal(await handleStripeEvent(e, f), "processed");
  assert.equal(f.row("c1").status, "active");
  assert.equal(f.sent.length, 0);
  f.failSend = false;
  await handleStripeEvent(evt("evt_mail2", "invoice.paid", invObj({ id: "in_1", status: "paid", paid: 99900, reason: "subscription_create" })), f);
  assert.deepEqual(f.sent.map((x) => x.kind), ["subscribed"]);
});

test("12. events arrive out of order: the latest Stripe state wins, and an older invoice event cannot downgrade a paid invoice", async () => {
  const f = new FakeBilling();
  subscribed(f);
  // Stripe's real, current state is ACTIVE (the customer already paid).
  f.stripeSubs.set("sub_1", subObj({ status: "active", end: day(60) }));
  // The paid event is processed first ...
  await handleStripeEvent(evt("evt_2", "invoice.paid", invObj({ id: "in_2", status: "paid", paid: 99900 }), 2000), f);
  // ... then the OLDER "payment failed" event shows up late. It carries stale data, but we re-read Stripe.
  await handleStripeEvent(evt("evt_1", "invoice.payment_failed", invObj({ id: "in_2", status: "open" }), 1000), f);
  assert.equal(f.row("c1").status, "active", "the stale failure did not suspend a customer who has paid");
  assert.equal(f.invoices.get("in_2")?.status, "paid", "the older invoice event did not overwrite the paid one");
  // And an update event with stale embedded data is overridden by the fresh read.
  await handleStripeEvent(evt("evt_3", "customer.subscription.updated", subObj({ status: "past_due", end: day(30) }), 500), f);
  assert.equal(f.row("c1").status, "active");
});

test("an old subscription's late 'deleted' event cannot cancel the new live one", async () => {
  const f = new FakeBilling();
  subscribed(f);
  await handleStripeEvent(evt("evt_ok", "invoice.paid", invObj({ id: "in_1", status: "paid", paid: 99900, reason: "subscription_create" })), f);
  // Customer cancelled, then subscribed again: Stripe now has sub_2 live; sub_1 is ended.
  f.stripeSubs.set("sub_1", subObj({ id: "sub_1", status: "canceled", end: day(30) }));
  f.stripeSubs.set("sub_2", subObj({ id: "sub_2", status: "active", end: day(70) }));
  f.row("c1").status = "canceled";
  await handleStripeEvent(evt("evt_n", "customer.subscription.updated", subObj({ id: "sub_2", status: "active", end: day(70) })), f);
  assert.equal(f.row("c1").subscriptionId, "sub_2");
  await handleStripeEvent(evt("evt_late_del", "customer.subscription.deleted", subObj({ id: "sub_1", status: "canceled", end: day(30) })), f);
  assert.equal(f.row("c1").subscriptionId, "sub_2");
  assert.equal(f.row("c1").status, "active");
});

test("13. a webhook is missed: the daily reconciliation finds Stripe's state, fixes the row, audits it and emails once", async () => {
  const f = new FakeBilling();
  subscribed(f);
  await handleStripeEvent(evt("evt_ok", "invoice.paid", invObj({ id: "in_1", status: "paid", paid: 99900, reason: "subscription_create" })), f);
  f.sent.length = 0;
  // The renewal failed at Stripe, but the webhook never arrived: we still believe "active".
  f.current = day(31);
  f.stripeSubs.set("sub_1", subObj({ status: "past_due", end: day(30) }));
  assert.equal(f.row("c1").status, "active");
  const s = await reconcileSubscriptions(f);
  assert.equal(s.changed, 1);
  assert.equal(f.row("c1").status, "past_due");
  assert.ok(f.row("c1").graceEndsAt, "the grace period starts when we discover it");
  assert.ok(f.audits.some((a) => a.event === "reconcile_discrepancy"), "the discrepancy is logged");
  // Another missed webhook: the customer paid, and we missed the recovery.
  f.current = day(33);
  f.stripeSubs.set("sub_1", subObj({ status: "active", end: day(60) }));
  const s2 = await reconcileSubscriptions(f);
  assert.equal(s2.changed, 1);
  assert.equal(f.row("c1").status, "active");
  assert.equal(f.row("c1").graceEndsAt, null);
  assert.ok(f.sent.some((e) => e.kind === "recovered"));
});

test("reconciliation: a missing or failing Stripe lookup is counted, never fatal; ended subscriptions are not re-checked", async () => {
  const f = new FakeBilling();
  subscribed(f);
  await handleStripeEvent(evt("evt_ok", "invoice.paid", invObj({ id: "in_1", status: "paid", paid: 99900, reason: "subscription_create" })), f);
  f.failRetrieve = new Error("Stripe is down");
  assert.deepEqual(await reconcileSubscriptions(f), { checked: 1, changed: 0, failed: 1, reminders: 0, expiries: 0 });
  f.failRetrieve = null;
  f.row("c1").status = "canceled";
  assert.equal((await reconcileSubscriptions(f)).checked, 0);
});

// =============================================================== scenario 16: tenant isolation
test("16. a subscription whose Stripe metadata names another business is refused and audited", async () => {
  const f = new FakeBilling();
  f.row("c1").customerId = "cus_1";
  f.row("c2").customerId = "cus_2";
  // An event for c1's customer, but the subscription claims to belong to c2: nothing is applied to either.
  f.stripeSubs.set("sub_x", subObj({ id: "sub_x", client: "c2", customer: "cus_1", status: "active", end: day(30) }));
  await handleStripeEvent(evt("evt_x", "checkout.session.completed", { mode: "subscription", client_reference_id: "c1", subscription: "sub_x", metadata: { client_id: "c1" } }), f);
  assert.equal(f.row("c1").status, "none");
  assert.equal(f.row("c2").status, "none");
  assert.ok(f.audits.some((a) => a.event === "tenant_mismatch"));
  // A subscription with no metadata at all is not attributed to anyone.
  f.stripeSubs.set("sub_y", subObj({ id: "sub_y", client: null, customer: "cus_2", status: "active", end: day(30) }));
  await handleStripeEvent(evt("evt_y", "customer.subscription.updated", subObj({ id: "sub_y", client: null, customer: "cus_2", status: "active", end: day(30) })), f);
  assert.equal(f.row("c2").status, "none");
  // A customer id that belongs to a different business than the metadata says.
  f.stripeSubs.set("sub_z", subObj({ id: "sub_z", client: "c2", customer: "cus_1", status: "active", end: day(30) }));
  await handleStripeEvent(evt("evt_z", "customer.subscription.updated", subObj({ id: "sub_z", client: "c2", customer: "cus_1", status: "active", end: day(30) })), f);
  assert.equal(f.row("c2").status, "none");
});

test("unknown event types are recorded and acknowledged; events for unknown businesses are ignored", async () => {
  const f = new FakeBilling();
  assert.equal(await handleStripeEvent(evt("evt_u1", "charge.refunded", { id: "ch_1" }), f), "ignored");
  assert.equal(await handleStripeEvent(evt("evt_u2", "checkout.session.completed", { mode: "subscription", client_reference_id: "not-a-business", subscription: "sub_1", metadata: {} }), f), "ignored");
  assert.equal(await handleStripeEvent(evt("evt_u3", "checkout.session.completed", { mode: "payment", client_reference_id: "c1" }), f), "ignored");
  assert.equal(f.events.get("evt_u1"), "ignored");
});

// =============================================================== emails, endpoint guards, rate limiting
test("billing emails: clear amounts, dates and next steps; HTML and text; no card data", () => {
  assert.equal(formatMoney(99900, "inr"), "₹999.00");
  const o = { to: "o@x.com", businessName: "Biz", appUrl: "https://app.example.com" };
  const failed = billingEmailMessage({ kind: "payment_failed", graceEndsAt: new Date("2026-12-21T10:00:00Z"), hostedUrl: "https://invoice.stripe.com/i/in_2" }, o);
  assert.match(failed.subject, /payment failed/i);
  assert.match(failed.text, /2026-12-21/);
  assert.match(failed.text, /7 days/);
  assert.match(failed.text, /invoice\.stripe\.com/);
  assert.ok(failed.html?.includes("Pay now"));
  assert.match(billingEmailMessage({ kind: "expired" }, o).text, /Nothing has been deleted/);
  assert.match(billingEmailMessage({ kind: "recovered", periodEnd: null }, o).subject, /back on/);
  assert.match(billingEmailMessage({ kind: "subscribed", periodEnd: new Date("2026-12-14T00:00:00Z") }, o).text, /₹999 per month/);
  assert.match(billingEmailMessage({ kind: "grace_reminder", graceEndsAt: new Date("2026-12-21T00:00:00Z"), daysLeft: 1 }, o).subject, /1 day left/);
  assert.ok(!/\r|\n/.test(billingEmailMessage({ kind: "ended" }, { ...o, businessName: "Biz\nBcc: evil@x.com" }).subject), "a business name cannot add header lines");
});

test("billing endpoints: JSON only, same origin only, rate limited", () => {
  const post = (headers: Record<string, string>) => new Request("https://app.example.com/api/billing/checkout", { method: "POST", headers, body: "{}" });
  assert.equal(checkPost(post({ "content-type": "application/json", origin: "https://app.example.com" })), null);
  assert.equal(checkPost(post({ "content-type": "text/plain", origin: "https://app.example.com" }))?.status, 415);
  assert.equal(checkPost(post({ "content-type": "application/json", origin: "https://evil.example" }))?.status, 403);
  assert.equal(checkPost(post({ "content-type": "application/json", "sec-fetch-site": "cross-site" }))?.status, 403);
  assert.equal(checkPost(post({ "content-type": "application/json" })), null); // non-browser client with the session cookie: allowed
  assert.equal(sameOrigin(post({ origin: "not a url" })), false);
  const lim = makeLimiter(3, 1000);
  assert.deepEqual([1, 2, 3, 4].map((i) => lim.allow("c1", 100 + i)), [true, true, true, false]);
  assert.equal(lim.allow("c2", 105), true);          // another business is unaffected
  assert.equal(lim.allow("c1", 1200), true);         // the window moves on
});

test("the Stripe client never puts the secret key in an error", async () => {
  const { stripeClient } = await import("../lib/billing/stripe");
  const fetchFail = (async () => new Response(JSON.stringify({ error: { message: "No such price", code: "resource_missing" } }), { status: 400 })) as typeof fetch;
  const c = stripeClient("sk_test_SECRET123", fetchFail);
  await assert.rejects(() => c.retrieveSubscription("sub_1"), (e: unknown) => e instanceof StripeError && !String(e.message).includes("SECRET123") && e.status === 400);
  assert.throws(() => stripeClient(undefined), /not set/);
});
