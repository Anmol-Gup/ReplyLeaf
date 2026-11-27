"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { parseIds } from "../../lib/bulk";
import { noteSchema } from "../../lib/notes";
import { clearSessionCookies, requireClient } from "../../lib/auth/session";
import { requirePaidAccess } from "../../lib/billing/gate";
import { conversationActions, conversationStateOf, type OpenHandoff } from "../../lib/conversation-state";
import { deleteContactData } from "../../lib/privacy";
import { runBatches } from "../../lib/batch";
import { requeueUnanswered } from "../../lib/resume-requeue";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { supabaseBatchDeps } from "../../lib/supabase-batch";
import { sendClientText } from "../../lib/supabase-deps";
import { MAX_DOCUMENTS } from "../../lib/kb/chunk";
import { ExtractError, extractText, MAX_UPLOAD_BYTES } from "../../lib/kb/extract";
import { publishDocument, reindexDocument } from "../../lib/kb/publish";
import { isWithinWindow } from "../../lib/whatsapp/window";

// SECURITY MODEL: every action starts with requireClient(), which verifies the
// session and derives clientId from the owner's membership. Writes use the
// service role (RLS is bypassed), so EVERY query below filters by that clientId.
// Row ids from forms are only ever matched together with client_id.

const uuid = z.string().uuid();
const flash = (path: string, notice: string): never => redirect(`${path}?notice=${notice}`);

export async function logout() {
  await clearSessionCookies();
  redirect("/login");
}

// ----------------------------------------------------------- conversations
// Takeover, resume and sending go through atomic SQL functions (migration 0026): the person is the signed-in user, never a form value.
const refresh = (id: string) => {
  revalidatePath(`/dashboard/conversations/${id}`);
  revalidatePath("/dashboard/conversations");
  revalidatePath("/dashboard/handoff");
  revalidatePath("/dashboard"); // the Overview counts change too
};
const rpcRow = <T,>(data: unknown): T | null => ((Array.isArray(data) ? data[0] : data) as T | null) ?? null;

export async function takeOver(formData: FormData) {
  const { clientId, user } = await requireClient();
  const id = uuid.parse(formData.get("id"));
  const { data, error } = await supabaseAdmin().rpc("take_over_conversation", {
    p_client_id: clientId, p_conversation_id: id, p_user_id: user.id, p_label: user.email ?? null,
  });
  const row = rpcRow<{ out_taken: boolean }>(data);
  refresh(id);
  if (error) return flash(`/dashboard/conversations/${id}`, error.message.includes("take_over_conversation") ? "handoff_needs_update" : "not_found");
  if (row && !row.out_taken) return flash(`/dashboard/conversations/${id}`, "assigned_other");
}

// "Resume AI": ends the human assignment and resolves the handoff. Only the person who has it can do this.
export async function handBack(formData: FormData) {
  const { clientId, user } = await requireClient();
  const id = uuid.parse(formData.get("id"));
  const { data, error } = await supabaseAdmin().rpc("resume_ai", {
    p_client_id: clientId, p_conversation_id: id, p_user_id: user.id, p_label: user.email ?? null,
  });
  const row = rpcRow<{ out_resumed: boolean }>(data);
  refresh(id);
  if (error) return flash(`/dashboard/conversations/${id}`, error.message.includes("resume_ai") ? "handoff_needs_update" : "not_found");
  if (row && !row.out_resumed) return flash(`/dashboard/conversations/${id}`, "assigned_other");
  // A customer message that arrived while a person was handling the chat is answered now, not lost.
  if (await requeueUnanswered(clientId, id)) after(() => runBatches([id], supabaseBatchDeps()));
}

