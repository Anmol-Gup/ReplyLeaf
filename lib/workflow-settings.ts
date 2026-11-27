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
/** An IANA time zone name such as "Asia/Kolkata". */
export const isTimeZone = (v: string) => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } };
const list = (items: number, each: number) => z.array(z.string().trim().min(1).max(each)).max(items);

export const workflowSettingsSchema = z.object({
  appointments: z.object({
    enabled: z.boolean().default(true),
    instructions: text(1000).default(""),
    workingDays: z.array(z.enum(WEEKDAYS)).max(7).default(["mon", "tue", "wed", "thu", "fri"]),
    openTime: hhmm.default("09:00"),
    closeTime: hhmm.default("17:00"),
    // The business's time zone: "today" and the opening hours are in this zone. null = not chosen yet.
    timezone: z.string().trim().max(60).refine(isTimeZone, "unknown time zone").nullable().default(null),
  }).prefault({}),
  enquiries: z.object({
    enabled: z.boolean().default(true),
    services: list(20, 100).default([]),
    questions: list(10, 200).default([]),
    instructions: text(1000).default(""),
  }).prefault({}),
  support: z.object({
    enabled: z.boolean().default(true),
    categories: list(10, 60).default([]),
    responseTime: text(100).default(""),
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
- Today's date is ${today}. Working days: ${dayList(a.workingDays)}; hours ${a.openTime}-${a.closeTime}${a.timezone ? ` (${a.timezone} time)` : ""}. This is information only: never promise that a day or time is free, and never say availability. Do not suggest or accept a day outside the working days or a time outside the hours; if the customer asks for one, say so kindly and ask for another. The system also checks this and will not let such a request through.
${outOfHoursNote()}
- Set intent to "appointment_request" and workflow.flow to "appointment". Collect, without a form: what the appointment is for (purpose), preferred date, preferred time, the customer's name if you do not already have it, and extra details such as online or in person or a time zone only when they matter. Ask for one or two missing things at a time, never everything at once, and never re-ask something already said in this chat. The customer's WhatsApp number is already known: do not ask for it. EMAIL: when you show the summary, politely add one line asking if they would like to share their email address for appointment-related updates, and that they can also get updates here on WhatsApp (for example: "Would you like to share your email address for appointment-related updates? You can also receive updates here on WhatsApp."). Skip that line if <saved_progress> already shows a known customer email or they already gave one. If they decline or ignore it, carry on: it never delays or blocks the request. If they give one, put it in contact.email.
- Fill the appointment fields with everything known so far on EVERY turn of this flow (null for unknown). Use preferred_date as YYYY-MM-DD resolved from today's date; if the customer is vague, ask.
- Once you have the purpose, a date or time, and the name (the customer name may already be known; do not ask again): set workflow.stage to "awaiting_confirmation", summarise the request in your reply and ask the customer to confirm. Do not submit yet.
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
- Standard details, only where relevant: the customer's name, the service they want, a description, key requirements and expected features or scope, budget range, expected timeline, an existing website or system, target users, platform, integrations. The owner's own questions below come on top of these, not instead of them.${e.services.length ? `\n- Services this business offers: ${e.services.join("; ")}. Do not offer services that are not listed.` : ""}${e.questions.length ? `\n- Questions this business always wants answered where relevant: ${e.questions.join(" | ")}` : ""}${e.instructions ? `\n- Extra instructions from the business: ${e.instructions}` : ""}
- Fill the lead fields (customer_name, project_type, description, budget, timeline, requirements as key/value pairs) with everything known so far on EVERY turn of this flow, null or an empty list for unknown. Judge what a request needs: a small, simple request needs only a couple of details, a larger one (for example an e-commerce site) deserves questions about scope, key features and requirements. Never interrogate. Always ask ONCE about the budget range and ONCE about the expected timeline before you show the summary (both in one short question is fine, and you may say "not sure yet" is an acceptable answer). If the customer declines, says they are not sure, or has already told you, do not ask again and carry on.
- Once you know at least the project type and a description, and you have asked about budget and timeline once, do not keep asking: set workflow.stage to "awaiting_confirmation", give a concise summary of the project and ask the customer to confirm it is right. A missing name never delays the summary: once the project type, description, budget and timeline have each been asked about or given, your NEXT message must be the summary (stage "awaiting_confirmation"), never a separate question about the name. If you still lack the name, add it to that same summary message. EMAIL: in that same message, politely add one line asking whether they would also like to share their email address so the team can send them the project proposal (for example: "Would you also like to share your email address so our team can send you the project proposal?"). Skip that line if <saved_progress> already shows a known customer email or they already gave one. If they decline or ignore it, carry on: it never delays or blocks the enquiry. If they give one, put it in contact.email. Do not submit yet.
- Only when the customer's LATEST message clearly confirms that summary: set action.type to "submit_lead" and action.customer_confirmed to true, and reply that the team has received the enquiry and will be in touch. Do not promise a time or a price.
- Always also fill "summary" with a concise project summary while an enquiry is under way.`);
  } else {
    out.push("PROJECT ENQUIRIES: not enabled. If the customer asks about a project or service, answer from the business knowledge only and offer to have a team member follow up (intent \"human_needed\").");
  }

  // --- support tickets
  if (s.support.enabled) {
    const t = s.support;
    out.push(`SUPPORT TICKETS: when the customer reports a problem or complaint with something they already bought or booked (for example "my order didn't arrive"), log a ticket.
- Set intent to "support_issue" and workflow.flow to "issue". Be brief and kind. Ask one or two questions at a time, only for what the team needs: what went wrong, an order or booking reference if there is one, and what they would like us to do. Never repeat a question already answered. Never promise a refund, replacement, compensation or a resolution time, and never say the problem is fixed.${t.categories.length ? `\n- Categories you may use: ${t.categories.join("; ")}.` : ""}${t.responseTime ? `\n- Expected response time: ${t.responseTime}. You may tell the customer this.` : ""}${t.instructions ? `\n- Extra instructions from the business: ${t.instructions}` : ""}
- Fill the ticket fields (customer_name, subject, description, category, reference_info, priority) with everything known so far on EVERY turn of this flow, null for unknown. priority is "high" ONLY if the customer explicitly says it is urgent or time-critical; an ordinary complaint, however annoyed, is "normal". Ask for an order or booking reference when one would apply (a missing delivery, a billing question), but a ticket without a reference is fine if the customer has none. The system adds the ticket reference to your final reply, so do not invent a ticket number. EMAIL: when you show the summary, politely add one line asking if they would like to share their email address for additional ticket updates, and that you can also keep them updated here on WhatsApp (for example: "Would you like to share your email address for additional ticket updates? We can also keep you updated here on WhatsApp."). Skip that line if <saved_progress> already shows a known customer email or they already gave one. If they decline or ignore it, still create the ticket as normal: the team will use their WhatsApp number. If they give one, put it in contact.email.
- Once you know what went wrong, your NEXT message must be the summary (stage "awaiting_confirmation"): a missing name, order number or category never delays it, and you must never ask for the name as a separate question. If you still lack the name, add it to that same summary message. Summarise the problem and ask the customer to confirm. Do not submit yet. Also fill "summary".
- Only when the customer's LATEST message clearly confirms that summary: set action.type to "submit_ticket" and action.customer_confirmed to true, and reply that the team has logged the issue and will look into it. Do not promise an outcome.`);
  } else {
    out.push("SUPPORT TICKETS: not enabled. If the customer reports a problem, say you are sorry to hear it and, if HUMAN HANDOFF is enabled, that a team member will follow up (intent \"human_needed\").");
  }

  // --- handoff
  if (s.handoff.enabled) {
    const h = s.handoff;
    out.push(`HUMAN HANDOFF: enabled.${teamAvailability(s)}${h.responseTime ? ` Expected response time: ${h.responseTime}. You may tell the customer this.` : " Do not promise any response time."}${h.escalationInstructions ? `\n- Hand over to a person in these cases too: ${h.escalationInstructions}` : ""}`);
  } else {
    out.push("HUMAN HANDOFF: disabled. Never say that a team member or person will take over or follow up, and do not offer it. If you cannot help, say so politely and suggest contacting the business directly. Use intent \"other\" or \"question\", never \"human_needed\".");
  }
  return out.join("\n\n");
}

/** What the assistant may say about when the team is available: the business hours when a time zone is set (one set of hours everywhere), else the older text. */
const teamAvailability = (s: WorkflowSettings): string => {
  const a = s.appointments;
  if (a.timezone) return ` The team is available: ${dayList(a.workingDays.length ? a.workingDays : [...WEEKDAYS])}, ${a.openTime}-${a.closeTime} (${a.timezone} time). Use only these hours.`;
  return s.handoff.availability ? ` The team is available: ${s.handoff.availability}.` : "";
};

/** The rule line for appointment requests: a day or time outside the working days or hours gets the business's contact details from its knowledge. */
export const outOfHoursNote = (): string =>
  "- When the customer asks for a day or time outside the working days or hours, say so politely and ask for another day or time. Do not share contact details for this.";

// ---- "closed right now": decided by code, in the business's time zone, then told to the assistant (it never guesses the time)
export type OpenStatus = { open: boolean; now: string; hours: string; nextOpen: string | null } | null;

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

/**
 * Is the business open at `now`? Uses the working days, hours and time zone saved in the settings. Returns null when no time zone has
 * been chosen (the local time is unknown, so nothing is claimed). No working days ticked means every day counts as a working day.
 */
export function businessStatus(now: Date, s: WorkflowSettings): OpenStatus {
  const zone = s.appointments.timezone;
  if (!zone) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  } catch { return null; }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dayIx = WEEKDAYS.findIndex((d) => d === get("weekday").slice(0, 3).toLowerCase());
  if (dayIx < 0) return null;
  const minutes = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
  const a = s.appointments;
  const works = (i: number) => a.workingDays.length === 0 || a.workingDays.includes(WEEKDAYS[i]);
  const open = works(dayIx) && minutes >= toMin(a.openTime) && minutes < toMin(a.closeTime);
  let nextOpen: string | null = null;
  if (!open) {
    if (works(dayIx) && minutes < toMin(a.openTime)) nextOpen = `today at ${a.openTime}`;
    else for (let k = 1; k <= 7 && !nextOpen; k++) {
      const i = (dayIx + k) % 7;
      if (works(i)) nextOpen = `${k === 1 ? "tomorrow" : WEEKDAY_LABELS[WEEKDAYS[i]]} at ${a.openTime}`;
    }
  }
  return { open, now: `${WEEKDAY_LABELS[WEEKDAYS[dayIx]]} ${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")} (${zone})`, hours: `${dayList(a.workingDays.length ? a.workingDays : [...WEEKDAYS])}, ${a.openTime}-${a.closeTime}`, nextOpen };
}

/** The rule added to the assistant's context while the business is closed. "" when it is open or the time zone is not set. */
export function renderClosedHours(status: OpenStatus): string {
  if (!status || status.open) return "";
  const next = status.nextOpen ? ` and the team is next available ${status.nextOpen}` : "";
  return `The business is CLOSED right now: it is ${status.now}, and the business hours are ${status.hours}${next}. Answer every normal question (services, prices, business information, anything else) from the business knowledge exactly as usual, and do NOT share contact details or mention being closed for those. ONLY when the customer asks to speak to, talk to, call or be connected with a person (a human, the owner, the team): say kindly that the team is not available right now${status.nextOpen ? ` and that they are next available ${status.nextOpen}` : ""}, and in the SAME message share the business's contact details (email, phone, WhatsApp) from the business knowledge exactly as written. If the knowledge has none, say the team will reply when it is next available. Never invent or change a phone number or email. Use these business hours, not any other hours.`;
}

/** The settings form (checkboxes, text boxes, one-item-per-line textareas) -> the settings shape, before validation.
 *  `get` returns a field's text, or null when it is missing (an unchecked checkbox is missing). */
export function formToWorkflowInput(get: (name: string) => string | null): unknown {
  const on = (n: string) => get(n) !== null;
  const text = (n: string) => get(n) ?? "";
  return {
    appointments: {
      enabled: on("appointments_enabled"),
      instructions: text("appointment_instructions"),
      workingDays: WEEKDAYS.filter((d) => on(`day_${d}`)),
      openTime: text("open_time") || "09:00",
      closeTime: text("close_time") || "17:00",
      timezone: text("timezone").trim() || null,
    },
    enquiries: {
      enabled: on("enquiries_enabled"),
      services: linesToList(text("services"), 20, 100),
      questions: linesToList(text("questions"), 10, 200),
      instructions: text("enquiry_instructions"),
    },
    support: {
      enabled: on("support_enabled"),
      categories: linesToList(text("support_categories"), 10, 60),
      responseTime: text("support_response_time"),
      instructions: text("support_instructions"),
    },
    handoff: {
      enabled: on("handoff_enabled"),
      availability: text("availability"),
      responseTime: text("response_time"),
      escalationInstructions: text("escalation_instructions"),
    },
  };
}
