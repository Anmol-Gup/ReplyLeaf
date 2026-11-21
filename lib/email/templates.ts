import { emailLayout } from "./html";
import { oneLine, type MailMessage } from "./mailer";
import { SOURCE_LABELS, type HandoffSource } from "../handoff";

// Plain-text emails only (no HTML), so customer-written text can't inject markup.
// Pure functions: easy to unit test.

export type OwnerEvent =
  | { type: "new_lead"; contactName: string | null; phone: string; firstMessage: string }
  | { type: "appointment_request"; contactName: string | null; phone: string; purpose: string; preferredDate: string | null; preferredTime: string | null; appointmentType: "online" | "in_person" | null; notes: string | null }
  | { type: "appointment_update"; status: "confirmed" | "reschedule_requested" | "cancelled" | "rejected"; contactName: string | null; phone: string; purpose: string; when: string | null; note: string | null }
  | { type: "lead_created"; contactName: string | null; phone: string; projectType: string; budget: string | null; timeline: string | null; summary: string; status: "new" | "qualified" }
  | { type: "ticket_created"; contactName: string | null; phone: string; subject: string; category: string | null; referenceInfo: string | null; priority: "normal" | "high"; summary: string }
  | { type: "ai_key_problem"; problem: "missing" | "invalid" }
  | { type: "whatsapp_problem"; problem: "billing" | "account" | "permission" | "policy" }
  | { type: "onboarded"; businessName: string }
  | { type: "needs_human"; conversationId?: string; contactName: string | null; phone: string; reason: HandoffSource; lastMessage: string; summary: string };

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
    case "appointment_request": {
      const when = [event.preferredDate, event.preferredTime].filter(Boolean).join(" ") || "not given";
      return {
        to: o.to,
        subject: oneLine(`New appointment request: ${who(event.contactName, event.phone)}`),
        text: `${o.businessName} has a new appointment REQUEST (not confirmed yet).\n\nCustomer: ${who(event.contactName, event.phone)}\nFor: ${clip(event.purpose, 300)}\nPreferred: ${when}${event.appointmentType ? `\nType: ${event.appointmentType === "online" ? "online" : "in person"}` : ""}${event.notes ? `\nNotes: ${clip(event.notes, 300)}` : ""}\n\nThe customer was told the team will review it and get back to them. Next step: open Appointments, then confirm, reject or propose another time.${o.appUrl ? `\n\nOpen Appointments: ${o.appUrl.replace(/\/$/, "")}/dashboard/appointments` : ""}`,
      };
    }
    case "appointment_update": {
      const verb = { confirmed: "was CONFIRMED", reschedule_requested: "needs RESCHEDULING", cancelled: "was CANCELLED", rejected: "was DECLINED" }[event.status];
      return {
        to: o.to,
        subject: oneLine(`Appointment ${verb.toLowerCase()}: ${who(event.contactName, event.phone)}`),
        text: `${o.businessName}: the appointment for ${who(event.contactName, event.phone)} ${verb}.\n\nFor: ${clip(event.purpose, 300)}${event.when ? `\nWhen: ${event.when}` : ""}${event.note ? `\nNote: ${clip(event.note, 300)}` : ""}${o.appUrl ? `\n\nOpen Appointments: ${o.appUrl.replace(/\/$/, "")}/dashboard/appointments` : ""}`,
      };
    }
    case "lead_created":
      return {
        to: o.to,
        subject: oneLine(`New ${event.status === "qualified" ? "qualified " : ""}lead: ${event.projectType}`),
        text: `${o.businessName} has a new project enquiry (${event.status === "qualified" ? "qualified: budget and timeline given" : "new: some details still missing"}).\n\nCustomer: ${who(event.contactName, event.phone)}\nProject: ${clip(event.projectType, 200)}\nBudget: ${event.budget ?? "not given"}\nTimeline: ${event.timeline ?? "not given"}\n\nSummary: ${clip(event.summary, 600)}\n\nNext step: open Leads, review the details and get in touch.${o.appUrl ? `\n\nOpen Leads: ${o.appUrl.replace(/\/$/, "")}/dashboard/leads` : ""}`,
      };
    case "ticket_created":
      return {
        to: o.to,
        subject: oneLine(`${event.priority === "high" ? "URGENT ticket" : "New ticket"}: ${event.subject}`),
        text: `${o.businessName} has a new ticket${event.priority === "high" ? " marked URGENT by the customer" : ""}.\n\nCustomer: ${who(event.contactName, event.phone)}\nIssue: ${clip(event.subject, 200)}${event.category ? `\nCategory: ${event.category}` : ""}${event.referenceInfo ? `\nReference: ${event.referenceInfo}` : ""}\n\nSummary: ${clip(event.summary, 600)}\n\nThe customer was told the team has logged it and will look into it. Next step: open Tickets, look into it and keep the customer updated.${o.appUrl ? `\n\nOpen Tickets: ${o.appUrl.replace(/\/$/, "")}/dashboard/tickets` : ""}`,
      };
    case "ai_key_problem":
      return {
        to: o.to,
        subject: oneLine(event.problem === "missing" ? "Your assistant is switched off: add your AI key" : "Your assistant is switched off: your AI key was refused"),
        text: `${o.businessName}: your WhatsApp assistant can't reply right now because ${event.problem === "missing" ? "no AI key has been added yet" : "the AI provider refused your key (it may have been revoked or have no credit)"}.\n\nUntil it is fixed, customers who message you get a short "our team will reply" message and their chats appear in Human handoff so nothing is lost.\n\nNext step: open Settings, then AI, and add or replace your key. After that, open Human handoff and click Resume assistant on the chats you want the assistant to take back.${o.appUrl ? `\n\nOpen Settings: ${o.appUrl.replace(/\/$/, "")}/dashboard/settings` : ""}`,
      };
    case "whatsapp_problem": {
      const what: Record<typeof event.problem, { subject: string; body: string; step: string }> = {
        billing: { subject: "WhatsApp could not deliver your assistant's reply: a billing problem", body: "WhatsApp refused to deliver a message because of a billing problem with your WhatsApp Business Account. This is separate from your Replyleaf subscription and your AI provider.", step: "Open WhatsApp Manager (business.facebook.com) and check the payment method on your WhatsApp Business Account. You get 1,000 free service messages each month per phone number; after that a valid payment method is needed." },
        account: { subject: "WhatsApp could not deliver your assistant's reply: account problem", body: "WhatsApp refused to deliver a message because of a problem with your WhatsApp account or phone number (for example it is restricted or not registered).", step: "Open WhatsApp Manager and check the status of your account and phone number." },
        permission: { subject: "WhatsApp could not deliver your assistant's reply: reconnect WhatsApp", body: "WhatsApp refused a message because the connection to your account has expired or lacks permission.", step: "Open Settings, then WhatsApp, and reconnect your number." },
        policy: { subject: "WhatsApp could not deliver your assistant's reply: policy block", body: "WhatsApp blocked a message under one of its messaging policies.", step: "Check the notices in WhatsApp Manager. Replyleaf does not retry blocked messages." },
      };
      const w = what[event.problem];
      return {
        to: o.to,
        subject: oneLine(w.subject),
        text: `${o.businessName}: ${w.body}\n\nThe customer's message is saved and the chat is still in your Conversations. Replyleaf will not keep retrying a message that WhatsApp refuses.\n\nNext step: ${w.step}\n\nYou are emailed about this at most once a day.${o.appUrl ? `\n\nOpen Conversations: ${o.appUrl.replace(/\/$/, "")}/dashboard/conversations` : ""}`,
      };
    }
    case "onboarded":
      return {
        to: o.to,
        subject: oneLine(`Your WhatsApp number is connected: ${event.businessName}`),
        text: `Your WhatsApp number is now connected to the assistant for ${event.businessName}.\n\nNext steps: add your business knowledge, then send a test message to your number.\nWhatsApp may take a few minutes to confirm the connection; the dashboard shows the status.${link}`,
      };
    case "needs_human": {
      const base = o.appUrl?.replace(/\/$/, "");
      const handoffLink = base ? (event.conversationId ? `\n\nOpen the conversation: ${base}/dashboard/conversations/${event.conversationId}\n(You will be asked to sign in first.)` : `\n\nOpen the Human Handoff page: ${base}/dashboard/handoff`) : "";
      return {
        to: o.to,
        subject: oneLine(`Needs a human: ${who(event.contactName, event.phone)}`),
        text: `${o.businessName}: the assistant has stopped replying to ${who(event.contactName, event.phone)} and is waiting for you.\n\nReason: ${SOURCE_LABELS[event.reason]}\nSummary: ${clip(event.summary)}\nTheir last message: ${clip(event.lastMessage)}\n\nNext step: open the chat, take over, reply to the customer, then resume the assistant when you are done.${event.reason === "booking_without_link" ? "\nTip: add a booking link in Settings so the assistant can share it next time." : ""}${handoffLink}`,
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

const KIND = { ticket: ["ticket", "Ticket", "Open ticket in Replyleaf", "Please review the issue and follow up with the customer."], appointment: ["appointment", "Appointment", "Open appointment in Replyleaf", "Please review the request and get back to the customer."], handoff: ["conversation", "Conversation", "Open conversation in Replyleaf", "The customer is waiting for a person. Please review the details and reply."] } as const;

/** Sent to whoever a ticket, appointment or handoff is assigned to by email. Branded HTML plus a plain-text twin; every value is escaped or clipped. */
export function assignedEmail(a: {
  to: string; kind: keyof typeof KIND; title: string; ref?: string; customerName: string | null; phone: string; detailLabel: string; detail: string;
  path: string; assignedBy: string; businessName: string; appUrl?: string;
}): MailMessage {
  const [noun, Noun, buttonLabel, ask] = KIND[a.kind];
  const url = a.appUrl ? `${a.appUrl.replace(/\/$/, "")}${a.path}` : undefined;
  const phone = a.phone ? `+${a.phone.replace(/^\+/, "")}` : "";
  const rows = [
    { label: Noun, value: clip(a.title, 200) },
    ...(a.ref ? [{ label: `${Noun} ID`, value: a.ref }] : []),
    { label: "Customer", value: a.customerName || phone || "Not given" },
    ...(a.customerName && phone ? [{ label: "Phone", value: phone }] : []),
    ...(a.detail ? [{ label: a.detailLabel, value: clip(a.detail, 500) }] : []),
  ];
  const text = `Hi,\n\nA ${noun} has been assigned to you by ${a.businessName}.\n\n${rows.map((r) => `${r.label}: ${r.value}`).join("\n")}${url ? `\n\n${buttonLabel}: ${url}` : ""}\n\n${ask}\n\nThanks,\n${a.businessName}\nPowered by Replyleaf`;
  return {
    to: a.to,
    subject: oneLine(`${Noun} assigned to you: ${a.title}`),
    text,
    html: emailLayout({
      preheader: `${a.assignedBy} assigned you: ${a.title}`.slice(0, 120),
      heading: `A ${noun} has been assigned to you`,
      paragraphs: [`Hi, ${a.businessName} has assigned a ${noun} to you.`],
      details: rows,
      plainValues: true,
      button: url ? { label: buttonLabel, url } : undefined,
      footer: `${ask} Powered by Replyleaf.`,
      brandName: a.businessName,
    }),
  };
}
