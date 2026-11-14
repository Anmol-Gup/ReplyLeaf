import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigest, type DigestData, type DigestSwitches } from "../lib/digest";
import { runDailyDigest, type DigestBusiness, type DigestDeps } from "../lib/digest-job";
import { isDigestEvent, sendNow } from "../lib/notify-settings";
import type { OwnerEvent } from "../lib/email/templates";

const ALL: DigestSwitches = { leads: true, appointments: true, tickets: true, handoffs: true };
const empty = (over: Partial<DigestData> = {}): DigestData => ({
  businessName: "Biz", contacts: [], leads: [], appointments: [], tickets: [],
  waiting: { appointments: 0, tickets: 0, urgentTickets: 0, handoffs: 0, followUpsDue: 0 }, ...over,
});
const busy = empty({
  contacts: [{ name: "Asha", phone: "911" }, { name: null, phone: "922" }],
  leads: [{ projectType: "e-commerce website", customer: "Asha", status: "qualified" }],
  appointments: [{ purpose: "check-up", customer: "Ravi", when: "2026-01-09 10am" }],
  tickets: [{ subject: "Order not delivered", customer: "Asha", urgent: true }],
  waiting: { appointments: 2, tickets: 3, urgentTickets: 1, handoffs: 1, followUpsDue: 1 },
});

test("the summary lists what is new and what is waiting, in HTML and text, with a dashboard link", () => {
  const m = buildDigest(busy, ALL, { appUrl: "https://app.example.com/", sinceLabel: "the last 24 hours" })!;
  assert.equal(m.subject, "Your daily summary: 5 new items, some waiting for you");
  for (const part of ["New contacts (2)", "No name yet (+922)", "e-commerce website: Asha (qualified)", "check-up: Ravi, 2026-01-09 10am", "URGENT: Order not delivered: Asha",
    "2 appointment requests waiting", "3 open support tickets (1 urgent)", "1 chat waiting for a person", "1 lead follow-up due", "https://app.example.com/dashboard"]) {
    assert.ok(m.text.includes(part), `text: ${part}`);
  }
  assert.ok(m.html?.includes("Your daily summary") && m.html.includes("Open your dashboard"));
  assert.ok(/Settings > Email notifications/.test(m.text));
});

test("nothing new and nothing waiting: no email at all; waiting alone is worth one", () => {
  assert.equal(buildDigest(empty(), ALL, { sinceLabel: "x" }), null);
  const waitingOnly = buildDigest(empty({ waiting: { appointments: 1, tickets: 0, urgentTickets: 0, handoffs: 0, followUpsDue: 0 } }), ALL, { sinceLabel: "x" })!;
  assert.equal(waitingOnly.subject, "Your daily summary: items are waiting for you");
});

test("sections follow the notification switches", () => {
  const m = buildDigest(busy, { leads: false, appointments: true, tickets: false, handoffs: false }, { sinceLabel: "x" })!;
  assert.ok(m.text.includes("check-up") && !m.text.includes("e-commerce") && !m.text.includes("Order not delivered") && !m.text.includes("New contacts") && !m.text.includes("waiting for a person"));
  assert.equal(buildDigest(busy, { leads: false, appointments: false, tickets: false, handoffs: false }, { sinceLabel: "x" }), null);
});

test("long lists are capped and say how many more", () => {
  const many = empty({ leads: Array.from({ length: 12 }, (_, i) => ({ projectType: `P${i}`, customer: null, status: "new" })) });
  const m = buildDigest(many, ALL, { sinceLabel: "x" })!;
  assert.ok(m.text.includes("...and 4 more") && m.text.includes("New project enquiries (12)") && !m.text.includes("P11"));
});

test("which events are batched into the summary and which stay immediate", () => {
  const ev = (e: OwnerEvent) => e;
  for (const e of [
    ev({ type: "new_lead", contactName: null, phone: "1", firstMessage: "" }),
    ev({ type: "lead_created", contactName: null, phone: "1", projectType: "x", budget: null, timeline: null, summary: "", status: "new" }),
    ev({ type: "appointment_request", contactName: null, phone: "1", purpose: "x", preferredDate: null, preferredTime: null, appointmentType: null, notes: null }),
    ev({ type: "appointment_update", status: "confirmed", contactName: null, phone: "1", purpose: "x", when: null, note: null }),
    ev({ type: "ticket_created", contactName: null, phone: "1", subject: "x", category: null, referenceInfo: null, priority: "normal", summary: "" }),
  ]) {
    assert.equal(isDigestEvent(e), true, e.type);
    assert.equal(sendNow({ delivery: "daily" }, e), false, e.type);
    assert.equal(sendNow(null, e), false, `${e.type} (no settings row yet counts as daily)`);
    assert.equal(sendNow({ delivery: "immediate" }, e), true, e.type);
  }
  for (const e of [
    ev({ type: "needs_human", contactName: null, phone: "1", reason: "owner", lastMessage: "", summary: "" }),
    ev({ type: "ai_key_problem", problem: "missing" }),
    ev({ type: "onboarded", businessName: "x" }),
  ]) {
    assert.equal(isDigestEvent(e), false, e.type);
    assert.equal(sendNow({ delivery: "daily" }, e), true, `${e.type} stays immediate`);
  }
});

