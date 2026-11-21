"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireClient } from "../../../lib/auth/session";
import { z } from "zod";
import { emailAssignee } from "../../../lib/assign";
import { cleanNote, handoffFormSchema, SOURCE_LABELS, type HandoffSource } from "../../../lib/handoff";
import { findMemberByEmail } from "../../../lib/team";
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

// Assign by typing an email: yourself or anyone else. A member of this business is assigned for real (database-checked); any other
// email is recorded as the assignee and gets an email with the details. An empty box unassigns. The form is never trusted.
export async function assignHandoff(formData: FormData) {
  const { clientId, user } = await requireClient();
  const to = back(formData);
  const id = uuid.safeParse(formData.get("id"));
  const email = z.union([z.literal(""), z.string().trim().toLowerCase().email().max(200)]).safeParse(String(formData.get("assignee_email") ?? "").trim());
  if (!id.success || !email.success) return go(to, "invalid");
  const db = supabaseAdmin();
  const { data: h } = await db.from("handoff_requests").select("id, conversation_id, status, reason, ai_summary, source").eq("id", id.data).eq("client_id", clientId).maybeSingle();
  if (!h) return go(to, "not_found");
  if (h.status === "resolved") return go(to, "invalid");

  const memberId = email.data ? (email.data === user.email?.toLowerCase() ? user.id : await findMemberByEmail(clientId, email.data)) : null;
  if (!email.data || memberId) {
    const { error } = await db.rpc("assign_handoff", { p_client_id: clientId, p_handoff_id: id.data, p_assignee: memberId, p_actor: user.id, p_label: user.email ?? null });
    if (error) return go(to, "handoff_needs_update");
  } else {
    const { error } = await db.from("handoff_requests").update({ assigned_user_id: null, assigned_to: email.data, assigned_at: new Date().toISOString(), status: "assigned", updated_at: new Date().toISOString() }).eq("id", h.id).eq("client_id", clientId);
    if (error) return go(to, "handoff_needs_update");
    await db.from("handoff_events").insert({ client_id: clientId, handoff_id: h.id, kind: "assigned", actor_user_id: user.id, actor_label: user.email ?? null, detail: { email: email.data } });
  }
  refreshAll(h.conversation_id as string);

  // Tell the person it was assigned to (not when you assign it to yourself). A failed email never undoes the assignment.
  if (email.data && email.data !== user.email?.toLowerCase()) {
    try {
      const [{ data: client }, { data: conv }, { data: last }] = await Promise.all([
        db.from("clients").select("name").eq("id", clientId).maybeSingle(),
        db.from("conversations").select("contact_id").eq("id", h.conversation_id).maybeSingle(),
        db.from("messages").select("body").eq("conversation_id", h.conversation_id).eq("direction", "inbound").order("created_at", { ascending: false }).limit(1).maybeSingle(),
      ]);
      const { data: c } = conv ? await db.from("contacts").select("name, phone").eq("id", conv.contact_id).maybeSingle() : { data: null };
      const sent = await emailAssignee({ email: email.data, memberId, self: false }, {
        kind: "handoff", title: (h.reason as string | null) ?? SOURCE_LABELS[h.source as HandoffSource], customerName: (c?.name as string | null) ?? null, phone: (c?.phone as string) ?? "",
        detailLabel: "Customer said", detail: (last?.body as string | null) ?? (h.ai_summary as string | null) ?? "", path: `/dashboard/handoff/${h.id}`,
        assignedBy: user.email ?? "A teammate", businessName: (client?.name as string) ?? "your team",
      });
      if (!sent) return go(to, "handoff_updated_no_email");
    } catch { return go(to, "handoff_updated_no_email"); }
  }
  return go(to, "handoff_updated");
}

// Mark resolved: closes the request and leaves the chat as it is (the assistant stays paused until someone resumes it).
export async function queueResolve(formData: FormData) {
  const { clientId, user } = await requireClient();
  const to = back(formData);
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) return go(to, "invalid");
  const db = supabaseAdmin();
  const { data: row } = await db.from("handoff_requests").select("conversation_id, assigned_user_id").eq("id", id.data).eq("client_id", clientId).maybeSingle();
  if (!row) return go(to, "not_found");
  if (row.assigned_user_id && row.assigned_user_id !== user.id) return go(to, "assigned_other");
  const { error } = await db.rpc("set_handoff_status", { p_client_id: clientId, p_handoff_id: id.data, p_action: "resolve", p_assignee: null });
  if (error) return go(to, "handoff_failed");
  refreshAll(row.conversation_id as string);
  return go(to, "handoff_resolved");
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
