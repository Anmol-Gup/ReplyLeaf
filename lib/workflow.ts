import { createHash } from "node:crypto";
import type { ReplyResult } from "./ai/schema";
import { WEEKDAYS, WEEKDAY_LABELS, type BookingMode, type WorkflowSettings } from "./workflow-settings";

// Server-side rules for the assistant's multi-step workflows. The model PROPOSES an action; this file DECIDES.
// Pure and unit-tested. Nothing is saved because a model said so: it must pass every check below.

export type FlowName = "appointment" | "enquiry" | "issue";
/**
 * Where a customer is in a multi-step flow, stored on the conversation (conversations.workflow_state, jsonb) so it survives
 * restarts and is never mixed between customers. `collected` and `missing` are what the assistant has gathered and still
 * needs; `summary` is the summary it last showed. Customer-derived text: it only ever goes to the model as data in the
 * user turn, never into the system prompt. A record being created clears the whole state.
 */
export type WorkflowState = {
  flow: FlowName; stage: "collecting" | "awaiting_confirmation"; updatedAt: string;
  collected?: Record<string, string>; missing?: string[]; summary?: string | null;
};

/** A confirmation prompt older than this is treated as stale: the customer must be shown a summary again. */
export const CONFIRMATION_TTL_MS = 48 * 60 * 60 * 1000;

export const REJECTED_SUBMIT_REPLY = "Thanks! Before I pass this to our team, could you please confirm the details are correct?";
export const ALREADY_SUBMITTED_REPLY = "That request is already with our team. We'll get back to you as soon as we can.";
export const ACTION_FAILED_REPLY = "Sorry, I couldn't submit that just now. I've let our team know and someone will follow up with you.";

export function parseWorkflowState(raw: unknown): WorkflowState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if ((r.flow !== "appointment" && r.flow !== "enquiry" && r.flow !== "issue") || (r.stage !== "collecting" && r.stage !== "awaiting_confirmation")) return null;
  const out: WorkflowState = { flow: r.flow, stage: r.stage, updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date(0).toISOString() };
  if (r.collected && typeof r.collected === "object" && !Array.isArray(r.collected)) {
    const entries = Object.entries(r.collected as Record<string, unknown>)
      .filter(([k, v]) => /^[a-z_ ]{1,60}$/i.test(k) && typeof v === "string").slice(0, 25)
      .map(([k, v]) => [k, (v as string).slice(0, 300)] as const);
    if (entries.length) out.collected = Object.fromEntries(entries);
  }
  if (Array.isArray(r.missing)) out.missing = r.missing.filter((m): m is string => typeof m === "string").slice(0, 10).map((m) => m.slice(0, 80));
  if (typeof r.summary === "string") out.summary = r.summary.slice(0, 600);
  return out;
}

