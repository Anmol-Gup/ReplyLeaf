import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  allowedStatuses, canMoveTicket, categoryOptions, cleanCategory, DEFAULT_CATEGORIES, describeTicketEvent, notificationOutcome, PRIORITIES, PRIORITY_LABELS,
  statusUpdateMessage, TICKET_EVENT_KINDS, TICKET_STATUSES, ticketFormSchema, ticketNoteSchema, type TicketStatus,
} from "../lib/tickets";
import { NOTICES } from "../lib/dashboard";

const ID = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

test("status changes follow the valid moves; Resolved and Closed are different", () => {
  assert.deepEqual([...TICKET_STATUSES], ["open", "in_progress", "waiting_on_customer", "resolved", "closed"]);
  assert.equal(canMoveTicket("open", "in_progress"), true);
  assert.equal(canMoveTicket("in_progress", "waiting_on_customer"), true);
  assert.equal(canMoveTicket("waiting_on_customer", "in_progress"), true);
  assert.equal(canMoveTicket("in_progress", "resolved"), true);
  assert.equal(canMoveTicket("resolved", "closed"), true);           // resolved is not closed: it can still be finished
  assert.equal(canMoveTicket("resolved", "in_progress"), true);      // or reopened
  assert.equal(canMoveTicket("closed", "in_progress"), true);        // a closed ticket can be reopened...
  assert.equal(canMoveTicket("closed", "resolved"), false);          // ...but not "re-resolved"
  assert.equal(canMoveTicket("closed", "open"), false);              // nothing goes back to Open: it is for new tickets
  assert.equal(canMoveTicket("in_progress", "open"), false);
  assert.equal(canMoveTicket("resolved", "waiting_on_customer"), false);
  for (const s of TICKET_STATUSES) assert.equal(canMoveTicket(s, s), true, `${s} -> itself (saving without a status change)`);
  // the page offers exactly the allowed ones, current first
  assert.deepEqual(allowedStatuses("open"), ["open", "in_progress", "waiting_on_customer", "resolved", "closed"]);
  assert.deepEqual(allowedStatuses("closed"), ["closed", "in_progress"]);
  for (const from of TICKET_STATUSES) for (const to of allowedStatuses(from)) assert.equal(canMoveTicket(from, to as TicketStatus), true);
});

test("priority stays Low, Medium, High (no Urgent level)", () => {
  assert.deepEqual([...PRIORITIES], ["low", "normal", "high"]);
  assert.deepEqual(PRIORITIES.map((p) => PRIORITY_LABELS[p]), ["Low", "Medium", "High"]);
});

test("the edit form: status, priority, category and a REAL assignee id (never a typed name); unchanged fields can be left out", () => {
  const base = { id: ID, status: "open", message: "" };
  assert.equal(ticketFormSchema.safeParse(base).success, true);
  assert.equal(ticketFormSchema.parse({ ...base, assigned_user_id: USER }).assigned_user_id, USER);
  assert.equal(ticketFormSchema.parse({ ...base, assigned_user_id: "" }).assigned_user_id, "");   // "" = unassigned
  for (const bad of ["raj@example.com", "Raj", "not-a-uuid", "'; drop table tickets;--"]) assert.equal(ticketFormSchema.safeParse({ ...base, assigned_user_id: bad }).success, false, bad);
  assert.equal(ticketFormSchema.safeParse({ ...base, status: "banana" }).success, false);
  assert.equal(ticketFormSchema.safeParse({ ...base, priority: "urgent" }).success, false);
  assert.equal(ticketFormSchema.safeParse({ ...base, category: "x".repeat(61) }).success, false);
  assert.equal(ticketFormSchema.safeParse({ ...base, message: "x".repeat(1001) }).success, false);
  assert.equal(ticketFormSchema.safeParse({ ...base, id: "nope" }).success, false);
});

