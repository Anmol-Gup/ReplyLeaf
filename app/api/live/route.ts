import { NextResponse } from "next/server";
import { getClientOrNull } from "../../../lib/auth/session";
import { loadLive } from "../../../lib/live";

export const dynamic = "force-dynamic";

// Polled by the dashboard. The business and the person come from the session on the server, never from the request.
export async function GET() {
  const c = await getClientOrNull();
  if (!c) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await loadLive(c.db, c.user.id), { headers: { "Cache-Control": "no-store" } });
}