const clean = (v: string | null | undefined, max: number) => {
  const s = (v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

/** Today's date (YYYY-MM-DD) in the business's time zone, or in UTC when none is set. */
export function todayInZone(now: Date, timeZone: string | null | undefined): string {
  if (timeZone) {
    try { return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now); } catch { /* fall back to UTC */ }
  }
  return now.toISOString().slice(0, 10);
}

/** "2026-11-20" -> the same string if it is a real date between today and a year ahead, else null. */
export function validPreferredDate(raw: string | null | undefined, now: Date, timeZone?: string | null): string | null {
  const s = (raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  const today = new Date(`${todayInZone(now, timeZone)}T00:00:00Z`);
  const limit = new Date(today.getTime() + 366 * 24 * 60 * 60 * 1000);
  return d >= today && d <= limit ? s : null;
}

export type AppointmentInput = {
  customerName: string; purpose: string; preferredDate: string | null; preferredTime: string | null;
  timezone: string | null; appointmentType: "online" | "in_person" | null; notes: string | null;
};
export type TicketInput = {
  customerName: string | null; subject: string; description: string; category: string | null; referenceInfo: string | null;
  priority: "normal" | "high"; summary: string; dedupeKey: string;
};
export type LeadInput = {
  customerName: string | null; projectType: string; description: string; budget: string | null; timeline: string | null;
  requirements: { key: string; value: string }[]; status: "new" | "qualified"; summary: string; dedupeKey: string;
};

/** Required: a purpose, a date or a time, and a name (from the chat or the contact). The WhatsApp number comes from the chat. */
export function validateAppointment(a: ReplyResult["appointment"], contactName: string | null, now: Date, timeZone?: string | null): { ok: true; value: AppointmentInput } | { ok: false; missing: string[] } {
  const purpose = clean(a.purpose, 300);
  const date = validPreferredDate(a.preferred_date, now, timeZone);
  const time = clean(a.preferred_time, 60);
  const name = clean(a.customer_name, 100) ?? clean(contactName, 100);
  const missing: string[] = [];
  if (!purpose) missing.push("purpose");
  if (!date && !time) missing.push("preferred date or time");
  if (!name) missing.push("name");
  if (missing.length || !purpose || !name) return { ok: false, missing };
  return {
    ok: true,
    value: { customerName: name, purpose, preferredDate: date, preferredTime: time, timezone: clean(a.timezone, 60), appointmentType: a.appointment_type, notes: clean(a.notes, 500) },
  };
}

/** The same appointment request twice while it is open = same key, so it is stored once (several DIFFERENT ones are fine). */
export const appointmentDedupeKey = (a: { purpose: string; preferredDate: string | null; preferredTime: string | null }) =>
  createHash("md5").update(`${a.purpose.trim().toLowerCase()}|${a.preferredDate ?? ""}|${(a.preferredTime ?? "").trim().toLowerCase()}`).digest("hex");

/** Same enquiry sent twice = same key, so it is stored once. */
export const leadDedupeKey = (projectType: string, description: string) =>
  createHash("sha256").update(`${projectType.toLowerCase()}\n${description.toLowerCase()}`.replace(/\s+/g, " ")).digest("hex").slice(0, 32);

/** Required: project type and a real description. Every lead starts as "new": only the owner marks it qualified. */
export function validateLead(l: ReplyResult["lead"], summary: string | null, contactName: string | null): { ok: true; value: LeadInput } | { ok: false; missing: string[] } {
  const projectType = clean(l.project_type, 200);
  const description = clean(l.description, 1500);
  const missing: string[] = [];
  if (!projectType) missing.push("project type");
  if (!description || description.length < 10) missing.push("description");
  if (missing.length || !projectType || !description) return { ok: false, missing };
  const budget = clean(l.budget, 100);
  const timeline = clean(l.timeline, 100);
  const requirements = l.requirements
    .map((r) => ({ key: clean(r.key, 60), value: clean(r.value, 300) }))
    .filter((r): r is { key: string; value: string } => Boolean(r.key && r.value))
    .slice(0, 15);
  return {
    ok: true,
    value: {
      customerName: clean(l.customer_name, 100) ?? clean(contactName, 100), projectType, description, budget, timeline, requirements,
      status: "new", // the owner decides when a lead is qualified; the assistant never does
      summary: clean(summary, 600) ?? `${projectType}: ${description}`.slice(0, 600),
      dedupeKey: leadDedupeKey(projectType, description),
    },
  };
}

/** Required: a subject and a real description. */
export function validateTicket(t: ReplyResult["ticket"], summary: string | null, contactName: string | null): { ok: true; value: TicketInput } | { ok: false; missing: string[] } {
  const subject = clean(t.subject, 150);
  const description = clean(t.description, 1500);
  const missing: string[] = [];
  if (!subject) missing.push("subject");
  if (!description || description.length < 10) missing.push("description");
  if (missing.length || !subject || !description) return { ok: false, missing };
  return {
    ok: true,
    value: {
      customerName: clean(t.customer_name, 100) ?? clean(contactName, 100), subject, description, category: clean(t.category, 60), referenceInfo: clean(t.reference_info, 100),
      priority: t.priority === "high" ? "high" : "normal",
      summary: clean(summary, 600) ?? `${subject}: ${description}`.slice(0, 600),
      dedupeKey: createHash("sha256").update(`${subject.toLowerCase()}\n${description.toLowerCase()}`.replace(/\s+/g, " ")).digest("hex").slice(0, 32),
    },
  };
}

/** "3pm", "3:30 pm", "15:00" -> minutes after midnight. Vague ("morning") or ambiguous ("3") times give null: they are not checked. */
export function parseClockTime(raw: string | null | undefined): number | null {
  const m = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?/i.exec(raw ?? "") ?? /(\d{1,2}):(\d{2})/.exec(raw ?? "");
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase();
  if (min > 59 || h > 23) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap === "p" ? 12 : 0);
  }
  return h * 60 + min;
}
const hhmm = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
const toMinutes = (hhmmText: string) => { const [h, m] = hhmmText.split(":").map(Number); return h * 60 + m; };

