import { Badge, Card, EmptyState, ErrorState, PageHeader } from "../../../../components/ui";
import { fmt } from "../../../../lib/dashboard";
import { supabaseAdmin } from "../../../../lib/supabase-admin";
import { ELIGIBILITY_LABELS, detectEligibility, monthBounds, summariseUsage, type UsageRow } from "../../../../lib/wa-usage";
import { classifyWhatsAppError } from "../../../../lib/whatsapp/errors";
import { parseWorkflowSettings } from "../../../../lib/workflow-settings";

// Support view: how each business's WhatsApp number is doing. The layout has already required an admin (404 for everyone else).
// Read-only. It never selects access tokens, PINs or anything about payment.
export default async function AdminWhatsApp() {
  const db = supabaseAdmin();
  const now = new Date();
  const { data: clients, error } = await db.from("clients")
    .select("id, name, status, wa_phone_number_id, wa_free_allowance, wa_free_tier_seen_at, wa_paid_service_seen_at, onboarding_status, last_webhook_at, wa_billing_ack_at, workflow_settings")
    .not("wa_phone_number_id", "is", null).order("name").limit(500);

  const rows = await Promise.all((clients ?? []).map(async (c) => {
    const { start, next } = monthBounds(now, parseWorkflowSettings(c.workflow_settings).appointments.timezone);
    const [usage, failed, lastOk] = await Promise.all([
      db.rpc("wa_usage_summary", { p_client_id: c.id, p_since: start.toISOString(), p_until: next.toISOString() }),
      db.from("messages").select("error, error_code").eq("client_id", c.id).eq("direction", "outbound").eq("via", "api").eq("status", "failed").gte("created_at", start.toISOString()).limit(300),
      db.from("messages").select("created_at").eq("client_id", c.id).eq("direction", "outbound").eq("via", "api").not("wa_message_id", "is", null).neq("status", "failed").order("created_at", { ascending: false }).limit(1),
    ]);
    const eligibility = detectEligibility(c);
    const phones = summariseUsage((usage.data ?? []) as UsageRow[], eligibility);
    const billingErrors = (failed.data ?? []).filter((r) => classifyWhatsAppError(r.error_code as number | null, r.error as string | null) === "billing").length;
    return { c, eligibility, phones, billingErrors, calcOk: !usage.error, lastAccepted: (lastOk.data?.[0]?.created_at as string | undefined) ?? null };
  }));

  return (
    <>
      <PageHeader title="WhatsApp usage" description="For support: each connected number, this month's estimated usage, delivery problems and webhook activity. Usage is an estimate from Replyleaf's own records; Meta's billing is the source of truth. Replyleaf does not read any customer's Meta billing data or payment status." />
      {error ? <ErrorState>Businesses could not be loaded.</ErrorState> : rows.length === 0 ? (
        <EmptyState icon="chat" title="No WhatsApp numbers connected yet">Connected businesses appear here.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Business</th><th>Number ID</th><th>Free allowance</th><th>Delivered (service)</th><th>Chargeable</th><th>Marketing / utility / auth</th><th>Failed</th><th>Awaiting</th><th>Billing errors</th><th>Last webhook</th><th>Last message accepted by Meta</th><th>Calculation</th></tr></thead>
            <tbody>
              {rows.map(({ c, eligibility, phones, billingErrors, calcOk, lastAccepted }) => {
                const t = phones.reduce((a, p) => ({
                  del: a.del + p.deliveredService, charge: a.charge + p.chargeableService, m: a.m + p.marketing, u: a.u + p.utility, au: a.au + p.authentication, f: a.f + p.failed, aw: a.aw + p.awaiting,
                }), { del: 0, charge: 0, m: 0, u: 0, au: 0, f: 0, aw: 0 });
                return (
                  <tr key={c.id}>
                    <td>{c.name}<br /><span className="muted">{c.status} · {c.onboarding_status ?? "manual"}{c.wa_billing_ack_at ? " · billing notice acknowledged" : ""}</span></td>
                    <td>{c.wa_phone_number_id}</td>
                    <td>{ELIGIBILITY_LABELS[eligibility]}</td>
                    <td>{t.del.toLocaleString()}</td>
                    <td>{t.charge.toLocaleString()}</td>
                    <td>{t.m} / {t.u} / {t.au}</td>
                    <td>{t.f}</td>
                    <td>{t.aw}</td>
                    <td>{billingErrors > 0 ? <Badge tone="danger">{billingErrors}</Badge> : "0"}</td>
                    <td>{c.last_webhook_at ? fmt(c.last_webhook_at) : <span className="muted">never</span>}</td>
                    <td>{lastAccepted ? fmt(lastAccepted) : <span className="muted">none yet</span>}</td>
                    <td>{calcOk ? <Badge tone="success">Estimated</Badge> : <Badge tone="danger">Failed</Badge>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Card title="Not available">
        <p className="muted">Meta payment methods and payment status, and Meta&apos;s own billed totals. Replyleaf does not call a Meta billing API, so there is no &quot;last Meta billing sync&quot;: the last message Meta accepted and the last webhook received show that the connection works.</p>
      </Card>
    </>
  );
}
