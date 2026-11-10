import { z } from "zod";

// Per-business settings for the assistant's workflows (appointment requests, project enquiries, human handoff).
// Stored as JSON in clients.workflow_settings. Everything has a default, and bad stored data falls back to
// defaults instead of breaking replies. NOTE: working days and hours are INFORMATION for the assistant and the
// customer. There is no calendar integration, so nothing here promises a free slot.

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const WEEKDAY_LABELS: Record<(typeof WEEKDAYS)[number], string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");
const text = (max: number) => z.string().trim().max(max);
const list = (items: number, each: number) => z.array(z.string().trim().min(1).max(each)).max(items);

export const workflowSettingsSchema = z.object({
  appointments: z.object({
    enabled: z.boolean().default(true),
    instructions: text(1000).default(""),
    workingDays: z.array(z.enum(WEEKDAYS)).max(7).default(["mon", "tue", "wed", "thu", "fri"]),
    openTime: hhmm.default("09:00"),
    closeTime: hhmm.default("17:00"),
    durationMinutes: z.number().int().min(5).max(480).nullable().default(null),
    minNoticeHours: z.number().int().min(0).max(720).default(0),
  }).prefault({}),
  enquiries: z.object({
    enabled: z.boolean().default(true),
    services: list(20, 100).default([]),
    questions: list(10, 200).default([]),
    budgetRanges: list(10, 60).default([]),
    instructions: text(1000).default(""),
  }).prefault({}),
  handoff: z.object({
    enabled: z.boolean().default(true),
    availability: text(200).default(""),
    responseTime: text(100).default(""),
    escalationInstructions: text(1000).default(""),
  }).prefault({}),
});

export type WorkflowSettings = z.infer<typeof workflowSettingsSchema>;

export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = workflowSettingsSchema.parse({});

/** Stored JSON -> settings. Anything invalid falls back to the defaults. */
export function parseWorkflowSettings(raw: unknown): WorkflowSettings {
  const r = workflowSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : DEFAULT_WORKFLOW_SETTINGS;
}

/** One entry per non-empty line, trimmed, de-duplicated, capped. For the textareas on the settings page. */
export function linesToList(raw: unknown, max: number, each: number): string[] {
  if (typeof raw !== "string") return [];
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const v = line.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, each);
    if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/** How the assistant handles "I want to book": share the link, collect a request for the owner, or hand over. */
export type BookingMode = "link" | "collect" | "handoff";
export function bookingMode(bookingLink: string | null | undefined, s: WorkflowSettings): BookingMode {
  if (bookingLink) return "link";
  return s.appointments.enabled ? "collect" : "handoff";
}

const dayList = (days: readonly string[]) => (days.length === 7 ? "every day" : days.map((d) => WEEKDAY_LABELS[d as (typeof WEEKDAYS)[number]]).join(", ") || "not set");

