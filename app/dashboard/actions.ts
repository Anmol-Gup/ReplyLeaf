"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { clearSessionCookies, requireClient } from "../../lib/auth/session";
import { requirePaidAccess } from "../../lib/billing/gate";
import { SOURCE_LABELS } from "../../lib/handoff";
import { deleteContactData } from "../../lib/privacy";
import { supabaseAdmin } from "../../lib/supabase-admin";
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
export async function takeOver(formData: FormData) {
  const { clientId, user } = await requireClient();
  const id = uuid.parse(formData.get("id"));
  const db = supabaseAdmin();
  // Records the handoff (so it shows on the Human Handoff page) and silences the assistant for THIS chat only.
  const { data, error } = await db.rpc("create_handoff", {
    p_client_id: clientId, p_conversation_id: id, p_source: "owner", p_reason: SOURCE_LABELS.owner, p_summary: null,
    p_status: "human_active", p_assigned_to: user.email ?? null,
  });
  if (!error) {
    const row = Array.isArray(data) ? data[0] : data;
    // A request that was already open (waiting or assigned) moves to "you are handling it".
    if (row && row.out_created === false) {
      await db.rpc("set_handoff_status", { p_client_id: clientId, p_handoff_id: row.out_id, p_action: "take_over", p_assignee: user.email ?? null });
    }
  }
  revalidatePath(`/dashboard/conversations/${id}`);
  revalidatePath("/dashboard/handoff");
}

export async function handBack(formData: FormData) {
  const { clientId } = await requireClient();
  const id = uuid.parse(formData.get("id"));
  const db = supabaseAdmin();
  // If a handoff is open for this chat, closing it also switches the assistant back on.
  const { data: open } = await db.from("handoff_requests").select("id")
    .eq("conversation_id", id).eq("client_id", clientId).neq("status", "resolved").maybeSingle();
  if (open) {
    await db.rpc("set_handoff_status", { p_client_id: clientId, p_handoff_id: open.id, p_action: "resume_ai", p_assignee: null });
  } else {
    await db.from("conversations")
      .update({ handling: "bot", failed_answer_count: 0, updated_at: new Date().toISOString() })
      .eq("id", id).eq("client_id", clientId);
  }
  revalidatePath(`/dashboard/conversations/${id}`);
  revalidatePath("/dashboard/handoff");
}

export async function sendHumanMessage(formData: FormData) {
  const { clientId } = await requireClient();
  await requirePaidAccess(clientId); // paid feature: blocked while the subscription is inactive (see lib/billing/access.ts)
  const id = uuid.parse(formData.get("id"));
  const text = z.string().trim().min(1).max(1500).safeParse(formData.get("text"));
  const back = `/dashboard/conversations/${id}`;
  if (!text.success) return flash(back, "invalid");

  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations")
    .select("id, handling, contact_id, last_customer_message_at")
    .eq("id", id).eq("client_id", clientId).maybeSingle();
  if (!conv) return flash("/dashboard/conversations", "not_found");
  if (conv.handling !== "human_active") return flash(back, "take_over_first");

  const record = (patch: object) => db.from("messages").insert({
    client_id: clientId, conversation_id: id, direction: "outbound", sender: "human",
    type: "text", body: text.data, ...patch,
  });

  // 24-hour window: block the send, keep a visible record, warn the owner.
  const last = conv.last_customer_message_at ? new Date(conv.last_customer_message_at) : null;
  if (!isWithinWindow(last)) {
    await record({ status: "blocked", error: "outside_24h_window" });
    return flash(back, "window_closed");
  }

  const [{ data: client }, { data: contact }] = await Promise.all([
    db.from("clients").select("wa_phone_number_id").eq("id", clientId).single(),
    db.from("contacts").select("phone").eq("id", conv.contact_id).eq("client_id", clientId).single(),
  ]);
  try {
    const sent = await sendClientText(clientId, client!.wa_phone_number_id, contact!.phone, text.data);
    await record({ status: "sent", wa_message_id: sent.waMessageId });
  } catch (e) {
    console.error("human send failed", e instanceof Error ? e.message : e);
    await record({ status: "failed", error: "send_failed" });
    return flash(back, "send_failed");
  }
  revalidatePath(back);
  redirect(back);
}

// ---------------------------------------------------------------- contacts
const contactSchema = z.object({
  name: z.string().trim().max(100),
  email: z.union([z.literal(""), z.string().trim().email().max(200)]),
  status: z.enum(["new", "lead", "customer", "lost"]),
  tags: z.string().max(400),
  notes: z.string().max(2000),
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
    .update({ name: v.name || null, email: v.email || null, status: v.status, tags, notes: v.notes || null })
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
  flash("/dashboard/contacts", "deleted");
}

// ---------------------------------------------------------------- settings
const settingsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  booking_link: z.union([z.literal(""), z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), "http(s) only")]),
});

export async function updateSettings(formData: FormData) {
  const { clientId } = await requireClient();
  const parsed = settingsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return flash("/dashboard/settings", "invalid");
  const v = parsed.data;
  await supabaseAdmin().from("clients").update({
    name: v.name,
    booking_link: v.booking_link || null,
  }).eq("id", clientId);
  flash("/dashboard/settings", "saved");
}

// --------------------------------------------------------------- knowledge
export async function updateKnowledge(formData: FormData) {
  const { clientId } = await requireClient();
  await requirePaidAccess(clientId); // paid feature: blocked while the subscription is inactive (see lib/billing/access.ts)
  const text = z.string().max(8000).safeParse(formData.get("kb_text"));
  if (!text.success) return flash("/dashboard/knowledge", "invalid");
  await supabaseAdmin().from("clients").update({ kb_text: text.data || null }).eq("id", clientId);
  flash("/dashboard/knowledge", "saved");
}

// --------------------------------------------------- knowledge: documents
const KB = "/dashboard/knowledge";
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
  let result;
  try {
    result = await publishDocument(clientId, id, t.data, c.data, user.id);
  } catch (e) {
    console.error("publish failed", e instanceof Error ? e.message : e);
    return flash(back, "invalid");
  }
  flash(back, result.embedded ? "published" : "published_no_vectors");
}

export async function discardDraft(formData: FormData) {
  const { clientId } = await requireClient();
  const id = uuid.parse(formData.get("id"));
  await supabaseAdmin().from("kb_documents").delete().eq("id", id).eq("client_id", clientId).eq("status", "draft");
  flash(KB, "discarded");
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
