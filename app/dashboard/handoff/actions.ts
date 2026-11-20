"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireClient } from "../../../lib/auth/session";
import { cleanAssignee, cleanNote, handoffFormSchema } from "../../../lib/handoff";
import { supabaseAdmin } from "../../../lib/supabase-admin";

// SECURITY MODEL (same as the other dashboard actions): requireClient() derives clientId from the
// signed-in owner's membership. Writes use the service role, so every call passes that clientId and
// the SQL functions only touch rows that belong to it. Form ids are never trusted on their own.

const LIST = "/dashboard/handoff";
const back = (formData: FormData) => {
  const raw = String(formData.get("back") ?? "");
  return raw.startsWith(LIST) && !raw.startsWith("//") && !raw.includes("\\") ? raw : LIST; // never an open redirect
};
const go = (to: string, notice: string): never => {
  const [path, query] = to.split("?");
  const q = new URLSearchParams(query ?? "");
  q.set("notice", notice);
  return redirect(`${path}?${q.toString()}`);
};

export async function handoffTransition(formData: FormData) {
  const { clientId, user } = await requireClient();
  const to = back(formData);
  const parsed = handoffFormSchema.safeParse({ id: formData.get("id"), action: formData.get("action") });
  if (!parsed.success) return go(to, "invalid");
  const { id, action } = parsed.data;

  // "Assign to me" and "Take over" use the signed-in owner's own email; "Assign" uses what was typed.
  const self = formData.get("self") === "1" || action === "take_over";
  const assignee = self ? (user.email ?? "Me") : cleanAssignee(formData.get("assignee"));
  if (action === "assign" && !assignee) return go(to, "invalid");

  const db = supabaseAdmin();
  const { data: row } = await db.from("handoff_requests").select("conversation_id").eq("id", id).eq("client_id", clientId).maybeSingle();
  if (!row) return go(to, "not_found");

  const { error } = await db.rpc("set_handoff_status", {
    p_client_id: clientId, p_handoff_id: id, p_action: action, p_assignee: assignee ?? null,
  });
  if (error) return go(to, "handoff_failed");

  revalidatePath(LIST);
  revalidatePath("/dashboard"); // the Overview counts change too
  revalidatePath(`/dashboard/conversations/${row.conversation_id}`);
  // After taking over, go straight to the chat to reply.
  if (action === "take_over") redirect(`/dashboard/conversations/${row.conversation_id}`);
  return go(to, action === "resume_ai" ? "handoff_resumed" : action === "resolve" ? "handoff_resolved" : "handoff_updated");
}

export async function saveHandoffNote(formData: FormData) {
  const { clientId } = await requireClient();
  const to = back(formData);
  const parsed = handoffFormSchema.pick({ id: true }).safeParse({ id: formData.get("id") });
  const note = cleanNote(formData.get("notes"));
  if (!parsed.success || note === null) return go(to, "invalid");

  const { data } = await supabaseAdmin().from("handoff_requests")
    .update({ internal_notes: note || null, updated_at: new Date().toISOString() })
    .eq("id", parsed.data.id).eq("client_id", clientId).select("id");
  if (!data?.length) return go(to, "not_found");
  revalidatePath(LIST);
  return go(to, "saved");
}
