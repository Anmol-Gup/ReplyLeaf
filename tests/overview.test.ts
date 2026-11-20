import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  APPOINTMENTS_TO_CONFIRM, assistantReadiness, buildAttention, HANDOFF_WAITING, isFollowUpDue, LEADS_ACTIVE, LEADS_NEW, overviewLinks, showCount, TICKETS_OPEN, type Counts, type ReadinessInput,
} from "../lib/overview";
import { effectiveSelection } from "../lib/filters";
import { APPOINTMENT_STATUSES, overview as apptOverview } from "../lib/appointments";
import { HANDOFF_STATUSES } from "../lib/handoff";
import { isOpenLead, LEAD_STATUSES, leadOverview } from "../lib/leads";
import { isOpenTicket, PRIORITIES, TICKET_STATUSES } from "../lib/tickets";

const zero: Counts = { handoffs: 0, appointments: 0, tickets: 0, highTickets: 0, newLeads: 0, followUps: 0, contacts: 0 };
const param = (href: string, name: string) => new URL(href, "https://x.test").searchParams.getAll(name);

test("what each metric counts: the right statuses, and never finished work", () => {
  assert.deepEqual([...HANDOFF_WAITING], ["requested", "assigned"]);               // waiting for a person; not 'human_active' (being handled) and not 'resolved'
  assert.deepEqual([...APPOINTMENTS_TO_CONFIRM], ["pending"]);                     // not confirmed, rejected, cancelled or completed
  assert.deepEqual([...TICKETS_OPEN], ["open", "in_progress", "waiting_on_customer"]); // not resolved or closed
  assert.deepEqual([...LEADS_NEW], ["new", "qualified"]);
  for (const s of HANDOFF_WAITING) assert.ok((HANDOFF_STATUSES as readonly string[]).includes(s));
  for (const s of APPOINTMENTS_TO_CONFIRM) assert.ok((APPOINTMENT_STATUSES as readonly string[]).includes(s));
  for (const s of TICKETS_OPEN) assert.ok(isOpenTicket(s));
  assert.deepEqual(TICKET_STATUSES.filter((s) => isOpenTicket(s)), [...TICKETS_OPEN]);    // exactly the open ones, no more
  assert.deepEqual(LEAD_STATUSES.filter((s) => isOpenLead(s)), [...LEADS_ACTIVE]);        // exactly the leads still being worked
  assert.ok(!(LEADS_ACTIVE as readonly string[]).includes("won") && !(LEADS_ACTIVE as readonly string[]).includes("lost"));
});

test("every card opens the existing page with the SAME statuses it counted, so the numbers match the lists", () => {
  assert.deepEqual(effectiveSelection(param(overviewLinks.handoffs, "status"), HANDOFF_STATUSES, []).selected, [...HANDOFF_WAITING]);
  assert.deepEqual(effectiveSelection(param(overviewLinks.appointments, "status"), APPOINTMENT_STATUSES, []).selected, [...APPOINTMENTS_TO_CONFIRM]);
  assert.deepEqual(effectiveSelection(param(overviewLinks.tickets, "status"), TICKET_STATUSES, []).selected, [...TICKETS_OPEN]);
  assert.deepEqual(effectiveSelection(param(overviewLinks.newLeads, "status"), LEAD_STATUSES, []).selected, [...LEADS_NEW]);
  assert.deepEqual(effectiveSelection(param(overviewLinks.highTickets, "priority"), PRIORITIES, []).selected, ["high"]);
  assert.deepEqual(effectiveSelection(param(overviewLinks.highTickets, "status"), TICKET_STATUSES, []).selected, [...TICKETS_OPEN]);
  assert.equal(param(overviewLinks.followUps, "due")[0], "1");
  assert.ok(overviewLinks.contacts === "/dashboard/contacts");
  for (const href of Object.values(overviewLinks)) assert.ok(href.startsWith("/dashboard/"), href); // existing pages only
});

