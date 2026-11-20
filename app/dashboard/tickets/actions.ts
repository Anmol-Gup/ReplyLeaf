"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePaidAccess } from "../../../lib/billing/gate";
import { requireClient } from "../../../lib/auth/session";
import { notifyCustomer } from "../../../lib/appointment-notify";
import { deliveryNotice } from "../../../lib/appointments";
import { cleanAssignedTo, isDone, resolvedAtFor, resolutionMessage, ticketFormSchema, ticketRef, type TicketStatus } from "../../../lib/tickets";
import { supabaseAdmin } from "../../../lib/supabase-admin";

// Same security model as the other dashboard actions: requireClient() gives the clientId, the write uses the
// service role, and the row is only matched together with that client_id. Internal notes are never sent anywhere.
export async function updateTicket(formData: FormData) {
  const { clientId, clientName } = await requireClient();
  if (formData.get("notify") !== null) await requirePaidAccess(clientId); // sending to the customer is a paid feature
  const parsed = ticketFormSchema.safeParse({
    id: formData.get("id"), status: formData.get("status"), priority: formData.get("priority") ?? undefined,
    assigned_to: String(formData.get("assigned_to") ?? ""), notes: String(formData.get("notes") ?? "").replace(/\u0000/g, "").trim(),
    message: String(formData.get("message") ?? "").replace(/\u0000/g, "").trim(),
  });
  if (!parsed.success) return redirect("/dashboard/tickets?notice=invalid");
  const v = parsed.data;
  const assignee = cleanAssignedTo(v.assigned_to);
  if (v.assigned_to.trim() && !assignee) return redirect(`/dashboard/tickets/${v.id}?notice=invalid`);

  const db = supabaseAdmin();
  const { data: before } = await db.from("tickets").select("id, status, resolved_at, conversation_id, subject")
    .eq("id", v.id).eq("client_id", clientId).maybeSingle();
  if (!before) return redirect("/dashboard/tickets?notice=not_found");

  const prev = before.status as TicketStatus;
  const { error } = await db.from("tickets").update({
    status: v.status, ...(v.priority ? { priority: v.priority } : {}), assigned_to: assignee, internal_notes: v.notes || null,
    resolved_at: resolvedAtFor(v.status, prev, before.resolved_at, new Date()), updated_at: new Date().toISOString(),
  }).eq("id", v.id).eq("client_id", clientId);
  if (error) return redirect(`/dashboard/tickets/${v.id}?notice=invalid`);

  revalidatePath("/dashboard/tickets");
  revalidatePath(`/dashboard/tickets/${v.id}`);

  // Closing the loop with the customer is OPT-IN (a checkbox), and only when it becomes resolved or closed.
  if (formData.get("notify") !== null && isDone(v.status) && !isDone(prev)) {
    const text = resolutionMessage(clientName, before.subject, ticketRef(v.id), v.message);
    const channel = await notifyCustomer(clientId, before.conversation_id, clientName, "Update on your issue", text);
    return redirect(`/dashboard/tickets/${v.id}?notice=${deliveryNotice("tkt", channel)}`);
  }
  return redirect(`/dashboard/tickets/${v.id}?notice=tkt_saved`);
}
