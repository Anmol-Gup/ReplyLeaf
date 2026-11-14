import { z } from "zod";

// The ONLY shape we accept from a model. Anything that fails this is discarded;
// we never act on unvalidated model output. Even valid output is only a PROPOSAL: lib/workflow.ts decides
// whether a request may be saved (feature switched on, the customer confirmed, required fields present).
//
// Intents: question (general question), appointment_request, project_enquiry, support_issue (a problem to raise),
// human_needed (handoff), other.
// Note: `answered` goes beyond the original spec. It is the signal we need for
// "two failed answers => human takeover" and for logging unanswered questions.
export const INTENTS = ["question", "appointment_request", "project_enquiry", "support_issue", "human_needed", "other"] as const;
export const FLOWS = ["appointment", "enquiry", "issue"] as const;
export const STAGES = ["collecting", "awaiting_confirmation"] as const;
export const ACTION_TYPES = ["none", "submit_appointment", "submit_lead", "submit_ticket"] as const;
export const PRIORITIES = ["normal", "high"] as const;
export const APPOINTMENT_TYPES = ["online", "in_person"] as const;

const short = (max: number) => z.string().trim().max(max).nullable();

export const ReplySchema = z.object({
  reply: z.string().trim().min(1).max(1500), // WhatsApp allows 4096; keep replies short
  intent: z.enum(INTENTS),
  answered: z.boolean(),
  contact: z.object({
    name: z.string().trim().max(100).nullable(),
    email: z.string().trim().max(200).nullable(), // validated properly before use (Stage 3)
  }),
  // What the customer needs, for the team. Used for handoffs and enquiries; capped again before saving.
  summary: short(600),
  // Where the assistant is in a multi-step flow. The server stores it and uses it as a guard.
  workflow: z.object({
    flow: z.enum(FLOWS).nullable(),
    stage: z.enum(STAGES).nullable(),
  }),
  // Everything known so far about an appointment request (repeated on every turn of that flow).
  appointment: z.object({
    purpose: short(300),
    preferred_date: short(20), // YYYY-MM-DD, checked in code
    preferred_time: short(60),
    timezone: short(60),
    appointment_type: z.enum(APPOINTMENT_TYPES).nullable(),
    notes: short(500),
    customer_name: short(100),
  }),
  // Everything known so far about a project enquiry.
  lead: z.object({
    project_type: short(200),
    description: short(1500),
    budget: short(100),
    timeline: short(100),
    requirements: z.array(z.object({ key: z.string().trim().min(1).max(60), value: z.string().trim().min(1).max(300) })).max(15),
  }),
  // Everything known so far about a support problem the customer wants to raise.
  ticket: z.object({
    subject: short(150),
    description: short(1500),
    category: short(60),
    reference_info: short(100), // an order or invoice number, if they gave one
    priority: z.enum(PRIORITIES).nullable(),
  }),
  // The ONLY way a request gets saved. Needs customer_confirmed AND the server-side checks.
  action: z.object({
    type: z.enum(ACTION_TYPES),
    customer_confirmed: z.boolean(),
  }),
});

export type ReplyResult = z.infer<typeof ReplySchema>;

// The same shape as JSON Schema, sent to the providers so they constrain their
// output. Written to satisfy OpenAI strict mode (every property required,
// additionalProperties false) and Gemini (type arrays for nullable fields).
const nullableString = (description: string) => ({ type: ["string", "null"], description });
const nullableEnum = (values: readonly string[], description: string) => ({ type: ["string", "null"], enum: [...values, null], description });
const obj = <P extends Record<string, unknown>>(properties: P) => ({ type: "object" as const, additionalProperties: false as const, required: Object.keys(properties), properties });

export const REPLY_JSON_SCHEMA = obj({
  reply: { type: "string", description: "The WhatsApp message to send to the customer." },
  intent: { type: "string", enum: [...INTENTS] },
  answered: {
    type: "boolean",
    description: "true only if the customer's question was answered using the business knowledge (or no question was asked). false if you had to say you will check with the team.",
  },
  contact: obj({
    name: nullableString("Customer's name only if they clearly stated it, else null."),
    email: nullableString("Customer's email only if they clearly stated it, else null."),
  }),
  summary: nullableString("One or two plain sentences telling the team what the customer needs (handoffs, project enquiries and support problems), based only on this conversation. Otherwise null."),
  workflow: obj({
    flow: nullableEnum(FLOWS, "The multi-step flow in progress: appointment, enquiry or issue, else null."),
    stage: nullableEnum(STAGES, "collecting while details are missing; awaiting_confirmation once you have shown the customer a summary and asked them to confirm; else null."),
  }),
  appointment: obj({
    purpose: nullableString("What the appointment is for, else null."),
    preferred_date: nullableString("Preferred date as YYYY-MM-DD, else null."),
    preferred_time: nullableString("Preferred time in the customer's words, else null."),
    timezone: nullableString("Customer's time zone if relevant and stated, else null."),
    appointment_type: nullableEnum(APPOINTMENT_TYPES, "online or in_person if the customer said, else null."),
    notes: nullableString("Anything else the customer wants the team to know, else null."),
    customer_name: nullableString("Customer's name for the appointment, else null."),
  }),
  lead: obj({
    project_type: nullableString("The kind of project or service, for example 'e-commerce website', else null."),
    description: nullableString("What the customer wants, in a few sentences, else null."),
    budget: nullableString("Budget in the customer's words if given, else null."),
    timeline: nullableString("Timeline in the customer's words if given, else null."),
    requirements: {
      type: "array",
      description: "Other structured details as key/value pairs, for example {key: 'platform', value: 'Shopify'}. Empty list if none.",
      items: obj({ key: { type: "string" }, value: { type: "string" } }),
    },
  }),
  ticket: obj({
    subject: nullableString("A short title for the problem, for example 'Order not delivered', else null."),
    description: nullableString("What went wrong and what the customer wants, in a few sentences, else null."),
    category: nullableString("A short category such as delivery, billing, product or account, else null."),
    reference_info: nullableString("An order or invoice number the customer gave, else null."),
    priority: nullableEnum(PRIORITIES, "high only if the customer says it is urgent or time-critical, otherwise normal."),
  }),
  action: obj({
    type: { type: "string", enum: [...ACTION_TYPES], description: "none unless the customer has just confirmed the summary you showed them." },
    customer_confirmed: { type: "boolean", description: "true only if the customer's latest message clearly confirms the summary you showed." },
  }),
});
