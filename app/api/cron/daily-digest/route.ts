import { isCronAuthorized } from "../../../../lib/cron";
import { runDailyDigest } from "../../../../lib/digest-job";
import { digestDeps } from "../../../../lib/supabase-digest";
import { raiseAlert } from "../../../../lib/supabase-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Daily: ONE summary email per business (new contacts, leads, appointment requests, tickets, and what is waiting).
// Safe to run twice: a business gets at most one per day. Businesses without an active subscription are skipped.
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  try {
    const summary = await runDailyDigest(digestDeps());
    console.log("daily digest", summary);
    if (summary.failed > 0) await raiseAlert(null, "daily_digest_failures", `${summary.failed} business(es) did not get their daily summary`).catch(() => {});
    return Response.json({ ok: true, ...summary });
  } catch (e) {
    console.error("daily digest failed", e instanceof Error ? e.message : "error");
    await raiseAlert(null, "daily_digest_failed", e instanceof Error ? e.message : "error").catch(() => {});
    return Response.json({ ok: false }, { status: 500 });
  }
}