// ---------------------------------------------------------------- the job
function fakeDeps(businesses: DigestBusiness[], o: { data?: DigestData; paid?: string[]; sendFails?: boolean } = {}) {
  const log = { sent: [] as { to: string; subject: string }[], claimed: new Map<string, string>(), released: [] as string[], marked: [] as string[], gathered: [] as { id: string; since: Date }[] };
  const deps: DigestDeps = {
    now: () => new Date("2026-01-02T03:45:00Z"),
    appUrl: "https://app.example.com",
    listBusinesses: async () => businesses,
    paid: async (ids) => new Set(o.paid ?? ids),
    gather: async (id, name, since) => { log.gathered.push({ id, since }); return o.data ?? busy; },
    claimToday: async (id, today) => { if (log.claimed.get(id) === today) return false; log.claimed.set(id, today); return true; },
    releaseToday: async (id) => { log.released.push(id); log.claimed.delete(id); },
    markSent: async (id) => { log.marked.push(id); },
    send: async (m) => { if (o.sendFails) throw new Error("smtp down"); log.sent.push({ to: m.to, subject: m.subject }); },
  };
  return { deps, log };
}
const biz = (id: string, over: Partial<DigestBusiness> = {}): DigestBusiness => ({ clientId: id, name: `Biz ${id}`, recipients: [`${id}@x.com`], switches: ALL, delivery: "daily", lastDigestAt: null, ...over });

test("job: one summary per business, to every recipient; running it twice the same day sends nothing more", async () => {
  const f = fakeDeps([biz("a", { recipients: ["a@x.com", "boss@x.com"] }), biz("b")]);
  const s = await runDailyDigest(f.deps);
  assert.deepEqual(f.log.sent.map((m) => m.to).sort(), ["a@x.com", "b@x.com", "boss@x.com"]);
  assert.equal(s.sent, 2);
  const again = await runDailyDigest(f.deps);
  assert.equal(again.sent, 0);
  assert.equal(f.log.sent.length, 3);
});

test("job: businesses on 'immediate', without an active subscription, or with no address are skipped", async () => {
  const f = fakeDeps([biz("imm", { delivery: "immediate" }), biz("unpaid"), biz("noaddr", { recipients: [] }), biz("ok")], { paid: ["imm", "noaddr", "ok"] });
  const s = await runDailyDigest(f.deps);
  assert.deepEqual(f.log.sent.map((m) => m.to), ["ok@x.com"]);
  assert.equal(s.skippedImmediate, 1);
  assert.equal(s.skippedUnpaid, 1);
});

test("job: an empty day sends nothing but moves the window forward", async () => {
  const f = fakeDeps([biz("a")], { data: empty() });
  const s = await runDailyDigest(f.deps);
  assert.equal(s.empty, 1);
  assert.equal(f.log.sent.length, 0);
  assert.deepEqual(f.log.marked, ["a"]);
});

test("job: covers everything since the last summary, but never more than 24 hours back after a long gap", async () => {
  const now = new Date("2026-01-02T03:45:00Z").getTime();
  const f = fakeDeps([biz("recent", { lastDigestAt: new Date(now - 20 * 3600_000) }), biz("old", { lastDigestAt: new Date(now - 10 * 86_400_000) }), biz("never")]);
  await runDailyDigest(f.deps);
  const since = (id: string) => f.log.gathered.find((g) => g.id === id)!.since.getTime();
  assert.equal(since("recent"), now - 20 * 3600_000);
  assert.equal(since("old"), now - 86_400_000);
  assert.equal(since("never"), now - 86_400_000);
});

test("job: a send failure gives today's slot back (so the next run retries) and never stops the other businesses", async () => {
  const f = fakeDeps([biz("a"), biz("b")], { sendFails: true });
  const s = await runDailyDigest(f.deps);
  assert.equal(s.failed, 2);
  assert.deepEqual(f.log.released, ["a", "b"]);
  assert.equal(f.log.claimed.size, 0);
  assert.equal(f.log.marked.length, 0, "the window does not move when nothing was sent");
});
