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
