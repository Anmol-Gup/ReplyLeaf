import { test } from "node:test";
import assert from "node:assert/strict";
import { businessHours, businessStatus, DEFAULT_WORKFLOW_SETTINGS, outOfHoursNote, renderClosedHours, renderWorkflowRules, workflowSettingsSchema } from "../lib/workflow-settings";
import { appointmentWindowIssue } from "../lib/workflow";
import { buildSystemPrompt, type PromptClient } from "../lib/ai/prompt";

// Business hours: decided by code in the business time zone, then told to the assistant. Contact details come from the knowledge base.
const settings = (appointments: object = {}, handoff: object = {}) => workflowSettingsSchema.parse({
  appointments: { workingDays: ["mon", "tue", "wed", "thu", "fri"], openTime: "09:00", closeTime: "17:00", timezone: "Asia/Kolkata", ...appointments },
  handoff: { availability: "", ...handoff },
});
const NOW = new Date("2026-01-02T12:00:00Z"); // a Friday
const KB = "Email: hello@biz.com\nWhatsApp: +91 98765 43210";

test("there is no contact setting: only hours. Business hours follow the appointment hours until they are saved separately", () => {
  assert.equal("contact" in (DEFAULT_WORKFLOW_SETTINGS.business as object), false);
  assert.equal("contact" in (workflowSettingsSchema.parse({ business: { contact: "x" } }).business as object), false); // an old value is ignored
  const old = workflowSettingsSchema.parse({ appointments: { timezone: "Asia/Kolkata", openTime: "10:00", closeTime: "18:00", workingDays: ["mon"] } });
  assert.deepEqual(businessHours(old), { workingDays: ["mon"], openTime: "10:00", closeTime: "18:00", timezone: "Asia/Kolkata" });
});

test("business hours and appointment hours are independent: each only affects its own behaviour", () => {
  const s = workflowSettingsSchema.parse({
    appointments: { timezone: "Asia/Kolkata", openTime: "09:00", closeTime: "17:00", workingDays: ["mon", "tue", "wed", "thu", "fri"] },
    business: { timezone: "Asia/Kolkata", openTime: "12:00", closeTime: "14:00", workingDays: ["mon"] },
  });
  assert.equal(businessStatus(new Date("2026-01-02T05:00:00Z"), s)?.open, false); // Fri 10:30 IST: appointments allow it, the business is closed
  assert.equal(businessStatus(new Date("2026-01-05T07:00:00Z"), s)?.open, true);  // Mon 12:30 IST: business open
  const issue = appointmentWindowIssue({ preferredDate: "2026-01-09", preferredTime: "10am" }, s.appointments, NOW);
  assert.equal(issue, null); // Friday 10am is fine for appointments
  assert.match(renderWorkflowRules(s, null, "2026-01-02"), /Monday, 12:00-14:00/); // the handoff line uses the business hours
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
  assert.match(closed, /Answer every normal question .* from the business knowledge exactly as usual, and do NOT share contact details/);
  assert.match(closed, /ONLY when the customer asks to speak to, talk to, call or be connected with a person/); // contacts only for a request for a person
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

test("an appointment day or time you do not work: no contact details are shared, and the built-in message is unchanged", () => {
  assert.doesNotMatch(outOfHoursNote(), /email|phone|WhatsApp/i);
  assert.match(outOfHoursNote(), /Do not share contact details/);
  assert.match(renderWorkflowRules(settings(), null, "2026-01-02"), /outside the working days or hours, say so politely/);
  const a = settings().appointments;
  const sat = appointmentWindowIssue({ preferredDate: "2026-01-10", preferredTime: "10am" }, a, NOW) ?? "";
  assert.match(sat, /Saturday/); assert.doesNotMatch(sat, /reach us/);
  assert.equal(appointmentWindowIssue({ preferredDate: "2026-01-09", preferredTime: "10am" }, a, NOW), null);
});

// ---- a chat waiting for a person: silent, except when the business is closed and the customer asks for a person again
import { notifyClosedWhilePaused, type BatchContext, type BatchDeps } from "../lib/batch";

function paused(over: Partial<BatchContext> = {}, at = "2026-01-02T18:00:00Z", intent = "human_needed", reply = "Team is away, next Monday 09:00. Email hello@biz.com") {
  const sent: string[] = []; const generated: string[][] = [];
  const ctx = {
    client: { id: "c1", name: "Biz", waPhoneNumberId: "PN", aiProvider: "gemini", monthlyMessageCap: 100, businessInfo: null, businessHours: null, bookingLink: null, kbText: KB,
      workflow: settings(), ai: { mode: "platform", apiKey: null, keyStatus: "none" }, billing: { allowed: true, reason: "active", banner: "none", graceEndsAt: null, paidThrough: null } },
    conversation: { id: "v1", handling: "human_active", failedAnswerCount: 0, lastCustomerMessageAt: new Date(at), workflowState: null },
    open: { appointments: [], tickets: 0, leads: 0 }, contact: { id: "k", name: "A" }, phone: "91", pending: [], history: [], repliesThisMonth: 0, recentInboundCount: 1, ...over,
  } as unknown as BatchContext;
  const deps = {
    load: async () => ctx,
    generate: async (_c: unknown, lines: string[]) => { generated.push(lines); return { result: { intent, reply }, usage: { inputTokens: 1, outputTokens: 1 }, provider: "gemini", model: "m" }; },
    sendText: async (_c: unknown, b: string) => { sent.push(b); return { waMessageId: "w" }; }, saveReply: async () => {},
  } as unknown as BatchDeps;
  return { ctx, deps, sent, generated, at: new Date(at) };
}

test("waiting chat, closed, customer asks for a person again: the assistant's closed reply goes out", async () => {
  const t = paused();
  await notifyClosedWhilePaused("v1", "Person se baat karni h", t.deps, t.at);
  assert.deepEqual(t.generated, [["Person se baat karni h"]]);
  assert.deepEqual(t.sent, ["Team is away, next Monday 09:00. Email hello@biz.com"]);
});

test("waiting chat, closed, a normal question: the assistant stays silent", async () => {
  const t = paused({}, "2026-01-02T18:00:00Z", "faq");
  await notifyClosedWhilePaused("v1", "What services do you offer?", t.deps, t.at);
  assert.equal(t.sent.length, 0);
});

test("waiting chat while open, with the assistant handling it, or with an inactive subscription: no reply and no AI call", async () => {
  const open = paused({}, "2026-01-02T05:00:00Z");
  await notifyClosedWhilePaused("v1", "person please", open.deps, open.at);
  assert.equal(open.sent.length + open.generated.length, 0);
  const bot = paused({ conversation: { id: "v1", handling: "bot", failedAnswerCount: 0, lastCustomerMessageAt: new Date("2026-01-02T18:00:00Z"), workflowState: null } });
  await notifyClosedWhilePaused("v1", "person please", bot.deps, bot.at);
  assert.equal(bot.sent.length + bot.generated.length, 0);
  const t = paused();
  t.ctx.client.billing = { allowed: false, reason: "none", banner: "none", graceEndsAt: null, paidThrough: null } as never;
  await notifyClosedWhilePaused("v1", "person please", t.deps, t.at);
  assert.equal(t.sent.length + t.generated.length, 0);
});

test("an AI failure while the chat waits for a person never throws and sends nothing", async () => {
  const t = paused();
  (t.deps as { generate: unknown }).generate = async () => { throw new Error("503"); };
  await notifyClosedWhilePaused("v1", "person please", t.deps, t.at);
  assert.equal(t.sent.length, 0);
});
