import { Badge, Card, EmptyState, ErrorState, PageHeader, Stat } from "../../../components/ui";
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
    <>
      <PageHeader title="Usage" description="What your assistant has used this month." />
      <div className="stat-grid">
        <Stat value={`${used.toLocaleString()} / ${cap.toLocaleString()}`} label="AI replies this month" />
        <Stat value={sum("out_input_tokens").toLocaleString()} label="Input tokens this month" />
        <Stat value={sum("out_output_tokens").toLocaleString()} label="Output tokens this month" />
      </div>
      <Card title="Monthly cap" description="When the cap is reached the assistant stops using AI and tells customers your team will reply personally.">
        <div className="stack-sm">
          <div className="spread"><span>{pct}% used</span>{pct >= 90 && <Badge tone="warn">Close to the cap</Badge>}</div>
          <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Monthly reply cap used"><div style={{ width: `${pct}%` }} /></div>
        </div>
      </Card>
      <Card title="Last 30 days">
        {summary.error ? <ErrorState>Usage could not be loaded.</ErrorState> : rows.length === 0 ? (
          <EmptyState icon="chart" title="No usage yet">Numbers appear after the assistant sends its first reply.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Day</th><th>Type</th><th>Provider / model</th><th>Events</th><th>Input tokens</th><th>Output tokens</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}><td>{r.out_day}</td><td>{r.out_kind}</td><td>{r.out_provider ?? "-"} / {r.out_model ?? "-"}</td><td>{Number(r.out_events)}</td><td>{Number(r.out_input_tokens).toLocaleString()}</td><td>{Number(r.out_output_tokens).toLocaleString()}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
