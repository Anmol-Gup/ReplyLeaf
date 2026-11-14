"use client";

import { useState } from "react";

// The billing buttons. They only ask OUR server to act: the server works out the business from the signed-in
// session, and Stripe handles the payment. Nothing here decides whether anyone has paid.
type Props = { canSubscribe: boolean; canManage: boolean; canCancel: boolean; paidThrough: string | null };

export default function BillingButtons({ canSubscribe, canManage, canCancel, paidThrough }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function post(path: string, what: string) {
    setBusy(what);
    setMessage(null);
    try {
      const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = (await res.json().catch(() => ({}))) as { url?: string; redirect?: string; error?: string; canceled?: boolean };
      if (body.url) { window.location.assign(body.url); return; }
      if (body.redirect) { window.location.assign(body.redirect); return; }
      if (res.ok && body.canceled) { window.location.reload(); return; }
      setMessage(
        res.status === 429 ? "Please wait a moment and try again."
          : body.error === "billing_not_configured" ? "Billing isn't switched on for this site yet."
          : body.error === "no_billing_account" ? "There's no billing account yet. Subscribe first."
          : "Something went wrong. Please try again.");
    } catch {
      setMessage("Couldn't reach the server. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack-sm">
      <div className="row">
        {canSubscribe && <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => post("/api/billing/checkout", "checkout")}>{busy === "checkout" ? "Opening checkout..." : "Subscribe for ₹999/month"}</button>}
        {canManage && <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => post("/api/billing/portal", "portal")}>{busy === "portal" ? "Opening..." : "Manage billing"}</button>}
        {canCancel && !confirming && <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => setConfirming(true)}>Cancel subscription</button>}
      </div>
      {confirming && (
        <div className="note" role="alertdialog" aria-label="Confirm cancellation">
          <p><b>Cancel your subscription?</b> It will not renew{paidThrough ? `, and everything keeps working until ${paidThrough}` : ""}. Your data is kept, and you can subscribe again any time.</p>
          <div className="row" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-danger btn-sm" disabled={busy !== null} onClick={() => post("/api/billing/cancel", "cancel")}>{busy === "cancel" ? "Cancelling..." : "Yes, cancel at the end of the period"}</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(false)}>Keep my subscription</button>
          </div>
        </div>
      )}
      {message && <p role="alert" className="muted">{message}</p>}
    </div>
  );
}
