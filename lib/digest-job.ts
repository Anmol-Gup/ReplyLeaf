import { buildDigest, type DigestData, type DigestSwitches } from "./digest";
import type { MailMessage } from "./email/mailer";

// Sends the daily summary: at most one email per business per day, only for businesses whose subscription allows
// automation, only when there is something to say. Everything external is behind DigestDeps so it is unit-tested.

export type DigestBusiness = {
  clientId: string; name: string; recipients: string[]; switches: DigestSwitches;
  delivery: "daily" | "immediate"; lastDigestAt: Date | null;
};

export interface DigestDeps {
  now(): Date;
  appUrl?: string;
  listBusinesses(): Promise<DigestBusiness[]>;
  /** The businesses whose subscription currently allows automation (billing). */
  paid(ids: string[], now: Date): Promise<Set<string>>;
  gather(clientId: string, name: string, since: Date, now: Date): Promise<DigestData>;
  claimToday(clientId: string, today: string): Promise<boolean>;
  releaseToday(clientId: string): Promise<void>;
  markSent(clientId: string, at: Date): Promise<void>;
  send(msg: MailMessage): Promise<void>;
}

export type DigestSummary = { businesses: number; sent: number; empty: number; skippedUnpaid: number; skippedImmediate: number; failed: number };

const DAY = 86_400_000;

export async function runDailyDigest(deps: DigestDeps): Promise<DigestSummary> {
  const now = deps.now();
  const today = now.toISOString().slice(0, 10);
  const all = await deps.listBusinesses();
  const paid = await deps.paid(all.map((b) => b.clientId), now);
  const summary: DigestSummary = { businesses: all.length, sent: 0, empty: 0, skippedUnpaid: 0, skippedImmediate: 0, failed: 0 };

  for (const b of all) {
    if (b.delivery === "immediate") { summary.skippedImmediate++; continue; }     // they get each one as it happens
    if (!paid.has(b.clientId)) { summary.skippedUnpaid++; continue; }             // automation is paused for them
    if (b.recipients.length === 0) continue;

    // Everything since the last digest, but never more than 36 hours back (a long gap must not produce a huge email).
    const since = b.lastDigestAt && now.getTime() - b.lastDigestAt.getTime() < 1.5 * DAY ? b.lastDigestAt : new Date(now.getTime() - DAY);
    let claimed = false;
    try {
      if (!(await deps.claimToday(b.clientId, today))) continue;                  // already sent today: running twice is harmless
      claimed = true;
      const data = await deps.gather(b.clientId, b.name, since, now);
      const msg = buildDigest(data, b.switches, { appUrl: deps.appUrl, sinceLabel: "the last 24 hours" });
      if (!msg) { summary.empty++; await deps.markSent(b.clientId, now); continue; }
      const results = await Promise.allSettled(b.recipients.map((to) => deps.send({ ...msg, to })));
      if (results.every((r) => r.status === "rejected")) throw new Error("no recipient could be emailed");
      await deps.markSent(b.clientId, now);
      summary.sent++;
    } catch (e) {
      summary.failed++;
      if (claimed) await deps.releaseToday(b.clientId).catch(() => {}); // so the next run can try again
      console.error("daily digest failed for a business", { clientId: b.clientId, error: e instanceof Error ? e.message : "error" });
    }
  }
  return summary;
}
