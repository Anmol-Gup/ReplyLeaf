// Small display helpers for the dashboard.
export const fmt = (iso: string | null | undefined) =>
  iso ? `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC` : "-";

export const NOTICES: Record<string, { kind: "ok" | "warn" | "error"; text: string }> = {
  saved: { kind: "ok", text: "Saved." },
  window_closed: { kind: "warn", text: "Not sent: the 24-hour WhatsApp window has closed for this customer. You can reply again once they message you (template messages come in a later phase)." },
  take_over_first: { kind: "warn", text: "Take over the conversation before replying, so the assistant stays silent." },
  send_failed: { kind: "error", text: "WhatsApp rejected the message. Nothing was sent. The admin has the details." },
  invalid: { kind: "error", text: "Some values were invalid. Please check and try again." },
  deleted: { kind: "ok", text: "The contact and all their messages were deleted." },
  published: { kind: "ok", text: "Published. The assistant can use this document now." },
  published_no_vectors: { kind: "warn", text: "Published, but the semantic-search index could not be built right now. Keyword search works; use Re-index later to add it." },
  reindexed: { kind: "ok", text: "Re-indexed." },
  discarded: { kind: "ok", text: "Draft discarded." },
  extract_failed: { kind: "error", text: "That file could not be used." },
  not_found: { kind: "error", text: "Not found." },
  appt_done: { kind: "ok", text: "Appointment updated." },
  appt_done_whatsapp: { kind: "ok", text: "Appointment updated and the customer was told on WhatsApp." },
  appt_done_email: { kind: "ok", text: "Appointment updated. The WhatsApp window had closed, so the customer was told by email." },
  appt_done_not_sent: { kind: "warn", text: "Appointment updated, but the customer could NOT be reached: the 24-hour WhatsApp window has closed and we have no email for them. Copy the message below and send it another way." },
  appt_need_alternative: { kind: "error", text: "Tell the customer what you suggest instead (a date, a time or a note)." },
  appt_failed: { kind: "error", text: "That change was not allowed (the appointment may already have changed). Refresh and try again." },
  subscription_required: { kind: "warn", text: "That needs an active subscription. Subscribe or update your payment method below. You can still view and export your data." },
  ai_key_saved: { kind: "ok", text: "Your AI key is saved and working. Chats that were waiting because of the key were handed back to the assistant." },
  ai_key_saved_unverified: { kind: "warn", text: "Your AI key is saved, but we couldn't check it just now (the provider didn't answer). It will be used on the next message; if it is wrong you will be emailed." },
  ai_key_refused: { kind: "error", text: "The provider refused that key, so nothing was saved. Check that you copied it completely, that it belongs to the provider you chose, and that it hasn't been revoked." },
  ai_key_format: { kind: "error", text: "That doesn't look like a key for the provider you chose. Nothing was saved." },
  ai_key_empty: { kind: "error", text: "Paste your AI key first." },
  ai_key_removed: { kind: "warn", text: "Your AI key was removed. The assistant is off until you add a new one." },
  notif_invalid: { kind: "error", text: "One of the email addresses is not valid (or there are more than 5 additional addresses). Nothing was changed." },
  tkt_saved: { kind: "ok", text: "Ticket updated." },
  tkt_done_whatsapp: { kind: "ok", text: "Ticket updated and the customer was told on WhatsApp." },
  tkt_done_email: { kind: "ok", text: "Ticket updated. The WhatsApp window had closed, so the customer was told by email." },
  tkt_done_not_sent: { kind: "warn", text: "Ticket updated, but the customer could NOT be reached: the 24-hour WhatsApp window has closed and we have no email for them." },
  lead_saved: { kind: "ok", text: "Lead updated." },
  handoff_updated: { kind: "ok", text: "Handoff updated." },
  handoff_resolved: { kind: "ok", text: "Marked as resolved. The assistant stays silent in that chat until you resume it." },
  handoff_resumed: { kind: "ok", text: "Done. The assistant is replying to that customer again." },
  handoff_failed: { kind: "error", text: "That change was not allowed (it may already be resolved or taken over). Refresh and try again." },
};

// ---- display helpers (pure, unit-tested) ----

const pad = (n: number) => String(n).padStart(2, "0");

/** "14:05" in UTC, for chat bubbles. */
export const fmtTime = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

/** "24 Oct" in UTC, for day dividers and lists. */
export const fmtDay = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`;
};

/** Plain-language state of the 24-hour WhatsApp window. */
export function windowStatus(lastCustomerMessageAt: string | null | undefined, now = new Date()): { open: boolean; label: string } {
  if (!lastCustomerMessageAt) return { open: false, label: "Closed: this customer has not messaged yet" };
  const msLeft = new Date(lastCustomerMessageAt).getTime() + 24 * 60 * 60 * 1000 - now.getTime();
  if (msLeft <= 0) return { open: false, label: "Closed: you can reply once they message again" };
  const h = Math.floor(msLeft / 3_600_000);
  const m = Math.floor((msLeft % 3_600_000) / 60_000);
  return { open: true, label: `Open: closes in ${h}h ${pad(m)}m` };
}

/** Case-insensitive "contains any" used by the list search boxes. */
export const matches = (query: string | undefined, ...fields: (string | null | undefined)[]) => {
  const q = (query ?? "").trim().toLowerCase();
  return !q || fields.some((f) => (f ?? "").toLowerCase().includes(q));
};

export const clip = (s: string | null | undefined, n = 70) => (s && s.length > n ? `${s.slice(0, n)}...` : (s ?? ""));