/** The workflow rules written into the system prompt. Owner-written text only (trusted); never customer text. */
export function renderWorkflowRules(s: WorkflowSettings, bookingLink: string | null, today: string): string {
  const mode = bookingMode(bookingLink, s);
  const out: string[] = [];

  // --- appointments
  if (mode === "link") {
    out.push(`APPOINTMENTS: a booking link exists: ${bookingLink}
- When the customer wants to book, share that link and tell them to pick a time there. Set intent to "appointment_request" and action.type to "none".
- Never say the customer is booked, confirmed or scheduled. You cannot make bookings.`);
  } else if (mode === "collect") {
    const a = s.appointments;
    out.push(`APPOINTMENTS: there is no calendar and no booking link. You can only collect an appointment REQUEST that the team confirms later.
- Today's date is ${today}. Working days: ${dayList(a.workingDays)}; hours ${a.openTime}-${a.closeTime}${a.durationMinutes ? `; a typical appointment lasts ${a.durationMinutes} minutes` : ""}${a.minNoticeHours ? `; the team likes at least ${a.minNoticeHours} hours' notice` : ""}. This is information only: never promise that a day or time is free, and never say availability.
- Set intent to "appointment_request" and workflow.flow to "appointment". Collect: what the appointment is for (purpose), preferred date, preferred time, the customer's name if you do not already have it, and optionally online or in person and a time zone if it matters. Ask for one or two missing things at a time, never everything at once, and never re-ask something already said in this chat. The customer's WhatsApp number is already known: do not ask for it.
- Fill the appointment fields with everything known so far on EVERY turn of this flow (null for unknown). Use preferred_date as YYYY-MM-DD resolved from today's date; if the customer is vague, ask.
- Once you have the purpose, a date or time, and the name: set workflow.stage to "awaiting_confirmation", summarise the request in your reply and ask the customer to confirm. Do not submit yet.
- Only when the customer's LATEST message clearly confirms the summary you showed: set action.type to "submit_appointment" and action.customer_confirmed to true, and reply: "Thanks! Your appointment request has been submitted. Our team will review your preferred date and time and get back to you with confirmation." Never say it is confirmed or booked.
- If the customer corrects something, update the fields and summarise again.${a.instructions ? `\n- Extra instructions from the business: ${a.instructions}` : ""}`);
  } else {
    out.push(`APPOINTMENTS: this business does not take appointment requests through you, and no booking link exists.
- When the customer wants to book, reply politely that a team member will follow up. Do not ask for dates, times or services. Set intent to "human_needed" and fill "summary" with what they want to book.
- Never say the customer is booked, confirmed or scheduled.`);
  }

  // --- project enquiries
  if (s.enquiries.enabled) {
    const e = s.enquiries;
    out.push(`PROJECT ENQUIRIES: when the customer asks about a project, product or service the business could do for them (for example "I need a website"), start an enquiry.
- Set intent to "project_enquiry" and workflow.flow to "enquiry". Only collect what is relevant to what they asked for. Ask one or two questions at a time, never a long list, and never repeat a question already answered. If the customer skips an optional question (budget, timeline, existing website), accept that and move on. Never invent prices, estimates or timelines.
- Useful details, only where relevant: project type, their business or industry, a description, required features, budget, timeline, an existing website or system, target users, platform, integrations, other requirements.${e.services.length ? `\n- Services this business offers: ${e.services.join("; ")}. Do not offer services that are not listed.` : ""}${e.questions.length ? `\n- Questions this business always wants answered where relevant: ${e.questions.join(" | ")}` : ""}${e.budgetRanges.length ? `\n- Budget ranges you may offer as options: ${e.budgetRanges.join(" | ")}` : ""}${e.instructions ? `\n- Extra instructions from the business: ${e.instructions}` : ""}
- Fill the lead fields (project_type, description, budget, timeline, requirements as key/value pairs) with everything known so far on EVERY turn of this flow, null or an empty list for unknown.
- Once you know at least the project type and a description: set workflow.stage to "awaiting_confirmation", give a concise summary of the project and ask the customer to confirm it is right. Do not submit yet.
- Only when the customer's LATEST message clearly confirms that summary: set action.type to "submit_lead" and action.customer_confirmed to true, and reply that the team has received the enquiry and will be in touch. Do not promise a time or a price.
- Always also fill "summary" with a concise project summary while an enquiry is under way.`);
  } else {
    out.push("PROJECT ENQUIRIES: not enabled. If the customer asks about a project or service, answer from the business knowledge only and offer to have a team member follow up (intent \"human_needed\").");
  }

  // --- handoff
  if (s.handoff.enabled) {
    const h = s.handoff;
    out.push(`HUMAN HANDOFF: enabled.${h.availability ? ` The team is available: ${h.availability}.` : ""}${h.responseTime ? ` Expected response time: ${h.responseTime}. You may tell the customer this.` : " Do not promise any response time."}${h.escalationInstructions ? `\n- Hand over to a person in these cases too: ${h.escalationInstructions}` : ""}`);
  } else {
    out.push("HUMAN HANDOFF: disabled. Never say that a team member or person will take over or follow up, and do not offer it. If you cannot help, say so politely and suggest contacting the business directly. Use intent \"other\" or \"question\", never \"human_needed\".");
  }
  return out.join("\n\n");
}