/**
 * Does the requested date and time fit the business's working days and opening hours? Returns a sentence
 * for the customer when it does not, otherwise null. Only what is known is checked, and this is NOT availability: there is
 * no calendar, so a request that passes is still only a request.
 */
export function appointmentWindowIssue(
  a: { preferredDate: string | null; preferredTime: string | null }, s: WorkflowSettings["appointments"], now: Date,
): string | null {
  if (a.preferredDate) {
    const d = new Date(`${a.preferredDate}T00:00:00Z`);
    const day = WEEKDAYS[(d.getUTCDay() + 6) % 7];
    if (s.workingDays.length > 0 && !s.workingDays.includes(day)) {
      return `Sorry, we don't take appointments on ${WEEKDAY_LABELS[day]}s (we work ${s.workingDays.map((w) => WEEKDAY_LABELS[w].slice(0, 3)).join(", ")}). Could you pick another day?`;
    }
  }
  const t = parseClockTime(a.preferredTime);
  if (t !== null) {
    const open = toMinutes(s.openTime), close = toMinutes(s.closeTime);
    if (t < open || t >= close) return `Our hours are ${hhmm(open)} to ${hhmm(close)}. Could you pick a time in that window?`;
  }
  return null;
}

export type Decision =
  | { kind: "none" }
  | { kind: "ticket"; value: TicketInput }
  | { kind: "appointment"; value: AppointmentInput }
  | { kind: "lead"; value: LeadInput }
  | { kind: "rejected"; flow: FlowName; reason: string; customerMessage?: string };

export type DecideInput = {
  prev: WorkflowState | null;
  result: ReplyResult;
  mode: BookingMode;
  settings: WorkflowSettings;
  contactName: string | null;
  now: Date;
};

/** May this reply save something? Only when ALL of these hold: the feature is on, the previous turn showed a summary
 *  (and it is not stale), the model says the customer confirmed, and the details are complete. */
export function decideAction({ prev, result, mode, settings, contactName, now }: DecideInput): Decision {
  const t = result.action.type;
  if (t === "none") return { kind: "none" };
  const flow: FlowName = t === "submit_appointment" ? "appointment" : t === "submit_ticket" ? "issue" : "enquiry";
  const enabled = flow === "appointment" ? mode === "collect" : flow === "issue" ? settings.support.enabled : settings.enquiries.enabled;
  if (!enabled) return { kind: "rejected", flow, reason: "feature_off" };
  if (!result.action.customer_confirmed) return { kind: "rejected", flow, reason: "not_confirmed" };
  const fresh = prev && prev.flow === flow && prev.stage === "awaiting_confirmation" && now.getTime() - new Date(prev.updatedAt).getTime() <= CONFIRMATION_TTL_MS;
  if (!fresh) return { kind: "rejected", flow, reason: "summary_not_shown" };
  if (flow === "appointment") {
    const v = validateAppointment(result.appointment, contactName, now, settings.appointments.timezone);
    if (!v.ok) return { kind: "rejected", flow, reason: `missing: ${v.missing.join(", ")}` };
    const issue = appointmentWindowIssue(v.value, settings.appointments, now);
    return issue ? { kind: "rejected", flow, reason: "outside_working_window", customerMessage: issue } : { kind: "appointment", value: v.value };
  }
  if (flow === "issue") {
    const v = validateTicket(result.ticket, result.summary, contactName);
    return v.ok ? { kind: "ticket", value: v.value } : { kind: "rejected", flow, reason: `missing: ${v.missing.join(", ")}` };
  }
  const v = validateLead(result.lead, result.summary, contactName);
  return v.ok ? { kind: "lead", value: v.value } : { kind: "rejected", flow, reason: `missing: ${v.missing.join(", ")}` };
}

const flowEnabled = (flow: FlowName, mode: BookingMode, settings: WorkflowSettings) =>
  flow === "appointment" ? mode === "collect" : flow === "issue" ? settings.support.enabled : settings.enquiries.enabled;

