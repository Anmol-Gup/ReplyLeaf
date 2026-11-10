import { z } from "zod";

// Pure helpers for leads / project enquiries (unit-tested).

type Tone = "brand" | "success" | "warn" | "danger" | "muted"; // same names as components/ui

export const LEAD_STATUSES = ["new", "qualified", "contacted", "proposal_sent", "negotiation", "won", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_LABELS: Record<LeadStatus, string> = {
  new: "New", qualified: "Qualified", contacted: "Contacted", proposal_sent: "Proposal sent", negotiation: "Negotiation", won: "Won", lost: "Lost",
};
export const LEAD_TONES: Record<LeadStatus, Tone> = {
  new: "warn", qualified: "brand", contacted: "muted", proposal_sent: "muted", negotiation: "brand", won: "success", lost: "danger",
};

export const isOpenLead = (s: LeadStatus) => s !== "won" && s !== "lost";

const realDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // Date gives "Invalid Date" for 2026-02-31: never throw
};
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(realDate, "not a real date");

export const leadFormSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(LEAD_STATUSES),
  follow_up_at: z.union([z.literal(""), isoDate]),
  notes: z.string().max(4000),
});

export type LeadForBrief = {
  customer_name: string | null; customer_phone: string; project_type: string; description: string; budget: string | null;
  timeline: string | null; status: LeadStatus; ai_summary: string | null; follow_up_at: string | null; created_at: string;
};

/** A plain-text project brief the owner can copy or download. Internal notes are NOT included (it may be forwarded). */
export function projectBrief(l: LeadForBrief, requirements: { requirement_key: string; requirement_value: string }[], business: string): string {
  const lines = [
    `PROJECT BRIEF: ${l.project_type}`,
    `Business: ${business}`,
    `Received: ${l.created_at.slice(0, 10)}`,
    "",
    `Customer: ${l.customer_name ?? "(name not given)"} (+${l.customer_phone})`,
    `Status: ${LEAD_LABELS[l.status]}`,
    ...(l.follow_up_at ? [`Follow up on: ${l.follow_up_at}`] : []),
    "",
    "SUMMARY",
    l.ai_summary ?? l.description,
    "",
    "DETAILS",
    `Project type: ${l.project_type}`,
    `Description: ${l.description}`,
    `Budget: ${l.budget ?? "not given"}`,
    `Timeline: ${l.timeline ?? "not given"}`,
    ...requirements.map((r) => `${r.requirement_key}: ${r.requirement_value}`),
  ];
  return lines.join("\n");
}

export function leadOverview(rows: { status: LeadStatus; follow_up_at: string | null }[], today: string) {
  return {
    total: rows.length,
    fresh: rows.filter((r) => r.status === "new" || r.status === "qualified").length,
    open: rows.filter((r) => isOpenLead(r.status)).length,
    dueFollowUp: rows.filter((r) => isOpenLead(r.status) && r.follow_up_at && r.follow_up_at <= today).length,
    won: rows.filter((r) => r.status === "won").length,
  };
}