test("categories: the business's own list, else the suggested ones; a ticket's own category is kept; nothing is invented", () => {
  assert.deepEqual(DEFAULT_CATEGORIES, ["Technical issue", "Billing", "Delivery", "Account access", "Product issue", "Other"]);
  assert.deepEqual(categoryOptions([], null), DEFAULT_CATEGORIES);
  assert.deepEqual(categoryOptions(["Refunds", "Shipping"], "Refunds"), ["Refunds", "Shipping"]);
  assert.deepEqual(categoryOptions([], "delivery"), DEFAULT_CATEGORIES);                       // matches "Delivery" regardless of case
  assert.deepEqual(categoryOptions([], "Warranty"), [...DEFAULT_CATEGORIES, "Warranty"]);       // what the assistant collected stays selectable
  assert.equal(cleanCategory("  Billing  "), "Billing");
  assert.equal(cleanCategory(""), null); assert.equal(cleanCategory("   "), null); assert.equal(cleanCategory(undefined), null);
  assert.equal(cleanCategory("x".repeat(100))?.length, 60);
});

test("internal notes: any number, each needs text, and a note can never be empty", () => {
  assert.equal(ticketNoteSchema.parse({ id: ID, body: "  called the customer  " }).body, "called the customer");
  for (const bad of ["", "   ", "\n\t"]) assert.equal(ticketNoteSchema.safeParse({ id: ID, body: bad }).success, false);
  assert.equal(ticketNoteSchema.safeParse({ id: ID, body: "x".repeat(4001) }).success, false);
  assert.equal(ticketNoteSchema.safeParse({ id: "x", body: "hi" }).success, false);
});

test("customer updates contain only the status and the optional line, never internal notes", () => {
  const secret = "INTERNAL: customer is rude, do not refund";
  for (const status of TICKET_STATUSES) {
    const m = statusUpdateMessage("AG", "Order late", "T-1A2B3C", status, "Your issue has been resolved.");
    assert.match(m, /T-1A2B3C/); assert.match(m, /AG/);
    assert.ok(!m.includes(secret) && !/internal/i.test(m), status);
  }
  assert.match(statusUpdateMessage("AG", "x", "T-1", "resolved", ""), /resolved/);
  assert.match(statusUpdateMessage("AG", "x", "T-1", "closed", ""), /closed/);
  assert.match(statusUpdateMessage("AG", "x", "T-1", "waiting_on_customer", "Please send your order number."), /more information[\s\S]*order number/);
  assert.match(statusUpdateMessage("AG", "x", "T-1", "resolved", "  a   b  "), /a b/);               // whitespace is tidied
  // the function takes no notes at all: there is nothing to leak
  assert.equal(statusUpdateMessage.length, 5);
});

