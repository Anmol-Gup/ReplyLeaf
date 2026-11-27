import { test } from "node:test";
import assert from "node:assert/strict";
import { businessStatus, DEFAULT_WORKFLOW_SETTINGS, outOfHoursNote, renderClosedHours, renderWorkflowRules, workflowSettingsSchema } from "../lib/workflow-settings";
import { appointmentWindowIssue } from "../lib/workflow";
import { buildSystemPrompt, type PromptClient } from "../lib/ai/prompt";

// Business hours: decided by code in the business time zone, then told to the assistant. Contact details come from the knowledge base.
const settings = (appointments: object = {}, handoff: object = {}) => workflowSettingsSchema.parse({
  appointments: { workingDays: ["mon", "tue", "wed", "thu", "fri"], openTime: "09:00", closeTime: "17:00", timezone: "Asia/Kolkata", ...appointments },
  handoff: { availability: "", ...handoff },
});
const NOW = new Date("2026-01-02T12:00:00Z"); // a Friday
const KB = "Email: hello@biz.com\nWhatsApp: +91 98765 43210";

test("there is no separate contact setting any more: the contact details are read from the knowledge base", () => {
  assert.equal("business" in DEFAULT_WORKFLOW_SETTINGS, false);
  assert.equal("business" in workflowSettingsSchema.parse({ business: { contact: "x" } }), false); // an old saved value is simply ignored
});

test("businessStatus: open and closed in the business's own time zone (India is 5h30 ahead of UTC)", () => {
  const s = settings();
  assert.equal(businessStatus(new Date("2026-01-02T05:00:00Z"), s)?.open, true);   // Fri 10:30 IST
  assert.equal(businessStatus(new Date("2026-01-02T11:29:00Z"), s)?.open, true);   // Fri 16:59 IST
  assert.equal(businessStatus(new Date("2026-01-02T11:30:00Z"), s)?.open, false);  // Fri 17:00 IST: closing time itself is closed
  assert.equal(businessStatus(new Date("2026-01-02T03:29:00Z"), s)?.open, false);  // Fri 08:59 IST
  assert.equal(businessStatus(new Date("2026-01-02T03:30:00Z"), s)?.open, true);   // Fri 09:00 IST
  assert.equal(businessStatus(new Date("2026-01-03T06:00:00Z"), s)?.open, false);  // Sat 11:30 IST: not a working day
});

test("businessStatus says when the business is next available", () => {
  const s = settings();
  assert.equal(businessStatus(new Date("2026-01-02T02:00:00Z"), s)?.nextOpen, "today at 09:00");      // Fri 07:30 IST
  assert.equal(businessStatus(new Date("2026-01-01T15:30:00Z"), s)?.nextOpen, "tomorrow at 09:00");   // Thu 21:00 IST
  assert.equal(businessStatus(new Date("2026-01-02T12:00:00Z"), s)?.nextOpen, "Monday at 09:00");     // Fri 17:30 IST
  assert.equal(businessStatus(new Date("2026-01-03T06:00:00Z"), s)?.nextOpen, "Monday at 09:00");     // Sat
  assert.match(businessStatus(new Date("2026-01-03T06:00:00Z"), s)?.now ?? "", /^Saturday 11:30 \(Asia\/Kolkata\)$/);
});

test("businessStatus claims nothing without a time zone, and no ticked days means every day counts", () => {
  assert.equal(businessStatus(NOW, settings({ timezone: null })), null);
  assert.equal(businessStatus(new Date("2026-01-03T06:00:00Z"), settings({ workingDays: [] }))?.open, true); // Sat 11:30 IST
  assert.equal(businessStatus(new Date("2026-01-02T18:30:00Z"), settings())?.open, false); // Sat 00:00 IST (midnight must not crash)
});

test("while closed the assistant is told so, with the reopening time, and to share the contact details found in the knowledge base", () => {
  const s = settings();
  const closed = renderClosedHours(businessStatus(new Date("2026-01-03T06:00:00Z"), s));
  assert.match(closed, /CLOSED right now/); assert.match(closed, /Saturday 11:30/); assert.match(closed, /next available Monday at 09:00/);
  assert.match(closed, /contact details \(email, phone, WhatsApp\) from the business knowledge exactly as written/);
  assert.match(closed, /If the knowledge has none, say the team will reply/); assert.match(closed, /Never invent or change a phone number or email/);
  assert.match(closed, /answering questions from the business knowledge exactly as usual|Keep answering questions from the business knowledge exactly as usual/);
  assert.equal(renderClosedHours(businessStatus(new Date("2026-01-02T05:00:00Z"), s)), ""); // open
  assert.equal(renderClosedHours(null), "");                                                  // no time zone
});

test("the system prompt carries both the knowledge (with the contact lines) and the closed rule while closed, and only then", () => {
  const client = { name: "Biz", businessInfo: null, businessHours: null, bookingLink: null, kbText: KB, workflow: settings() } as unknown as PromptClient;
  const ctx = (now: Date) => ({ today: "2026-01-03", now, flowState: null, open: { appointments: [], tickets: 0, leads: 0 } });
  const closed = buildSystemPrompt(client, [], ctx(new Date("2026-01-03T06:00:00Z")));
  assert.match(closed, /CLOSED right now/); assert.match(closed, /hello@biz\.com/); assert.match(closed, /\+91 98765 43210/);
  assert.doesNotMatch(buildSystemPrompt(client, [], ctx(new Date("2026-01-02T05:00:00Z"))), /CLOSED right now/);
});

