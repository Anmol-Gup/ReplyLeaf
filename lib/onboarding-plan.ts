// Decides what the onboarding callback should do, BEFORE any call to Meta, so the
// rules are pure and testable:
//   * one client per login, and a WABA / phone number belongs to exactly one client
//   * retrying after a failure resumes the SAME client row (never a duplicate)

export type ClientRow = {
  id: string;
  onboardingStatus: "manual" | "pending" | "connected" | "failed";
  onboardingStep: string | null;
  updatedAt: Date | null;
};

// A flow that stops updating its row for this long is treated as crashed and may be resumed.
export const IN_PROGRESS_WINDOW_MS = 2 * 60 * 1000;

export type PlanInput = {
  /** The client this login already belongs to, if any. */
  mine: ClientRow | null;
  /** The client that already owns the WABA being connected, if any. */
  wabaOwner: ClientRow | null;
  /** The client that already owns the phone number being connected, if any. */
  phoneOwner: ClientRow | null;
};

export type Plan =
  | { action: "create" }
  | { action: "resume"; clientId: string }
  | { action: "already_connected" }
  | { action: "in_progress" }
  | { action: "conflict"; what: "waba" | "phone" };

export function planOnboarding({ mine, wabaOwner, phoneOwner }: PlanInput, now = new Date()): Plan {
  // Never take over a WABA or number that is linked to a different client.
  if (wabaOwner && wabaOwner.id !== mine?.id) return { action: "conflict", what: "waba" };
  if (phoneOwner && phoneOwner.id !== mine?.id) return { action: "conflict", what: "phone" };

  if (!mine) return { action: "create" };
  // A failed onboarding (an expired token also marks it failed) can be retried.
  if (mine.onboardingStatus === "failed") return { action: "resume", clientId: mine.id };

  // 'pending' before the final step means a flow is running now (a double click would
  // otherwise race it) or crashed earlier. Resume only once it has gone quiet.
  if (mine.onboardingStatus === "pending" && mine.onboardingStep !== "complete") {
    const quietFor = mine.updatedAt ? now.getTime() - mine.updatedAt.getTime() : Infinity;
    return quietFor < IN_PROGRESS_WINDOW_MS ? { action: "in_progress" } : { action: "resume", clientId: mine.id };
  }
  return { action: "already_connected" };
}

export const STEP_REASONS: Record<string, string> = {
  token_exchange: "WhatsApp did not accept the sign-in code (it may have expired). Please try again.",
  phone_access: "We could not confirm access to that phone number.",
  subscribe: "We could not subscribe to your WhatsApp account's messages.",
  register: "We could not register the phone number.",
  save: "We could not save the connection.",
  token_expired: "The connection to WhatsApp expired. Please reconnect.",
  token_refresh: "The connection could not be renewed. Please reconnect.",
  partner_removed: "WhatsApp reports the connection was removed from your account.",
};
