"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireClient } from "../../../lib/auth/session";
import { notifyCustomer } from "../../../lib/appointment-notify";
import { appointmentFormSchema, customerMessage, formProblem, rescheduleNote, whenText } from "../../../lib/appointments";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { notifyOwner } from "../../../lib/supabase-deps";

// SECURITY MODEL (same as the other dashboard actions): requireClient() derives clientId from the signed-in
// owner's membership; writes use the service role, so every query filters by that clientId and the SQL
// functions only touch rows that belong to it. Form ids are never trusted on their own.

const detail = (id: string) => `/dashboard/appointments/${id}`;
const go = (id: string, notice: string): never => redirect(`${detail(id)}?notice=${notice}`);

export async function appointmentTransition(formData: FormData) {
  const { clientId, clientName } = await requireClient();
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
