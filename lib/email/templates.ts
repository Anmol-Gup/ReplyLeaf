import { emailLayout } from "./html";
import { oneLine, type MailMessage } from "./mailer";
import { SOURCE_LABELS, type HandoffSource } from "../handoff";

// Plain-text emails only (no HTML), so customer-written text can't inject markup.
// Pure functions: easy to unit test.

export type OwnerEvent =
  | { type: "new_lead"; contactName: string | null; phone: string; firstMessage: string }
  | { type: "onboarded"; businessName: string }
  | { type: "needs_human"; contactName: string | null; phone: string; reason: HandoffSource; lastMessage: string; summary: string };

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
    case "onboarded":
      return {
        to: o.to,
        subject: oneLine(`Your WhatsApp number is connected: ${event.businessName}`),
        text: `Your WhatsApp number is now connected to the assistant for ${event.businessName}.\n\nNext steps: add your business knowledge, then send a test message to your number.\nWhatsApp may take a few minutes to confirm the connection; the dashboard shows the status.${link}`,
      };
    case "needs_human": {
      const handoffLink = o.appUrl ? `\n\nOpen the Human Handoff page: ${o.appUrl.replace(/\/$/, "")}/dashboard/handoff` : "";
      return {
        to: o.to,
        subject: oneLine(`Needs a human: ${who(event.contactName, event.phone)}`),
        text: `${o.businessName}: the assistant has stopped replying to ${who(event.contactName, event.phone)} and is waiting for you.\n\nReason: ${SOURCE_LABELS[event.reason]}\nSummary: ${clip(event.summary)}\nTheir last message: ${clip(event.lastMessage)}\n\nNext step: open the chat, reply to the customer, then mark it resolved or hand it back to the assistant.${event.reason === "booking_without_link" ? "\nTip: add a booking link in Settings so the assistant can share it next time." : ""}${handoffLink}`,
      };
    }
  }
}

export function adminAlertEmail(a: { to: string; kind: string; detail: string | null; clientName?: string | null }): MailMessage {
  return {
    to: a.to,
    subject: oneLine(`[WA assistant] ${a.kind}${a.clientName ? ` (${a.clientName})` : ""}`),
    text: `Alert: ${a.kind}\nClient: ${a.clientName ?? "unknown"}\n\n${clip(a.detail ?? "(no detail)", 1500)}`,
  };
}

// ---- sign-up emails (branded HTML + plain-text twin) ----

const base = (appUrl?: string) => appUrl?.replace(/\/$/, "");

/** To the admin, once a new sign-up has verified their email and is waiting for approval. */
export function signupNotificationEmail(a: { to: string; email: string; business: string; appUrl?: string }): MailMessage {
  const review = base(a.appUrl) ? `${base(a.appUrl)}/admin/signups` : undefined;
  return {
    to: a.to,
    subject: oneLine(`New sign-up waiting for approval: ${a.business}`),
    text: `A new account has verified their email and is waiting for your approval.\n\nBusiness: ${a.business}\nEmail: ${a.email}\n\n${review ? `Review and approve: ${review}\n\n` : ""}Or from a terminal: npm run approve-user -- ${a.email}`,
    html: emailLayout({
      preheader: `${a.business} is waiting for approval`,
      heading: "New sign-up waiting for approval",
      paragraphs: ["Someone has verified their email address and is waiting for you to approve their access."],
      details: [{ label: "Business", value: a.business }, { label: "Email", value: a.email }],
      button: review ? { label: "Review and approve", url: review } : undefined,
      footer: review ? undefined : "Approve from a terminal with: npm run approve-user -- " + a.email,
    }),
  };
}

/** To the new owner, once they have verified their email and are on the waiting list. */
export function pendingUserEmail(a: { to: string; business: string }): MailMessage {
  return {
    to: a.to,
    subject: "You're on the list: we'll email you when your access is ready",
    text: `Thanks for signing up${a.business ? ` (${a.business})` : ""}.\n\nYour email is verified and your account is on our waiting list. We're onboarding businesses in small groups, and we'll email you as soon as your access is approved.\n\nYou don't need to do anything else.`,
    html: emailLayout({
      preheader: "Your email is verified. We'll let you know when you're approved.",
      heading: "You're on the list",
      paragraphs: [
        `Thanks for signing up${a.business ? `, ${a.business}` : ""}. Your email is verified and your account is on our waiting list.`,
        "We're onboarding businesses in small groups. We'll email you as soon as your access is approved. You don't need to do anything else.",
      ],
      footer: "You're receiving this because you created an account.",
    }),
  };
}

/** To the new owner: their access was approved. */
export function approvedEmail(a: { to: string; appUrl?: string }): MailMessage {
  const login = base(a.appUrl) ? `${base(a.appUrl)}/login` : undefined;
  return {
    to: a.to,
    subject: "Your access is ready",
    text: `Good news: your account has been approved.${login ? `\n\nSign in: ${login}` : ""}\n\nAfter signing in you can connect your WhatsApp number and set up your assistant.`,
    html: emailLayout({
      preheader: "Your account has been approved. Sign in to get started.",
      heading: "Your access is ready",
      paragraphs: [
        "Good news: your account has been approved.",
        "After signing in you can connect your WhatsApp number and set up your assistant.",
      ],
      button: login ? { label: "Sign in", url: login } : undefined,
    }),
  };
}
