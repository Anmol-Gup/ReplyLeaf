import { NextResponse } from "next/server";
import { z } from "zod";
import { getClientOrNull } from "../../../../lib/auth/session";
import { supabaseAdmin } from "../../../../lib/supabase-admin";

export const dynamic = "force-dynamic";

const body = z.union([z.object({ id: z.string().uuid() }), z.object({ all: z.literal(true) })]);

// Mark one notification (or all) read. Only the signed-in person's own rows, and only in their business.
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const c = await getClientOrNull();
  if (!c) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  let q = supabaseAdmin().from("notifications").update({ read_at: new Date().toISOString() })
    .eq("user_id", c.user.id).eq("client_id", c.clientId).is("read_at", null);
  if ("id" in parsed.data) q = q.eq("id", parsed.data.id);
  const { error } = await q;
  return error ? NextResponse.json({ error: "failed" }, { status: 500 }) : NextResponse.json({ ok: true });
}
