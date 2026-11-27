import Link from "next/link";
import SubmitButton from "../../../components/SubmitButton";
import TimezoneSelect from "../../../components/TimezoneSelect";
import WorkflowCard from "../../../components/WorkflowCard";
import { Alert, Badge, Card, PageHeader } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import Notice from "../Notice";
import OnboardingBanner from "../OnboardingBanner";
import { updateSettings } from "../actions";
import { maskedKey, PROVIDER_LABELS, type AiMode, type KeyProvider, type KeyStatus } from "../../../lib/ai-keys";
import { fmt } from "../../../lib/dashboard";
import { assistantSetup, parseTab, SETTINGS_TABS } from "../../../lib/settings-tabs";
import { removeAiKey, saveAiKey, setPlatformProvider, updateNotifications, updateWorkflows } from "./actions";
import { BILLING_STATUS_UNAVAILABLE, detectEligibility, ELIGIBILITY_LABELS, FREE_SERVICE_MESSAGES, monthBounds, summariseUsage, WHATSAPP_MANAGER_URL, type UsageRow } from "../../../lib/wa-usage";
import ChangeAwareSubmit from "../../../components/ChangeAwareSubmit";
import { parseWorkflowSettings, WEEKDAYS, WEEKDAY_LABELS } from "../../../lib/workflow-settings";

// Every IANA zone this server knows (Node 20+). A zone saved earlier that is missing here is still listed.
// Some systems list "Asia/Calcutta" and not "Asia/Kolkata", so the common names are added explicitly.
const TIME_ZONES = [...new Set(["UTC", "Asia/Kolkata", ...Intl.supportedValuesOf("timeZone")])].sort();

