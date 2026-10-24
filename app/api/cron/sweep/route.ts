import { sweepDueBatches } from "../../../../lib/batch";
import { isCronAuthorized } from "../../../../lib/cron";
import { supabaseBatchDeps } from "../../../../lib/supabase-batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Backstop for batches stranded by a crashed worker. The webhook already sweeps
// after every request, so this only matters on quiet accounts. Safe to run twice:
// claiming a batch is atomic and idempotent.
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  const swept = await sweepDueBatches(supabaseBatchDeps(), 20);
  return Response.json({ swept });
}