test("follow-ups due: due or overdue, and only for leads still being worked; the Overview and the Leads page agree", () => {
  const today = "2026-11-21";
  const L = (status: string, follow_up_at: string | null) => ({ status, follow_up_at });
  assert.equal(isFollowUpDue(L("new", "2026-11-21"), today), true);            // due today
  assert.equal(isFollowUpDue(L("contacted", "2026-11-01"), today), true);      // overdue
  assert.equal(isFollowUpDue(L("negotiation", "2026-11-22"), today), false);   // in the future
  assert.equal(isFollowUpDue(L("new", null), today), false);                   // no follow-up set
  assert.equal(isFollowUpDue(L("won", "2026-11-01"), today), false);           // finished leads never need a follow-up
  assert.equal(isFollowUpDue(L("lost", "2026-11-01"), today), false);
  const rows = ["new", "qualified", "contacted", "proposal_sent", "negotiation", "won", "lost"].flatMap((s) => [L(s, "2026-11-01"), L(s, "2026-12-01"), L(s, null)]);
  assert.equal(rows.filter((r) => isFollowUpDue(r, today)).length, leadOverview(rows as never, today).dueFollowUp);
  assert.equal(rows.filter((r) => isFollowUpDue(r, today)).length, 5);
});

test("Needs your attention: only what has something in it, most urgent first, each with its filtered link and count", () => {
  assert.deepEqual(buildAttention(zero), []);                                                       // nothing: the page says 'all caught up'
  assert.deepEqual(buildAttention({ ...zero, contacts: 50, tickets: 9 }).map((a) => a.key), []);   // totals are not tasks
  const all = buildAttention({ handoffs: 2, appointments: 3, tickets: 9, highTickets: 1, newLeads: 4, followUps: 5, contacts: 99 });
  assert.deepEqual(all.map((a) => a.key), ["handoffs", "highTickets", "appointments", "followUps", "newLeads"]);
  assert.deepEqual(all.map((a) => a.n), [2, 1, 3, 5, 4]);
  assert.equal(all[0].href, overviewLinks.handoffs); assert.equal(all[1].href, overviewLinks.highTickets);
  assert.equal(all[0].text, "chats are waiting for a person");
  assert.equal(buildAttention({ ...zero, handoffs: 1 })[0].text, "chat is waiting for a person");
  assert.equal(buildAttention({ ...zero, highTickets: 1 })[0].text, "high-priority open ticket");
  assert.equal(buildAttention({ ...zero, followUps: 1 })[0].text, "lead follow-up due");
  assert.deepEqual(buildAttention({ ...zero, appointments: 2 }).map((a) => a.key), ["appointments"]);  // zero categories are hidden
  assert.deepEqual(buildAttention({ ...zero, handoffs: null, appointments: null }), []);               // an unreadable count is never guessed
  assert.equal(showCount(null), "-"); assert.equal(showCount(0), "0"); assert.equal(showCount(1200), (1200).toLocaleString());
});

const ready: ReadinessInput = { hasPhone: true, onboardingStatus: "connected", clientStatus: "active", aiMode: "byok", hasKey: true, keyStatus: "valid", billingAllowed: true, kbReady: true };
const row = (r: ReturnType<typeof assistantReadiness>, k: string) => r.rows.find((x) => x.key === k)!;

test("the assistant is Active only when everything it needs is in place", () => {
  const ok = assistantReadiness(ready);
  assert.equal(ok.active, true); assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.rows.map((r) => [r.key, r.state]), [["whatsapp", "Connected"], ["ai", "Connected"], ["assistant", "Active"], ["knowledge", "Ready"]]);
  // WhatsApp connected is not enough
  const noKey = assistantReadiness({ ...ready, hasKey: false, keyStatus: "none" });
  assert.equal(noKey.active, false); assert.equal(row(noKey, "whatsapp").state, "Connected");
  assert.deepEqual([row(noKey, "ai").state, row(noKey, "ai").href, row(noKey, "assistant").state], ["Not configured", "/dashboard/settings?tab=ai", "Inactive"]);
  assert.match(noKey.problems.join(" "), /cannot answer customers/);
  const bad = assistantReadiness({ ...ready, keyStatus: "invalid" });
  assert.deepEqual([row(bad, "ai").state, row(bad, "assistant").state], ["Connection error", "Inactive"]);
  assert.match(bad.problems.join(" "), /refused the key/);
  assert.equal(assistantReadiness({ ...ready, keyStatus: "unverified" }).active, true);   // saved but not checked yet: it is tried
  assert.equal(assistantReadiness({ ...ready, aiMode: "platform", hasKey: false, keyStatus: "none" }).active, true); // platform AI needs no key
});

