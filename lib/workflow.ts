import { createHash } from "node:crypto";
import type { ReplyResult } from "./ai/schema";
import type { BookingMode, WorkflowSettings } from "./workflow-settings";

// Server-side rules for the assistant's multi-step workflows. The model PROPOSES an action; this file DECIDES.
// Pure and unit-tested. Nothing is saved because a model said so: it must pass every check below.

export type FlowName = "appointment" | "enquiry";
export type WorkflowState = { flow: FlowName; stage: "collecting" | "awaiting_confirmation"; updatedAt: string };

/** A confirmation prompt older than this is treated as stale: the customer must be shown a summary again. */
export const CONFIRMATION_TTL_MS = 48 * 60 * 60 * 1000;

export const REJECTED_SUBMIT_REPLY = "Thanks! Before I pass this to our team, could you please confirm the details are correct?";
export const ACTION_FAILED_REPLY = "Sorry, I couldn't submit that just now. I've let our team know and someone will follow up with you.";

export function parseWorkflowState(raw: unknown): WorkflowState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if ((r.flow !== "appointment" && r.flow !== "enquiry") || (r.stage !== "collecting" && r.stage !== "awaiting_confirmation")) return null;
  return { flow: r.flow, stage: r.stage, updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date(0).toISOString() };
}

const clean = (v: string | null | undefined, max: number) => {
  const s = (v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

/** "2026-11-20" -> the same string if it is a real date between today and a year ahead, else null. */
export function validPreferredDate(raw: string | null | undefined, now: Date): string | null {
  const s = (raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const limit = new Date(today.getTime() + 366 * 24 * 60 * 60 * 1000);
  return d >= today && d <= limit ? s : null;
}

export type AppointmentInput = {
  customerName: string; purpose: string; preferredDate: string | null; preferredTime: string | null;
  timezone: string | null; appointmentType: "online" | "in_person" | null; notes: string | null;
};
export type LeadInput = {
  customerName: string | null; projectType: string; description: string; budget: string | null; timeline: string | null;
  requirements: { key: string; value: string }[]; status: "new" | "qualified"; summary: string; dedupeKey: string;
};

/** Required: a purpose, a date or a time, and a name (from the chat or the contact). The WhatsApp number comes from the chat. */
export function validateAppointment(a: ReplyResult["appointment"], contactName: string | null, now: Date): { ok: true; value: AppointmentInput } | { ok: false; missing: string[] } {
  const purpose = clean(a.purpose, 300);
  const date = validPreferredDate(a.preferred_date, now);
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

/** Same enquiry sent twice = same key, so it is stored once. */
export const leadDedupeKey = (projectType: string, description: string) =>
  createHash("sha256").update(`${projectType.toLowerCase()}\n${description.toLowerCase()}`.replace(/\s+/g, " ")).digest("hex").slice(0, 32);

/** Required: project type and a real description. "qualified" only when budget AND timeline are known too. */
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
      customerName: clean(contactName, 100), projectType, description, budget, timeline, requirements,
      status: budget && timeline ? "qualified" : "new",
      summary: clean(summary, 600) ?? `${projectType}: ${description}`.slice(0, 600),
      dedupeKey: leadDedupeKey(projectType, description),
    },
  };
}

export type Decision =
  | { kind: "none" }
  | { kind: "appointment"; value: AppointmentInput }
  | { kind: "lead"; value: LeadInput }
  | { kind: "rejected"; flow: FlowName; reason: string };

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
  const flow: FlowName = t === "submit_appointment" ? "appointment" : "enquiry";
  const enabled = flow === "appointment" ? mode === "collect" : settings.enquiries.enabled;
  if (!enabled) return { kind: "rejected", flow, reason: "feature_off" };
  if (!result.action.customer_confirmed) return { kind: "rejected", flow, reason: "not_confirmed" };
  const fresh = prev && prev.flow === flow && prev.stage === "awaiting_confirmation" && now.getTime() - new Date(prev.updatedAt).getTime() <= CONFIRMATION_TTL_MS;
  if (!fresh) return { kind: "rejected", flow, reason: "summary_not_shown" };
  if (flow === "appointment") {
    const v = validateAppointment(result.appointment, contactName, now);
    return v.ok ? { kind: "appointment", value: v.value } : { kind: "rejected", flow, reason: `missing: ${v.missing.join(", ")}` };
  }
  const v = validateLead(result.lead, result.summary, contactName);
  return v.ok ? { kind: "lead", value: v.value } : { kind: "rejected", flow, reason: `missing: ${v.missing.join(", ")}` };
}

/** The state to store after this turn (null clears it). */
export function nextWorkflowState({ prev, result, decision, mode, settings, contactName, now }: DecideInput & { decision: Decision }): WorkflowState | null {
  if (decision.kind === "appointment" || decision.kind === "lead") return null; // done
  const at = now.toISOString();
  if (decision.kind === "rejected") return { flow: decision.flow, stage: "collecting", updatedAt: at };
  const flow = result.workflow.flow;
  if (!flow) return null;
  if (flow === "appointment" && mode !== "collect") return null;
  if (flow === "enquiry" && !settings.enquiries.enabled) return null;
  let stage = result.workflow.stage ?? "collecting";
  // "awaiting_confirmation" is only believed when the details are already complete enough to submit.
  if (stage === "awaiting_confirmation") {
    const complete = flow === "appointment"
      ? validateAppointment(result.appointment, contactName, now).ok
      : validateLead(result.lead, result.summary, contactName).ok;
    if (!complete) stage = "collecting";
  }
  // Keep the earlier timestamp while nothing changed, so a stale prompt can still expire.
  const keep = prev && prev.flow === flow && prev.stage === stage;
  return { flow, stage, updatedAt: keep ? prev.updatedAt : at };
}