test("one set of hours: the human-handoff text quotes the business hours, not the older separate availability text", () => {
  const withTz = renderWorkflowRules(settings({}, { availability: "Mon - Sat, 9 AM - 6 PM" }), null, "2026-01-02");
  assert.match(withTz, /The team is available: Monday, Tuesday, Wednesday, Thursday, Friday, 09:00-17:00 \(Asia\/Kolkata time\)\. Use only these hours/);
  assert.doesNotMatch(withTz, /Mon - Sat, 9 AM - 6 PM/);
  const noTz = renderWorkflowRules(settings({ timezone: null }, { availability: "Mon - Sat, 9 AM - 6 PM" }), null, "2026-01-02");
  assert.match(noTz, /The team is available: Mon - Sat, 9 AM - 6 PM\./);
});

test("an appointment day or time you do not work: the rule shares the knowledge-base contact details, and the built-in message is unchanged", () => {
  assert.match(outOfHoursNote(), /contact details \(email, phone, WhatsApp\) from the business knowledge exactly as written/);
  assert.match(renderWorkflowRules(settings(), null, "2026-01-02"), /outside the working days or hours, say so politely/);
  const a = settings().appointments;
  const sat = appointmentWindowIssue({ preferredDate: "2026-01-10", preferredTime: "10am" }, a, NOW) ?? "";
  assert.match(sat, /Saturday/); assert.doesNotMatch(sat, /reach us/);
  assert.equal(appointmentWindowIssue({ preferredDate: "2026-01-09", preferredTime: "10am" }, a, NOW), null);
});

// ---- the notice a customer gets when they write to a chat that is waiting for a person while the business is closed
import { CLOSED_NOTICE_PREFIX, closedHandoffNotice, findContacts } from "../lib/workflow-settings";
import { notifyClosedWhilePaused, type BatchContext, type BatchDeps } from "../lib/batch";

test("findContacts reads emails and phone numbers from the knowledge exactly as written", () => {
  const c = findContacts(KB, null);
  assert.deepEqual(c.emails, ["hello@biz.com"]);
  assert.deepEqual(c.phones, ["+91 98765 43210"]);
  assert.deepEqual(findContacts("nothing here", null), { emails: [], phones: [] });
});

test("closedHandoffNotice: only while closed, with the next time and the contacts", () => {
  const closed = businessStatus(new Date("2026-01-02T18:00:00Z"), settings());
  const n = closedHandoffNotice(closed, findContacts(KB));
  assert.ok(n.startsWith(CLOSED_NOTICE_PREFIX));
  assert.match(n, /Monday at 09:00/);
  assert.match(n, /hello@biz\.com/);
  assert.match(n, /\+91 98765 43210/);
  assert.equal(closedHandoffNotice(businessStatus(new Date("2026-01-02T05:00:00Z"), settings()), findContacts(KB)), "");
  assert.equal(closedHandoffNotice(null, findContacts(KB)), "");
});

function paused(over: Partial<BatchContext> = {}, at = "2026-01-02T18:00:00Z") {
  const sent: string[] = [];
  const ctx = {
    client: { id: "c1", name: "Biz", waPhoneNumberId: "PN", aiProvider: "gemini", monthlyMessageCap: 100, businessInfo: null, businessHours: null, bookingLink: null, kbText: KB,
      workflow: settings(), ai: { mode: "platform", apiKey: null, keyStatus: "none" }, billing: { allowed: true, reason: "active", banner: "none", graceEndsAt: null, paidThrough: null } },
    conversation: { id: "v1", handling: "human_active", failedAnswerCount: 0, lastCustomerMessageAt: new Date(at), workflowState: null },
    open: { appointments: [], tickets: 0, leads: 0 }, contact: { id: "k", name: "A" }, phone: "91", pending: [], history: [], repliesThisMonth: 0, recentInboundCount: 1, ...over,
  } as unknown as BatchContext;
  const deps = { load: async () => ctx, sendText: async (_c: unknown, b: string) => { sent.push(b); return { waMessageId: "w" }; }, saveReply: async () => {} } as unknown as BatchDeps;
  return { ctx, deps, sent, at: new Date(at) };
}

test("a customer writing to a waiting chat while closed gets the notice once", async () => {
  const t = paused();
  await notifyClosedWhilePaused("v1", t.deps, t.at);
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0], /hello@biz\.com/);
  const again = paused({ closedNoticeSent: true });
  await notifyClosedWhilePaused("v1", again.deps, again.at);
  assert.equal(again.sent.length, 0);
});

test("no notice while open, when the assistant is handling the chat, or when the subscription is inactive", async () => {
  const open = paused({}, "2026-01-02T05:00:00Z");
  await notifyClosedWhilePaused("v1", open.deps, open.at);
  assert.equal(open.sent.length, 0);
  const bot = paused({ conversation: { id: "v1", handling: "bot", failedAnswerCount: 0, lastCustomerMessageAt: new Date("2026-01-02T18:00:00Z"), workflowState: null } });
  await notifyClosedWhilePaused("v1", bot.deps, bot.at);
  assert.equal(bot.sent.length, 0);
  const t = paused();
  t.ctx.client.billing = { allowed: false, reason: "none", banner: "none", graceEndsAt: null, paidThrough: null } as never;
  await notifyClosedWhilePaused("v1", t.deps, t.at);
  assert.equal(t.sent.length, 0);
});
