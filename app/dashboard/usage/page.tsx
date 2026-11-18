import { Badge, Card, EmptyState, ErrorState, PageHeader, Stat } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import { fmt, fmtDay } from "../../../lib/dashboard";
import Link from "next/link";
import { BILLING_STATUS_UNAVAILABLE, ELIGIBILITY_LABELS, FREE_SERVICE_MESSAGES, isEligibility, monthBounds, summariseUsage, WHATSAPP_MANAGER_URL, type UsageRow } from "../../../lib/wa-usage";
import { classifyWhatsAppError } from "../../../lib/whatsapp/errors";
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
  // WhatsApp messaging usage: per business phone number, for the current period (the business's time zone, UTC if none is set).
  // Counted in SQL from this business's own messages; the owner's session means row level security applies as well.
  const { start: waStart, next: waReset } = monthBounds(now, parseWorkflowSettings(client?.workflow_settings).appointments.timezone);
  const [usageRes, { data: failedRows, count: failedCount }, { data: waClient }] = await Promise.all([
    db.rpc("wa_usage_summary", { p_client_id: clientId, p_since: waStart.toISOString(), p_until: waReset.toISOString() }),
    db.from("messages").select("created_at, error, error_code", { count: "exact" }).eq("direction", "outbound").eq("via", "api").eq("status", "failed").gte("created_at", waStart.toISOString()).order("created_at", { ascending: false }).limit(5),
    db.from("clients").select("wa_phone_number_id, wa_free_allowance").eq("id", clientId).single(),
  ]);
  const eligibility = isEligibility(waClient?.wa_free_allowance) ? waClient.wa_free_allowance : "unknown";
  const phones = summariseUsage((usageRes.data ?? []) as UsageRow[], eligibility);
  if (phones.length === 0 && waClient?.wa_phone_number_id) phones.push(...summariseUsage([{ out_phone_number_id: waClient.wa_phone_number_id, out_category: "service", out_total: 0, out_delivered: 0, out_failed: 0, out_awaiting: 0 }], eligibility));
  const billingErrors = (failedRows ?? []).filter((r) => classifyWhatsAppError(r.error_code as number | null, r.error as string | null) === "billing");
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
      <Card title="WhatsApp Messaging Usage"
        description={`Estimated from the messages Replyleaf sent that WhatsApp reported as delivered, ${fmtDay(waStart.toISOString())} to ${fmtDay(new Date(waReset.getTime() - 1).toISOString())}. Meta, not Replyleaf, bills WhatsApp messages; your Meta billing is the source of truth.`}>
        <div className="stack">
          {usageRes.error && <ErrorState>WhatsApp usage could not be loaded.</ErrorState>}
          <p className="muted">
            {ELIGIBILITY_LABELS[eligibility]}.{" "}
            {eligibility === "unknown" && "Not every account qualifies, so the free-allowance figures below assume it does until you confirm. "}
            <Link href="/dashboard/settings?tab=whatsapp">Change this in Settings</Link>.
          </p>
          {phones.length === 0 && <p className="muted">No WhatsApp number is connected yet.</p>}
          {phones.map((u) => (
            <div key={u.phoneNumberId ?? "none"} className="stack">
              <h3>Phone number ID: {u.phoneNumberId ?? "unknown"}</h3>
              <div className="stat-grid">
                <Stat value={u.deliveredService.toLocaleString()} label="Service messages delivered" />
                <Stat value={u.freeAllowance.toLocaleString()} label="Free allowance" />
                <Stat value={u.freeRemaining.toLocaleString()} label="Remaining free messages" />
                <Stat value={u.chargeableService.toLocaleString()} label="Chargeable service messages" />
                <Stat value={u.marketing.toLocaleString()} label="Marketing messages" />
                <Stat value={u.utility.toLocaleString()} label="Utility messages" />
                <Stat value={u.authentication.toLocaleString()} label="Authentication messages" />
                <Stat value={u.failed.toLocaleString()} label="Failed messages" />
                <Stat value={u.awaiting.toLocaleString()} label="Awaiting delivery confirmation" />
              </div>
              {u.state !== "not_applicable" && (
                <div className="stack-sm">
                  <div className="spread"><span>{u.percentUsed}% of the free allowance used</span></div>
                  <div className="bar" role="progressbar" aria-valuenow={u.percentUsed} aria-valuemin={0} aria-valuemax={100} aria-label="Free service-message allowance used"><div style={{ width: `${u.percentUsed}%` }} /></div>
                </div>
              )}
              {u.state === "near" && <p className="notice"><span>You have used {u.percentUsed}% of your free service-message allowance this month.</span></p>}
              {u.state === "exhausted" && <p className="notice warn"><span>Your free service-message allowance has been used. Additional eligible service messages may be charged by Meta according to your account&apos;s pricing and billing setup.</span></p>}
              {u.state === "not_applicable" && <p className="muted">You told us this number does not receive the free allowance, so every delivered service message may be chargeable by Meta.</p>}
            </div>
          ))}
          {billingErrors.length > 0 && (
            <p className="notice error" role="alert"><span>WhatsApp could not deliver this message. Please check your WhatsApp Business Account billing configuration with Meta or your messaging provider. <a href={WHATSAPP_MANAGER_URL} target="_blank" rel="noopener noreferrer">Open WhatsApp Manager</a></span></p>
          )}
          {(failedCount ?? 0) > 0 && (
            <div>
              <h3>Delivery errors this month: {failedCount}</h3>
              <ul className="reqs">
                {(failedRows ?? []).map((r, i) => <li key={i}>{fmt(r.created_at as string)}: {r.error ? (r.error as string).slice(0, 140) : "delivery failed"}{r.error_code ? ` (code ${r.error_code})` : ""}</li>)}
              </ul>
            </div>
          )}
          <p className="muted"><b>WhatsApp billing:</b> {BILLING_STATUS_UNAVAILABLE}. Replyleaf cannot see your Meta payment method or its status, so check it in <a href={WHATSAPP_MANAGER_URL} target="_blank" rel="noopener noreferrer">WhatsApp Manager</a> (or with your messaging provider). Replyleaf never asks for or stores card details.</p>
          <p className="hint">
            Customer messages don&apos;t count. Replies typed in the WhatsApp Business app on your phone aren&apos;t sent through Replyleaf, so they aren&apos;t counted. Messages not yet delivered, or that failed, are never counted as delivered. Three separate costs: your Replyleaf subscription, your AI provider (paid directly with your own key), and WhatsApp messaging (Meta).
          </p>
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
