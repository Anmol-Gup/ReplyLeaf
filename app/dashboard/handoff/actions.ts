"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireClient } from "../../../lib/auth/session";
import { z } from "zod";
import { cleanNote, handoffFormSchema } from "../../../lib/handoff";
import { supabaseAdmin } from "../../../lib/supabase-admin";

// SECURITY MODEL (same as the other dashboard actions): requireClient() derives clientId from the
// signed-in owner's membership. Writes use the service role, so every call passes that clientId and
// the SQL functions only touch rows that belong to it. Form ids are never trusted on their own.

const LIST = "/dashboard/handoff";
const back = (formData: FormData) => {
  const raw = String(formData.get("back") ?? "");
  return (raw.startsWith(LIST) || raw.startsWith("/dashboard/conversations/")) && !raw.startsWith("//") && !raw.includes("\\") ? raw : LIST; // never an open redirect
};
const go = (to: string, notice: string): never => {
  const [path, query] = to.split("?");
  const q = new URLSearchParams(query ?? "");
  q.set("notice", notice);
  return redirect(`${path}?${q.toString()}`);
};

const uuid = z.string().uuid();
const labelOf = (e: string | undefined) => e ?? null;

async function conversationOf(clientId: string, handoffId: string) {
  const { data } = await supabaseAdmin().from("handoff_requests").select("conversation_id").eq("id", handoffId).eq("client_id", clientId).maybeSingle();
  return (data?.conversation_id as string | undefined) ?? null;
}
const refreshAll = (conversationId: string) => {
  revalidatePath(LIST); revalidatePath("/dashboard"); revalidatePath("/dashboard/conversations"); revalidatePath(`/dashboard/conversations/${conversationId}`);
};

// Take over from the queue: the same atomic function as in Conversations, then straight to the chat to reply.
export async function queueTakeOver(formData: FormData) {
  const { clientId, user } = await requireClient();
  const to = back(formData);
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) return go(to, "invalid");
  const conv = await conversationOf(clientId, id.data);
  if (!conv) return go(to, "not_found");
  const { data, error } = await supabaseAdmin().rpc("take_over_conversation", { p_client_id: clientId, p_conversation_id: conv, p_user_id: user.id, p_label: labelOf(user.email ?? undefined) });
  if (error) return go(to, "handoff_needs_update");
  refreshAll(conv);
  const row = (Array.isArray(data) ? data[0] : data) as { out_taken: boolean } | null;
  if (row && !row.out_taken) return go(to, "assigned_other");
  redirect(`/dashboard/conversations/${conv}`);
}

// Assign to a real member of this business (or unassign with an empty choice). The database checks membership; the form is never trusted.
export async function assignHandoff(formData: FormData) {
  const { clientId, user } = await requireClient();
  const to = back(formData);
  const id = uuid.safeParse(formData.get("id"));
  const who = z.union([z.literal(""), uuid]).safeParse(formData.get("assignee") ?? "");
  if (!id.success || !who.success) return go(to, "invalid");
  const conv = await conversationOf(clientId, id.data);
  if (!conv) return go(to, "not_found");
  const { error } = await supabaseAdmin().rpc("assign_handoff", {
    p_client_id: clientId, p_handoff_id: id.data, p_assignee: who.data || null, p_actor: user.id, p_label: user.email ?? null,
  });
  if (error) return go(to, /member|resolved/.test(error.message) ? "invalid" : "handoff_needs_update");
  refreshAll(conv);
  return go(to, "handoff_updated");
}

export async function queueResumeAi(formData: FormData) {
  const { clientId, user } = await requireClient();
  const to = back(formData);
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) return go(to, "invalid");
  const conv = await conversationOf(clientId, id.data);
  if (!conv) return go(to, "not_found");
  const { data, error } = await supabaseAdmin().rpc("resume_ai", { p_client_id: clientId, p_conversation_id: conv, p_user_id: user.id, p_label: user.email ?? null });
  if (error) return go(to, "handoff_needs_update");
  refreshAll(conv);
  const row = (Array.isArray(data) ? data[0] : data) as { out_resumed: boolean } | null;
  return go(to, row && !row.out_resumed ? "assigned_other" : "handoff_resumed");
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
