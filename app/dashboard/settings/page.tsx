import Link from "next/link";
import SubmitButton from "../../../components/SubmitButton";
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
import { parseWorkflowSettings, WEEKDAYS, WEEKDAY_LABELS } from "../../../lib/workflow-settings";

// Settings are split into tabs (?tab=ai|workflows|notifications|whatsapp), each with ONE save button
// (the AI tab has its own small forms because the key is handled separately and never read back).
// Every form and server action is unchanged apart from where it sends you afterwards.
export default async function Settings({ searchParams }: { searchParams: Promise<{ notice?: string; tab?: string }> }) {
  const { notice, tab: rawTab } = await searchParams;
  const tab = parseTab(rawTab);
  const { db, clientId } = await requireClient();
  const { data: c } = await db.from("clients")
    .select("name, booking_link, ai_provider, ai_mode, ai_key_status, ai_key_last4, ai_key_checked_at, owner_email, monthly_message_cap, wa_phone_number_id, onboarding_status, onboarding_step, status, workflow_settings").eq("id", clientId).single();
  const { data: n } = await db.from("notification_settings").select("primary_email, additional_emails, appointment_notifications, lead_notifications, handoff_notifications, ticket_notifications, delivery").eq("client_id", clientId).maybeSingle();
  const w = parseWorkflowSettings(c?.workflow_settings);
  const mode = (c?.ai_mode ?? "platform") as AiMode;
  const status = (c?.ai_key_status ?? "none") as KeyStatus;
  const provider = (c?.ai_provider ?? "gemini") as KeyProvider;
  const setup = assistantSetup({
    mode, hasKey: status !== "none", keyStatus: status,
    hasPhone: Boolean(c?.wa_phone_number_id), onboardingStatus: c?.onboarding_status ?? null, clientStatus: c?.status ?? null,
  });
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

      <nav className="tabs" aria-label="Settings sections">
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
                  <SubmitButton pendingText="Saving...">Save name</SubmitButton>
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
              <div><SubmitButton pendingText="Checking and saving...">{mode === "byok" && status !== "none" ? "Replace key" : "Save key"}</SubmitButton></div>
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
                <SubmitButton variant="secondary" pendingText="Saving...">Save provider</SubmitButton>
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
            description="Used when no booking link is set. The assistant collects a request and you confirm it on the Appointments page. If a booking link is set, it shares the link instead.">

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
                    </WorkflowCard>
          <WorkflowCard name="enquiries_enabled" title="Project enquiries" switchLabel="Collect project enquiries" defaultChecked={w.enquiries.enabled}
            description="When a customer asks about a project or service, the assistant asks the relevant questions, shows a summary, and saves a lead after the customer confirms.">

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
                    </WorkflowCard>
          <WorkflowCard name="support_enabled" title="Tickets" switchLabel="Log tickets" defaultChecked={w.support.enabled}
            description="When a customer reports a problem (for example an order that didn't arrive), the assistant collects the details, shows a summary, and logs a ticket after the customer confirms. It never promises a refund or a fix.">

            <label className="field">Categories <span className="hint">One per line, for example "Delivery" or "Billing". The assistant picks one if it fits.</span>
              <textarea name="support_categories" rows={3} defaultValue={w.support.categories.join("\n")} />
            </label>
            <label className="field">Expected response time <span className="hint">The assistant may tell customers this. Leave empty and it promises no time.</span>
              <input name="support_response_time" maxLength={100} defaultValue={w.support.responseTime} placeholder="within 2 business days" />
            </label>
            <label className="field">Instructions for the assistant <span className="hint">For example: always ask for the order number.</span>
              <textarea name="support_instructions" rows={3} maxLength={1000} defaultValue={w.support.instructions} />
            </label>
                    </WorkflowCard>
          <WorkflowCard name="handoff_enabled" title="Human handoff" switchLabel="Hand chats over to my team" defaultChecked={w.handoff.enabled}
            description="When a customer asks for a person, the assistant steps aside for that chat and you are emailed. Turn this off only if nobody can follow up.">

            <label className="field">When your team is available <input name="availability" maxLength={200} defaultValue={w.handoff.availability} placeholder="Mon-Fri, 9am-6pm" /></label>
            <label className="field">Expected response time <span className="hint">The assistant may tell customers this. Leave empty and it promises no time.</span>
              <input name="response_time" maxLength={100} defaultValue={w.handoff.responseTime} placeholder="within 1 business day" />
            </label>
            <label className="field">Also hand over when... <span className="hint">For example: the customer mentions a refund or a legal matter.</span>
              <textarea name="escalation_instructions" rows={3} maxLength={1000} defaultValue={w.handoff.escalationInstructions} />
            </label>
                    </WorkflowCard>
          <div><SubmitButton pendingText="Saving...">Save workflows</SubmitButton></div>
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
          <div><SubmitButton pendingText="Saving...">Save notifications</SubmitButton></div>
        </form>
      )}

      {tab === "whatsapp" && (
        <Card title="WhatsApp connection" description="The WhatsApp Business number your customers message.">
          <div className="stack">
            <OnboardingBanner status={c?.onboarding_status} step={c?.onboarding_step} />
            {c?.wa_phone_number_id
              ? <p className="muted">Phone number ID: <b>{c.wa_phone_number_id}</b>{mode === "platform" && <> · Monthly reply cap: {c?.monthly_message_cap} (set by the platform admin)</>}</p>
              : <Alert kind="warn">No WhatsApp number is connected yet. <Link href="/onboarding">Connect WhatsApp</Link></Alert>}
          </div>
        </Card>
      )}
    </>
  );
}
