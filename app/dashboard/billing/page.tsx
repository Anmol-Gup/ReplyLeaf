import BillingButtons from "../../../components/BillingButtons";
import { Badge, Card, EmptyState, PageHeader } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import { billingEnforced, computeAccess, daysLeft, type SubscriptionRow } from "../../../lib/billing/access";
import { formatMoney } from "../../../lib/billing/emails";
import { syncAfterCheckout } from "../../../lib/billing/supabase-billing";
import { fmt } from "../../../lib/dashboard";
import Notice from "../Notice";

const date = (v: string | null | undefined) => (v ? new Date(v).toISOString().slice(0, 10) : "-");

const STATUS_LABEL: Record<string, string> = {
  none: "No subscription", incomplete: "Payment not completed", incomplete_expired: "Expired", trialing: "Active", active: "Active",
  past_due: "Payment overdue", canceled: "Cancelled", unpaid: "Unpaid", paused: "Paused",
};

export default async function Billing({ searchParams }: { searchParams: Promise<{ notice?: string; checkout?: string }> }) {
  const { notice, checkout } = await searchParams;
  const { db, clientId } = await requireClient();
  if (checkout === "success" && billingEnforced()) await syncAfterCheckout(clientId); // from Stripe, not from the URL

  const [{ data: client }, { data: sub }, { data: invoices }] = await Promise.all([
    db.from("clients").select("billing_exempt").eq("id", clientId).maybeSingle(),
    db.from("subscriptions").select("status, stripe_customer_id, current_period_start, current_period_end, cancel_at_period_end, grace_ends_at, ended_at").eq("client_id", clientId).maybeSingle(),
    db.from("invoices").select("stripe_invoice_id, status, amount_due, amount_paid, currency, hosted_invoice_url, invoice_pdf, period_start, period_end, paid_at, created_at").eq("client_id", clientId).order("created_at", { ascending: false }).limit(24),
  ]);
  const now = new Date();
  const enforced = billingEnforced();
  const exempt = client?.billing_exempt === true;
  const row: SubscriptionRow = sub ? { status: sub.status, current_period_end: sub.current_period_end, cancel_at_period_end: sub.cancel_at_period_end, grace_ends_at: sub.grace_ends_at } : null;
  const access = computeAccess(row, { exempt, enforced, now });
  const status = sub?.status ?? "none";
  const live = status === "active" || status === "trialing" || status === "past_due";
  const cancelling = live && sub?.cancel_at_period_end === true;
  const processing = checkout === "success" && !live;

  return (
    <>
      <PageHeader title="Billing" description="Your subscription, payments and invoices." />
      <Notice code={notice} />
      {processing && <p className="note" role="status">We&apos;re confirming your payment with Stripe. This usually takes a few seconds: refresh this page in a moment. Your access starts as soon as Stripe confirms it.</p>}
      {checkout === "cancelled" && <p className="muted">Checkout was cancelled. You haven&apos;t been charged.</p>}

      <Card title="WhatsApp AI Assistant" description="₹999 per month, billed monthly in INR. It renews automatically each month until you cancel, and you can cancel any time."
        actions={exempt ? <Badge tone="brand">Complimentary</Badge> : <Badge tone={access.allowed ? (access.reason === "grace" ? "warn" : "success") : "danger"}>{STATUS_LABEL[status] ?? status}</Badge>}>
        <div className="stack">
          {!enforced && <p className="muted">Billing isn&apos;t switched on for this installation, so every feature is available.</p>}
          {enforced && exempt && <p className="muted">Your account is on a complimentary plan. There is nothing to pay.</p>}
          {enforced && !exempt && (
            <dl className="handoff-facts">
              <div><dt>Status</dt><dd>{STATUS_LABEL[status] ?? status}{access.reason === "grace" && access.graceEndsAt ? ` (pay by ${date(access.graceEndsAt.toISOString())})` : ""}</dd></div>
              <div><dt>{cancelling ? "Ends on" : "Next payment"}</dt><dd>{live ? date(sub?.current_period_end) : "-"}</dd></div>
              <div><dt>Current period</dt><dd>{sub?.current_period_start ? `${date(sub.current_period_start)} to ${date(sub.current_period_end)}` : "-"}</dd></div>
              <div><dt>Plan</dt><dd>₹999 / month</dd></div>
            </dl>
          )}
          {enforced && !exempt && access.reason === "grace" && <p role="alert"><b>Your latest payment failed.</b> Update your payment method within {daysLeft(access.graceEndsAt, now)} day(s). Your assistant keeps working until then.</p>}
          {enforced && !exempt && !access.allowed && (
            <div className="note">
              <p><b>{status === "past_due" ? "Your payment is overdue, so WhatsApp automation is paused." : "Your subscription is inactive."}</b> {status === "past_due" ? "Update your payment method and everything resumes automatically. Nothing has been deleted." : "Subscribe to switch the assistant on. Your data is kept."}</p>
            </div>
          )}
          {enforced && !exempt && (
            <BillingButtons
              canSubscribe={!live}
              canManage={Boolean(sub?.stripe_customer_id)}
              canCancel={live && !cancelling}
              paidThrough={sub?.current_period_end ? date(sub.current_period_end) : null}
            />
          )}
        </div>
      </Card>

      {enforced && !exempt && !live && (
        <Card title="What's included">
          <ul className="stack-sm" style={{ paddingLeft: 18, margin: 0 }}>
            <li>An AI assistant that answers your customers on WhatsApp from your own information.</li>
            <li>Appointment requests, project enquiries and tickets, with owner emails.</li>
            <li>Human handoff with an inbox for your team.</li>
            <li>Your data stays yours: you can export it at any time, even without a subscription.</li>
          </ul>
          <p className="muted" style={{ marginTop: 12 }}>
            This price is for using Replyleaf. You pay your own AI provider (with your own key) and Meta&apos;s WhatsApp charges separately: we don&apos;t charge for AI usage or WhatsApp messages.
            Your card or bank mandate is authorised by you on Stripe&apos;s secure page, and the subscription only starts once that is confirmed.
          </p>
        </Card>
      )}

      <Card title="What you pay for" description="Three separate costs. Replyleaf only charges the first one.">
        <ul className="reqs">
          <li><b>Replyleaf subscription:</b> ₹999 per month, paid here.</li>
          <li><b>AI usage:</b> paid directly to your AI provider (Google or OpenAI) with your own key.</li>
          <li><b>WhatsApp messaging:</b> paid to Meta through your own WhatsApp Business Account or messaging provider. Each business phone number gets its first 1,000 delivered service messages free every month; after that Meta charges, at rates that depend on the country. Replyleaf does not pay or collect these charges. See <a href="/dashboard/usage">Usage</a> for an estimate of this month.</li>
        </ul>
      </Card>

      <Card title="Payment history">
        {(invoices ?? []).length === 0 ? <EmptyState icon="card" title="No payments yet">Invoices appear here after your first payment.</EmptyState> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Period</th><th>Amount</th><th>Status</th><th>Invoice</th></tr></thead>
              <tbody>
                {(invoices ?? []).map((i) => (
                  <tr key={i.stripe_invoice_id}>
                    <td>{fmt(i.paid_at ?? i.created_at).replace(" UTC", "")}</td>
                    <td>{date(i.period_start)} to {date(i.period_end)}</td>
                    <td>{formatMoney(Number(i.status === "paid" ? i.amount_paid : i.amount_due), i.currency)}</td>
                    <td><Badge tone={i.status === "paid" ? "success" : i.status === "open" ? "warn" : "muted"}>{i.status === "paid" ? "Paid" : i.status === "open" ? "Unpaid" : i.status}</Badge></td>
                    <td>{i.hosted_invoice_url ? <a href={i.hosted_invoice_url} target="_blank" rel="noopener noreferrer">View</a> : "-"}{i.invoice_pdf && <> · <a href={i.invoice_pdf} target="_blank" rel="noopener noreferrer">PDF</a></>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Your data" description="You can download everything in your account at any time, whatever your subscription status.">
        <a className="btn btn-secondary" href="/api/account/export">Export my data (JSON)</a>
      </Card>
    </>
  );
}
