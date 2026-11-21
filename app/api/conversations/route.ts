import { NextResponse } from "next/server";
import { getClientOrNull } from "../../../lib/auth/session";
import { loadConversationList } from "../../../lib/conversation-list";
import { CONVERSATION_FILTERS, type ConversationFilter } from "../../../lib/conversation-state";

export const dynamic = "force-dynamic";

// The Conversations list for the signed-in person's business. Filter and search are applied here; the business is never taken from the request.
export async function GET(req: Request) {
  const c = await getClientOrNull();
  if (!c) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url);
  const f = u.searchParams.get("filter") ?? "all";
  const filter = (CONVERSATION_FILTERS as readonly string[]).includes(f) ? (f as ConversationFilter) : "all";
  const res = await loadConversationList(c.db, c.user.id, { filter, q: u.searchParams.get("q") ?? "" });
  return NextResponse.json(res, { headers: { "Cache-Control": "no-store" } });
}