export async function sendHumanMessage(formData: FormData) {
  const { clientId, user } = await requireClient();
  await requirePaidAccess(clientId); // paid feature: blocked while the subscription is inactive (see lib/billing/access.ts)
  const id = uuid.parse(formData.get("id"));
  const text = z.string().trim().min(1).max(1500).safeParse(formData.get("text"));
  const requestId = z.string().min(8).max(64).regex(/^[\w-]+$/).safeParse(formData.get("request_id"));
  const back = `/dashboard/conversations/${id}`;
  if (!text.success) return flash(back, "invalid");

  const db = supabaseAdmin();
  const [{ data: conv }, { data: open }] = await Promise.all([
    db.from("conversations").select("id, handling, contact_id, last_customer_message_at").eq("id", id).eq("client_id", clientId).maybeSingle(),
    db.from("handoff_requests").select("status, assigned_user_id").eq("conversation_id", id).eq("client_id", clientId).neq("status", "resolved").maybeSingle(),
  ]);
  if (!conv) return flash("/dashboard/conversations", "not_found");
  // Only the person who has the chat may reply: not while the assistant handles it, not for another agent's chat.
  const state = conversationStateOf(conv.handling, open as OpenHandoff, user.id);
  if (!conversationActions(state).canReply) return flash(back, state === "other" ? "assigned_other" : "take_over_first");

  // 24-hour window: block the send, keep a visible record, warn the owner.
  const last = conv.last_customer_message_at ? new Date(conv.last_customer_message_at) : null;
  const base = { client_id: clientId, conversation_id: id, direction: "outbound", sender: "human", type: "text", body: text.data };
  if (!isWithinWindow(last)) {
    await db.from("messages").insert({ ...base, status: "blocked", error: "outside_24h_window" });
    return flash(back, "window_closed");
  }

  // The row is saved FIRST with the request id: a double click or a retry of the same form hits the unique index and sends nothing.
  // The message is therefore never lost, and shows "sending" until WhatsApp answers.
  const { data: row, error: insErr } = await db.from("messages")
    .insert({ ...base, status: "sending", client_request_id: requestId.success ? requestId.data : null })
    .select("id").single();
  if (insErr) {
    if (insErr.code === "23505") { refresh(id); redirect(back); } // already sent by an earlier click of the same form
    if (/client_request_id/.test(insErr.message)) return flash(back, "handoff_needs_update");
    return flash(back, "send_failed");
  }

  const [{ data: client }, { data: contact }] = await Promise.all([
    db.from("clients").select("wa_phone_number_id").eq("id", clientId).single(),
    db.from("contacts").select("phone").eq("id", conv.contact_id).eq("client_id", clientId).single(),
  ]);
  try {
    const sent = await sendClientText(clientId, client!.wa_phone_number_id, contact!.phone, text.data);
    await db.from("messages").update({ status: "sent", wa_message_id: sent.waMessageId }).eq("id", row.id).eq("client_id", clientId);
  } catch (e) {
    console.error("human send failed", e instanceof Error ? e.message : e);
    await db.from("messages").update({ status: "failed", error: "send_failed" }).eq("id", row.id).eq("client_id", clientId);
    return flash(back, "send_failed");
  }
  refresh(id);
  redirect(back);
}

// ---------------------------------------------------------------- contacts
const contactSchema = z.object({
  name: z.string().trim().max(100),
  email: z.union([z.literal(""), z.string().trim().email().max(200)]),
  status: z.enum(["new", "lead", "customer", "lost"]),
  tags: z.string().max(400),
  notes: z.string().max(2000).optional(), // the page no longer shows a notes box: when it is not sent, the stored note is left alone
});

export async function updateContact(formData: FormData) {
  const { clientId } = await requireClient();
  const id = uuid.parse(formData.get("id"));
  const back = `/dashboard/contacts/${id}`;
  const parsed = contactSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return flash(back, "invalid");
  const v = parsed.data;
  const tags = [...new Set(v.tags.split(",").map((t) => t.trim()).filter(Boolean))].slice(0, 20).map((t) => t.slice(0, 30));
  await supabaseAdmin().from("contacts")
    .update({ name: v.name || null, email: v.email || null, status: v.status, tags, ...(v.notes !== undefined ? { notes: v.notes || null } : {}) })
    .eq("id", id).eq("client_id", clientId);
  flash(back, "saved");
}