test("the server action never puts notes into a customer message, and the notes are not read by the assistant", () => {
  const actions = readFileSync("app/dashboard/tickets/actions.ts", "utf8");
  const sendBlock = actions.slice(actions.indexOf("const message = statusUpdateMessage"), actions.indexOf("revalidatePath(detail(v.id));\n    return go(v.id, deliveryNotice"));
  assert.ok(sendBlock.includes("v.message") && !/note|body/i.test(sendBlock.replace(/notification/gi, "")), "the customer message is built from the status and the typed line only");
  // the assistant's context builders never read the notes tables
  for (const f of ["lib/supabase-batch.ts", "lib/ai/prompt.ts", "lib/batch.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/ticket_notes|internal_notes/.test(src), `${f} must not read internal notes`);
  }
});

test("the activity lines say what happened and never contain note text", () => {
  assert.equal(describeTicketEvent("created", {}), "Ticket created");
  assert.equal(describeTicketEvent("status", { from: "open", to: "in_progress" }), "Status changed from Open to In progress");
  assert.equal(describeTicketEvent("priority", { from: "normal", to: "high" }), "Priority changed from Medium to High");
  assert.equal(describeTicketEvent("category", { from: null, to: "Billing" }), "Category set to Billing");
  assert.equal(describeTicketEvent("category", { from: "Billing", to: null }), "Category cleared");
  assert.equal(describeTicketEvent("assigned", { from: null, to: USER, to_label: "Priya" }), "Assigned to Priya");
  assert.equal(describeTicketEvent("assigned", { from: USER, to: "b", from_label: "Priya", to_label: "Raj" }), "Reassigned from Priya to Raj");
  assert.equal(describeTicketEvent("assigned", { from: USER, to: null, from_label: "Priya", to_label: null }), "Unassigned (was Priya)");
  assert.equal(describeTicketEvent("note", { body: "secret text" }), "Internal note added");
  assert.ok(!describeTicketEvent("note", { body: "secret text" }).includes("secret"));
  assert.equal(describeTicketEvent("resolved", {}), "Ticket resolved");
  assert.equal(describeTicketEvent("closed", {}), "Ticket closed");
  for (const k of TICKET_EVENT_KINDS) assert.ok(describeTicketEvent(k, {}).length > 0, k);
});

test("a notification is only called 'delivered' when WhatsApp says so; failures and not-sent are stated plainly", () => {
  assert.equal(notificationOutcome({ channel: "whatsapp" }, null).tone, "warn");                       // accepted, not confirmed
  assert.match(notificationOutcome({ channel: "whatsapp" }, "sent").label, /not confirmed yet/);
  assert.match(notificationOutcome({ channel: "whatsapp" }, "delivered").label, /Delivered/);
  assert.match(notificationOutcome({ channel: "whatsapp" }, "read").label, /Delivered/);
  assert.match(notificationOutcome({ channel: "whatsapp" }, "failed").label, /Failed/);
  assert.equal(notificationOutcome({ channel: "whatsapp" }, "failed").tone, "danger");
  assert.match(notificationOutcome({ channel: "email" }, null).label, /Sent by email/);
  assert.match(notificationOutcome({ channel: "failed" }, null).label, /Failed/);
  const none = notificationOutcome({ channel: "none" }, null);                                          // window closed, no email: not sent, and why
  assert.match(none.label, /Not sent/); assert.match(none.label, /24-hour/);
});

test("every outcome the ticket page can redirect to has a message", () => {
  for (const code of ["tkt_saved", "tkt_needs_update", "tkt_bad_transition", "tkt_bad_assignee", "tkt_nothing_to_notify", "tkt_note_added", "tkt_note_empty", "tkt_done_whatsapp", "tkt_done_email", "tkt_done_failed", "tkt_done_not_sent"]) {
    assert.ok(NOTICES[code], code);
  }
  assert.equal(NOTICES.tkt_done_failed.kind, "error");
  assert.match(NOTICES.tkt_done_not_sent.text, /NOT told[\s\S]*24-hour/);
});

test("authorization lives on the server: the assignee is checked against the business's members, and the ticket against the business", () => {
  const actions = readFileSync("app/dashboard/tickets/actions.ts", "utf8");
  assert.match(actions, /isTeamMember\(clientId, newAssignee\)/);
  assert.match(actions, /canMoveTicket\(prev, v\.status\)/);
  assert.equal((actions.match(/\.eq\("client_id", clientId\)/g) ?? []).length >= 3, true);              // every read and update is scoped to the business...
  assert.equal((actions.match(/client_id: clientId/g) ?? []).length >= 3, true);                        // ...and every insert carries the business id
  const team = readFileSync("lib/team.ts", "utf8");
  assert.match(team, /from\("client_users"\)[\s\S]*eq\("client_id", clientId\)/);
});

test("a database that is missing an update is reported as that, never as 'not found'", () => {
  const actions = readFileSync("app/dashboard/tickets/actions.ts", "utf8");
  assert.match(actions, /readError\) return go\(v\.id, needsUpdate\(readError\)/);          // a failed read of the ticket is not "no such ticket"
  for (const code of ["42703", "42P01", "PGRST204", "PGRST205"]) assert.ok(actions.includes(code), code);
  assert.match(NOTICES.tkt_needs_update.text, /migration 0025/);
  assert.equal(NOTICES.tkt_needs_update.kind, "error");
});