const field = (v: string | null | undefined, max = 200) => { const c = clean(v, max); return c ?? undefined; };

/** What has been gathered so far for a flow, and what is still missing (required fields only). */
export function collectionProgress(flow: FlowName, result: ReplyResult, contactName: string | null, now: Date, settings: WorkflowSettings): { collected: Record<string, string>; missing: string[] } {
  const raw: Record<string, string | undefined> = {};
  let missing: string[] = [];
  if (flow === "appointment") {
    const a = result.appointment;
    Object.assign(raw, { purpose: field(a.purpose), date: field(a.preferred_date), time: field(a.preferred_time), type: a.appointment_type ?? undefined, name: field(a.customer_name), notes: field(a.notes) });
    const v = validateAppointment(a, contactName, now, settings.appointments.timezone);
    missing = v.ok ? [] : v.missing;
    if (v.ok && appointmentWindowIssue(v.value, settings.appointments, now)) missing = ["a date and time inside our working days and hours"];
  } else if (flow === "issue") {
    const t = result.ticket;
    Object.assign(raw, { subject: field(t.subject), description: field(t.description, 300), category: field(t.category), reference: field(t.reference_info), urgent: t.priority === "high" ? "yes" : undefined, name: field(t.customer_name) });
    const v = validateTicket(t, result.summary, contactName);
    missing = v.ok ? [] : v.missing;
  } else {
    const l = result.lead;
    Object.assign(raw, { project: field(l.project_type), description: field(l.description, 300), budget: field(l.budget), timeline: field(l.timeline), name: field(l.customer_name) });
    for (const r of l.requirements.slice(0, 10)) { const k = clean(r.key, 40)?.toLowerCase().replace(/[^a-z ]/g, ""); const v = clean(r.value, 200); if (k && v) raw[k] = v; }
    const v = validateLead(l, result.summary, contactName);
    missing = v.ok ? [] : v.missing;
  }
  const collected = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) as Record<string, string>;
  return { collected, missing };
}

/** The state to store after this turn (null clears it). */
export function nextWorkflowState({ prev, result, decision, mode, settings, contactName, now }: DecideInput & { decision: Decision }): WorkflowState | null {
  if (decision.kind === "appointment" || decision.kind === "lead" || decision.kind === "ticket") return null; // done: the record exists
  const at = now.toISOString();
  if (decision.kind === "rejected") {
    const base = prev && prev.flow === decision.flow ? { collected: prev.collected, missing: prev.missing } : {};
    return { flow: decision.flow, stage: "collecting", updatedAt: at, ...base };
  }
  const flow = result.workflow.flow;
  // The customer changed their mind: nothing is saved and nothing is kept.
  if (result.workflow.stage === "cancelled") return null;
  if (!flow) {
    // A side question (or small talk) in the middle of a flow: keep what was collected and resume later. A summary that was
    // shown earlier no longer counts (the customer might say "yes" to the answer), so a new summary is needed. Stale state expires.
    if (!prev || !flowEnabled(prev.flow, mode, settings)) return null;
    if (now.getTime() - new Date(prev.updatedAt).getTime() > CONFIRMATION_TTL_MS) return null;
    return { ...prev, stage: "collecting" };
  }
  if (!flowEnabled(flow, mode, settings)) return null;
  let stage: "collecting" | "awaiting_confirmation" = result.workflow.stage === "awaiting_confirmation" ? "awaiting_confirmation" : "collecting";
  const progress = collectionProgress(flow, result, contactName, now, settings);
  // "awaiting_confirmation" is only believed when the details are already complete enough to submit.
  if (stage === "awaiting_confirmation" && progress.missing.length > 0) stage = "collecting";
  // Keep the earlier timestamp while nothing changed, so a stale prompt can still expire.
  const keep = prev && prev.flow === flow && prev.stage === stage;
  // If the model sent nothing new for this flow (all fields null), do not wipe what was collected earlier.
  const collected = Object.keys(progress.collected).length === 0 && prev?.flow === flow ? prev.collected : progress.collected;
  const state: WorkflowState = { flow, stage, updatedAt: keep ? prev.updatedAt : at, missing: progress.missing };
  if (collected && Object.keys(collected).length) state.collected = collected;
  if (stage === "awaiting_confirmation" && result.summary) state.summary = clean(result.summary, 600);
  return state;
}