// Suggestions are model guesses: only an explicit click here overwrites a value.
export async function resolveSuggestion(formData: FormData) {
  const { clientId } = await requireClient();
  const id = uuid.parse(formData.get("id"));
  const field = z.enum(["name", "email"]).parse(formData.get("field"));
  const accept = formData.get("accept") === "yes";
  const db = supabaseAdmin();
  const { data: c } = await db.from("contacts").select("suggested").eq("id", id).eq("client_id", clientId).maybeSingle();
  if (!c) return flash("/dashboard/contacts", "not_found");

  const suggested = { ...(c.suggested as Record<string, string>) };
  const value = suggested[field];
  delete suggested[field];
  const patch: Record<string, unknown> = { suggested };
  if (accept && value) {
    if (field === "email" && !z.string().email().safeParse(value).success) return flash(`/dashboard/contacts/${id}`, "invalid");
    patch[field] = value;
  }
  await db.from("contacts").update(patch).eq("id", id).eq("client_id", clientId);
  revalidatePath(`/dashboard/contacts/${id}`);
}

export async function deleteContact(formData: FormData) {
  const { clientId } = await requireClient();
  const id = uuid.parse(formData.get("id"));
  if (formData.get("confirm") !== "yes") return flash(`/dashboard/contacts/${id}`, "invalid");
  await deleteContactData(clientId, { contactId: id });
  revalidatePath("/dashboard"); // the Overview changes too
  flash("/dashboard/contacts", "deleted");
}

// Delete several contacts and their messages at once (the ones ticked in the list), each through the same erasure as the single delete.
export async function bulkDeleteContacts(formData: FormData) {
  const { clientId } = await requireClient();
  const ids = parseIds(formData.getAll("ids"));
  if (ids.length === 0) return flash("/dashboard/contacts", "invalid");
  for (const id of ids) await deleteContactData(clientId, { contactId: id });
  revalidatePath("/dashboard"); // the Overview changes too
  flash("/dashboard/contacts", "deleted");
}

// A private note on a contact: any number of them, each kept with its author and time.
export async function addContactNote(formData: FormData) {
  const { clientId, user } = await requireClient();
  const parsed = noteSchema.safeParse({ id: formData.get("id"), body: String(formData.get("body") ?? "") });
  if (!parsed.success) {
    const id = String(formData.get("id") ?? "");
    return flash(/^[0-9a-f-]{36}$/i.test(id) ? `/dashboard/contacts/${id}` : "/dashboard/contacts", /^[0-9a-f-]{36}$/i.test(id) ? "note_empty" : "invalid");
  }
  const db = supabaseAdmin();
  const { data: contact } = await db.from("contacts").select("id").eq("id", parsed.data.id).eq("client_id", clientId).maybeSingle();
  if (!contact) return flash("/dashboard/contacts", "not_found");
  const { error } = await db.from("contact_notes").insert({ client_id: clientId, contact_id: parsed.data.id, author_user_id: user.id, author_label: user.email ?? null, body: parsed.data.body });
  if (error) return flash(`/dashboard/contacts/${parsed.data.id}`, error.code === "42P01" || error.code === "PGRST205" ? "notes_needs_update" : "invalid");
  revalidatePath(`/dashboard/contacts/${parsed.data.id}`);
  flash(`/dashboard/contacts/${parsed.data.id}`, "note_added");
}

// ---------------------------------------------------------------- settings
const settingsSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export async function updateSettings(formData: FormData) {
  const { clientId } = await requireClient();
  const parsed = settingsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return redirect("/dashboard/settings?tab=ai&notice=invalid");
  const v = parsed.data;
  await supabaseAdmin().from("clients").update({
    name: v.name }).eq("id", clientId);
  redirect("/dashboard/settings?tab=ai&notice=saved");
}

