"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { clearSessionCookies, requireClient } from "../../lib/auth/session";
import { deleteContactData } from "../../lib/privacy";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { sendClientText } from "../../lib/supabase-deps";
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
  const { clientId } = await requireClient();
  const id = uuid.parse(formData.get("id"));
  await supabaseAdmin().from("conversations")
    .update({ handling: "human_active", updated_at: new Date().toISOString() })
    .eq("id", id).eq("client_id", clientId);
  revalidatePath(`/dashboard/conversations/${id}`);
}

export async function handBack(formData: FormData) {
  const { clientId } = await requireClient();
  const id = uuid.parse(formData.get("id"));
  await supabaseAdmin().from("conversations")
    .update({ handling: "bot", failed_answer_count: 0, updated_at: new Date().toISOString() })
    .eq("id", id).eq("client_id", clientId);
  revalidatePath(`/dashboard/conversations/${id}`);
}

export async function sendHumanMessage(formData: FormData) {
  const { clientId } = await requireClient();
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

// ---------------------------------------------------------------- bookings
export async function setBookingStatus(formData: FormData) {
  const { clientId } = await requireClient();
  const id = uuid.parse(formData.get("id"));
  const status = z.enum(["confirmed", "declined"]).parse(formData.get("status"));
  await supabaseAdmin().from("booking_requests").update({ status })
    .eq("id", id).eq("client_id", clientId).eq("status", "pending");
  revalidatePath("/dashboard/bookings");
}

// ---------------------------------------------------------------- settings
const settingsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  business_info: z.string().max(4000),
  business_hours: z.string().max(1000),
  booking_link: z.union([z.literal(""), z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), "http(s) only")]),
  ai_provider: z.enum(["gemini", "openai"]),
  owner_email: z.union([z.literal(""), z.string().trim().email().max(200)]),
});

export async function updateSettings(formData: FormData) {
  const { clientId } = await requireClient();
  const parsed = settingsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return flash("/dashboard/settings", "invalid");
  const v = parsed.data;
  await supabaseAdmin().from("clients").update({
    name: v.name, business_info: v.business_info || null, business_hours: v.business_hours || null,
    booking_link: v.booking_link || null, ai_provider: v.ai_provider, owner_email: v.owner_email || null,
  }).eq("id", clientId);
  flash("/dashboard/settings", "saved");
}

// --------------------------------------------------------------- knowledge
export async function updateKnowledge(formData: FormData) {
  const { clientId } = await requireClient();
  const text = z.string().max(30000).safeParse(formData.get("kb_text"));
  if (!text.success) return flash("/dashboard/knowledge", "invalid");
  await supabaseAdmin().from("clients").update({ kb_text: text.data || null }).eq("id", clientId);
  flash("/dashboard/knowledge", "saved");
}
