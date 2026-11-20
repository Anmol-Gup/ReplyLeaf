import Link from "next/link";
import { Alert, Badge, Card, EmptyState, PageHeader, Stat } from "../../components/ui";
import { requireClient } from "../../lib/auth/session";
import { loadAccess } from "../../lib/billing/gate";
import { clip, fmtDay } from "../../lib/dashboard";
import { STATUS_LABELS as APPT_LABELS, STATUS_TONES as APPT_TONES, whenText, type AppointmentStatus } from "../../lib/appointments";
import { LEAD_LABELS, LEAD_TONES, type LeadStatus } from "../../lib/leads";
import {
  APPOINTMENTS_TO_CONFIRM, assistantReadiness, buildAttention, HANDOFF_WAITING, LEADS_ACTIVE, LEADS_NEW, overviewLinks, showCount, TICKETS_OPEN, type Counts,
} from "../../lib/overview";
import { PRIORITY_LABELS, priorityOf, TICKET_LABELS, TICKET_TONES, ticketRef, type TicketStatus } from "../../lib/tickets";
import { todayInZone } from "../../lib/workflow";
import { parseWorkflowSettings } from "../../lib/workflow-settings";
import type { AiMode, KeyStatus } from "../../lib/ai-keys";

// The home page: is the assistant ready, what needs the owner now, and the latest of everything it collected.
// Numbers are counted by the database (never from a capped list), always for THIS business: the signed-in owner's session limits every
// read through row level security, and every query also names the business the server resolved. A number that cannot be read shows a
// dash, never a made-up zero. The statuses counted are the same ones the linked pages filter on (lib/overview.ts).
type CountQuery = PromiseLike<{ count: number | null; error: unknown }>;
const counted = async (q: CountQuery): Promise<number | null> => { const r = await q; return r.error ? null : r.count ?? 0; };

