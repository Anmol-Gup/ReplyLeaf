import Link from "next/link";
import { requireClient } from "../../lib/auth/session";
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
    <section className="card">
      <h1>Overview</h1>
      <OnboardingBanner status={conn?.onboarding_status} step={conn?.onboarding_step} />
      <div className="grid">
        <Link className="stat" href="/dashboard/conversations"><b>{human}</b>conversations waiting for you</Link>
        <Link className="stat" href="/dashboard/bookings"><b>{pending}</b>booking requests to confirm</Link>
        <Link className="stat" href="/dashboard/contacts"><b>{leads}</b>new leads</Link>
        <Link className="stat" href="/dashboard/contacts"><b>{contacts}</b>contacts in total</Link>
      </div>
    </section>
  );
}
