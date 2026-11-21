import { NextResponse } from "next/server";
import { getClientOrNull } from "../../../lib/auth/session";
import { decodeCursor, DRAWER_FILTERS, encodeCursor, FILTER_KINDS, PAGE_SIZE, type DrawerFilter } from "../../../lib/notifications";

export const dynamic = "force-dynamic";

// The notification drawer's pages: a filter and a cursor in, up to 20 newest-first items and the per-category counts out.
// Read with the person's own (RLS) client, so only their own notifications in their business can come back.
export async function GET(req: Request) {
  const c = await getClientOrNull();
  if (!c) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url);
  const f = u.searchParams.get("filter") ?? "all";
  const filter: DrawerFilter = (DRAWER_FILTERS as readonly string[]).includes(f) ? (f as DrawerFilter) : "all";
  const cursor = decodeCursor(u.searchParams.get("cursor"));
  const withCounts = u.searchParams.get("counts") !== "0";

  let q = c.db.from("notifications").select("id, kind, title, body, link, read_at, created_at").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE_SIZE + 1);
  if (filter === "unread") q = q.is("read_at", null);
  else if (filter !== "all") q = q.in("kind", FILTER_KINDS[filter]);
  if (cursor) q = q.or(`created_at.lt."${cursor.at}",and(created_at.eq."${cursor.at}",id.lt.${cursor.id})`);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: "failed" }, { status: 500 });
  const rows = data ?? [];
  const page = rows.slice(0, PAGE_SIZE);
  const items = page.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, read: n.read_at !== null, created_at: n.created_at }));
  const last = page[page.length - 1];

  let counts: Record<DrawerFilter, number> | undefined;
  if (withCounts) {
    const head = (mod: (x: ReturnType<typeof base>) => unknown) => mod(base()) as PromiseLike<{ count: number | null }>;
    const base = () => c.db.from("notifications").select("id", { count: "exact", head: true });
    const [all, unread, handoff, appointment, ticket] = await Promise.all([
      head((x) => x), head((x) => x.is("read_at", null)),
      head((x) => x.in("kind", FILTER_KINDS.handoff)), head((x) => x.in("kind", FILTER_KINDS.appointment)), head((x) => x.in("kind", FILTER_KINDS.ticket)),
    ]);
    counts = { all: all.count ?? 0, unread: unread.count ?? 0, handoff: handoff.count ?? 0, appointment: appointment.count ?? 0, ticket: ticket.count ?? 0 };
  }
  return NextResponse.json({ items, nextCursor: rows.length > PAGE_SIZE && last ? encodeCursor(last.created_at, last.id) : null, counts }, { headers: { "Cache-Control": "no-store" } });
}