export default async function Overview() {
  const { db, clientId } = await requireClient();
  const mine = (table: string) => db.from(table).select("id", { count: "exact", head: true }).eq("client_id", clientId);

  const { data: conn } = await db.from("clients")
    .select("onboarding_status, ai_mode, ai_key_status, status, wa_phone_number_id, kb_text, workflow_settings").eq("id", clientId).single();
  const today = todayInZone(new Date(), parseWorkflowSettings(conn?.workflow_settings).appointments.timezone);

  const [handoffs, appointments, tickets, highTickets, newLeads, followUps, contacts, kbDocs, access, leadsRes, apptRes, ticketRes] = await Promise.all([
    counted(mine("handoff_requests").in("status", [...HANDOFF_WAITING])),
    counted(mine("appointments").in("status", [...APPOINTMENTS_TO_CONFIRM])),
    counted(mine("tickets").in("status", [...TICKETS_OPEN])),
    counted(mine("tickets").in("status", [...TICKETS_OPEN]).eq("priority", "high")),
    counted(mine("leads").in("status", [...LEADS_NEW])),
    counted(mine("leads").in("status", [...LEADS_ACTIVE]).not("follow_up_at", "is", null).lte("follow_up_at", today)),
    counted(mine("contacts").eq("spoke", true)),            // one per person: a contact is one row however many leads, tickets or chats they have
    counted(mine("kb_documents").eq("status", "active")),
    loadAccess(clientId).catch(() => null),
    db.from("leads").select("id, customer_name, customer_phone, project_type, status, created_at").eq("client_id", clientId).order("created_at", { ascending: false }).limit(3),
    db.from("appointments").select("id, customer_name, customer_phone, purpose, preferred_date, preferred_time, status").eq("client_id", clientId).order("created_at", { ascending: false }).limit(3),
    db.from("tickets").select("id, customer_name, customer_phone, subject, priority, status").eq("client_id", clientId).order("created_at", { ascending: false }).limit(3),
  ]);
  const counts: Counts = { handoffs, appointments, tickets, highTickets, newLeads, followUps, contacts };

  const status = (conn?.ai_key_status ?? "none") as KeyStatus;
  const readiness = assistantReadiness({
    hasPhone: Boolean(conn?.wa_phone_number_id), onboardingStatus: conn?.onboarding_status ?? null, clientStatus: conn?.status ?? null,
    aiMode: (conn?.ai_mode ?? "platform") as AiMode, hasKey: status !== "none", keyStatus: status,
    billingAllowed: access ? access.allowed : true, kbReady: Boolean(conn?.kb_text?.trim()) || (kbDocs ?? 0) > 0,
  });
  const attention = buildAttention(counts);

  type Lead = { id: string; customer_name: string | null; customer_phone: string; project_type: string; status: LeadStatus; created_at: string };
  type Appt = { id: string; customer_name: string | null; customer_phone: string; purpose: string; preferred_date: string | null; preferred_time: string | null; status: AppointmentStatus };
  type Ticket = { id: string; customer_name: string | null; customer_phone: string; subject: string; priority: string; status: TicketStatus };
  const leads = (leadsRes.error ? [] : leadsRes.data ?? []) as Lead[];
  const appts = (apptRes.error ? [] : apptRes.data ?? []) as Appt[];
  const tix = (ticketRes.error ? [] : ticketRes.data ?? []) as Ticket[];
  const who = (name: string | null, phone: string) => name || `+${phone}`;

  return (
    <>
      <PageHeader title="Overview" description="What needs your attention, and the latest your assistant has collected." />

      <Card title="Assistant status">
        <ul className="readiness">
          {readiness.rows.map((r) => (
            <li key={r.key}>
              <span className="muted">{r.label}</span>
              <Badge tone={r.tone}>{r.state}</Badge>
              {r.href && <Link href={r.href}>Fix</Link>}
            </li>
          ))}
        </ul>
        {readiness.problems.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <Alert kind="warn"><b>Your assistant is not answering customers.</b> {readiness.problems.join(" ")}</Alert>
          </div>
        )}
      </Card>

      <div className="metric-grid">
        <Stat href={overviewLinks.handoffs} value={showCount(handoffs)} label="Human handoffs" />
        <Stat href={overviewLinks.appointments} value={showCount(appointments)} label="Appointments to confirm" />
        <Stat href={overviewLinks.tickets} value={showCount(tickets)} label="Open tickets" />
        <Stat href={overviewLinks.newLeads} value={showCount(newLeads)} label="New leads" />
        <Stat href={overviewLinks.followUps} value={showCount(followUps)} label="Follow-ups due" />
        <Stat href={overviewLinks.contacts} value={showCount(contacts)} label="Total contacts" />
      </div>

      {attention.length === 0 ? (
        <p className="caught-up" role="status">You&apos;re all caught up. Nothing needs your attention right now.</p>
      ) : (
        <Card title="Needs your attention">
          <ul className="reqs" style={{ gap: 10, fontSize: "0.95rem" }}>
            {attention.map((a) => (
              <li key={a.key}><Badge tone={a.tone}>{a.n}</Badge> <Link href={a.href}>{a.text}</Link></li>
            ))}
          </ul>
        </Card>
      )}

      <div className="overview-grid">
        <Card title="Latest leads" actions={<Link href="/dashboard/leads" className="btn btn-ghost btn-sm">View all</Link>}>
          {leads.length === 0 ? <EmptyState icon="users" title="No leads yet">New enquiries collected by your assistant will appear here.</EmptyState> : (
            <ul className="latest compact">
              {leads.map((l) => (
                <li key={l.id}>
                  <div><Link href={`/dashboard/leads/${l.id}`}>{who(l.customer_name, l.customer_phone)}</Link><br /><span className="muted">{clip(l.project_type, 50)} · {fmtDay(l.created_at)}</span></div>
                  <Badge tone={LEAD_TONES[l.status]}>{LEAD_LABELS[l.status]}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Latest appointment requests" actions={<Link href="/dashboard/appointments" className="btn btn-ghost btn-sm">View all</Link>}>
          {appts.length === 0 ? <EmptyState icon="calendar" title="No appointment requests yet">Requests collected by your assistant will appear here.</EmptyState> : (
            <ul className="latest compact">
              {appts.map((a) => (
                <li key={a.id}>
                  <div><Link href={`/dashboard/appointments/${a.id}`}>{who(a.customer_name, a.customer_phone)}</Link><br /><span className="muted">{clip(a.purpose, 50)}{whenText(a.preferred_date, a.preferred_time) ? ` · ${whenText(a.preferred_date, a.preferred_time)}` : ""}</span></div>
                  <Badge tone={APPT_TONES[a.status]}>{APPT_LABELS[a.status]}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Latest tickets" actions={<Link href="/dashboard/tickets" className="btn btn-ghost btn-sm">View all</Link>}>
          {tix.length === 0 ? <EmptyState icon="alert" title="No support tickets yet">Customer issues logged by your assistant will appear here.</EmptyState> : (
            <ul className="latest compact">
              {tix.map((t) => (
                <li key={t.id}>
                  <div><Link href={`/dashboard/tickets/${t.id}`}>{ticketRef(t.id)}: {clip(t.subject, 45)}</Link><br /><span className="muted">{who(t.customer_name, t.customer_phone)} · {PRIORITY_LABELS[priorityOf(t.priority)]} priority</span></div>
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
