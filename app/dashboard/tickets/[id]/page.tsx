import CustomerCard from "../../../../components/CustomerCard";
import Link from "next/link";
import { notFound } from "next/navigation";
import ConfirmForm from "../../../../components/ConfirmForm";
import ShowMore from "../../../../components/ShowMore";
import SubmitButton from "../../../../components/SubmitButton";
import Icon from "../../../../components/Icon";
import { Badge } from "../../../../components/ui";
import { shortName } from "../../../../lib/notifications";
import { whatsappLink } from "../../../../lib/appointments";
import { requireClient } from "../../../../lib/auth/session";
import { fmt } from "../../../../lib/dashboard";
import { listTeam } from "../../../../lib/team";
import {
  allowedStatuses, categoryOptions, describeTicketEvent, notificationOutcome, PRIORITIES, PRIORITY_LABELS, priorityOf, TICKET_LABELS, TICKET_TONES, ticketRef, type TicketStatus,
} from "../../../../lib/tickets";
import { parseWorkflowSettings } from "../../../../lib/workflow-settings";
import Notice from "../../Notice";
import { addTicketNote, deleteTicket, updateTicket } from "../actions";

type Note = { id: string; author_label: string | null; body: string; created_at: string };
type Event = { id: string; kind: string; detail: Record<string, unknown> | null; actor_label: string | null; created_at: string };

// One ticket: its properties on the left (editable in place), the problem and its activity in the middle, the customer on the right. Reads of the new notes and activity are separate, so a database that has not had the
// latest migration still shows the ticket.
const SHOWN_NOTES = 3;
const SHOWN_EVENTS = 5; // the page shows the latest few and folds the rest away, so a busy ticket never makes it endless

