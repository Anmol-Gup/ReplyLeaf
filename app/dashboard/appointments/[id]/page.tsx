import CustomerCard from "../../../../components/CustomerCard";
import ConfirmForm from "../../../../components/ConfirmForm";
import SubmitButton from "../../../../components/SubmitButton";
import Link from "next/link";
import { notFound } from "next/navigation";
import AppointmentEditForm from "../../../../components/AppointmentEditForm";
import Icon from "../../../../components/Icon";
import { Badge } from "../../../../components/ui";
import { requireClient } from "../../../../lib/auth/session";
import { emailsByContact } from "../../../../lib/contact-emails";
import { fmt } from "../../../../lib/dashboard";
import { OWNER_STATUSES, STATUS_LABELS, STATUS_TONES, whatsappLink, whenText, type AppointmentStatus } from "../../../../lib/appointments";
import Notice from "../../Notice";
import { deleteAppointment, updateAppointment } from "../actions";

// One appointment: the editable details on the left, what the customer asked for in the middle, the customer on the right. The owner
// talks to the customer directly; nothing here is sent to them.
export default async function AppointmentDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string; edit?: string }> }) {
  const { id } = await params;
  const { notice, edit } = await searchParams;
  const editing = edit === "1";
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
              {editing ? (
                <>
                  <p className="hint" style={{ marginTop: 0 }}>After you have spoken to the customer, set the status here. Nothing is sent to them.</p>
                  <AppointmentEditForm action={updateAppointment} statuses={options} cancelHref={`/dashboard/appointments/${id}`}
                    a={{ id: a.id, status, scheduled_date: a.scheduled_date, scheduled_time: a.scheduled_time, preferred_date: a.preferred_date, preferred_time: a.preferred_time, customer_email: a.customer_email }} />
                </>
              ) : (
                <>
                  <div className="rec-prop"><small>Status</small><span><Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge></span></div>
                  <div className="rec-prop"><small>Agreed</small><span>{agreed || <span className="muted">Not agreed yet</span>}</span></div>
                  <div className="rec-prop"><small>Email</small><span>{email || <span className="muted">Not given</span>}</span></div>
                  <div className="rec-prop"><small>Requested</small><span>{fmt(a.created_at)}</span></div>
                  <p style={{ marginTop: 10 }}><Link href={`/dashboard/appointments/${id}?edit=1`} className="rec-link">Edit properties</Link></p>
                </>
              )}
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
        </main>

        <aside className="rec-col" aria-label="Customer">
          <CustomerCard contact={contact} conversationId={a.conversation_id} fallback={{ name: a.customer_name, phone: a.customer_phone }} />
        </aside>
      </div>
    </>
  );
}