// Settings are split into tabs (?tab=ai|workflows|notifications|whatsapp), each with ONE save button
// (the AI tab has its own small forms because the key is handled separately and never read back).
// Every form and server action is unchanged apart from where it sends you afterwards.
export default async function Settings({ searchParams }: { searchParams: Promise<{ notice?: string; tab?: string }> }) {
  const { notice, tab: rawTab } = await searchParams;
  const tab = parseTab(rawTab);
  const { db, clientId } = await requireClient();
  const { data: c } = await db.from("clients")
    .select("name, booking_link, ai_provider, ai_mode, ai_key_status, ai_key_last4, ai_key_checked_at, owner_email, monthly_message_cap, wa_phone_number_id, wa_free_allowance, wa_free_tier_seen_at, wa_paid_service_seen_at, onboarding_status, onboarding_step, status, workflow_settings").eq("id", clientId).single();
  const { data: n } = await db.from("notification_settings").select("primary_email, additional_emails, appointment_notifications, lead_notifications, handoff_notifications, ticket_notifications, delivery").eq("client_id", clientId).maybeSingle();
  const w = parseWorkflowSettings(c?.workflow_settings);
  const mode = (c?.ai_mode ?? "platform") as AiMode;
  const status = (c?.ai_key_status ?? "none") as KeyStatus;
  const provider = (c?.ai_provider ?? "gemini") as KeyProvider;
  const setup = assistantSetup({
    mode, hasKey: status !== "none", keyStatus: status,
    hasPhone: Boolean(c?.wa_phone_number_id), onboardingStatus: c?.onboarding_status ?? null, clientStatus: c?.status ?? null,
  });
  // WhatsApp tab only: this month's delivered service messages, for the free-allowance line (same figures as the Usage page).
  const eligibility = detectEligibility(c ?? {});
  let delivered: number | null = null;
  if (tab === "whatsapp" && c?.wa_phone_number_id) {
    const { start, next } = monthBounds(new Date(), w.appointments.timezone);
    const { data: u, error: uErr } = await db.rpc("wa_usage_summary", { p_client_id: clientId, p_since: start.toISOString(), p_until: next.toISOString() });
    if (!uErr) delivered = summariseUsage((u ?? []) as UsageRow[], eligibility).reduce((n, x) => n + x.deliveredService, 0);
  }
  const needsAttention = new Set(setup.steps.filter((x) => !x.done).map((x) => x.tab));
  const current = SETTINGS_TABS.find((t) => t.id === tab)!;

  return (
    <>
      <PageHeader title="Settings" description="Set up your assistant, what it collects, and who hears about it." />
      <Notice code={notice} />

      {!setup.ready && (
        <div style={{ marginBottom: 16 }}>
          <Alert kind="warn">
            <b>Your assistant is not answering customers yet.</b> It starts replying as soon as these steps are done:
            <ul className="setup" style={{ marginTop: 10 }}>
              {setup.steps.map((x) => (
                <li key={x.id}>
                  <span className={`tick${x.done ? " done" : ""}`} aria-hidden="true">{x.done ? "✓" : "!"}</span>
                  <span>
                    <b>{x.title}</b>{x.done ? "" : <> <Link href={`/dashboard/settings?tab=${x.tab}`}>Go to {SETTINGS_TABS.find((t) => t.id === x.tab)!.label}</Link></>}
                    {!x.done && <><br /><span className="muted">{x.detail}</span></>}
                  </span>
                </li>
              ))}
            </ul>
          </Alert>
        </div>
      )}

      <nav className="settings-tabs" aria-label="Settings sections">
        {SETTINGS_TABS.map((t) => (
          <Link key={t.id} href={`/dashboard/settings?tab=${t.id}`} aria-current={t.id === tab ? "page" : undefined}>
            {t.label}{needsAttention.has(t.id) && <span className="dot" title="Needs attention" />}
          </Link>
        ))}
      </nav>
      <p className="muted" style={{ marginBottom: 16 }}>{current.blurb}</p>

      {tab === "ai" && (
        <section className="stack">
          <form action={updateSettings}>
            <Card title="Assistant configuration" description="How the assistant names your business. Describe your business, opening hours and prices on the Knowledge base page.">
              <div className="stack">
                <label className="field">Business name<input name="name" required maxLength={100} defaultValue={c?.name ?? ""} /></label>
                <div className="row">
                  <ChangeAwareSubmit pendingText="Saving...">Save name</ChangeAwareSubmit>
                  <Link href="/dashboard/knowledge">Open Knowledge base</Link>
                </div>
              </div>
            </Card>
          </form>
        <Card title="AI connection" description={mode === "byok"
          ? "Your assistant uses YOUR AI account, so your AI provider bills you directly for what it uses. Your key is stored encrypted and is never shown again."
          : "Your assistant currently uses the platform's AI, which is included for you. You can switch to your own AI account at any time."}
          actions={mode === "byok"
            ? status === "valid" ? <Badge tone="success">Key working</Badge> : status === "unverified" ? <Badge tone="warn">Key saved, not checked</Badge> : status === "invalid" ? <Badge tone="danger">Key refused</Badge> : <Badge tone="danger">No key</Badge>
            : <Badge tone="brand">Platform AI</Badge>}>
          <div className="stack">
            {mode === "byok" && status !== "none" && (
              <p className="muted">Using {PROVIDER_LABELS[provider]} with the key ending <b>{maskedKey(c?.ai_key_last4)}</b>{c?.ai_key_checked_at ? ` (last checked ${fmt(c.ai_key_checked_at)})` : ""}.</p>
            )}
            <form action={saveAiKey} className="stack">
              <label className="field">AI provider
                <select name="ai_provider" defaultValue={provider}>
                  <option value="gemini">{PROVIDER_LABELS.gemini}</option>
                  <option value="openai">{PROVIDER_LABELS.openai}</option>
                </select>
              </label>
              <label className="field">{mode === "byok" && status !== "none" ? "Replace your key" : "Your AI key"}
                <span className="hint">Create it in your provider&apos;s dashboard (Google AI Studio for Gemini, platform.openai.com for OpenAI). We check it before saving, and it is stored encrypted.</span>
                <input name="ai_key" type="password" autoComplete="off" spellCheck={false} maxLength={300} placeholder="Paste your key" />
              </label>
              <div><ChangeAwareSubmit pendingText="Checking and saving...">{mode === "byok" && status !== "none" ? "Replace key" : "Save key"}</ChangeAwareSubmit></div>
            </form>
            {mode === "byok" && status !== "none" && (
              <form action={removeAiKey}>
                <SubmitButton variant="danger" pendingText="Removing...">Remove my key</SubmitButton>
                <p className="muted" style={{ marginTop: 6 }}>The assistant stops replying until you add another key.</p>
              </form>
            )}
            {mode === "platform" && (
              <form action={setPlatformProvider} className="row">
                <label className="field">Platform AI provider
                  <select name="ai_provider" defaultValue={provider}>
                    <option value="gemini">{PROVIDER_LABELS.gemini}</option>
                    <option value="openai">{PROVIDER_LABELS.openai}</option>
                  </select>
                </label>
                <ChangeAwareSubmit pendingText="Saving...">Save provider</ChangeAwareSubmit>
              </form>
            )}
          </div>
        </Card>
        </section>
      )}

      {tab === "workflows" && (
        <form action={updateWorkflows} className="stack">
          <WorkflowCard name="appointments_enabled" title="Appointment requests" switchLabel="Collect appointment requests" defaultChecked={w.appointments.enabled}
            always={<label className="field">Booking link <span className="hint">Optional, for example Calendly. If set, the assistant shares it when a customer wants to book, instead of collecting a request. Works even if appointment requests are off.</span>
              <input name="booking_link" type="url" maxLength={500} defaultValue={c?.booking_link ?? ""} placeholder="https://calendly.com/your-name" />
            </label>}
            description="With no booking link, the assistant collects the appointment details from the customer by itself (what it is for, preferred date and time, name), checks them against your working days and hours, and sends you a pending request to accept or reject on the Appointments page. With a booking link, it shares the link instead.">

            <p className="hint">Appointments follow your working days, hours and time zone from the Business hours card below.</p>
            <label className="field">Additional instructions (optional) <span className="hint">Added on top of the standard behaviour, never instead of it. For example: ask whether they are a new patient.</span>
              <textarea name="appointment_instructions" rows={3} maxLength={1000} defaultValue={w.appointments.instructions} />
            </label>
                    </WorkflowCard>
          <section className="card stack">
            <h2>Business hours</h2>
            <p className="muted">Shared by the whole assistant: appointment requests, the human handoff text and the closed-hours replies all use these hours. While you are closed, the assistant still answers normal questions from your Knowledge base as usual. Only when a customer asks to speak to a person does it say you are not available right now, when you are next available, and share your contact details from the Knowledge base.</p>
            <fieldset className="field"><legend>Working days <span className="hint">Information for the assistant. It never promises that a time is free: there is no calendar connection.</span></legend>
              <div className="row">
                {WEEKDAYS.map((d) => <label key={d} className="check"><input type="checkbox" name={`day_${d}`} defaultChecked={w.appointments.workingDays.includes(d)} /> {WEEKDAY_LABELS[d]}</label>)}
              </div>
            </fieldset>
            <label className="field">Time zone <span className="hint">Your opening hours and &quot;today&quot; are in this zone. The assistant uses it to understand dates like &quot;tomorrow&quot;.</span>
              <TimezoneSelect name="timezone" defaultValue={w.appointments.timezone} zones={[...new Set([...(w.appointments.timezone ? [w.appointments.timezone] : []), ...TIME_ZONES])].sort()} />
            </label>
            <div className="row">
              <label className="field">Opens <input type="time" name="open_time" defaultValue={w.appointments.openTime} /></label>
              <label className="field">Closes <input type="time" name="close_time" defaultValue={w.appointments.closeTime} /></label>
            </div>
            <p className="hint">Keep your email, phone or WhatsApp number in your Knowledge base (core knowledge). While you are closed, the assistant shares those details exactly as written, and nothing it does not find there. Choose your time zone above so it knows when you are closed.</p>
          </section>
          <WorkflowCard name="enquiries_enabled" title="Project enquiries" switchLabel="Collect project enquiries" defaultChecked={w.enquiries.enabled}
            description="When a customer asks about a project or service, the assistant works out what it needs to know (service, description, key requirements, budget and timeline when relevant), asks naturally, shows a summary, and saves a lead only after the customer confirms. You do not need to list the questions.">

            <label className="field">Services you offer <span className="hint">Helps the assistant understand what your business provides. One per line. It will not offer anything that is not listed.</span>
              <textarea name="services" rows={4} defaultValue={w.enquiries.services.join("\n")} placeholder={"Website design\nMobile apps"} />
            </label>
            <label className="field">Custom questions (optional) <span className="hint">Your own qualifying questions, one per line, asked only where relevant. The assistant already knows how to collect standard project details, so you only add what is specific to your business.</span>
              <textarea name="questions" rows={3} defaultValue={w.enquiries.questions.join("\n")} />
            </label>
            <label className="field">Additional instructions (optional) <span className="hint">Added on top of the standard behaviour, never instead of it.</span>
              <textarea name="enquiry_instructions" rows={3} maxLength={1000} defaultValue={w.enquiries.instructions} />
            </label>
                    </WorkflowCard>
          <WorkflowCard name="support_enabled" title="Tickets" switchLabel="Log tickets" defaultChecked={w.support.enabled}
            description="When a customer reports a problem (for example an order that didn't arrive), the assistant collects what the team needs (what went wrong, an order or reference number, context), shows a summary, and logs a ticket after the customer confirms. It then gives the customer the ticket number. It never promises a refund or a fix, and only marks a ticket urgent if the customer says so.">

            <label className="field">Categories (optional) <span className="hint">One per line, for example "Delivery" or "Billing". The assistant picks one if it fits.</span>
              <textarea name="support_categories" rows={3} defaultValue={w.support.categories.join("\n")} />
            </label>
            <label className="field">Expected response time <span className="hint">The assistant may tell customers this. Leave empty and it promises no time.</span>
              <input name="support_response_time" maxLength={100} defaultValue={w.support.responseTime} placeholder="within 2 business days" />
            </label>
            <label className="field">Additional instructions (optional) <span className="hint">Added on top of the standard behaviour. For example: always ask for the order number.</span>
              <textarea name="support_instructions" rows={3} maxLength={1000} defaultValue={w.support.instructions} />
            </label>
                    </WorkflowCard>
          <WorkflowCard name="handoff_enabled" title="Human handoff" switchLabel="Hand chats over to my team" defaultChecked={w.handoff.enabled}
            description="When a customer asks for a person, the assistant steps aside for that chat and you are emailed. Turn this off only if nobody can follow up.">

            <p className="hint">When your team is available: the assistant uses your Business hours above.</p>
            <label className="field">Expected response time <span className="hint">The assistant may tell customers this. Leave empty and it promises no time.</span>
              <input name="response_time" maxLength={100} defaultValue={w.handoff.responseTime} placeholder="within 1 business day" />
            </label>
            <label className="field">Also hand over when... <span className="hint">For example: the customer mentions a refund or a legal matter.</span>
              <textarea name="escalation_instructions" rows={3} maxLength={1000} defaultValue={w.handoff.escalationInstructions} />
            </label>
                    </WorkflowCard>
          <div><ChangeAwareSubmit pendingText="Saving...">Save workflows</ChangeAwareSubmit></div>
        </form>
      )}

      {tab === "notifications" && (
        <form action={updateNotifications} className="stack">
        <Card title="Email notifications" description="Who is emailed about appointment requests, new leads and chats that need a person. Addresses are only used for these emails.">
          <div className="stack">
            <label className="field">Main email <input type="email" name="primary_email" maxLength={200} defaultValue={n?.primary_email ?? c?.owner_email ?? ""} /></label>
            <label className="field">Additional recipients <span className="hint">Up to 5, separated by commas or new lines.</span>
              <textarea name="additional_emails" rows={2} defaultValue={(n?.additional_emails ?? []).join("\n")} />
            </label>
            <fieldset className="field">
              <legend>How often <span className="hint">For new contacts, project enquiries, appointment requests and tickets. A chat that needs a person is always emailed straight away.</span></legend>
              <label className="check"><input type="radio" name="delivery" value="daily" defaultChecked={(n?.delivery ?? "daily") === "daily"} /> One summary a day (recommended)</label>
              <label className="check"><input type="radio" name="delivery" value="immediate" defaultChecked={n?.delivery === "immediate"} /> An email for each one as it happens</label>
            </fieldset>
            <label className="check"><input type="checkbox" name="appointment_notifications" defaultChecked={n?.appointment_notifications ?? true} /> Appointment requests and changes</label>
            <label className="check"><input type="checkbox" name="lead_notifications" defaultChecked={n?.lead_notifications ?? true} /> New leads</label>
            <label className="check"><input type="checkbox" name="ticket_notifications" defaultChecked={n?.ticket_notifications ?? true} /> Tickets</label>
            <label className="check"><input type="checkbox" name="handoff_notifications" defaultChecked={n?.handoff_notifications ?? true} /> Chats that need a person</label>
          </div>
        </Card>
          <div><ChangeAwareSubmit pendingText="Saving...">Save notifications</ChangeAwareSubmit></div>
        </form>
      )}

      {tab === "whatsapp" && (
        <Card title="WhatsApp connection" description="The WhatsApp Business number your customers message.">
          <div className="stack">
            <OnboardingBanner status={c?.onboarding_status} step={c?.onboarding_step} />
            {c?.wa_phone_number_id && <p className="muted">Your WhatsApp Business Account is connected to Replyleaf. Meta messaging charges are separate from your Replyleaf subscription and are managed through your WhatsApp Business Account or messaging provider. See <Link href="/dashboard/usage">Usage</Link> for this month&apos;s messages.</p>}
            {c?.wa_phone_number_id
              ? <p className="muted">Phone number ID: <b>{c.wa_phone_number_id}</b>{mode === "platform" && <> · Monthly reply cap: {c?.monthly_message_cap} (set by the platform admin)</>}</p>
              : <Alert kind="warn">No WhatsApp number is connected yet. <Link href="/onboarding">Connect WhatsApp</Link></Alert>}
            <div className="stack" style={{ gap: 6 }}>
              <h3>How WhatsApp messaging works</h3>
              <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
                <li><b>24-hour rule:</b> the assistant can reply freely for 24 hours after a customer&apos;s last message. After that WhatsApp only allows pre-approved templates, which Replyleaf does not send, so a late reply will not go out. Customers can message you again to reopen the window.</li>
                <li><b>Who charges what:</b> your Replyleaf subscription is separate. Meta bills WhatsApp messaging to your own WhatsApp Business Account.</li>
                <li><b>Free allowance:</b> Meta gives eligible numbers {FREE_SERVICE_MESSAGES.toLocaleString()} free service messages a month. {ELIGIBILITY_LABELS[eligibility]}{eligibility === "unknown" ? " yet (it is detected automatically from the delivery reports from WhatsApp)" : ""}.{delivered !== null && <> {delivered.toLocaleString()} delivered this month.</>} <Link href="/dashboard/usage">See Usage</Link>.</li>
                <li><b>Prices</b> differ by country and message type and change over time, so they are not shown here. See <a href="https://developers.facebook.com/docs/whatsapp/pricing" target="_blank" rel="noopener noreferrer">Meta&apos;s pricing page</a>.</li>
              </ul>
            </div>
            <p className="muted"><b>WhatsApp billing:</b> {BILLING_STATUS_UNAVAILABLE}. Replyleaf cannot see your Meta payment method or its status. Keep a payment method on your Meta account: delivery of service messages can stop once the free ones are used if there is none. Check it in <a href={WHATSAPP_MANAGER_URL} target="_blank" rel="noopener noreferrer">WhatsApp Manager</a> or with your messaging provider. Replyleaf never asks for or stores card details.</p>
          </div>
        </Card>
      )}
    </>
  );
}