export default async function TicketDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string; edit?: string }> }) {
  const { id } = await params;
  const { notice, edit } = await searchParams;
  const editing = edit === "1";
  const { db, clientId } = await requireClient();
  const { data: t } = await db.from("tickets").select("*").eq("id", id).maybeSingle();
  if (!t) notFound(); // also what another business's id looks like: RLS returns nothing

  const [{ data: contact }, notesRes, eventsRes, { data: biz }, team] = await Promise.all([
    db.from("contacts").select("id, name, phone, email, status").eq("id", t.contact_id).maybeSingle(),
    db.from("ticket_notes").select("id, author_label, body, created_at").eq("ticket_id", id).order("created_at", { ascending: false }).limit(200),
    db.from("ticket_events").select("id, kind, detail, actor_label, created_at").eq("ticket_id", id).order("created_at", { ascending: false }).limit(200),
    db.from("clients").select("workflow_settings").eq("id", clientId).maybeSingle(),
    listTeam(clientId),
  ]);
  const notes = (notesRes.error ? [] : notesRes.data ?? []) as Note[];
  // The newest notes first; the single note written before notes were dated goes last.
  const allNotes: Note[] = [...notes, ...(t.internal_notes ? [{ id: "earlier", author_label: null, body: t.internal_notes as string, created_at: "" }] : [])];
  const renderNote = (n: Note) => (
    <li key={n.id}><div><span style={{ whiteSpace: "pre-wrap" }}>{n.body}</span><br /><span className="muted">{n.id === "earlier" ? "Earlier note (written before notes were dated)" : `${shortName(n.author_label) || "A team member"} · ${fmt(n.created_at)}`}</span></div></li>
  );
  const events = (eventsRes.error ? [] : eventsRes.data ?? []) as Event[];

  // WhatsApp's own report for the messages we told customers about, so "sent" is never shown as "delivered".
  const waIds = events.map((e) => (e.kind === "notification" ? (e.detail?.wa_message_id as string | undefined) : undefined)).filter((x): x is string => Boolean(x));
  const { data: msgs } = waIds.length ? await db.from("messages").select("wa_message_id, status").in("wa_message_id", waIds) : { data: [] };
  const deliveryOf = new Map((msgs ?? []).map((m) => [m.wa_message_id as string, m.status as string]));

  const renderEvent = (e: Event) => {
    const d = e.detail ?? {};
    const outcome = e.kind === "notification" ? notificationOutcome(d, deliveryOf.get(String(d.wa_message_id ?? "")) ?? null) : null;
    return (
      <li key={e.id}>
        <div>
          {describeTicketEvent(e.kind, d)}{outcome && <>: <Badge tone={outcome.tone}>{outcome.label}</Badge></>}<br />
          <span className="muted">{shortName(e.actor_label) || "Assistant"} · {fmt(e.created_at)}</span>
        </div>
      </li>
    );
  };

  const status = t.status as TicketStatus;
  const priority = priorityOf(t.priority);
  const link = whatsappLink(t.customer_phone);
  const categories = categoryOptions(parseWorkflowSettings(biz?.workflow_settings).support.categories, t.category);
  const assignedLabel = shortName(team.find((m) => m.id === t.assigned_user_id)?.label) || null;
  // A person who has since left the business is still shown by name once, rather than silently dropped.
  const assigneeOptions = t.assigned_user_id && !assignedLabel ? [...team, { id: t.assigned_user_id as string, label: "Former team member" }] : team;

  return (
    <>
      <Link href="/dashboard/tickets" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }}><Icon name="back" size={16} /> All tickets</Link>
      <header className="card rec-head">
        <span className="rec-ico rec-ticket rec-big" aria-hidden="true"><Icon name="alert" size={24} /></span>
        <div className="rec-who">
          <h1>{ticketRef(t.id)}: {t.subject}</h1>
          <p className="muted">Raised {fmt(t.created_at)}</p>
          <div className="row" style={{ marginTop: 8 }}>
            <Badge tone={TICKET_TONES[status]}>{TICKET_LABELS[status]}</Badge>
            {priority === "high" ? <Badge tone="danger">High priority</Badge> : <Badge>{PRIORITY_LABELS[priority]} priority</Badge>}
            {t.category && <Badge tone="brand">{t.category}</Badge>}
          </div>
        </div>
        <div className="row">
          {link && <a className="btn btn-secondary" href={link} target="_blank" rel="noopener noreferrer">Message on WhatsApp</a>}
          <ConfirmForm action={deleteTicket} message="Delete this ticket permanently? This cannot be undone."><input type="hidden" name="id" value={t.id} /><SubmitButton variant="danger" pendingText="Deleting...">Delete</SubmitButton></ConfirmForm>
        </div>
      </header>
      <Notice code={notice} />

      <div className="rec-cols">
        <aside className="rec-col" aria-label="About this ticket">
          <details className="card rec-card" open>
            <summary>About this ticket</summary>
            <div className="rec-body">
              {editing ? (
                <form action={updateTicket} className="stack-sm">
                  <input type="hidden" name="id" value={t.id} />
                  <label className="field">Status
                    <select name="status" defaultValue={status}>{allowedStatuses(status).map((s) => <option key={s} value={s}>{TICKET_LABELS[s]}</option>)}</select>
                  </label>
                  <label className="field">Priority
                    <select name="priority" defaultValue={priority}>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}</select>
                  </label>
                  <label className="field">Category
                    <select name="category" defaultValue={t.category ?? ""}>
                      <option value="">Not set</option>
                      {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </label>
                  <label className="field">Assigned to
                    <select name="assigned_user_id" defaultValue={t.assigned_user_id ?? ""}>
                      <option value="">Unassigned</option>
                      {assigneeOptions.map((m) => <option key={m.id} value={m.id}>{shortName(m.label)}</option>)}
                    </select>
                  </label>
                  <div className="rec-notify">
                    <label className="check"><input type="checkbox" name="notify" /> Notify customer about this status update</label>
                    <label className="field">Message to the customer <span className="hint">Optional. Added to the standard update.</span>
                      <textarea name="message" rows={2} maxLength={1000} placeholder="Your issue has been resolved. Please let us know if you need any further assistance." />
                    </label>
                    <p className="hint">Nothing is sent unless you tick the box, and only when the status changes. Sent as a plain message by WhatsApp if the customer wrote in the last 24 hours, otherwise by email if we have their address; if neither is possible it is not sent and you are told why. No paid templates are used.</p>
                  </div>
                  <div className="row"><SubmitButton small pendingText="Saving...">Save changes</SubmitButton><Link className="btn btn-ghost btn-sm" href={`/dashboard/tickets/${id}`}>Cancel</Link></div>
                </form>
              ) : (
                <>
                  <div className="rec-prop"><small>Status</small><span><Badge tone={TICKET_TONES[status]}>{TICKET_LABELS[status]}</Badge></span></div>
                  <div className="rec-prop"><small>Priority</small><span>{PRIORITY_LABELS[priority]}</span></div>
                  <div className="rec-prop"><small>Category</small><span>{t.category ?? <span className="muted">Not set</span>}</span></div>
                  <div className="rec-prop"><small>Assigned to</small><span>{assignedLabel ?? (t.assigned_user_id ? "Former team member" : t.assigned_to ?? <span className="muted">Unassigned</span>)}</span></div>
                  <div className="rec-prop"><small>Raised</small><span>{fmt(t.created_at)}</span></div>
                  {t.resolved_at && <div className="rec-prop"><small>Resolved</small><span>{fmt(t.resolved_at)}</span></div>}
                  <p style={{ marginTop: 10 }}><Link href={`/dashboard/tickets/${id}?edit=1`} className="rec-link">Edit properties</Link></p>
                </>
              )}
            </div>
          </details>
        </aside>

        <main className="rec-col">
          <section className="card">
            <h2 className="rec-title">Description</h2>
            <div className="rec-body">
              <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{t.description}</p>
              {t.reference_info && <div className="rec-prop" style={{ marginTop: 12 }}><small>Reference given</small><span>{t.reference_info}</span></div>}
            </div>
          </section>
          <section className="card">
            <h2 className="rec-title">Notes</h2>
            <div className="rec-body">
              <p className="muted" style={{ marginTop: 0 }}>Private. Only your team sees these; they are never sent to the customer or used by the assistant.</p>
              <form action={addTicketNote} className="stack-sm">
                <input type="hidden" name="id" value={t.id} />
                <label className="sr-only" htmlFor="note-body">Add a note</label>
                <textarea id="note-body" name="body" required rows={2} maxLength={4000} placeholder="Add a note" />
                <div><SubmitButton small variant="secondary" pendingText="Adding...">Add note</SubmitButton></div>
              </form>
              {allNotes.length === 0 ? <p className="muted" style={{ marginBottom: 0 }}>No notes yet.</p> : <div style={{ marginTop: 10 }}><ShowMore initial={SHOWN_NOTES} noun="note">{allNotes.map(renderNote)}</ShowMore></div>}
            </div>
          </section>
          <section className="card">
            <h2 className="rec-title">Activity</h2>
            <div className="rec-body">
              {events.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nothing has happened to this ticket since activity tracking began.</p> : (
                <ShowMore initial={SHOWN_EVENTS} noun="event">{events.map(renderEvent)}</ShowMore>
              )}
            </div>
          </section>
        </main>

        <aside className="rec-col" aria-label="Customer">
          <CustomerCard contact={contact} conversationId={t.conversation_id} fallback={{ name: t.customer_name, phone: t.customer_phone }} />
        </aside>
      </div>
    </>
  );
}
