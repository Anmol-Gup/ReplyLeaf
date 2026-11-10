"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireClient } from "../../../lib/auth/session";
import { leadFormSchema } from "../../../lib/leads";
import { supabaseAdmin } from "../../../lib/supabase-admin";

// Same security model as the other dashboard actions: requireClient() gives the clientId, the write uses the
// service role, and the row is only matched together with that client_id.
export async function updateLead(formData: FormData) {
  const { clientId } = await requireClient();
  const parsed = leadFormSchema.safeParse({
    id: formData.get("id"), status: formData.get("status"),
    follow_up_at: String(formData.get("follow_up_at") ?? ""), notes: String(formData.get("notes") ?? "").replace(/\u0000/g, "").trim(),
  });
  if (!parsed.success) return redirect("/dashboard/leads?notice=invalid");
  const v = parsed.data;
  const { data } = await supabaseAdmin().from("leads")
    .update({ status: v.status, follow_up_at: v.follow_up_at || null, internal_notes: v.notes || null, updated_at: new Date().toISOString() })
    .eq("id", v.id).eq("client_id", clientId).select("id");
  if (!data?.length) return redirect("/dashboard/leads?notice=not_found");
  revalidatePath("/dashboard/leads");
  revalidatePath(`/dashboard/leads/${v.id}`);
  return redirect(`/dashboard/leads/${v.id}?notice=lead_saved`);
}