// --------------------------------------------------------------- knowledge
export async function updateKnowledge(formData: FormData) {
  const { clientId } = await requireClient();
  await requirePaidAccess(clientId); // paid feature: blocked while the subscription is inactive (see lib/billing/access.ts)
  const text = z.string().max(8000).safeParse(formData.get("kb_text"));
  if (!text.success) return flash("/dashboard/knowledge", "invalid");
  await supabaseAdmin().from("clients").update({ kb_text: text.data || null }).eq("id", clientId);
  await touchKnowledge(clientId);
  revalidatePath("/dashboard"); // the Overview changes too
  flash("/dashboard/knowledge", "saved");
}

// --------------------------------------------------- knowledge: documents
const KB = "/dashboard/knowledge";
/** Marks that the knowledge changed (core text saved, document deleted) so older assistant replies are not shown to the model. Never blocks the action: it is skipped until migration 0031 is applied. */
async function touchKnowledge(clientId: string) {
  try { await supabaseAdmin().from("clients").update({ kb_changed_at: new Date().toISOString() }).eq("id", clientId); } catch { /* optional */ }
}
const titleSchema = z.string().trim().min(1).max(200);
const contentSchema = z.string().trim().min(1).max(200_000);

// Step 1: paste text or upload a file. Creates a DRAFT only; nothing is searchable
// until the owner reviews the extracted text and confirms (publishDocumentAction).
/** Drafts and active documents (archived ones are not counted). */
async function countOpenDocuments(clientId: string): Promise<number> {
  const { count } = await supabaseAdmin().from("kb_documents").select("id", { count: "exact", head: true })
    .eq("client_id", clientId).neq("status", "archived");
  return count ?? 0;
}


export async function createDocument(formData: FormData) {
  const { clientId } = await requireClient();
  await requirePaidAccess(clientId); // paid feature: blocked while the subscription is inactive (see lib/billing/access.ts)
  if (await countOpenDocuments(clientId) >= MAX_DOCUMENTS) return flash(KB, "too_many_docs");
  const file = formData.get("file");
  let text = String(formData.get("text") ?? "");
  let title = String(formData.get("title") ?? "").trim();
  let source = "paste";
  let filename: string | null = null;

  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_UPLOAD_BYTES) return redirect(`${KB}?notice=extract_failed&why=too_large`);
    try {
      const out = extractText(file.name, Buffer.from(await file.arrayBuffer()));
      text = out.text; source = out.source; filename = file.name.slice(0, 200);
      title ||= file.name.replace(/\.[^.]+$/, "");
    } catch (e) {
      const why = e instanceof ExtractError ? e.code : "unreadable";
      return redirect(`${KB}?notice=extract_failed&why=${why}`);
    }
  }

  title ||= text.trim().split("\n")[0]?.slice(0, 80) ?? "";
  const t = titleSchema.safeParse(title);
  const c = contentSchema.safeParse(text);
  if (!t.success || !c.success) return flash(KB, "invalid");

  const { data, error } = await supabaseAdmin().from("kb_documents")
    .insert({ client_id: clientId, title: t.data, content: c.data, status: "draft", source, filename })
    .select("id").single();
  if (error) throw new Error(`creating document failed: ${error.message}`);
  redirect(`${KB}/documents/${data.id}`);
}

// Step 2: the owner confirmed the (possibly edited) text. Chunk, embed, publish a new version.
export async function publishDocumentAction(formData: FormData) {
  const { clientId, user } = await requireClient();
  await requirePaidAccess(clientId); // paid feature: blocked while the subscription is inactive (see lib/billing/access.ts)
  const id = uuid.parse(formData.get("id"));
  const back = `${KB}/documents/${id}`;
  const t = titleSchema.safeParse(formData.get("title"));
  const c = contentSchema.safeParse(formData.get("content"));
  if (!t.success || !c.success) return flash(back, "invalid");
  // Nothing changed on a published document: do not create an identical new version. (Browsers post line breaks as CRLF.)
  const norm = (x: string) => x.replace(/\r\n/g, "\n").trim();
  const { data: current } = await supabaseAdmin().from("kb_documents").select("title, content, status, version").eq("id", id).eq("client_id", clientId).maybeSingle();
  if (current && current.status !== "draft" && current.version > 0 && current.title === t.data && norm(current.content ?? "") === norm(c.data)) return flash(back, "no_changes");
  let result;
  try {
    result = await publishDocument(clientId, id, t.data, c.data, user.id);
  } catch (e) {
    console.error("publish failed", e instanceof Error ? e.message : e);
    return flash(back, "invalid");
  }
  revalidatePath("/dashboard"); // the Overview changes too
  flash(back, result.embedded ? "published" : "published_no_vectors");
}

