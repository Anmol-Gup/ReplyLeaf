import Link from "next/link";
import Pagination from "../../../components/Pagination";
import SubmitButton from "../../../components/SubmitButton";
import { Badge, EmptyState, ErrorState, PageHeader, SearchBox } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import { clip, fmt, matches, windowStatus } from "../../../lib/dashboard";
import {
  allowedActions, SOURCE_LABELS, STATUS_LABELS, STATUS_TONES, type HandoffSource, type HandoffStatus,
} from "../../../lib/handoff";
import { buildQuery, paginate } from "../../../lib/paginate";
import Notice from "../Notice";
import { handoffTransition, saveHandoffNote } from "./actions";

const FILTERS = [
  { key: "open", label: "Open" },
  { key: "requested", label: "Waiting for you" },
  { key: "assigned", label: "Assigned" },
  { key: "human_active", label: "You are handling" },
  { key: "resolved", label: "Resolved" },
  { key: "all", label: "All" },
] as const;

type Handoff = {
  id: string; conversation_id: string; source: HandoffSource; reason: string | null; ai_summary: string | null;
  status: HandoffStatus; assigned_to: string | null; internal_notes: string | null; created_at: string; resolved_at: string | null;
};

export default async function HumanHandoff({ searchParams }: { searchParams: Promise<{ notice?: string; q?: string; status?: string; page?: string }> }) {
  const { notice, q, status: statusRaw, page: pageRaw } = await searchParams;
  const status = FILTERS.some((f) => f.key === statusRaw) ? (statusRaw as string) : "open";
  const { db } = await requireClient(); // RLS: only this business's rows can come back

  const { data, error } = await db.from("handoff_requests")
    .select("id, conversation_id, source, reason, ai_summary, status, assigned_to, internal_notes, created_at, resolved_at")
    .order("created_at", { ascending: false }).limit(300);
  const all = (data ?? []) as Handoff[];

  // Who and what, fetched in bulk (still through the RLS client).
  const convIds = [...new Set(all.map((h) => h.conversation_id))];
  const [convs, inbound] = await Promise.all([
    convIds.length ? db.from("conversations").select("id, contact_id, last_customer_message_at").in("id", convIds) : Promise.resolve({ data: [] }),
    convIds.length
      ? db.from("messages").select("conversation_id, body, created_at").in("conversation_id", convIds).eq("direction", "inbound").order("created_at", { ascending: false }).limit(600)
      : Promise.resolve({ data: [] }),
  ]);
  const convById = new Map((convs.data ?? []).map((c) => [c.id as string, c]));
  const contactIds = [...new Set((convs.data ?? []).map((c) => c.contact_id as string))];
  const { data: contacts } = contactIds.length ? await db.from("contacts").select("id, name, phone").in("id", contactIds) : { data: [] };
  const contactById = new Map((contacts ?? []).map((c) => [c.id as string, c]));
  const lastMessage = new Map<string, string>();
  for (const m of inbound.data ?? []) if (!lastMessage.has(m.conversation_id as string) && m.body) lastMessage.set(m.conversation_id as string, m.body as string);

  const view = (h: Handoff) => {
    const conv = convById.get(h.conversation_id);
    const contact = conv ? contactById.get(conv.contact_id as string) : undefined;
    return { h, conv, name: contact?.name ?? null, phone: contact?.phone ?? "", last: lastMessage.get(h.conversation_id) ?? "" };
  };
  const rows = all.map(view);
  const counts: Record<string, number> = { all: rows.length, open: 0, requested: 0, assigned: 0, human_active: 0, resolved: 0 };
  for (const r of rows) { counts[r.h.status]++; if (r.h.status !== "resolved") counts.open++; }

  const matching = rows.filter((r) =>
    (status === "all" || (status === "open" ? r.h.status !== "resolved" : r.h.status === status)) &&
    matches(q, r.name, r.phone, r.last, r.h.ai_summary, r.h.assigned_to, r.h.internal_notes));
  const paged = paginate(matching, pageRaw, 10);
  const here = `/dashboard/handoff${buildQuery({ status: status === "open" ? null : status, q, page: paged.page > 1 ? paged.page : null })}`;

  return (
    <>
      <PageHeader title="Human handoff" description="Chats where the assistant has stepped aside for a person. The assistant stays silent in each of these chats until you resume it. Your other chats are not affected." />
      <Notice code={notice} />
      <nav className="tabs" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <Link key={f.key} href={`/dashboard/handoff${buildQuery({ status: f.key === "open" ? null : f.key, q })}`}
            className={`tab${status === f.key ? " active" : ""}`} aria-current={status === f.key ? "page" : undefined}>
            {f.label} <span className="tab-count">{counts[f.key]}</span>
          </Link>
        ))}
      </nav>
      <SearchBox q={q} placeholder="Search by name, phone, message, summary or assignee" />

      {error ? <ErrorState>Your handoff requests could not be loaded.</ErrorState> : paged.items.length === 0 ? (
        q || status !== "open"
          ? <EmptyState icon="search" title="Nothing here" action={{ href: "/dashboard/handoff", label: "Show open requests" }}>No handoff requests match this view.</EmptyState>
          : <EmptyState icon="shield" title="No chats are waiting for you">When a customer asks for a person, or the assistant can&apos;t help, the chat appears here and you get an email.</EmptyState>
      ) : (
        <ul className="handoff-list">
          {paged.items.map(({ h, conv, name, phone, last }) => {
            const actions = allowedActions(h.status);
            const w = windowStatus(conv?.last_customer_message_at as string | null | undefined);
            return (
              <li key={h.id} className="card handoff-card">
                <div className="handoff-top">
                  <div style={{ minWidth: 0 }}>
                    <h2><Link href={`/dashboard/conversations/${h.conversation_id}`}>{name || "Unknown customer"}</Link></h2>
                    <p className="muted">+{phone} · requested {fmt(h.created_at)}</p>
                  </div>
                  <Badge tone={STATUS_TONES[h.status]}>{STATUS_LABELS[h.status]}</Badge>
                </div>
                <dl className="handoff-facts">
                  <div><dt>Reason</dt><dd>{h.reason ?? SOURCE_LABELS[h.source]}</dd></div>
                  <div><dt>AI summary</dt><dd>{h.ai_summary || "-"}</dd></div>
                  <div><dt>Last message</dt><dd>{last ? clip(last, 200) : "-"}</dd></div>
                  <div><dt>Assigned to</dt><dd>{h.assigned_to ?? "Nobody yet"}</dd></div>
                  {h.status === "resolved" && <div><dt>Resolved</dt><dd>{fmt(h.resolved_at)}</dd></div>}
                  {h.internal_notes && <div><dt>Internal note</dt><dd className="note">{h.internal_notes}</dd></div>}
                </dl>
                {h.status !== "resolved" && (
                  <p className="muted handoff-window">
                    {w.open ? <>You can reply on WhatsApp. {w.label}.</> : <>You can&apos;t reply on WhatsApp right now. {w.label}.</>}
                  </p>
                )}
                <div className="handoff-actions">
                  <Link className="btn btn-secondary btn-sm" href={`/dashboard/conversations/${h.conversation_id}`}>Open conversation</Link>
                  {actions.includes("take_over") && (
                    <form action={handoffTransition}>
                      <input type="hidden" name="id" value={h.id} /><input type="hidden" name="action" value="take_over" /><input type="hidden" name="back" value={here} />
                      <SubmitButton small pendingText="Taking over...">Take over</SubmitButton>
                    </form>
                  )}
                  {actions.includes("resolve") && (
                    <form action={handoffTransition}>
                      <input type="hidden" name="id" value={h.id} /><input type="hidden" name="action" value="resolve" /><input type="hidden" name="back" value={here} />
                      <SubmitButton small variant="secondary" pendingText="Saving...">Mark resolved</SubmitButton>
                    </form>
                  )}
                  {actions.includes("resume_ai") && (
                    <form action={handoffTransition}>
                      <input type="hidden" name="id" value={h.id} /><input type="hidden" name="action" value="resume_ai" /><input type="hidden" name="back" value={here} />
                      <SubmitButton small variant="secondary" pendingText="Resuming...">Resume assistant</SubmitButton>
                    </form>
                  )}
                </div>
                {h.status !== "resolved" && (
                  <details className="handoff-more">
                    <summary>Assign or add a note</summary>
                    <div className="handoff-forms">
                      <form action={handoffTransition} className="row">
                        <input type="hidden" name="id" value={h.id} /><input type="hidden" name="action" value="assign" /><input type="hidden" name="back" value={here} />
                        <label className="sr-only" htmlFor={`as-${h.id}`}>Assign to (name or email)</label>
                        <input id={`as-${h.id}`} name="assignee" maxLength={100} placeholder="Name or email" defaultValue={h.assigned_to ?? ""} />
                        <SubmitButton small variant="secondary" pendingText="Saving...">Assign</SubmitButton>
                        <SubmitButton small variant="ghost" name="self" value="1" pendingText="Saving...">Assign to me</SubmitButton>
                      </form>
                      <form action={saveHandoffNote} className="stack-sm">
                        <input type="hidden" name="id" value={h.id} /><input type="hidden" name="back" value={here} />
                        <label className="field">Internal note <span className="hint">Only your team sees this. It is never sent to the customer.</span>
                          <textarea name="notes" rows={3} maxLength={2000} defaultValue={h.internal_notes ?? ""} />
                        </label>
                        <div><SubmitButton small variant="secondary" pendingText="Saving...">Save note</SubmitButton></div>
                      </form>
                    </div>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!error && <Pagination p={paged} label="Handoff requests" hrefFor={(n) => `/dashboard/handoff${buildQuery({ status: status === "open" ? null : status, q, page: n > 1 ? n : null })}`} />}
    </>
  );
}
