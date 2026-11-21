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
import ChangeAwareSubmit from "../../../../components/ChangeAwareSubmit";
import { deleteAppointment, saveAppointmentNote, updateAppointment } from "../actions";

// One appointment: the editable details on the left, what the customer asked for in the middle, the customer on the right. The owner
// talks to the customer directly; nothing here is sent to them.
export default async function AppointmentDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  const { notice } = await searchParams;
  const { db } = await requireClient();
  const { data: a } = await db.from("appointments").select("*").eq("id", id).maybeSingle();
  if (!a) notFound(); // also what another business's id looks like: RLS returns nothing

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
  const history: { key: string; icon: IconName; title: string; detail: string; at: string }[] = [
    ...(a.updated_at && new Date(a.updated_at).getTime() - new Date(a.created_at).getTime() > 2000 ? [{ key: "updated", icon: "check" as IconName, title: `Status: ${STATUS_LABELS[status]}`, detail: agreed ? `Agreed for ${agreed}` : "Last changed", at: a.updated_at as string }] : []),
    { key: "created", icon: "calendar", title: "Appointment requested", detail: a.purpose as string, at: a.created_at as string },
  ];
  // The owner's four statuses, plus the record's own if it is an older one (so it is never hidden).
  const options = [...new Set<AppointmentStatus>([...OWNER_STATUSES, status])].map((s) => ({ value: s, label: STATUS_LABELS[s] }));

  return (
    <>
      <Link href="/dashboard/appointments" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }}><Icon name="back" size={16} /> All appointments</Link>
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
              <div className="rec-prop"><small>Requested</small><span>{fmt(a.created_at)}</span></div>
              <p className="hint" style={{ marginBottom: 0 }}>Click a value to change it. Nothing is sent to the customer.</p>
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
            <h2 className="rec-title">Notes</h2>
            <div className="rec-body">
              <form action={saveAppointmentNote} className="stack-sm">
                <input type="hidden" name="id" value={a.id} />
                <label className="field">Private note <span className="hint">Only your team sees this. It is never sent to the customer.</span>
                  <textarea name="notes" rows={4} maxLength={2000} defaultValue={a.internal_notes ?? ""} />
                </label>
                <div><ChangeAwareSubmit pendingText="Saving...">Save note</ChangeAwareSubmit></div>
              </form>
            </div>
          </section>
          <section className="card">
            <h2 className="rec-title">Activity</h2>
            <div className="rec-body">
              {history.map((h) => (
                <article key={h.key} className="rec-item">
                  <span className="rec-ico rec-appointment"><Icon name={h.icon} size={16} /></span>
                  <div className="rec-main"><div className="rec-top"><b>{h.title}</b><span className="muted">{fmt(h.at)}</span></div><p>{h.detail}</p></div>
                </article>
              ))}
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
