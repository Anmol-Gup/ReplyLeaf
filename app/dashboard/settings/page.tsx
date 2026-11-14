import SubmitButton from "../../../components/SubmitButton";
import { Card, PageHeader } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import Notice from "../Notice";
import OnboardingBanner from "../OnboardingBanner";
import { updateSettings } from "../actions";
import { updateNotifications, updateWorkflows } from "./actions";
import { parseWorkflowSettings, WEEKDAYS, WEEKDAY_LABELS } from "../../../lib/workflow-settings";

export default async function Settings({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const { notice } = await searchParams;
  const { db, clientId } = await requireClient();
  const { data: c } = await db.from("clients")
    .select("name, business_info, business_hours, booking_link, ai_provider, owner_email, monthly_message_cap, wa_phone_number_id, onboarding_status, onboarding_step, workflow_settings").eq("id", clientId).single();
  const { data: n } = await db.from("notification_settings").select("primary_email, additional_emails, appointment_notifications, lead_notifications, handoff_notifications, ticket_notifications").eq("client_id", clientId).maybeSingle();
  const w = parseWorkflowSettings(c?.workflow_settings);
  return (
    <>
      <PageHeader title="Settings" description="How your business appears to the assistant and where alerts go." />
      <Notice code={notice} />
      <form action={updateSettings} className="stack">
        <Card title="Business">
          <div className="stack">
            <label className="field">Business name<input name="name" required maxLength={100} defaultValue={c?.name ?? ""} /></label>
            <label className="field">About the business<textarea name="business_info" maxLength={4000} defaultValue={c?.business_info ?? ""} /></label>
            <label className="field">Opening hours<textarea name="business_hours" maxLength={1000} defaultValue={c?.business_hours ?? ""} /></label>
          </div>
        </Card>
        <Card title="Booking link and AI">
          <div className="stack">
            <label className="field">Booking link <span className="hint">Optional, for example Calendly. If set, the assistant shares it when a customer wants to book. If not, a team member takes over those chats.</span>
              <input name="booking_link" type="url" maxLength={500} defaultValue={c?.booking_link ?? ""} placeholder="https://calendly.com/your-name" />
            </label>
            <label className="field">AI provider
              <select name="ai_provider" defaultValue={c?.ai_provider}><option value="gemini">Gemini</option><option value="openai">OpenAI</option></select>
            </label>
          </div>
        </Card>
        <div><SubmitButton pendingText="Saving...">Save settings</SubmitButton></div>
      </form>

      <form action={updateWorkflows} className="stack" style={{ marginTop: 16 }}>
        <Card title="Appointment requests" description="Used when no booking link is set. The assistant collects a request and you confirm it on the Appointments page. If a booking link is set, it shares the link instead.">
          <div className="stack">
            <label className="check"><input type="checkbox" name="appointments_enabled" defaultChecked={w.appointments.enabled} /> Collect appointment requests</label>
            <fieldset className="field"><legend>Working days <span className="hint">Information for the assistant. It never promises that a time is free: there is no calendar connection.</span></legend>
              <div className="row">
                {WEEKDAYS.map((d) => <label key={d} className="check"><input type="checkbox" name={`day_${d}`} defaultChecked={w.appointments.workingDays.includes(d)} /> {WEEKDAY_LABELS[d]}</label>)}
              </div>
            </fieldset>
            <div className="row">
              <label className="field">Opens <input type="time" name="open_time" defaultValue={w.appointments.openTime} /></label>
              <label className="field">Closes <input type="time" name="close_time" defaultValue={w.appointments.closeTime} /></label>
              <label className="field">Appointment length (minutes) <input type="number" name="appointment_duration" min={5} max={480} defaultValue={w.appointments.durationMinutes ?? ""} /></label>
              <label className="field">Minimum notice (hours) <input type="number" name="appointment_notice" min={0} max={720} defaultValue={w.appointments.minNoticeHours} /></label>
            </div>
            <label className="field">Instructions for the assistant <span className="hint">For example: ask which service they want, or whether they are a new patient.</span>
              <textarea name="appointment_instructions" rows={3} maxLength={1000} defaultValue={w.appointments.instructions} />
            </label>
          </div>
        </Card>
        <Card title="Project enquiries" description="When a customer asks about a project or service, the assistant asks the relevant questions, shows a summary, and saves a lead after the customer confirms.">
          <div className="stack">
            <label className="check"><input type="checkbox" name="enquiries_enabled" defaultChecked={w.enquiries.enabled} /> Collect project enquiries</label>
            <label className="field">Services you offer <span className="hint">One per line. The assistant will not offer anything that is not listed.</span>
              <textarea name="services" rows={4} defaultValue={w.enquiries.services.join("\n")} placeholder={"Website design\nMobile apps"} />
            </label>
            <label className="field">Questions you always want answered <span className="hint">One per line, asked only where relevant.</span>
              <textarea name="questions" rows={3} defaultValue={w.enquiries.questions.join("\n")} />
            </label>
            <label className="field">Budget ranges to offer <span className="hint">One per line, for example "Under $1,000".</span>
              <textarea name="budget_ranges" rows={3} defaultValue={w.enquiries.budgetRanges.join("\n")} />
            </label>
            <label className="field">Instructions for the assistant
              <textarea name="enquiry_instructions" rows={3} maxLength={1000} defaultValue={w.enquiries.instructions} />
            </label>
          </div>
        </Card>
        <Card title="Support tickets" description="When a customer reports a problem (for example an order that didn't arrive), the assistant collects the details, shows a summary, and logs a ticket after the customer confirms. It never promises a refund or a fix.">
          <div className="stack">
            <label className="check"><input type="checkbox" name="support_enabled" defaultChecked={w.support.enabled} /> Log support tickets</label>
            <label className="field">Categories <span className="hint">One per line, for example "Delivery" or "Billing". The assistant picks one if it fits.</span>
              <textarea name="support_categories" rows={3} defaultValue={w.support.categories.join("\n")} />
            </label>
            <label className="field">Expected response time <span className="hint">The assistant may tell customers this. Leave empty and it promises no time.</span>
              <input name="support_response_time" maxLength={100} defaultValue={w.support.responseTime} placeholder="within 2 business days" />
            </label>
            <label className="field">Instructions for the assistant <span className="hint">For example: always ask for the order number.</span>
              <textarea name="support_instructions" rows={3} maxLength={1000} defaultValue={w.support.instructions} />
            </label>
          </div>
        </Card>
        <Card title="Human handoff" description="When a customer asks for a person, the assistant steps aside for that chat and you are emailed. Turn this off only if nobody can follow up.">
          <div className="stack">
            <label className="check"><input type="checkbox" name="handoff_enabled" defaultChecked={w.handoff.enabled} /> Hand chats over to my team</label>
            <label className="field">When your team is available <input name="availability" maxLength={200} defaultValue={w.handoff.availability} placeholder="Mon-Fri, 9am-6pm" /></label>
            <label className="field">Expected response time <span className="hint">The assistant may tell customers this. Leave empty and it promises no time.</span>
              <input name="response_time" maxLength={100} defaultValue={w.handoff.responseTime} placeholder="within 1 business day" />
            </label>
            <label className="field">Also hand over when... <span className="hint">For example: the customer mentions a refund or a legal matter.</span>
              <textarea name="escalation_instructions" rows={3} maxLength={1000} defaultValue={w.handoff.escalationInstructions} />
            </label>
          </div>
        </Card>
        <div><SubmitButton pendingText="Saving...">Save workflow settings</SubmitButton></div>
      </form>

      <form action={updateNotifications} className="stack" style={{ marginTop: 16 }}>
        <Card title="Email notifications" description="Who is emailed about appointment requests, new leads and chats that need a person. Addresses are only used for these emails.">
          <div className="stack">
            <label className="field">Main email <input type="email" name="primary_email" maxLength={200} defaultValue={n?.primary_email ?? c?.owner_email ?? ""} /></label>
            <label className="field">Additional recipients <span className="hint">Up to 5, separated by commas or new lines.</span>
              <textarea name="additional_emails" rows={2} defaultValue={(n?.additional_emails ?? []).join("\n")} />
            </label>
            <label className="check"><input type="checkbox" name="appointment_notifications" defaultChecked={n?.appointment_notifications ?? true} /> Appointment requests and changes</label>
            <label className="check"><input type="checkbox" name="lead_notifications" defaultChecked={n?.lead_notifications ?? true} /> New leads</label>
            <label className="check"><input type="checkbox" name="ticket_notifications" defaultChecked={n?.ticket_notifications ?? true} /> Support tickets</label>
            <label className="check"><input type="checkbox" name="handoff_notifications" defaultChecked={n?.handoff_notifications ?? true} /> Chats that need a person</label>
          </div>
        </Card>
        <div><SubmitButton pendingText="Saving...">Save notification settings</SubmitButton></div>
      </form>

      <Card title="WhatsApp connection">
        <div className="stack">
          <OnboardingBanner status={c?.onboarding_status} step={c?.onboarding_step} />
          <p className="muted">Phone number ID: {c?.wa_phone_number_id ?? "not connected"} · Monthly reply cap: {c?.monthly_message_cap} (set by the platform admin)</p>
        </div>
      </Card>
    </>
  );
}
