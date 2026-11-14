import { paidClientIds } from "./billing/gate";
import type { DigestBusiness, DigestDeps } from "./digest-job";
import { getMailer } from "./email/mailer";
import { supabaseAdmin } from "./supabase-admin";

// The production implementation of DigestDeps. Every query filters by client_id.
export function digestDeps(): DigestDeps {
  const db = supabaseAdmin();
  const must = <T,>(r: { data: T; error: { message: string } | null }, what: string): T => {
    if (r.error) throw new Error(`${what} failed: ${r.error.message}`);
    return r.data;
  };
  return {
    now: () => new Date(),
    appUrl: process.env.APP_URL,
    paid: paidClientIds,

    async listBusinesses(): Promise<DigestBusiness[]> {
      const clients = must(await db.from("clients").select("id, name, owner_email").eq("status", "active"), "clients");
      const settings = must(await db.from("notification_settings").select("*"), "notification settings");
      const by = new Map((settings ?? []).map((s) => [s.client_id as string, s]));
      return (clients ?? []).map((c) => {
        const s = by.get(c.id as string);
        const to = [s?.primary_email ?? c.owner_email, ...((s?.additional_emails as string[] | undefined) ?? [])].filter((x): x is string => Boolean(x));
        return {
          clientId: c.id as string, name: c.name as string, recipients: [...new Set(to.map((x) => x.toLowerCase()))],
          switches: { leads: s?.lead_notifications ?? true, appointments: s?.appointment_notifications ?? true, tickets: s?.ticket_notifications ?? true, handoffs: s?.handoff_notifications ?? true },
          delivery: (s?.delivery as "daily" | "immediate" | undefined) ?? "daily",
          lastDigestAt: s?.last_digest_at ? new Date(s.last_digest_at as string) : null,
        };
      });
    },

    async gather(clientId, name, since, now) {
      const sinceIso = since.toISOString();
      const today = now.toISOString().slice(0, 10);
      const [contacts, leads, appts, tickets, waitAppts, waitTickets, urgent, handoffs, followUps] = await Promise.all([
        db.from("contacts").select("name, phone").eq("client_id", clientId).gt("created_at", sinceIso).order("created_at", { ascending: false }).limit(50),
        db.from("leads").select("project_type, customer_name, status").eq("client_id", clientId).gt("created_at", sinceIso).order("created_at", { ascending: false }).limit(50),
        db.from("appointments").select("purpose, customer_name, preferred_date, preferred_time").eq("client_id", clientId).gt("created_at", sinceIso).order("created_at", { ascending: false }).limit(50),
        db.from("tickets").select("subject, customer_name, priority").eq("client_id", clientId).gt("created_at", sinceIso).order("created_at", { ascending: false }).limit(50),
        db.from("appointments").select("id", { count: "exact", head: true }).eq("client_id", clientId).in("status", ["pending", "reschedule_requested"]),
        db.from("tickets").select("id", { count: "exact", head: true }).eq("client_id", clientId).in("status", ["open", "in_progress", "waiting_on_customer"]),
        db.from("tickets").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("priority", "high").in("status", ["open", "in_progress", "waiting_on_customer"]),
        db.from("handoff_requests").select("id", { count: "exact", head: true }).eq("client_id", clientId).neq("status", "resolved"),
        db.from("leads").select("id", { count: "exact", head: true }).eq("client_id", clientId).not("status", "in", "(won,lost)").lte("follow_up_at", today),
      ]);
      for (const r of [contacts, leads, appts, tickets, waitAppts, waitTickets, urgent, handoffs, followUps]) if (r.error) throw new Error(`digest query failed: ${r.error.message}`);
      return {
        businessName: name,
        contacts: (contacts.data ?? []).map((c) => ({ name: c.name as string | null, phone: c.phone as string })),
        leads: (leads.data ?? []).map((l) => ({ projectType: l.project_type as string, customer: l.customer_name as string | null, status: l.status as string })),
        appointments: (appts.data ?? []).map((a) => ({ purpose: a.purpose as string, customer: a.customer_name as string | null, when: [a.preferred_date, a.preferred_time].filter(Boolean).join(" ") })),
        tickets: (tickets.data ?? []).map((t) => ({ subject: t.subject as string, customer: t.customer_name as string | null, urgent: t.priority === "high" })),
        waiting: { appointments: waitAppts.count ?? 0, tickets: waitTickets.count ?? 0, urgentTickets: urgent.count ?? 0, handoffs: handoffs.count ?? 0, followUpsDue: followUps.count ?? 0 },
      };
    },

    claimToday: async (clientId, today) => must(await db.rpc("claim_daily_digest", { p_client_id: clientId, p_today: today }), "claim_daily_digest") === true,
    releaseToday: async (clientId) => { must(await db.rpc("release_daily_digest", { p_client_id: clientId }), "release_daily_digest"); },
    markSent: async (clientId, at) => { must(await db.rpc("mark_digest_sent", { p_client_id: clientId, p_at: at.toISOString() }), "mark_digest_sent"); },
    async send(msg) {
      const mailer = getMailer();
      if (!mailer) throw new Error("email is not configured (GMAIL_*)");
      await mailer.send(msg);
    },
  };
}
