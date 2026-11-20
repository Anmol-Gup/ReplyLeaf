"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePaidAccess } from "../../../lib/billing/gate";
import { requireClient } from "../../../lib/auth/session";
import { notifyCustomer } from "../../../lib/appointment-notify";
import { appointmentEditSchema, appointmentFormSchema, customerMessage, formProblem, rescheduleNote, statusMessageAction, whenText } from "../../../lib/appointments";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { notifyOwner } from "../../../lib/supabase-deps";

// SECURITY MODEL (same as the other dashboard actions): requireClient() derives clientId from the signed-in
// owner's membership; writes use the service role, so every query filters by that clientId and the SQL
// functions only touch rows that belong to it. Form ids are never trusted on their own.

const detail = (id: string) => `/dashboard/appointments/${id}`;
const go = (id: string, notice: string): never => redirect(`${detail(id)}?notice=${notice}`);

export async function appointmentTransition(formData: FormData) {
  const { clientId, clientName } = await requireClient();
  await requirePaidAccess(clientId); // paid feature: blocked while the subscription is inactive (see lib/billing/access.ts)
  const rawId = String(formData.get("id") ?? "");
  const parsed = appointmentFormSchema.safeParse({
    id: formData.get("id"), action: formData.get("action"),
    date: String(formData.get("date") ?? ""), time: String(formData.get("time") ?? ""), note: String(formData.get("note") ?? ""),
  });
  if (!parsed.success) return z.string().uuid().safeParse(rawId).success ? go(rawId, "invalid") : redirect("/dashboard/appointments?notice=invalid");
  const { id, action, date, time, note } = parsed.data;
  if (formProblem(action, { date, time, note })) return go(id, "appt_need_alternative");

  const db = supabaseAdmin();
  const { data: before } = await db.from("appointments")
    .select("id, conversation_id, purpose, preferred_date, preferred_time, customer_name, customer_phone")
    .eq("id", id).eq("client_id", clientId).maybeSingle();
  if (!before) return redirect("/dashboard/appointments?notice=not_found");

  const alternative = action === "reschedule" ? rescheduleNote({ date, time, note }) : action === "reject" ? note ?? "" : "";
  const { error } = await db.rpc("set_appointment_status", {
    p_client_id: clientId, p_appointment_id: id, p_action: action,
    p_date: action === "confirm" && date ? date : null, p_time: action === "confirm" ? time ?? null : null, p_note: alternative || null,
  });
  if (error) return go(id, "appt_failed");

  const { data: after } = await db.from("appointments").select("scheduled_date, scheduled_time").eq("id", id).eq("client_id", clientId).single();
  const when = action === "confirm" ? whenText(after?.scheduled_date, after?.scheduled_time) : whenText(before.preferred_date, before.preferred_time);

  // Tell the team (the notification settings decide who) and the customer. Neither can undo the change.
  const status = ({ confirm: "confirmed", reject: "rejected", reschedule: "reschedule_requested", cancel: "cancelled" } as const)[action as "confirm" | "reject" | "reschedule" | "cancel"];
  if (status) {
    await notifyOwner(clientId, {
      type: "appointment_update", status, contactName: before.customer_name, phone: before.customer_phone,
      purpose: before.purpose, when: when || null, note: alternative || null,
    }).catch((e) => console.warn("appointment team email failed", e instanceof Error ? e.message : e));
  }
  if (action === "complete") { revalidatePath("/dashboard/appointments"); return go(id, "appt_done"); }

  const text = customerMessage(action, { purpose: before.purpose, when, note: alternative }, clientName);
  const subject = ({ confirm: "Your appointment is confirmed", reject: "About your appointment request", reschedule: "Can we reschedule your appointment?", cancel: "Your appointment was cancelled" })[action];
  const channel = await notifyCustomer(clientId, before.conversation_id, clientName, subject, text);
  revalidatePath("/dashboard/appointments");
  revalidatePath(detail(id));
  return go(id, channel === "whatsapp" ? "appt_done_whatsapp" : channel === "email" ? "appt_done_email" : "appt_done_not_sent");
}