export async function discardDraft(formData: FormData) {
  const { clientId } = await requireClient();
  const id = uuid.parse(formData.get("id"));
  await supabaseAdmin().from("kb_documents").delete().eq("id", id).eq("client_id", clientId).eq("status", "draft");
  flash(KB, "discarded");
}

// Permanent delete of a document in any state (draft, active or archived). Its versions and search chunks go with it (database cascade),
// so the assistant stops using it at once. The id must belong to the signed-in business.
export async function deleteDocument(formData: FormData) {
  const { clientId } = await requireClient();
  const id = uuid.parse(formData.get("id"));
  await supabaseAdmin().from("kb_documents").delete().eq("id", id).eq("client_id", clientId);
  await touchKnowledge(clientId);
  revalidatePath(KB);
  revalidatePath("/dashboard"); // the Overview changes too
  flash(KB, "doc_deleted");
}

export async function setDocumentStatus(formData: FormData) {
  const { clientId } = await requireClient();
  await requirePaidAccess(clientId); // paid feature: blocked while the subscription is inactive (see lib/billing/access.ts)
  const id = uuid.parse(formData.get("id"));
  const status = z.enum(["active", "archived"]).parse(formData.get("status"));
  // Un-archiving brings a document back into the limit.
  if (status === "active" && await countOpenDocuments(clientId) >= MAX_DOCUMENTS) return flash(`${KB}/documents/${id}`, "too_many_docs");
  await supabaseAdmin().from("kb_documents").update({ status, updated_at: new Date().toISOString() })
    .eq("id", id).eq("client_id", clientId).gt("version", 0);
  revalidatePath(`${KB}/documents/${id}`);
  revalidatePath(KB); // the list this can be done from
  revalidatePath("/dashboard"); // the Overview changes too
}

// Restoring creates a NEW version with the old text, so history is never rewritten.
export async function restoreVersion(formData: FormData) {
  const { clientId, user } = await requireClient();
  await requirePaidAccess(clientId); // paid feature: blocked while the subscription is inactive (see lib/billing/access.ts)
  const id = uuid.parse(formData.get("id"));
  const version = z.coerce.number().int().positive().parse(formData.get("version"));
  const { data: v } = await supabaseAdmin().from("kb_document_versions").select("title, content")
    .eq("client_id", clientId).eq("document_id", id).eq("version", version).maybeSingle();
  if (!v) return flash(KB, "not_found");
  const result = await publishDocument(clientId, id, v.title, v.content, user.id);
  flash(`${KB}/documents/${id}`, result.embedded ? "published" : "published_no_vectors");
}

export async function reindexDocumentAction(formData: FormData) {
  const { clientId } = await requireClient();
  await requirePaidAccess(clientId); // paid feature: blocked while the subscription is inactive (see lib/billing/access.ts)
  const id = uuid.parse(formData.get("id"));
  const back = `${KB}/documents/${id}`;
  try {
    const r = await reindexDocument(clientId, id);
    flash(back, r.embedded ? "reindexed" : "published_no_vectors");
  } catch (e) {
    if (e instanceof Error && e.message.includes("NEXT_REDIRECT")) throw e;
    console.error("reindex failed", e instanceof Error ? e.message : e);
    flash(back, "invalid");
  }
}

export async function resolveQuestion(formData: FormData) {
  const { clientId } = await requireClient();
  const id = uuid.parse(formData.get("id"));
  const status = z.enum(["resolved", "dismissed"]).parse(formData.get("status"));
  await supabaseAdmin().from("unanswered_questions").update({ status }).eq("id", id).eq("client_id", clientId);
  revalidatePath(KB);
}
