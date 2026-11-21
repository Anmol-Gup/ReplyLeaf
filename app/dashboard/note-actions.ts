"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireClient } from "../../lib/auth/session";
import { noteSchema } from "../../lib/notes";
import { supabaseAdmin } from "../../lib/supabase-admin";

// Edit the text of an existing note. The note is matched on its own id, the record it belongs to and the signed-in business, so a
// forged id can never change another business's note. Only the text changes; the author and the time stay as they were.
const TARGETS = {
  contact: { table: "contact_notes", fk: "contact_id", path: "/dashboard/contacts" },
  lead: { table: "lead_notes", fk: "lead_id", path: "/dashboard/leads" },
  ticket: { table: "ticket_notes", fk: "ticket_id", path: "/dashboard/tickets" },
  appointment: { table: "appointment_notes", fk: "appointment_id", path: "/dashboard/appointments" },
} as const;

export async function editNote(formData: FormData) {
  const { clientId } = await requireClient();
  const kind = z.enum(["contact", "lead", "ticket", "appointment"]).safeParse(formData.get("kind"));
  const noteId = z.string().uuid().safeParse(formData.get("note_id"));
  const parsed = noteSchema.safeParse({ id: formData.get("id"), body: String(formData.get("body") ?? "") });
  if (!kind.success || !noteId.success) return redirect("/dashboard?notice=invalid");
  const t = TARGETS[kind.data];
  if (!parsed.success) {
    const id = String(formData.get("id") ?? "");
    return redirect(/^[0-9a-f-]{36}$/i.test(id) ? `${t.path}/${id}?notice=note_empty` : `${t.path}?notice=invalid`);
  }
  const here = `${t.path}/${parsed.data.id}`;
  const { data, error } = await supabaseAdmin().from(t.table).update({ body: parsed.data.body })
    .eq("id", noteId.data).eq(t.fk, parsed.data.id).eq("client_id", clientId).select("id");
  if (error) return redirect(`${here}?notice=invalid`);
  if (!data?.length) return redirect(`${t.path}?notice=not_found`);
  revalidatePath(here);
  return redirect(`${here}?notice=note_updated`);
}
