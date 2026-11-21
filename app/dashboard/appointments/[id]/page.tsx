import CustomerCard from "../../../../components/CustomerCard";
import ConfirmForm from "../../../../components/ConfirmForm";
import SubmitButton from "../../../../components/SubmitButton";
import Link from "next/link";
import { notFound } from "next/navigation";
import InlineProp from "../../../../components/InlineProp";
import Icon, { type IconName } from "../../../../components/Icon";
import { Badge } from "../../../../components/ui";
import { requireClient } from "../../../../lib/auth/session";
import { emailsByContact } from "../../../../lib/contact-emails";
import { fmt } from "../../../../lib/dashboard";
import { OWNER_STATUSES, STATUS_LABELS, STATUS_TONES, whatsappLink, whenText, type AppointmentStatus } from "../../../../lib/appointments";
import Notice from "../../Notice";
import { editNote } from "../../note-actions";
import ActivityList, { type ActivityItem } from "../../../../components/ActivityList";
import { shortName } from "../../../../lib/notifications";
import { addAppointmentNote, deleteAppointment, updateAppointment } from "../actions";

// One appointment: the editable details on the left, what the customer asked for in the middle, the customer on the right. The owner
// talks to the customer directly; nothing here is sent to them.
export default async function AppointmentDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  const { notice } = await searchParams;
  const { db } = await requireClient();
  const { data: a } = await db.from("appointments").select("*").eq("id", id).maybeSingle();
  if (!a) notFound(); // also what another business's id looks like: RLS returns nothing

  const notesRes = await db.from("appointment_notes").select("id, author_label, body, created_at").eq("appointment_id", id).order("created_at", { ascending: false }).limit(200);
  const noteRows = (notesRes.error ? [] : notesRes.data ?? []) as { id: string; author_label: string | null; body: string; created_at: string }[]; // a database without migration 0027 simply shows none
  const { data: contact } = await db.from("contacts").select("id, name, phone, email, status").eq("id", a.contact_id).maybeSingle();
  const chatEmail = (await emailsByContact(db, [a.contact_id])).get(a.contact_id) ?? null; // an email the customer gave in chat
  const status = a.status as AppointmentStatus;
  const prefer = whenText(a.preferred_date, a.preferred_time);
  const agreed = whenText(a.scheduled_date, a.scheduled_time);
  const email = a.customer_email || chatEmail;
  const contactLink = whatsappLink(a.customer_phone);
  // Every current value, so changing one property never touches the others.
  const hidden = { id: a.id, status, scheduled_date: (a.scheduled_date as string | null) ?? "", scheduled_time: (a.scheduled_time as string | null) ?? "", customer_email: (a.customer_email as string | null) ?? "" };
  // What the record itself tells us (there is no separate history for appointments).
  const feed: ActivityItem[] = [
    ...(a.updated_at && new Date(a.updated_at).getTime() - new Date(a.created_at).getTime() > 2000 ? [{ key: "updated", kind: "update", icon: "check" as IconName, title: `Status: ${STATUS_LABELS[status]}`, detail: agreed ? `Agreed for ${agreed}` : "Last changed", at: a.updated_at as string }] : []),
    { key: "created", kind: "update", icon: "calendar" as IconName, title: "Appointment requested", detail: a.purpose as string, at: a.created_at as string },
    ...noteRows.map((n): ActivityItem => ({ key: `n-${n.id}`, kind: "note", noteId: n.id, icon: "chat", title: "Note", detail: n.body, at: n.created_at, meta: shortName(n.author_label) || "A team member" })),
    ...(a.internal_notes ? [{ key: "n-earlier", kind: "note", icon: "chat" as IconName, title: "Note", detail: a.internal_notes as string, at: "", meta: "Earlier note (written before notes were dated)" }] : []),
  ].sort((x, y) => (y.at || "").localeCompare(x.at || ""));
  // The owner's four statuses, plus the record's own if it is an older one (so it is never hidden).
  const options = [...new Set<AppointmentStatus>([...OWNER_STATUSES, status])].map((s) => ({ value: s, label: STATUS_LABELS[s] }));

  return (
    <>
      <Link href="/dashboard/appointments" className="rec-back"><Icon name="back" size={14} /> All appointments</Link>
      <header className="card rec-head">
        <span className="rec-ico rec-appointment rec-big" aria-hidden="true"><Icon name="calendar" size={24} /></span>
        <div className="rec-who">
          <h1>{a.customer_name || "Appointment request"}</h1>
          <p className="muted">+{a.customer_phone} · requested {fmt(a.created_at)}</p>
          <div className="row" style={{ marginTop: 8 }}>
            <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>
            {agreed && <Badge tone="brand">{agreed}</Badge>}
          </div>
        </div>
        <div className="row">
          {contactLink && <a className="btn btn-secondary" href={contactLink} target="_blank" rel="noopener noreferrer">Message on WhatsApp</a>}
          <ConfirmForm action={deleteAppointment} message="Delete this appointment permanently? This cannot be undone."><input type="hidden" name="id" value={a.id} /><SubmitButton variant="danger" pendingText="Deleting...">Delete</SubmitButton></ConfirmForm>
        </div>
      </header>
      <Notice code={notice} />

      <div className="rec-cols">
        <aside className="rec-col" aria-label="About this appointment">
          <details className="card rec-card" open>
            <summary>About this appointment</summary>
            <div className="rec-body">
              <InlineProp label="Status" action={updateAppointment} hidden={hidden} display={<Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>}
                revealWhen={{ control: "status", value: "confirmed" }}
                controls={[
                  { name: "status", kind: "select", value: status, options },
                  { name: "scheduled_date", kind: "date", value: (a.scheduled_date ?? a.preferred_date ?? "") as string, label: "Agreed date", required: true, reveal: true },
                  { name: "scheduled_time", kind: "text", value: (a.scheduled_time ?? a.preferred_time ?? "") as string, label: "Agreed time (for example 10:30 or 3pm)", placeholder: "10:30 or 3pm", required: true, maxLength: 60, reveal: true },
                ]} />
              {status === "confirmed" ? (
                <InlineProp label="Agreed" action={updateAppointment} hidden={hidden} alwaysConfirm display={agreed || <span className="muted">Not agreed yet</span>}
                  controls={[
                    { name: "scheduled_date", kind: "date", value: (a.scheduled_date ?? "") as string, label: "Agreed date", required: true },
                    { name: "scheduled_time", kind: "text", value: (a.scheduled_time ?? "") as string, label: "Agreed time", placeholder: "10:30 or 3pm", required: true, maxLength: 60 },
                  ]} />
              ) : (
                <div className="rec-prop"><small>Agreed</small><span className="muted">Not agreed yet. Set the status to Confirmed to add the date and time.</span></div>
              )}
              <InlineProp label="Email" action={updateAppointment} hidden={hidden} emptyText="Click to add" display={email || undefined}
                controls={[{ name: "customer_email", kind: "email", value: email ?? "", placeholder: "customer@example.com", maxLength: 200 }]} />
              <InlineProp label="Assigned to" action={updateAppointment} hidden={hidden} emptyText="Click to assign" display={(a.assigned_to as string | null) || undefined}
                controls={[{ name: "assignee_email", kind: "email", value: (a.assigned_to as string | null) ?? "", placeholder: "Email (yours or a teammate's), empty = unassigned", maxLength: 200 }]} />
              <div className="rec-prop"><small>Requested</small><span>{fmt(a.created_at)}</span></div>
              <p className="hint" style={{ marginBottom: 0 }}>Click a value to change it. Nothing is sent to the customer. Assigning emails the person you choose.</p>
            </div>
          </details>
        </aside>

        <main className="rec-col">
          <section className="card">
            <h2 className="rec-title">Request</h2>
            <div className="rec-body">
              <div className="rec-prop"><small>For</small><span>{a.purpose}</span></div>
              <div className="rec-prop"><small>Customer asked for</small><span>{prefer || "-"}</span></div>
              {a.notes && <div className="rec-prop"><small>Customer notes</small><span style={{ whiteSpace: "pre-wrap" }}>{a.notes}</span></div>}
            </div>
          </section>
          <section className="card">
            <h2 className="rec-title">Activities</h2>
            <div className="rec-body">
              <ActivityList items={feed} noteAction={addAppointmentNote} editAction={editNote} noteKind="appointment" recordId={a.id} kinds={[{ id: "note", label: "Notes" }, { id: "update", label: "Updates" }]} />
            </div>
          </section>
        </main>

        <aside className="rec-col" aria-label="Customer">
          <CustomerCard contact={contact} conversationId={a.conversation_id} fallback={{ name: a.customer_name, phone: a.customer_phone }} />
        </aside>
      </div>
    </>
  );
}
