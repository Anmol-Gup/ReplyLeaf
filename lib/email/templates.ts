import { oneLine, type MailMessage } from "./mailer";

// Plain-text emails only (no HTML), so customer-written text can't inject markup.
// Pure functions: easy to unit test.

export type OwnerEvent =
  | { type: "new_lead"; contactName: string | null; phone: string; firstMessage: string }
  | { type: "new_booking"; contactName: string | null; phone: string; service: string; preferredTime: string; bookingName: string }
  | { type: "needs_human"; contactName: string | null; phone: string; reason: "customer_request_or_upset" | "failed_answers"; lastMessage: string };

const who = (name: string | null, phone: string) => (name ? `${name} (+${phone})` : `+${phone}`);
const clip = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n)}...` : s);

export function ownerEmail(
  event: OwnerEvent, o: { to: string; businessName: string; appUrl?: string },
): MailMessage {
  const link = o.appUrl ? `\n\nOpen the dashboard: ${o.appUrl.replace(/\/$/, "")}/dashboard` : "";
  switch (event.type) {
    case "new_lead":
      return {
        to: o.to,
        subject: oneLine(`New lead: ${who(event.contactName, event.phone)}`),
        text: `${o.businessName} has a new lead on WhatsApp.\n\nFrom: ${who(event.contactName, event.phone)}\nFirst message: ${clip(event.firstMessage)}${link}`,
      };
    case "new_booking":
      return {
        to: o.to,
        subject: oneLine(`New booking request: ${event.service}`),
        text: `${o.businessName} has a new booking REQUEST (not confirmed yet).\n\nCustomer: ${who(event.contactName, event.phone)}\nName for booking: ${event.bookingName}\nService: ${event.service}\nPreferred time: ${event.preferredTime}\n\nThe customer was told the team will confirm shortly. Please confirm or decline it.${link}`,
      };
    case "needs_human":
      return {
        to: o.to,
        subject: oneLine(`Needs a human: ${who(event.contactName, event.phone)}`),
        text: `${o.businessName}: the assistant has stopped replying to ${who(event.contactName, event.phone)} and is waiting for you.\n\nReason: ${event.reason === "failed_answers" ? "the assistant could not answer twice in a row" : "the customer asked for a person or seems upset"}\nTheir last message: ${clip(event.lastMessage)}\n\nReply from the dashboard, then hand the chat back to the assistant when you are done.${link}`,
      };
  }
}

export function adminAlertEmail(a: { to: string; kind: string; detail: string | null; clientName?: string | null }): MailMessage {
  return {
    to: a.to,
    subject: oneLine(`[WA assistant] ${a.kind}${a.clientName ? ` (${a.clientName})` : ""}`),
    text: `Alert: ${a.kind}\nClient: ${a.clientName ?? "unknown"}\n\n${clip(a.detail ?? "(no detail)", 1500)}`,
  };
}
