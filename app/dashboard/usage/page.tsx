import { requireClient } from "../../../lib/auth/session";
import { supabaseAdmin } from "../../../lib/supabase-admin";

export default async function Usage() {
  const { db, clientId } = await requireClient();
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [{ data: client }, { count: replies }, summary] = await Promise.all([
    db.from("clients").select("monthly_message_cap").eq("id", clientId).single(),
    db.from("usage_events").select("id", { count: "exact", head: true }).eq("kind", "reply").gte("created_at", monthStart.toISOString()),
    // Aggregation runs in SQL; clientId comes from the verified membership.
    supabaseAdmin().rpc("client_usage_summary", { p_client_id: clientId, p_since: since.toISOString() }),
  ]);
  const rows = (summary.data ?? []) as { out_day: string; out_provider: string | null; out_model: string | null; out_kind: string; out_events: number; out_input_tokens: number; out_output_tokens: number }[];
  const cap = client?.monthly_message_cap ?? 0;
  const used = replies ?? 0;
  const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const month = rows.filter((r) => new Date(r.out_day) >= monthStart);
  const sum = (k: "out_input_tokens" | "out_output_tokens") => month.reduce((a, r) => a + Number(r[k]), 0);

  return (
    <section className="card">
      <h1>Usage</h1>
      <h2>This month</h2>
      <p>{used} of {cap} AI replies used</p>
      <div className="bar"><div style={{ width: `${pct}%` }} /></div>
      <p className="muted">When the cap is reached the assistant stops using AI and tells customers the team will reply personally. Tokens this month: {sum("out_input_tokens").toLocaleString()} in / {sum("out_output_tokens").toLocaleString()} out.</p>
      <h2>Last 30 days</h2>
      <table>
        <thead><tr><th>Day</th><th>Type</th><th>Provider / model</th><th>Events</th><th>Input tokens</th><th>Output tokens</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}><td>{r.out_day}</td><td>{r.out_kind}</td><td>{r.out_provider ?? "-"} / {r.out_model ?? "-"}</td><td>{Number(r.out_events)}</td><td>{Number(r.out_input_tokens).toLocaleString()}</td><td>{Number(r.out_output_tokens).toLocaleString()}</td></tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={6} className="muted">No usage yet.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
