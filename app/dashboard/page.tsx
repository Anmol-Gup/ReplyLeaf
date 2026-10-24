import { requireClient } from "../../lib/auth/session";
import { PageHeader, Stat } from "../../components/ui";
import OnboardingBanner from "./OnboardingBanner";

export default async function Overview() {
  const { db, clientId } = await requireClient(); // RLS limits every count to this owner's client
  const { data: conn } = await db.from("clients").select("onboarding_status, onboarding_step").eq("id", clientId).single();
  const count = async (table: string, col?: string, val?: string) => {
    let q = db.from(table).select("id", { count: "exact", head: true });
    if (col && val) q = q.eq(col, val);
    return (await q).count ?? 0;
  };
  const [human, pending, leads, contacts] = await Promise.all([
    count("conversations", "handling", "human_active"),
    count("booking_requests", "status", "pending"),
    count("contacts", "status", "lead"),
    count("contacts"),
  ]);
  return (
    <>
      <PageHeader title="Overview" description="What needs your attention right now." />
      <OnboardingBanner status={conn?.onboarding_status} step={conn?.onboarding_step} />
      <div className="stat-grid">
        <Stat href="/dashboard/conversations" value={human} label="Conversations waiting for you" />
        <Stat href="/dashboard/bookings" value={pending} label="Booking requests to confirm" />
        <Stat href="/dashboard/contacts" value={leads} label="New leads" />
        <Stat href="/dashboard/contacts" value={contacts} label="Contacts in total" />
      </div>
    </>
  );
}
