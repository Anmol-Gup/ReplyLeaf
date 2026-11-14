import { supabaseAdmin } from "./supabase-admin";

// Right-to-erasure: delete one contact and everything hanging off them
// (conversations, messages, pending batches, leads, appointments, tickets, logged unanswered
// questions) via ON DELETE CASCADE. usage_events keep only anonymous token
// counts (their message_id is set to null). Always scoped to ONE client.
export type DeleteResult = { deleted: boolean; messages: number };

export const normalizePhone = (phone: string) => phone.replace(/\D/g, "");

export async function deleteContactData(
  clientId: string,
  by: { contactId: string } | { phone: string },
): Promise<DeleteResult> {
  const db = supabaseAdmin();
  let q = db.from("contacts").select("id").eq("client_id", clientId);
  if ("contactId" in by) q = q.eq("id", by.contactId);
  else {
    const phone = normalizePhone(by.phone);
    if (phone.length < 6) throw new Error("phone number looks invalid");
    q = q.eq("phone", phone);
  }
  const { data: contact, error } = await q.maybeSingle();
  if (error) throw new Error(`contact lookup failed: ${error.message}`);
  if (!contact) return { deleted: false, messages: 0 };

  const { count } = await db
    .from("messages").select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .in("conversation_id", (
      await db.from("conversations").select("id").eq("client_id", clientId).eq("contact_id", contact.id)
    ).data?.map((c) => c.id as string) ?? []);

  const { error: delErr } = await db.from("contacts").delete().eq("client_id", clientId).eq("id", contact.id);
  if (delErr) throw new Error(`delete failed: ${delErr.message}`);
  return { deleted: true, messages: count ?? 0 };
}
