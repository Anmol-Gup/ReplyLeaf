import { z } from "zod";

// The ONLY shape we accept from a model. Anything that fails this is discarded;
// we never act on unvalidated model output.
//
// Intent "booking" means the customer wants to book. The assistant never takes bookings itself:
// it shares the business's booking link, or (no link) hands the chat to a person.
//
// Note: `answered` goes beyond the original spec. It is the signal we need for
// "two failed answers => human takeover" and for logging unanswered questions.
export const INTENTS = ["question", "booking", "human_needed", "other"] as const;

export const ReplySchema = z.object({
  reply: z.string().trim().min(1).max(1500), // WhatsApp allows 4096; keep replies short
  intent: z.enum(INTENTS),
  answered: z.boolean(),
  contact: z.object({
    name: z.string().trim().max(100).nullable(),
    email: z.string().trim().max(200).nullable(), // validated properly before use (Stage 3)
  }),
  // What the customer needs, for the team. Only used when a person takes over; capped again before saving.
  summary: z.string().trim().max(600).nullable(),
});

export type ReplyResult = z.infer<typeof ReplySchema>;

// The same shape as JSON Schema, sent to the providers so they constrain their
// output. Written to satisfy OpenAI strict mode (every property required,
// additionalProperties false) and Gemini (type arrays for nullable fields).
const nullableString = (description: string) => ({ type: ["string", "null"], description });

export const REPLY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "intent", "answered", "contact", "summary"],
  properties: {
    reply: { type: "string", description: "The WhatsApp message to send to the customer." },
    intent: { type: "string", enum: [...INTENTS] },
    answered: {
      type: "boolean",
      description: "true only if the customer's question was answered using the business knowledge (or no question was asked). false if you had to say you will check with the team.",
    },
    contact: {
      type: "object",
      additionalProperties: false,
      required: ["name", "email"],
      properties: {
        name: nullableString("Customer's name only if they clearly stated it, else null."),
        email: nullableString("Customer's email only if they clearly stated it, else null."),
      },
    },
    summary: nullableString("When intent is human_needed (or the customer wants to book and no booking link exists): one or two plain sentences telling the team what the customer needs, based only on this conversation. Otherwise null."),
  },
} as const;
