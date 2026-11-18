import { Badge, Card, EmptyState, ErrorState, PageHeader, Stat } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import { fmt, fmtDay } from "../../../lib/dashboard";
import { monthBounds, serviceUsage, FREE_SERVICE_MESSAGES } from "../../../lib/wa-usage";
import { classifyWhatsAppError, PROBLEM_LABELS } from "../../../lib/whatsapp/errors";
import { parseWorkflowSettings } from "../../../lib/workflow-settings";
import { supabaseAdmin } from "../../../lib/supabase-admin";

export default async function Usage() {
  const { db, clientId } = await requireClient();
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [{ data: client }, { count: replies }, summary] = await Promise.all([
    db.from("clients").select("monthly_message_cap, ai_mode, workflow_settings").eq("id", clientId).single(),
    db.from("usage_events").select("id", { count: "exact", head: true }).eq("kind", "reply").gte("created_at", monthStart.toISOString()),
    // Aggregation runs in SQL; clientId comes from the verified membership.
    supabaseAdmin().rpc("client_usage_summary", { p_client_id: clientId, p_since: since.toISOString() }),
  ]);
  const rows = (summary.data ?? []) as { out_day: string; out_provider: string | null; out_model: string | null; out_kind: string; out_events: number; out_input_tokens: number; out_output_tokens: number }[];
  // WhatsApp messaging: delivered service messages this month (the month resets in the business's time zone, UTC if none is set).
  const { start: waStart, next: waReset } = monthBounds(now, parseWorkflowSettings(client?.workflow_settings).appointments.timezone);
  const [{ count: deliveredCount }, { data: failedRows, count: failedCount }] = await Promise.all([
    db.from("messages").select("id", { count: "exact", head: true }).eq("direction", "outbound").in("status", ["delivered", "read"]).gte("created_at", waStart.toISOString()),
    db.from("messages").select("created_at, error", { count: "exact" }).eq("direction", "outbound").eq("status", "failed").gte("created_at", waStart.toISOString()).order("created_at", { ascending: false }).limit(5),
  ]);
  const wa = serviceUsage(deliveredCount ?? 0);
  const byok = client?.ai_mode === "byok";
  const cap = client?.monthly_message_cap ?? 0;
  const used = replies ?? 0;
  const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const month = rows.filter((r) => new Date(r.out_day) >= monthStart);
  const sum = (k: "out_input_tokens" | "out_output_tokens") => month.reduce((a, r) => a + Number(r[k]), 0);

  return (
    <>
      <PageHeader title="Usage" description="What your assistant has used this month." />
      <div className="stat-grid">
        <Stat value={byok ? used.toLocaleString() : `${used.toLocaleString()} / ${cap.toLocaleString()}`} label="AI replies this month" />
        <Stat value={sum("out_input_tokens").toLocaleString()} label="Input tokens this month" />
        <Stat value={sum("out_output_tokens").toLocaleString()} label="Output tokens this month" />
      </div>
      {byok ? (
        <Card title="Your AI account">
          <p className="muted">The assistant uses your own AI key, so your AI provider bills you directly for these tokens. There is no monthly reply cap from us. Check your provider&apos;s dashboard for cost and limits.</p>
        </Card>
      ) : (
      <Card title="Monthly cap" description="When the cap is reached the assistant stops using AI and tells customers your team will reply personally.">
        <div className="stack-sm">
          <div className="spread"><span>{pct}% used</span>{pct >= 90 && <Badge tone="warn">Close to the cap</Badge>}</div>
          <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Monthly reply cap used"><div style={{ width: `${pct}%` }} /></div>
        </div>
      </Card>
      )}
      <Card title="WhatsApp messages this month" description="Meta, not Replyleaf, charges for WhatsApp messages. Each business phone number gets its first 1,000 delivered service messages free every month; the rest are charged by Meta to your WhatsApp account.">
        <div className="stat-grid">
          <Stat value={wa.delivered.toLocaleString()} label="Service messages delivered" />
          <Stat value={wa.freeUsed.toLocaleString()} label="Free messages used" />
          <Stat value={wa.freeRemaining.toLocaleString()} label={`Free messages left of ${FREE_SERVICE_MESSAGES.toLocaleString()}`} />
          <Stat value={wa.paid.toLocaleString()} label="Paid messages (charged by Meta)" />
        </div>
        <p className="muted" style={{ marginTop: 12 }}>
          Resets on {fmtDay(waReset.toISOString())}. This is an estimate from the replies Replyleaf sent that WhatsApp reported as delivered (the assistant&apos;s and the ones you send from the dashboard). Customer messages don&apos;t count, and messages you type in the WhatsApp Business app on your phone aren&apos;t sent through Replyleaf, so they aren&apos;t counted here. Your Meta billing is the source of truth, and rates depend on the country.
        </p>
        {(failedCount ?? 0) > 0 && (
          <div style={{ marginTop: 12 }}>
            <h3>Delivery errors this month: {failedCount}</h3>
            <ul className="reqs">
              {(failedRows ?? []).map((r, i) => <li key={i}>{fmt(r.created_at as string)}: {PROBLEM_LABELS[classifyWhatsAppError(null, r.error as string | null)]}{r.error ? ` (${(r.error as string).slice(0, 120)})` : ""}</li>)}
            </ul>
          </div>
        )}
        <p className="hint" style={{ marginTop: 12 }}>
          Three separate costs: your Replyleaf subscription, your AI provider (you pay it directly with your own key), and WhatsApp messaging (Meta). Replyleaf doesn&apos;t pay or collect your WhatsApp charges.
        </p>
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
