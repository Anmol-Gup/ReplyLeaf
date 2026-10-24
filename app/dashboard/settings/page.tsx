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
    <section className="card">
      <h1>Settings</h1>
      <Notice code={notice} />
      <form action={updateSettings} className="stack">
        <label>Business name<input name="name" required maxLength={100} defaultValue={c?.name ?? ""} /></label>
        <label>About the business<textarea name="business_info" maxLength={4000} defaultValue={c?.business_info ?? ""} /></label>
        <label>Opening hours<textarea name="business_hours" maxLength={1000} defaultValue={c?.business_hours ?? ""} /></label>
        <label>Booking link (optional, e.g. Calendly). If set, the assistant shares it instead of collecting booking requests.
          <input name="booking_link" type="url" maxLength={500} defaultValue={c?.booking_link ?? ""} placeholder="https://calendly.com/your-name" />
        </label>
        <label>AI provider
          <select name="ai_provider" defaultValue={c?.ai_provider}><option value="gemini">Gemini</option><option value="openai">OpenAI</option></select>
        </label>
        <label>Email for alerts (new leads, booking requests, chats needing you)
          <input name="owner_email" type="email" maxLength={200} defaultValue={c?.owner_email ?? ""} />
        </label>
        <div><button type="submit">Save</button></div>
      </form>
      <h2>WhatsApp connection</h2>
      <OnboardingBanner status={c?.onboarding_status} step={c?.onboarding_step} />
      <h2>Account</h2>
      <p className="muted">WhatsApp phone number ID: {c?.wa_phone_number_id ?? "not connected"} · Monthly reply cap: {c?.monthly_message_cap} (set by the platform admin)</p>
    </section>
  );
}
