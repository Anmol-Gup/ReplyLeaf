import { requireClient } from "../../../lib/auth/session";
import Notice from "../Notice";
import { updateKnowledge } from "../actions";

export default async function Knowledge({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const { notice } = await searchParams;
  const { db, clientId } = await requireClient();
  const { data } = await db.from("clients").select("kb_text").eq("id", clientId).single();
  return (
    <section className="card">
      <h1>Knowledge base</h1>
      <Notice code={notice} />
      <p className="muted">The assistant answers ONLY from this text. If something is not here, it tells the customer it will check with the team. Include prices, opening hours, policies and FAQs.</p>
      <form action={updateKnowledge} className="stack">
        <textarea name="kb_text" style={{ minHeight: 360 }} maxLength={30000} defaultValue={data?.kb_text ?? ""} />
        <div><button type="submit">Save</button></div>
      </form>
    </section>
  );
}