export async function saveAppointmentNote(formData: FormData) {
  const { clientId } = await requireClient();
  const id = z.string().uuid().safeParse(formData.get("id"));
  const notes = z.string().max(2000).safeParse(String(formData.get("notes") ?? "").replace(/\u0000/g, "").trim());
  if (!id.success || !notes.success) return redirect("/dashboard/appointments?notice=invalid");
  const { data } = await supabaseAdmin().from("appointments")
    .update({ internal_notes: notes.data || null, updated_at: new Date().toISOString() })
    .eq("id", id.data).eq("client_id", clientId).select("id");
  if (!data?.length) return redirect("/dashboard/appointments?notice=not_found");
  revalidatePath(detail(id.data));
  return go(id.data, "saved");
}

// The owner fixes an appointment by hand: any detail, and any status (including moving a rejected or cancelled one back to
// "Unconfirmed"). Unlike the guided buttons above, nothing is sent to the customer unless the owner ticks "Tell the customer".
// That message is free-form text (never a template): WhatsApp if the 24-hour window is open, else email, else shown to copy.
export async function updateAppointment(formData: FormData) {
  const { clientId, clientName } = await requireClient();
  await requirePaidAccess(clientId);
  const rawId = String(formData.get("id") ?? "");
  const text = (n: string) => String(formData.get(n) ?? "").replace(/\u0000/g, "");
  const parsed = appointmentEditSchema.safeParse({
    id: formData.get("id"), status: formData.get("status"), customer_name: text("customer_name"), purpose: text("purpose"),
    preferred_date: text("preferred_date"), preferred_time: text("preferred_time"), scheduled_date: text("scheduled_date"), scheduled_time: text("scheduled_time"),
    appointment_type: text("appointment_type"), timezone: text("timezone"), note: text("note"), notify: formData.get("notify") !== null,
  });
  if (!parsed.success) return z.string().uuid().safeParse(rawId).success ? go(rawId, "invalid") : redirect("/dashboard/appointments?notice=invalid");
  const v = parsed.data;

  const db = supabaseAdmin();
  const { data: before } = await db.from("appointments").select("id, status, conversation_id").eq("id", v.id).eq("client_id", clientId).maybeSingle();
  if (!before) return redirect("/dashboard/appointments?notice=not_found");

  const { error } = await db.from("appointments").update({
    status: v.status, customer_name: v.customer_name || null, purpose: v.purpose,
    preferred_date: v.preferred_date || null, preferred_time: v.preferred_time || null,
    scheduled_date: v.scheduled_date || null, scheduled_time: v.scheduled_time || null,
    appointment_type: v.appointment_type || null, timezone: v.timezone || null,
    reschedule_note: v.status === "rejected" || v.status === "reschedule_requested" ? (v.note || null) : null,
    updated_at: new Date().toISOString(),
  }).eq("id", v.id).eq("client_id", clientId);
  // Two open requests for the same thing are not allowed (the same rule that stops the assistant saving a duplicate).
  if (error) return go(v.id, error.code === "23505" ? "appt_conflict" : "appt_failed");
  revalidatePath("/dashboard/appointments");
  revalidatePath(detail(v.id));

  const action = statusMessageAction(v.status);
  if (!v.notify || !action || before.status === v.status && !v.note) return go(v.id, "appt_done");
  const when = action === "confirm" || action === "cancel" ? whenText(v.scheduled_date, v.scheduled_time) || whenText(v.preferred_date, v.preferred_time) : whenText(v.preferred_date, v.preferred_time);
  const message = customerMessage(action, { purpose: v.purpose, when, note: v.note }, clientName);
  const subject = ({ confirm: "Your appointment is confirmed", reject: "About your appointment request", reschedule: "Can we reschedule your appointment?", cancel: "Your appointment was cancelled" })[action];
  const channel = await notifyCustomer(clientId, before.conversation_id, clientName, subject, message);
  return go(v.id, channel === "whatsapp" ? "appt_done_whatsapp" : channel === "email" ? "appt_done_email" : "appt_done_not_sent");
}
