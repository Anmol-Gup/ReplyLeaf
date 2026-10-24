// WhatsApp 24-hour customer service window: free-form messages are allowed
// only within 24h of the customer's last message. After that only approved
// templates can be sent (Phase 2).
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export function isWithinWindow(
  lastCustomerMessageAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!lastCustomerMessageAt) return false;
  return now.getTime() - lastCustomerMessageAt.getTime() < WINDOW_MS;
}

// Shown in the dashboard (Stage 4) when a send is blocked.
export const WINDOW_CLOSED_WARNING =
  "The 24-hour WhatsApp window has closed for this customer. You can only reply once they message you again (template messages are coming in a later phase).";
