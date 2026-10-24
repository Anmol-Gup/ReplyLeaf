import { sweepDueBatches } from "../../../../lib/batch";
import { supabaseBatchDeps } from "../../../../lib/supabase-batch";
import { safeEqual } from "../../../../lib/whatsapp/signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Backstop for batches stranded by a crashed worker. The webhook already sweeps
// after every request, so this only matters on quiet accounts. Vercel calls it
// with "Authorization: Bearer $CRON_SECRET". Safe to run twice: claiming a batch
// is atomic and idempotent.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const swept = await sweepDueBatches(supabaseBatchDeps(), 20);
  return Response.json({ swept });
}
