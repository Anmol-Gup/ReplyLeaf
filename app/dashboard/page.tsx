import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader, Stat } from "../../components/ui";
import { requireClient } from "../../lib/auth/session";
import { clip, fmtDay } from "../../lib/dashboard";
import { overview as apptOverview, STATUS_LABELS as APPT_LABELS, STATUS_TONES as APPT_TONES, whenText, type AppointmentStatus } from "../../lib/appointments";
import { LEAD_LABELS, LEAD_TONES, leadOverview, type LeadStatus } from "../../lib/leads";
import { isOpenTicket, TICKET_LABELS, TICKET_TONES, ticketOverview, ticketRef, type TicketStatus } from "../../lib/tickets";
import type { AiMode, KeyStatus } from "../../lib/ai-keys";
import AiKeyBanner from "./AiKeyBanner";
import OnboardingBanner from "./OnboardingBanner";

// The home page: what needs the owner now, and the latest of everything the assistant collected. Every number links to the page
// that lists it. All reads go through the owner's session, so row level security limits them to this business.
export default async function Overview() {
  const { db, clientId } = await requireClient();
  const today = new Date().toISOString().slice(0, 10);
  const [{ data: conn }, handoff, contacts, leadsRes, apptRes, ticketRes] = await Promise.all([
    db.from("clients").select("onboarding_status, onboarding_step, ai_mode, ai_key_status").eq("id", clientId).single(),
    db.from("handoff_requests").select("id, status"),
    db.from("contacts").select("id", { count: "exact", head: true }).eq("spoke", true),
    db.from("leads").select("id, customer_name, customer_phone, project_type, status, follow_up_at, created_at").order("created_at", { ascending: false }).limit(300),
    db.from("appointments").select("id, customer_name, customer_phone, purpose, preferred_date, preferred_time, scheduled_date, scheduled_time, status, created_at").order("created_at", { ascending: false }).limit(300),
    db.from("tickets").select("id, customer_name, customer_phone, subject, priority, status, created_at").order("created_at", { ascending: false }).limit(300),
  ]);

  const handoffs = (handoff.data ?? []) as { status: string }[];
  const waiting = handoffs.filter((h) => h.status === "requested").length;
  const handoffOpen = handoffs.filter((h) => h.status !== "resolved").length;

  type Lead = { id: string; customer_name: string | null; customer_phone: string; project_type: string; status: LeadStatus; follow_up_at: string | null; created_at: string };
  type Appt = { id: string; customer_name: string | null; customer_phone: string; purpose: string; preferred_date: string | null; preferred_time: string | null; scheduled_date: string | null; scheduled_time: string | null; status: AppointmentStatus; created_at: string };
  type Ticket = { id: string; customer_name: string | null; customer_phone: string; subject: string; priority: string; status: TicketStatus; created_at: string };
  const leads = (leadsRes.data ?? []) as Lead[];
  const appts = (apptRes.data ?? []) as Appt[];
  const tickets = (ticketRes.data ?? []) as Ticket[];
  const lo = leadOverview(leads, today);
  const ao = apptOverview(appts, today);
  const to = ticketOverview(tickets);
  const openTickets = tickets.filter((t) => isOpenTicket(t.status)).length;

  // What needs the owner now, most urgent first. Each line links to the list that shows exactly those items.
  const attention = [
    { n: waiting, text: `chat${waiting === 1 ? "" : "s"} waiting for a person`, href: "/dashboard/handoff?status=requested", tone: "danger" as const },
    { n: ao.pending, text: `appointment request${ao.pending === 1 ? "" : "s"} to confirm`, href: "/dashboard/appointments?status=pending&status=reschedule_requested", tone: "warn" as const },
    { n: to.urgent, text: `urgent open ticket${to.urgent === 1 ? "" : "s"}`, href: "/dashboard/tickets?status=open&status=in_progress&status=waiting_on_customer", tone: "danger" as const },
    { n: lo.dueFollowUp, text: `lead follow-up${lo.dueFollowUp === 1 ? "" : "s"} due`, href: "/dashboard/leads", tone: "warn" as const },
    { n: lo.fresh, text: `new or qualified lead${lo.fresh === 1 ? "" : "s"} to contact`, href: "/dashboard/leads?status=new&status=qualified", tone: "brand" as const },
  ].filter((a) => a.n > 0);

  const who = (name: string | null, phone: string) => name || `+${phone}`;

  return (
    <>
      <PageHeader title="Overview" description="What needs your attention, and the latest your assistant has collected." />
      <OnboardingBanner status={conn?.onboarding_status} step={conn?.onboarding_step} />
      <AiKeyBanner mode={(conn?.ai_mode ?? "platform") as AiMode} hasKey={(conn?.ai_key_status ?? "none") !== "none"} status={(conn?.ai_key_status ?? "none") as KeyStatus} />

      <div className="stat-grid">
        <Stat href="/dashboard/handoff?status=requested&status=assigned&status=human_active" value={handoffOpen} label="Chats handed to you" />
        <Stat href="/dashboard/appointments?status=pending&status=reschedule_requested" value={ao.pending} label="Appointments to confirm" />
        <Stat href="/dashboard/tickets?status=open&status=in_progress&status=waiting_on_customer" value={openTickets} label="Open tickets" />
        <Stat href="/dashboard/leads?status=new&status=qualified" value={lo.fresh} label="New or qualified leads" />
        <Stat href="/dashboard/leads" value={lo.dueFollowUp} label="Lead follow-ups due" />
        <Stat href="/dashboard/contacts" value={contacts.count ?? 0} label="Contacts in total" />
      </div>

      <Card title="Needs your attention">
        {attention.length === 0 ? (
          <EmptyState icon="check" title="You're all caught up">Nothing is waiting for you right now. New requests from customers will show up here.</EmptyState>
        ) : (
          <ul className="reqs" style={{ gap: 10, fontSize: "0.95rem" }}>
            {attention.map((a) => (
              <li key={a.text}><Badge tone={a.tone}>{a.n}</Badge> <Link href={a.href}>{a.text}</Link></li>
            ))}
          </ul>
        )}
      </Card>

      <div className="overview-grid">
        <Card title="Latest leads" actions={<Link href="/dashboard/leads" className="btn btn-ghost btn-sm">View all</Link>}>
          {leads.length === 0 ? <p className="muted">No leads yet. When a customer describes a project, it appears here.</p> : (
            <ul className="latest">
              {leads.slice(0, 5).map((l) => (
                <li key={l.id}>
                  <div><Link href={`/dashboard/leads/${l.id}`}>{who(l.customer_name, l.customer_phone)}</Link><br /><span className="muted">{clip(l.project_type, 60)} · {fmtDay(l.created_at)}</span></div>
                  <Badge tone={LEAD_TONES[l.status]}>{LEAD_LABELS[l.status]}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Latest appointment requests" actions={<Link href="/dashboard/appointments" className="btn btn-ghost btn-sm">View all</Link>}>
          {appts.length === 0 ? <p className="muted">No appointment requests yet.</p> : (
            <ul className="latest">
              {appts.slice(0, 5).map((a) => (
                <li key={a.id}>
                  <div><Link href={`/dashboard/appointments/${a.id}`}>{who(a.customer_name, a.customer_phone)}</Link><br /><span className="muted">{clip(a.purpose, 50)}{whenText(a.scheduled_date ?? a.preferred_date, a.scheduled_time ?? a.preferred_time) ? ` · ${whenText(a.scheduled_date ?? a.preferred_date, a.scheduled_time ?? a.preferred_time)}` : ""}</span></div>
                  <Badge tone={APPT_TONES[a.status]}>{APPT_LABELS[a.status]}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Latest tickets" actions={<Link href="/dashboard/tickets" className="btn btn-ghost btn-sm">View all</Link>}>
          {tickets.length === 0 ? <p className="muted">No tickets yet. When a customer reports a problem, it appears here.</p> : (
            <ul className="latest">
              {tickets.slice(0, 5).map((t) => (
                <li key={t.id}>
                  <div><Link href={`/dashboard/tickets/${t.id}`}>{ticketRef(t.id)}: {clip(t.subject, 50)}</Link><br /><span className="muted">{who(t.customer_name, t.customer_phone)} · {fmtDay(t.created_at)}{t.priority === "high" ? " · urgent" : ""}</span></div>
                  <Badge tone={TICKET_TONES[t.status]}>{TICKET_LABELS[t.status]}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
