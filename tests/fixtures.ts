import type { ReplyResult } from "../lib/ai/schema";

// A complete, valid model reply. Tests override only what they care about.
export const baseReply = (over: Partial<ReplyResult> = {}): ReplyResult => ({
  reply: "We open at 9.", intent: "question", answered: true,
  contact: { name: null, email: null }, summary: null,
  workflow: { flow: null, stage: null },
  appointment: { purpose: null, preferred_date: null, preferred_time: null, timezone: null, appointment_type: null, notes: null, customer_name: null },
  lead: { project_type: null, description: null, budget: null, timeline: null, requirements: [], customer_name: null },
  ticket: { subject: null, description: null, category: null, reference_info: null, priority: null, customer_name: null },
  action: { type: "none", customer_confirmed: false },
  ...over,
});
