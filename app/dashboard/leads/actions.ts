"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireClient } from "../../../lib/auth/session";
import { leadDetailsSchema, leadFormSchema, parseRequirementLines } from "../../../lib/leads";
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
  revalidatePath("/dashboard"); // the Overview counts change too
  revalidatePath(`/dashboard/leads/${v.id}`);
  return redirect(`/dashboard/leads/${v.id}?notice=lead_saved`);
}

// Everything about a lead in one save: status, follow-up date, the customer's name, the service, description, budget, timeline,
// the requirement list and your private notes. Same security model: the clientId comes from the session and every write is matched on it.
export async function updateLeadDetails(formData: FormData) {
  const { clientId } = await requireClient();
  const parsed = leadDetailsSchema.safeParse({
    id: formData.get("id"), status: formData.get("status"), follow_up_at: String(formData.get("follow_up_at") ?? ""), notes: String(formData.get("notes") ?? ""),
    customer_name: String(formData.get("customer_name") ?? ""), project_type: String(formData.get("project_type") ?? ""),
    description: String(formData.get("description") ?? ""), budget: String(formData.get("budget") ?? ""), timeline: String(formData.get("timeline") ?? ""),
    requirements: String(formData.get("requirements") ?? ""),
  });
  if (!parsed.success) {
    const id = String(formData.get("id") ?? "");
    return redirect(/^[0-9a-f-]{36}$/i.test(id) ? `/dashboard/leads/${id}?notice=invalid` : "/dashboard/leads?notice=invalid");
  }
  const v = parsed.data;
  const db = supabaseAdmin();
  const { data } = await db.from("leads")
    .update({
      status: v.status, follow_up_at: v.follow_up_at || null, internal_notes: v.notes || null,
      customer_name: v.customer_name || null, project_type: v.project_type, description: v.description, budget: v.budget || null, timeline: v.timeline || null, updated_at: new Date().toISOString(),
    })
    .eq("id", v.id).eq("client_id", clientId).select("id");
  if (!data?.length) return redirect("/dashboard/leads?notice=not_found");
  // Replace the requirement list (delete, then insert), always scoped to this business and this lead.
  await db.from("lead_requirements").delete().eq("lead_id", v.id).eq("client_id", clientId);
  const reqs = parseRequirementLines(v.requirements);
  if (reqs.length) await db.from("lead_requirements").insert(reqs.map((r) => ({ client_id: clientId, lead_id: v.id, requirement_key: r.key, requirement_value: r.value })));
  revalidatePath("/dashboard"); // the Overview counts change too
  revalidatePath("/dashboard/leads");
  revalidatePath(`/dashboard/leads/${v.id}`);
  return redirect(`/dashboard/leads/${v.id}?notice=lead_saved`);
}
