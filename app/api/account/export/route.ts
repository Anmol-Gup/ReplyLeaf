import { getClientOrNull } from "../../../../lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Download this business's data as JSON. Always available to the signed-in owner, even with no subscription.
// Read through the owner's own session (RLS), so nothing from another business can appear. No secrets are in these
// tables (tokens and AI keys live in client_secrets, which owners cannot read), and embeddings are left out.
const TABLES: { name: string; columns: string }[] = [
  { name: "contacts", columns: "id, name, phone, email, status, tags, notes, created_at" },
  { name: "conversations", columns: "id, contact_id, handling, created_at, last_customer_message_at" },
  { name: "messages", columns: "id, conversation_id, direction, sender, type, body, status, created_at" },
  { name: "leads", columns: "id, contact_id, customer_name, customer_phone, project_type, description, budget, timeline, status, ai_summary, internal_notes, follow_up_at, created_at" },
  { name: "lead_requirements", columns: "lead_id, requirement_key, requirement_value" },
  { name: "appointments", columns: "id, contact_id, customer_name, customer_phone, purpose, preferred_date, preferred_time, timezone, appointment_type, notes, status, scheduled_date, scheduled_time, internal_notes, created_at" },
  { name: "tickets", columns: "id, contact_id, customer_name, customer_phone, subject, description, category, reference_info, priority, status, assigned_to, internal_notes, created_at, resolved_at" },
  { name: "handoff_requests", columns: "id, conversation_id, source, reason, ai_summary, status, assigned_to, internal_notes, created_at, resolved_at" },
  { name: "kb_documents", columns: "id, title, status, created_at" },
  { name: "invoices", columns: "stripe_invoice_id, status, amount_due, amount_paid, currency, period_start, period_end, paid_at, created_at" },
];
const PAGE = 1000;
const MAX_ROWS = 50_000; // per table, a safety bound

export async function GET() {
  const me = await getClientOrNull();
  if (!me) return Response.json({ error: "unauthorized" }, { status: 401 });

  const out: Record<string, unknown> = { exported_at: new Date().toISOString(), business: me.clientName };
  for (const t of TABLES) {
    const rows: unknown[] = [];
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const { data, error } = await me.db.from(t.name).select(t.columns).range(from, from + PAGE - 1);
      if (error) return Response.json({ error: "export_failed" }, { status: 500 });
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
    out[t.name] = rows;
  }
  return new Response(JSON.stringify(out, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="replyleaf-export-${new Date().toISOString().slice(0, 10)}.json"`,
      "cache-control": "private, no-store",
    },
  });
}
