import SubmitButton from "../../../components/SubmitButton";
import { Card, PageHeader } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import Notice from "../Notice";
import OnboardingBanner from "../OnboardingBanner";
import { updateSettings } from "../actions";

export default async function Settings({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const { notice } = await searchParams;
  const { db, clientId } = await requireClient();
  const { data: c } = await db.from("clients")
    .select("name, business_info, business_hours, booking_link, ai_provider, owner_email, monthly_message_cap, wa_phone_number_id, onboarding_status, onboarding_step").eq("id", clientId).single();
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
        <Card title="Alerts">
          <label className="field">Email for alerts <span className="hint">New leads and chats that need you.</span>
            <input name="owner_email" type="email" maxLength={200} defaultValue={c?.owner_email ?? ""} />
          </label>
        </Card>
        <div><SubmitButton pendingText="Saving...">Save settings</SubmitButton></div>
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
