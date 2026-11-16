import { emailLayout } from "./email/html";
import { oneLine, type MailMessage } from "./email/mailer";

// The daily summary email. Pure (unit-tested): the data is gathered elsewhere, this decides what to say.
// Each section only appears when that kind of notification is switched on, and the whole email is skipped on a day
// with nothing new and nothing waiting.

export type DigestData = {
  businessName: string;
  contacts: { name: string | null; phone: string }[];
  leads: { projectType: string; customer: string | null; status: string }[];
  appointments: { purpose: string; customer: string | null; when: string }[];
  tickets: { subject: string; customer: string | null; urgent: boolean }[];
  waiting: { appointments: number; tickets: number; urgentTickets: number; handoffs: number; followUpsDue: number };
};

export type DigestSwitches = { leads: boolean; appointments: boolean; tickets: boolean; handoffs: boolean };

const MAX_LISTED = 8;
const who = (name: string | null, fallback = "a customer") => name?.trim() || fallback;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Row = { label: string; value: string };
type Section = { title: string; rows: Row[] };

export function buildDigest(d: DigestData, sw: DigestSwitches, o: { appUrl?: string; sinceLabel: string }): MailMessage & { to: "" } | null {
  const sections: Section[] = [];
  let totalNew = 0;
  const cap = <T,>(items: T[], f: (x: T) => Row): Row[] => {
    const rows = items.slice(0, MAX_LISTED).map(f);
    if (items.length > MAX_LISTED) rows.push({ label: "", value: `...and ${items.length - MAX_LISTED} more` });
    return rows;
  };

  if (sw.leads && d.contacts.length) totalNew += d.contacts.length;
  if (sw.leads && d.leads.length) totalNew += d.leads.length;
  if (sw.appointments && d.appointments.length) totalNew += d.appointments.length;
  if (sw.tickets && d.tickets.length) totalNew += d.tickets.length;

  if (sw.leads && d.contacts.length) sections.push({ title: `New contacts (${d.contacts.length})`, rows: cap(d.contacts, (c) => ({ label: "Contact", value: `${who(c.name, "No name yet")} (+${c.phone})` })) });
  if (sw.leads && d.leads.length) sections.push({ title: `New project enquiries (${d.leads.length})`, rows: cap(d.leads, (l) => ({ label: "Lead", value: `${l.projectType}: ${who(l.customer)} (${l.status})` })) });
  if (sw.appointments && d.appointments.length) sections.push({ title: `New appointment requests (${d.appointments.length})`, rows: cap(d.appointments, (a) => ({ label: "Request", value: `${a.purpose}: ${who(a.customer)}${a.when ? `, ${a.when}` : ""}` })) });
  if (sw.tickets && d.tickets.length) sections.push({ title: `New tickets (${d.tickets.length})`, rows: cap(d.tickets, (t) => ({ label: t.urgent ? "URGENT" : "Ticket", value: `${t.subject}: ${who(t.customer)}` })) });

  const waiting: string[] = [];
  if (sw.appointments && d.waiting.appointments) waiting.push(`${plural(d.waiting.appointments, "appointment request")} waiting for you to confirm`);
  if (sw.tickets && d.waiting.tickets) waiting.push(`${plural(d.waiting.tickets, "open ticket")}${d.waiting.urgentTickets ? ` (${d.waiting.urgentTickets} urgent)` : ""}`);
  if (sw.handoffs && d.waiting.handoffs) waiting.push(`${plural(d.waiting.handoffs, "chat")} waiting for a person`);
  if (sw.leads && d.waiting.followUpsDue) waiting.push(`${plural(d.waiting.followUpsDue, "lead follow-up")} due`);

  if (sections.length === 0 && waiting.length === 0) return null; // nothing to say today

  const base = o.appUrl?.replace(/\/$/, "");
  const link = base ? `${base}/dashboard` : null;
  const subject = oneLine(
    sections.length
      ? `Your daily summary: ${totalNew} new ${totalNew === 1 ? "item" : "items"}${waiting.length ? ", some waiting for you" : ""}`
      : "Your daily summary: items are waiting for you");

  const text = [
    `${d.businessName}: ${o.sinceLabel}`,
    ...sections.flatMap((s) => ["", s.title, ...s.rows.map((r) => `- ${r.label ? `${r.label}: ` : ""}${r.value}`)]),
    ...(waiting.length ? ["", "Still waiting for you", ...waiting.map((w) => `- ${w}`)] : []),
    ...(link ? ["", `Open your dashboard: ${link}`] : []),
    "", "You get this once a day. Urgent things (a chat that needs a person) are still emailed straight away. Change this under Settings > Email notifications.",
  ].join("\n");

  const details = [
    ...sections.flatMap((s) => [{ label: s.title, value: " " }, ...s.rows.map((r) => ({ label: r.label || " ", value: r.value }))]),
    ...(waiting.length ? [{ label: "Still waiting for you", value: " " }, ...waiting.map((w) => ({ label: " ", value: w }))] : []),
  ];
  const html = emailLayout({
    preheader: `${d.businessName}: ${o.sinceLabel}`,
    heading: "Your daily summary",
    paragraphs: [`Here is what happened at ${d.businessName} (${o.sinceLabel}).`],
    details,
    button: link ? { label: "Open your dashboard", url: link } : undefined,
    footer: "You get this once a day. A chat that needs a person is still emailed straight away. Change this under Settings, Email notifications.",
  });
  return { to: "", subject, text, html };
}
