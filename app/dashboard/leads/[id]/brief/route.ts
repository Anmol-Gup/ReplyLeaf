import { requireClient } from "../../../../../lib/auth/session";
import { projectBrief } from "../../../../../lib/leads";

export const dynamic = "force-dynamic";

// Downloads the project brief as a text file. Signed-in owners only; RLS means another business's id returns nothing.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db, clientName } = await requireClient();
  const { data: l } = await db.from("leads").select("*").eq("id", id).maybeSingle();
  if (!l) return new Response("Not found", { status: 404 });
  const { data: reqs } = await db.from("lead_requirements").select("requirement_key, requirement_value").eq("lead_id", id).order("created_at");
  return new Response(projectBrief(l, reqs ?? [], clientName), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="project-brief-${id.slice(0, 8)}.txt"`,
      "cache-control": "private, no-store",
    },
  });
}
