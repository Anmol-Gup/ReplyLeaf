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
  not_found: { kind: "error", text: "Not found." },
};
