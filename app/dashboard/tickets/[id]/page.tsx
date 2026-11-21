import CustomerCard from "../../../../components/CustomerCard";
import Link from "next/link";
import { notFound } from "next/navigation";
import ConfirmForm from "../../../../components/ConfirmForm";
import ShowMore from "../../../../components/ShowMore";
import SubmitButton from "../../../../components/SubmitButton";
import { Badge, Card, PageHeader } from "../../../../components/ui";
import { shortName } from "../../../../lib/notifications";
import { whatsappLink } from "../../../../lib/appointments";
import { requireClient } from "../../../../lib/auth/session";
import { emailsByContact } from "../../../../lib/contact-emails";
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

// One ticket: the problem, a form to manage it (status, priority, category, who has it, and an optional message to the customer),
// private notes over time, and the activity. Reads of the new notes and activity are separate, so a database that has not had the
// latest migration still shows the ticket.
const SHOWN_EVENTS = 5; // the page shows the latest few and folds the rest away, so a busy ticket never makes it endless
const SHOWN_NOTES = 3;

export default async function TicketDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  const { notice } = await searchParams;
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
  const events = (eventsRes.error ? [] : eventsRes.data ?? []) as Event[];
  const emailOf = (await emailsByContact(db, [t.contact_id])).get(t.contact_id) ?? contact?.email ?? null;

  // WhatsApp's own report for the messages we told customers about, so "sent" is never shown as "delivered".
  const waIds = events.map((e) => (e.kind === "notification" ? (e.detail?.wa_message_id as string | undefined) : undefined)).filter((x): x is string => Boolean(x));
  const { data: msgs } = waIds.length ? await db.from("messages").select("wa_message_id, status").in("wa_message_id", waIds) : { data: [] };
  const deliveryOf = new Map((msgs ?? []).map((m) => [m.wa_message_id as string, m.status as string]));

  // The renderers need the delivery reports and the old single note, so they live inside the page function.
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
  // The newest notes first; the single note written before notes were dated goes last.
  const allNotes: Note[] = [...notes, ...(t.internal_notes ? [{ id: "earlier", author_label: null, body: t.internal_notes as string, created_at: "" }] : [])];
  const renderNote = (n: Note) => (
    <li key={n.id}><div><span style={{ whiteSpace: "pre-wrap" }}>{n.body}</span><br /><span className="muted">{n.id === "earlier" ? "Earlier note (written before notes were dated)" : `${shortName(n.author_label) || "A team member"} · ${fmt(n.created_at)}`}</span></div></li>
  );

  const status = t.status as TicketStatus;
  const priority = priorityOf(t.priority);
  const link = whatsappLink(t.customer_phone);
  const categories = categoryOptions(parseWorkflowSettings(biz?.workflow_settings).support.categories, t.category);
  const assignedLabel = shortName(team.find((m) => m.id === t.assigned_user_id)?.label) || null;
  // A person who has since left the business is still shown by name once, rather than silently dropped.
  const assigneeOptions = t.assigned_user_id && !assignedLabel ? [...team, { id: t.assigned_user_id as string, label: "Former team member" }] : team;

  return (
    <>
      <PageHeader
        title={`${ticketRef(t.id)}: ${t.subject}`}
        description={`${t.customer_name || "Customer"} · +${t.customer_phone}${emailOf ? ` · ${emailOf}` : ""} · raised ${fmt(t.created_at)}`}
        actions={<span className="row">{link && <a className="btn btn-secondary btn-sm" href={link} target="_blank" rel="noopener noreferrer">Message on WhatsApp</a>}<Link className="btn btn-ghost btn-sm" href="/dashboard/tickets">All tickets</Link><ConfirmForm action={deleteTicket} message="Delete this ticket permanently? This cannot be undone."><input type="hidden" name="id" value={t.id} /><SubmitButton variant="danger" small pendingText="Deleting...">Delete</SubmitButton></ConfirmForm></span>}
      />
      <Notice code={notice} />

      <div className="dcols">
        <div className="rec-col">
      <CustomerCard contact={contact} conversationId={t.conversation_id} fallback={{ name: t.customer_name, phone: t.customer_phone }} />
      <Card title="The problem" actions={<span className="row">{priority === "high" && <Badge tone="danger">High priority</Badge>}<Badge tone={TICKET_TONES[status]}>{TICKET_LABELS[status]}</Badge></span>}>
        <dl className="handoff-facts">
          <div><dt>What happened</dt><dd>{t.description}</dd></div>
          <div><dt>Category</dt><dd>{t.category ?? <span className="muted">Not set</span>}</dd></div>
          {t.reference_info && <div><dt>Reference given</dt><dd>{t.reference_info}</dd></div>}
          <div><dt>Assigned to</dt><dd>{assignedLabel ?? (t.assigned_user_id ? "Former team member" : t.assigned_to ? <>{t.assigned_to} <span className="muted">(typed before team assignment)</span></> : <span className="muted">Unassigned</span>)}</dd></div>
        </dl>
        <p className="muted" style={{ marginTop: 12 }}>
          <Link href={`/dashboard/conversations/${t.conversation_id}`}>Open the conversation</Link>
          {contact && <> · <Link href={`/dashboard/contacts/${contact.id}`}>Contact details</Link></>}
        </p>
      </Card>

      <form action={updateTicket} className="stack" id="edit">
        <input type="hidden" name="id" value={t.id} />
        <Card title="Edit ticket" description="Change the status, priority, category or who has it.">
          <div className="grid2">
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
          </div>
        </Card>

        <Card title="Customer notification" description="Optional. Nothing is sent unless you tick the box, and only when the status changes. Your private notes are never included.">
          <div className="stack-sm">
            <label className="check"><input type="checkbox" name="notify" /> Notify customer about this status update</label>
            <label className="field">Message to the customer <span className="hint">Optional. Added to the standard update.</span>
              <textarea name="message" rows={2} maxLength={1000} placeholder="Your issue has been resolved. Please let us know if you need any further assistance." />
            </label>
            <p className="hint">Sent as a plain message by WhatsApp if the customer wrote in the last 24 hours, otherwise by email if we have their address. If neither is possible it is not sent, and you will be told why. Replyleaf does not use paid message templates.</p>
            <div><SubmitButton pendingText="Saving...">Save changes</SubmitButton></div>
          </div>
        </Card>
      </form>

        </div>
        <div className="rec-col">
      <Card title="Internal notes" description="Private. Only your team sees these, and they are never sent to the customer or used by the assistant.">
        <div className="stack-sm">
          <form action={addTicketNote} className="stack-sm">
            <input type="hidden" name="id" value={t.id} />
            <label className="field">Add a note <textarea name="body" required rows={2} maxLength={4000} /></label>
            <div><SubmitButton variant="secondary" pendingText="Adding...">Add note</SubmitButton></div>
          </form>
          {allNotes.length === 0 && <p className="muted">No notes yet.</p>}
          {allNotes.length > 0 && <ShowMore initial={SHOWN_NOTES} noun="note">{allNotes.map(renderNote)}</ShowMore>}
        </div>
      </Card>


      <Card title="Activity">
        {events.length === 0 ? <p className="muted">Nothing has happened to this ticket since activity tracking began.</p> : (
          <ShowMore initial={SHOWN_EVENTS} noun="event">{events.map(renderEvent)}</ShowMore>
        )}
      </Card>
        </div>
      </div>
    </>
  );
}
