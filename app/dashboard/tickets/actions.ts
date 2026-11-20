"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePaidAccess } from "../../../lib/billing/gate";
import { requireClient } from "../../../lib/auth/session";
import { notifyCustomerDetailed } from "../../../lib/appointment-notify";
import { deliveryNotice } from "../../../lib/appointments";
import { canMoveTicket, cleanCategory, isDone, resolvedAtFor, statusUpdateMessage, ticketFormSchema, ticketNoteSchema, ticketRef, type TicketStatus } from "../../../lib/tickets";
import { isTeamMember, listTeam } from "../../../lib/team";
import { supabaseAdmin } from "../../../lib/supabase-admin";

// SECURITY MODEL (same as the other dashboard actions): requireClient() gives the clientId and the signed-in user; every write uses the
// service role and matches the row on that client_id. The status, the assignee and the priority from the form are never trusted:
// the status must be a valid move, the assignee must be a real member of THIS business, and every change is written to the ticket's
// activity. Notes and the assignee are private: nothing but the status and the optional line typed for the customer is ever sent to them.

const detail = (id: string) => `/dashboard/tickets/${id}`;
const go = (id: string, notice: string): never => redirect(`${detail(id)}?notice=${notice}`);

type EventRow = { client_id: string; ticket_id: string; kind: string; detail: Record<string, unknown>; actor_user_id: string; actor_label: string | null };

export async function updateTicket(formData: FormData) {
  const { clientId, clientName, user } = await requireClient();
  const notify = formData.get("notify") !== null;
  if (notify) await requirePaidAccess(clientId); // sending to the customer is a paid feature
  const text = (n: string) => (formData.has(n) ? String(formData.get(n) ?? "").replace(/\u0000/g, "") : undefined);
  const parsed = ticketFormSchema.safeParse({
    id: formData.get("id"), status: formData.get("status"), priority: formData.get("priority") ?? undefined,
    category: text("category"), assigned_user_id: text("assigned_user_id"), message: String(formData.get("message") ?? "").replace(/\u0000/g, "").trim(),
  });
  if (!parsed.success) return redirect("/dashboard/tickets?notice=invalid");
  const v = parsed.data;

  const db = supabaseAdmin();
  const { data: before } = await db.from("tickets")
    .select("id, status, priority, category, assigned_user_id, resolved_at, conversation_id, subject")
    .eq("id", v.id).eq("client_id", clientId).maybeSingle();
  if (!before) return redirect("/dashboard/tickets?notice=not_found");

  const prev = before.status as TicketStatus;
  if (!canMoveTicket(prev, v.status)) return go(v.id, "tkt_bad_transition");

  // Assignment: only a member of this business (never a free-typed name or an id from another business).
  const wantsAssignee = v.assigned_user_id !== undefined;
  const newAssignee = v.assigned_user_id || null;
  if (newAssignee && !(await isTeamMember(clientId, newAssignee))) return go(v.id, "tkt_bad_assignee");

  const actor = { client_id: clientId, ticket_id: v.id, actor_user_id: user.id, actor_label: user.email ?? null };
  const team = wantsAssignee && newAssignee !== (before.assigned_user_id ?? null) ? await listTeam(clientId) : [];
  const labelOf = (id: string | null) => (id ? team.find((m) => m.id === id)?.label ?? null : null);

  const category = v.category === undefined ? undefined : cleanCategory(v.category);
  const events: EventRow[] = [];
  if (v.status !== prev) events.push({ ...actor, kind: "status", detail: { from: prev, to: v.status } });
  if (v.priority && v.priority !== before.priority) events.push({ ...actor, kind: "priority", detail: { from: before.priority, to: v.priority } });
  if (category !== undefined && category !== (before.category ?? null)) events.push({ ...actor, kind: "category", detail: { from: before.category ?? null, to: category } });
  if (wantsAssignee && newAssignee !== (before.assigned_user_id ?? null)) {
    events.push({ ...actor, kind: "assigned", detail: { from: before.assigned_user_id ?? null, to: newAssignee, from_label: labelOf(before.assigned_user_id ?? null), to_label: labelOf(newAssignee) } });
  }
  if (v.status !== prev && v.status === "resolved") events.push({ ...actor, kind: "resolved", detail: {} });
  if (v.status !== prev && v.status === "closed") events.push({ ...actor, kind: "closed", detail: {} });

  const { error } = await db.from("tickets").update({
    status: v.status, ...(v.priority ? { priority: v.priority } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(wantsAssignee ? { assigned_user_id: newAssignee, ...(newAssignee ? { assigned_to: null } : {}) } : {}), // the old free-text name is replaced by the real person
    resolved_at: resolvedAtFor(v.status, prev, before.resolved_at, new Date()), updated_at: new Date().toISOString(),
  }).eq("id", v.id).eq("client_id", clientId);
  if (error) return go(v.id, "invalid");
  if (events.length) await db.from("ticket_events").insert(events); // the activity is a record, not a gate: a failure here never undoes the change

  revalidatePath("/dashboard/tickets");
  revalidatePath(detail(v.id));

  // Telling the customer is opt-in, and only when the status really changed (so a double click or a repeat save never sends twice).
  if (notify) {
    if (v.status === prev) return go(v.id, "tkt_nothing_to_notify");
    const message = statusUpdateMessage(clientName, before.subject, ticketRef(v.id), v.status, v.message);
    const sent = await notifyCustomerDetailed(clientId, before.conversation_id, clientName, "Update on your issue", message);
    // Recorded as WhatsApp's own word: "whatsapp" means WhatsApp ACCEPTED it. Delivery is looked up later and shown honestly.
    await db.from("ticket_events").insert({ ...actor, kind: "notification", detail: { channel: sent.channel, wa_message_id: sent.waMessageId, status: v.status } });
    revalidatePath(detail(v.id));
    return go(v.id, deliveryNotice("tkt", sent.channel));
  }
  return go(v.id, "tkt_saved");
}

/** Add a private note. Earlier notes are never touched. The note text is stored on the note only, never in the activity. */
export async function addTicketNote(formData: FormData) {
  const { clientId, user } = await requireClient();
  const parsed = ticketNoteSchema.safeParse({ id: formData.get("id"), body: String(formData.get("body") ?? "") });
  if (!parsed.success) {
    const id = String(formData.get("id") ?? "");
    return redirect(/^[0-9a-f-]{36}$/i.test(id) ? `${detail(id)}?notice=tkt_note_empty` : "/dashboard/tickets?notice=invalid");
  }
  const { id, body } = parsed.data;
  const db = supabaseAdmin();
  const { data: ticket } = await db.from("tickets").select("id").eq("id", id).eq("client_id", clientId).maybeSingle();
  if (!ticket) return redirect("/dashboard/tickets?notice=not_found");
  const { error } = await db.from("ticket_notes").insert({ client_id: clientId, ticket_id: id, author_user_id: user.id, author_label: user.email ?? null, body });
  if (error) return go(id, "invalid");
  await db.from("ticket_events").insert({ client_id: clientId, ticket_id: id, kind: "note", detail: {}, actor_user_id: user.id, actor_label: user.email ?? null });
  revalidatePath(detail(id));
  return go(id, "tkt_note_added");
}
