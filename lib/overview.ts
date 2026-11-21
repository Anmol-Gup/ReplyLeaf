import { buildQuery } from "./paginate";
import type { AiMode, KeyStatus } from "./ai-keys";
import { keyProblem } from "./ai-keys";

// What the Overview page counts and links to. Pure (unit-tested). The status sets below are the SINGLE definition: the counts, the
// "Needs your attention" list and the filtered pages they open all use them, so a number on the Overview always matches the list
// you land on.

/** Chats waiting for a person to take over: asked for, or assigned but not yet being handled. Not "being handled" and not resolved. */
export const HANDOFF_WAITING = ["requested", "assigned"] as const;
/** Appointment requests the owner has not yet decided on. An appointment is not a booking until the owner confirms it. */
export const APPOINTMENTS_TO_CONFIRM = ["pending"] as const;
/** Tickets that are not resolved or closed. */
export const TICKETS_OPEN = ["open", "in_progress", "waiting_on_customer"] as const;
/** Leads nobody has contacted yet. */
export const LEADS_NEW = ["new", "qualified"] as const;
/** Leads still being worked: the only ones a follow-up can be due for (never won or lost). */
export const LEADS_ACTIVE = ["new", "qualified", "contacted", "proposal_sent", "negotiation"] as const;

/** A follow-up is due when its date has arrived (or passed) and the lead is still being worked. */
export const isFollowUpDue = (l: { status: string; follow_up_at: string | null }, today: string) =>
  (LEADS_ACTIVE as readonly string[]).includes(l.status) && Boolean(l.follow_up_at) && (l.follow_up_at as string) <= today;

// ---- where each number leads (existing pages, with their filters already applied)
const q = (path: string, params: Record<string, string | string[] | undefined>) => `${path}${buildQuery(params)}`;
export const overviewLinks = {
  handoffs: q("/dashboard/handoff", { view: "waiting" }),
  appointments: q("/dashboard/appointments", { status: [...APPOINTMENTS_TO_CONFIRM] }),
  tickets: q("/dashboard/tickets", { status: [...TICKETS_OPEN] }),
  highTickets: q("/dashboard/tickets", { status: [...TICKETS_OPEN], priority: ["high"] }),
  newLeads: q("/dashboard/leads", { status: [...LEADS_NEW] }),
  followUps: q("/dashboard/leads", { due: "1" }),
  contacts: "/dashboard/contacts",
};

export type Counts = {
  handoffs: number | null; appointments: number | null; tickets: number | null; highTickets: number | null;
  newLeads: number | null; followUps: number | null; contacts: number | null;
};

export type AttentionItem = { key: string; n: number; text: (n: number) => string; href: string; tone: "danger" | "warn" | "brand" };

const plural = (n: number, one: string, many: string) => `${one === many ? one : n === 1 ? one : many}`;

/** What needs the owner, most urgent first. Only categories with something in them; an unavailable count (null) is left out, never guessed. */
export function buildAttention(c: Counts): { key: string; n: number; text: string; href: string; tone: AttentionItem["tone"] }[] {
  const items: AttentionItem[] = [
    { key: "handoffs", n: c.handoffs ?? 0, text: (n) => `${n === 1 ? "chat is" : "chats are"} waiting for a person`, href: overviewLinks.handoffs, tone: "danger" },
    { key: "highTickets", n: c.highTickets ?? 0, text: (n) => `high-priority open ${plural(n, "ticket", "tickets")}`, href: overviewLinks.highTickets, tone: "danger" },
    { key: "appointments", n: c.appointments ?? 0, text: (n) => `appointment ${plural(n, "request", "requests")} to confirm`, href: overviewLinks.appointments, tone: "warn" },
    { key: "followUps", n: c.followUps ?? 0, text: (n) => `lead ${plural(n, "follow-up", "follow-ups")} due`, href: overviewLinks.followUps, tone: "warn" },
    { key: "newLeads", n: c.newLeads ?? 0, text: (n) => `new or qualified ${plural(n, "lead", "leads")} to contact`, href: overviewLinks.newLeads, tone: "brand" },
  ];
  return items.filter((i) => i.n > 0).map((i) => ({ key: i.key, n: i.n, text: i.text(i.n), href: i.href, tone: i.tone }));
}

// ---- is the assistant ready to answer customers?
export type ReadinessInput = {
  hasPhone: boolean; onboardingStatus: string | null; clientStatus: string | null;
  aiMode: AiMode; hasKey: boolean; keyStatus: KeyStatus;
  billingAllowed: boolean; kbReady: boolean;
};
export type ReadinessRow = { key: "whatsapp" | "ai" | "assistant" | "knowledge"; label: string; state: string; tone: "success" | "warn" | "danger" | "muted"; href: string | null; ok: boolean };

export function assistantReadiness(i: ReadinessInput): { rows: ReadinessRow[]; active: boolean; problems: string[] } {
  const waFailed = i.onboardingStatus === "failed";
  const waOk = i.hasPhone && !waFailed;
  const aiProblem = keyProblem(i.aiMode, i.hasKey, i.keyStatus);
  const aiOk = aiProblem === null;
  const paused = i.clientStatus === "paused" && waOk; // a paused, otherwise connected account was switched off by the platform

  const problems: string[] = [];
  if (!i.hasPhone) problems.push("No WhatsApp number is connected, so there are no customer chats to answer.");
  else if (waFailed) problems.push("The WhatsApp connection needs attention.");
  if (aiProblem === "missing") problems.push("No AI key is configured, so the assistant cannot answer customers. Their chats go to Human handoff.");
  if (aiProblem === "invalid") problems.push("Your AI provider refused the key, so the assistant cannot answer customers. Their chats go to Human handoff.");
  if (paused) problems.push("This account is paused. Please contact the platform admin.");
  if (!i.billingAllowed) problems.push("Your subscription is not active, so the assistant is off. See Billing.");
  const active = waOk && aiOk && !paused && i.billingAllowed;

  const rows: ReadinessRow[] = [
    { key: "whatsapp", label: "WhatsApp", state: !i.hasPhone ? "Disconnected" : waFailed ? "Needs attention" : "Connected", tone: !i.hasPhone ? "danger" : waFailed ? "warn" : "success", href: waOk ? null : "/dashboard/settings?tab=whatsapp", ok: waOk },
    { key: "ai", label: "AI provider", state: aiProblem === "missing" ? "Not configured" : aiProblem === "invalid" ? "Connection error" : "Connected", tone: aiOk ? "success" : "danger", href: aiOk ? null : "/dashboard/settings?tab=ai", ok: aiOk },
    { key: "assistant", label: "Assistant", state: active ? "Active" : "Inactive", tone: active ? "success" : "danger", href: null, ok: active },
    { key: "knowledge", label: "Knowledge base", state: i.kbReady ? "Ready" : "Empty", tone: i.kbReady ? "success" : "muted", href: i.kbReady ? null : "/dashboard/knowledge", ok: i.kbReady },
  ];
  return { rows, active, problems };
}

/** A count for display: the number, or a dash when it could not be read (never a made-up zero). */
export const showCount = (n: number | null) => (n === null ? "-" : n.toLocaleString());
