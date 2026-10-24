// Daily job logic: keep the 60-day WhatsApp business tokens alive.
// Pure orchestration over RefreshDeps, so it is unit-tested with fakes.
// See refreshBusinessToken() for what Meta's docs leave unclear about refresh.

export const REFRESH_WITHIN_DAYS = 14;

export type ExpiringToken = { clientId: string; clientName: string; expiresAt: Date };

export type RefreshedToken = { expiresAt: Date; assumed: boolean };

export interface RefreshDeps {
  /** Clients whose token expires within `days` (or already has). Tokens stay inside the implementation. */
  listExpiring(days: number): Promise<ExpiringToken[]>;
  /** Refreshes one client's token and stores the new encrypted token + expiry. Throws on failure. */
  refresh(clientId: string): Promise<RefreshedToken>;
  /** Marks onboarding as failed (reason token_expired) so the owner sees "Reconnect". */
  markExpired(clientId: string): Promise<void>;
  alert(clientId: string, kind: string, detail: string): Promise<void>;
  now(): Date;
}

export type RefreshReport = { checked: number; refreshed: number; failed: number; expired: number };

export async function refreshExpiringTokens(deps: RefreshDeps): Promise<RefreshReport> {
  const report: RefreshReport = { checked: 0, refreshed: 0, failed: 0, expired: 0 };
  const now = deps.now();

  for (const t of await deps.listExpiring(REFRESH_WITHIN_DAYS)) {
    report.checked++;
    const daysLeft = Math.floor((t.expiresAt.getTime() - now.getTime()) / 86_400_000);

    // Past expiry Meta says the token is forfeited: only a new Embedded Signup helps.
    if (t.expiresAt.getTime() <= now.getTime()) {
      report.expired++;
      await deps.markExpired(t.clientId);
      await deps.alert(t.clientId, "token_expired", `${t.clientName}: WhatsApp token expired; the customer must reconnect.`);
      continue;
    }

    try {
      await deps.refresh(t.clientId);
      report.refreshed++;
    } catch (e) {
      report.failed++;
      await deps.alert(
        t.clientId, "token_refresh_failed",
        `${t.clientName}: could not refresh the WhatsApp token (${daysLeft} day(s) left). ${e instanceof Error ? e.message.slice(0, 300) : ""}`,
      );
    }
  }
  return report;
}
