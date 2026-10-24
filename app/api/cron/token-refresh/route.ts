import { isCronAuthorized } from "../../../../lib/cron";
import { supabaseRefreshDeps } from "../../../../lib/supabase-token-refresh";
import { refreshExpiringTokens } from "../../../../lib/token-refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Daily: refresh WhatsApp business tokens that expire within 14 days, and email the
// admin (through the normal alert path) when a refresh fails or a token has expired.
// Idempotent: running it twice just refreshes again.
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  try {
    return Response.json({ ok: true, ...(await refreshExpiringTokens(supabaseRefreshDeps())) });
  } catch (e) {
    console.error("token refresh job failed", e instanceof Error ? e.message : e);
    return Response.json({ ok: false }, { status: 500 });
  }
}
