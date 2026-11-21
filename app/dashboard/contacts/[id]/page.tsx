import Link from "next/link";
import { notFound } from "next/navigation";
import ActivityList from "../../../../components/ActivityList";
import ConfirmForm from "../../../../components/ConfirmForm";
import Icon from "../../../../components/Icon";
import InlineProp from "../../../../components/InlineProp";
import SubmitButton from "../../../../components/SubmitButton";
import { Alert, Badge } from "../../../../components/ui";
import { requireClient } from "../../../../lib/auth/session";
import { LEAD_LABELS, LEAD_TONES, type LeadStatus } from "../../../../lib/leads";
import { STATUS_LABELS as APPT_LABELS, STATUS_TONES as APPT_TONES, whenText, type AppointmentStatus } from "../../../../lib/appointments";
import { TICKET_LABELS, TICKET_TONES, ticketRef, type TicketStatus } from "../../../../lib/tickets";
import { fmt, windowStatus } from "../../../../lib/dashboard";
import { buildTimeline } from "../../../../lib/timeline";
import Notice from "../../Notice";
import { deleteContact, resolveSuggestion, updateContact } from "../../actions";

// One customer: who they are (left), everything they have raised (centre) and the linked records (right).
// Only what already exists: editing the details, opening the conversation, and the permanent delete (header button, with a confirmation).
export default async function ContactPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  const { notice } = await searchParams;
  const { db } = await requireClient();
  const { data: c } = await db.from("contacts").select("id, name, phone, email, status, tags, suggested, created_at").eq("id", id).maybeSingle();
  if (!c) notFound();
  const suggested = (c.suggested ?? {}) as Record<string, string>;
  const { data: conv } = await db.from("conversations").select("id, handling, last_customer_message_at").eq("contact_id", id).maybeSingle();
  // Everything this customer has raised, across leads, appointments, tickets and handoffs (RLS limits all of it to this business).
  const [leads, appts, tickets, handoffs] = await Promise.all([
    db.from("leads").select("id, project_type, budget, status, created_at").eq("contact_id", id),
    db.from("appointments").select("id, purpose, preferred_date, preferred_time, scheduled_date, scheduled_time, status, created_at").eq("contact_id", id),
    db.from("tickets").select("id, subject, priority, status, created_at").eq("contact_id", id),
    conv ? db.from("handoff_requests").select("id, conversation_id, reason, status, created_at").eq("conversation_id", conv.id) : Promise.resolve({ data: [] }),
  ]);
  const timeline = buildTimeline({
    leads: (leads.data ?? []) as never[], appointments: (appts.data ?? []) as never[],
    tickets: (tickets.data ?? []) as never[], handoffs: (handoffs.data ?? []) as never[],
  });
  const items = timeline.map((t) => ({ key: `${t.kind}-${t.id}`, kind: t.kind, title: t.title, detail: t.detail, href: t.href, at: t.at, label: t.statusLabel, tone: t.tone }));
  const w = windowStatus(conv?.last_customer_message_at);
  const tags = (c.tags as string[]) ?? [];
  // Every current value, so changing one property never touches the others.
  const hidden = { id, name: c.name ?? "", email: c.email ?? "", status: c.status as string, tags: tags.join(", ") };
  const leadRows = (leads.data ?? []) as { id: string; project_type: string; budget: string | null; status: LeadStatus; created_at: string }[];
  const apptRows = (appts.data ?? []) as { id: string; purpose: string; preferred_date: string | null; preferred_time: string | null; scheduled_date: string | null; scheduled_time: string | null; status: AppointmentStatus }[];
  const ticketRows = (tickets.data ?? []) as { id: string; subject: string; status: TicketStatus }[];

  return (
    <>
      <Link href="/dashboard/contacts" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }}><Icon name="back" size={16} /> All contacts</Link>
      <header className="card rec-head">
        <span className="avatar rec-avatar" aria-hidden="true">{(c.name || "?").trim()[0].toUpperCase()}</span>
        <div className="rec-who">
          <h1>{c.name || "Unnamed contact"}</h1>
          <p className="muted">+{c.phone}{c.email ? ` · ${c.email}` : ""}</p>
          <div className="row" style={{ marginTop: 8 }}>
            <Badge tone="success">{c.status}</Badge>
            {conv && <Badge tone={conv.handling === "human_active" ? "warn" : "brand"}>{conv.handling === "human_active" ? "Human handling" : "AI handling"}</Badge>}
            {conv && <span className="window"><span className={`dot${w.open ? " on" : ""}`} aria-hidden="true" /> {w.open ? "24-hour window open" : "24-hour window closed"}</span>}
          </div>
        </div>
        <div className="row">
          {conv && <Link className="btn btn-primary" href={`/dashboard/conversations/${conv.id}`}><Icon name="chat" size={16} /> Open conversation</Link>}
          <ConfirmForm action={deleteContact} message={`Delete ${c.name || "this contact"}, their conversation and all their messages permanently? This cannot be undone.`}>
            <input type="hidden" name="id" value={id} /><input type="hidden" name="confirm" value="yes" />
            <SubmitButton variant="danger" pendingText="Deleting...">Delete</SubmitButton>
          </ConfirmForm>
        </div>
      </header>
      <Notice code={notice} />

      {Object.entries(suggested).map(([field, value]) => (
        <Alert key={field} kind="warn">
          <p>The assistant picked up a possible <b>{field}</b> from the chat: <b>{value}</b>. Current value: <b>{((c as Record<string, unknown>)[field] as string) || "(empty)"}</b>. It is only a guess, so it has not been applied.</p>
          <div className="row" style={{ marginTop: 10 }}>
            <form action={resolveSuggestion}>
              <input type="hidden" name="id" value={id} /><input type="hidden" name="field" value={field} /><input type="hidden" name="accept" value="yes" />
              <SubmitButton small pendingText="Saving...">Use this {field}</SubmitButton>
            </form>
            <form action={resolveSuggestion}>
              <input type="hidden" name="id" value={id} /><input type="hidden" name="field" value={field} />
              <SubmitButton small variant="secondary" pendingText="Dismissing...">Dismiss</SubmitButton>
            </form>
          </div>
        </Alert>
      ))}

      <div className="rec-cols">
        <aside className="rec-col" aria-label="About this contact">
          <details className="card rec-card" open>
            <summary>About this contact</summary>
            <div className="rec-body">
              <InlineProp label="Name" action={updateContact} hidden={hidden} display={c.name || undefined} emptyText="Click to add a name"
                controls={[{ name: "name", kind: "text", value: c.name ?? "", maxLength: 100 }]} />
              <div className="rec-prop"><small>Phone</small><span>+{c.phone}</span></div>
              <InlineProp label="Email" action={updateContact} hidden={hidden} display={c.email || undefined} emptyText="Click to add an email"
                controls={[{ name: "email", kind: "email", value: c.email ?? "", maxLength: 200 }]} />
              <InlineProp label="Status" action={updateContact} hidden={hidden} display={<Badge tone="success">{c.status}</Badge>}
                controls={[{ name: "status", kind: "select", value: c.status, options: ["new", "lead", "customer", "lost"].map((x) => ({ value: x, label: x })) }]} />
              <InlineProp label="Tags" action={updateContact} hidden={hidden} emptyText="Click to add tags"
                display={tags.length ? <span className="row">{tags.map((t) => <Badge key={t}>{t}</Badge>)}</span> : undefined}
                controls={[{ name: "tags", kind: "text", value: tags.join(", "), placeholder: "Comma separated", maxLength: 400 }]} />
              <div className="rec-prop"><small>First message</small><span>{fmt(c.created_at)}</span></div>
              {conv?.last_customer_message_at && <div className="rec-prop"><small>Last customer message</small><span>{fmt(conv.last_customer_message_at)}</span></div>}
              <p className="hint" style={{ marginBottom: 0 }}>Click a value to change it.</p>
            </div>
          </details>
        </aside>

        <main className="rec-col">
          <section className="card">
            <h2 className="rec-title">Activity</h2>
            <div className="rec-body"><ActivityList items={items} /></div>
          </section>
        </main>

        <aside className="rec-col" aria-label="Linked records">
          <details className="card rec-card" open>
            <summary>Leads ({leadRows.length})</summary>
            <div className="rec-body">
              {leadRows.length === 0 ? <p className="muted">None.</p> : <>{leadRows.slice(0, 2).map((l) => (
                <div key={l.id} className="rec-assoc"><div><Link href={`/dashboard/leads/${l.id}`}>{l.project_type}</Link>{l.budget && <small className="muted">Budget {l.budget}</small>}</div><Badge tone={LEAD_TONES[l.status]}>{LEAD_LABELS[l.status]}</Badge></div>
              ))}{leadRows.length > 2 && <p className="rec-all"><a href={`/dashboard/leads?q=${encodeURIComponent(c.phone)}`} target="_blank" rel="noopener noreferrer">View all {leadRows.length} leads ↗</a></p>}</>}
            </div>
          </details>
          <details className="card rec-card" open>
            <summary>Tickets ({ticketRows.length})</summary>
            <div className="rec-body">
              {ticketRows.length === 0 ? <p className="muted">None.</p> : <>{ticketRows.slice(0, 2).map((t) => (
                <div key={t.id} className="rec-assoc"><div><Link href={`/dashboard/tickets/${t.id}`}>{ticketRef(t.id)}</Link><small className="muted">{t.subject}</small></div><Badge tone={TICKET_TONES[t.status]}>{TICKET_LABELS[t.status]}</Badge></div>
              ))}{ticketRows.length > 2 && <p className="rec-all"><a href={`/dashboard/tickets?q=${encodeURIComponent(c.phone)}`} target="_blank" rel="noopener noreferrer">View all {ticketRows.length} tickets ↗</a></p>}</>}
            </div>
          </details>
          <details className="card rec-card" open>
            <summary>Appointments ({apptRows.length})</summary>
            <div className="rec-body">
              {apptRows.length === 0 ? <p className="muted">None.</p> : <>{apptRows.slice(0, 2).map((a) => (
                <div key={a.id} className="rec-assoc"><div><Link href={`/dashboard/appointments/${a.id}`}>{a.purpose}</Link><small className="muted">{whenText(a.scheduled_date ?? a.preferred_date, a.scheduled_time ?? a.preferred_time) || "No time yet"}</small></div><Badge tone={APPT_TONES[a.status]}>{APPT_LABELS[a.status]}</Badge></div>
              ))}{apptRows.length > 2 && <p className="rec-all"><a href={`/dashboard/appointments?q=${encodeURIComponent(c.phone)}`} target="_blank" rel="noopener noreferrer">View all {apptRows.length} appointments ↗</a></p>}</>}
            </div>
          </details>
        </aside>
      </div>
    </>
  );
}