test("WhatsApp disconnected, needing attention, a paused account and an inactive subscription each switch the assistant off, with a link to fix it", () => {
  const none = assistantReadiness({ ...ready, hasPhone: false, onboardingStatus: null });
  assert.deepEqual([row(none, "whatsapp").state, row(none, "whatsapp").href, none.active], ["Disconnected", "/dashboard/settings?tab=whatsapp", false]);
  const failed = assistantReadiness({ ...ready, onboardingStatus: "failed" });
  assert.deepEqual([row(failed, "whatsapp").state, failed.active], ["Needs attention", false]);
  assert.equal(assistantReadiness({ ...ready, onboardingStatus: "pending" }).active, true);     // waiting for Meta's confirmation does not stop replies
  const paused = assistantReadiness({ ...ready, clientStatus: "paused" });
  assert.equal(paused.active, false); assert.match(paused.problems.join(" "), /paused/);
  const unpaid = assistantReadiness({ ...ready, billingAllowed: false });
  assert.equal(unpaid.active, false); assert.match(unpaid.problems.join(" "), /subscription/);
  const empty = assistantReadiness({ ...ready, kbReady: false });
  assert.deepEqual([row(empty, "knowledge").state, row(empty, "knowledge").href, empty.active], ["Empty", "/dashboard/knowledge", true]); // an empty knowledge base is shown, but does not switch it off
  // no row ever carries a credential
  assert.ok(!JSON.stringify(none).match(/sk-|AIza|AQ\./));
});

test("the Overview page counts in the database for THIS business and never shows a made-up number", () => {
  const page = readFileSync("app/dashboard/page.tsx", "utf8");
  assert.match(page, /eq\("client_id", clientId\)/);
  assert.match(page, /const mine = \(table: string\) => db\.from\(table\)\.select\("id", \{ count: "exact", head: true \}\)\.eq\("client_id", clientId\)/); // every count is scoped
  assert.equal((page.match(/\.eq\("client_id", clientId\)/g) ?? []).length >= 4, true);      // counts and the three latest lists
  for (const bad of [".limit(300)", ".limit(500)"]) assert.ok(!page.includes(bad), `counts must not come from a capped list (${bad})`);
  assert.match(page, /\.eq\("spoke", true\)/);                                                // contacts: one per person
  assert.match(page, /showCount\(/);                                                           // unreadable counts show a dash
  // the latest sections show three records each, with a View all link and the right empty-state words
  assert.equal((page.match(/\.limit\(3\)/g) ?? []).length, 3);
  assert.equal((page.match(/View all/g) ?? []).length, 3);
  assert.match(page, /New enquiries collected by your assistant will appear here/);
  assert.match(page, /Customer issues logged by your assistant will appear here/);
  assert.match(page, /You&apos;re all caught up\. Nothing needs your attention right now\./);
});

test("actions that change what the Overview shows also refresh it", () => {
  for (const f of ["app/dashboard/appointments/actions.ts", "app/dashboard/tickets/actions.ts", "app/dashboard/leads/actions.ts", "app/dashboard/handoff/actions.ts", "app/dashboard/actions.ts", "app/dashboard/settings/actions.ts"]) {
    assert.match(readFileSync(f, "utf8"), /revalidatePath\("\/dashboard"\)/, f);
  }
});

test("appointments: the Overview's 'to confirm' is the unconfirmed status only, finished work is not counted", () => {
  const rows = APPOINTMENT_STATUSES.map((status) => ({ status, scheduled_date: null, preferred_date: null }));
  assert.equal(rows.filter((r) => (APPOINTMENTS_TO_CONFIRM as readonly string[]).includes(r.status)).length, 1);
  assert.ok(apptOverview(rows, "2026-11-21").pending >= 1);   // the older helper also counts legacy 'reschedule' requests; the Overview deliberately does not
});
