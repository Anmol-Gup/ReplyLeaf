import { supabaseAdmin } from "./supabase-admin";

// The people who can work on a business's tickets: the real members of THAT business (client_users), looked up on the server.
// There are no invented members: today a business usually has just its owner, and the list will grow only when more people are
// actually added to the business.
export type TeamMember = { id: string; label: string };

/** Everyone who belongs to this business. Never throws: an unreadable account is shown by its id rather than breaking the page. */
export async function listTeam(clientId: string): Promise<TeamMember[]> {
  const db = supabaseAdmin();
  const { data: rows } = await db.from("client_users").select("user_id").eq("client_id", clientId);
  const members = await Promise.all((rows ?? []).map(async (r) => {
    const id = r.user_id as string;
    try {
      const { data } = await db.auth.admin.getUserById(id);
      const meta = (data.user?.user_metadata ?? {}) as { full_name?: string; name?: string };
      return { id, label: (meta.full_name || meta.name || data.user?.email || id).toString() };
    } catch {
      return { id, label: id };
    }
  }));
  return members.sort((a, b) => a.label.localeCompare(b.label));
}

/** Is this user a member of this business? The only check that may allow an assignment. */
export async function isTeamMember(clientId: string, userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin().from("client_users").select("user_id").eq("client_id", clientId).eq("user_id", userId).maybeSingle();
  return Boolean(data);
}
