import Link from "next/link";
import Pagination from "../../../components/Pagination";
import SubmitButton from "../../../components/SubmitButton";
import { Badge, EmptyState, ErrorState, PageHeader, SearchBox } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import { clip, fmt, matches, windowStatus } from "../../../lib/dashboard";
import { ago } from "../../../lib/notifications";
import { listTeam } from "../../../lib/team";
import {
  allowedActions, HANDOFF_STATUSES, SOURCE_LABELS, STATUS_LABELS, STATUS_TONES, type HandoffSource, type HandoffStatus,
} from "../../../lib/handoff";
import { buildQuery, paginate } from "../../../lib/paginate";
import Notice from "../Notice";
import { assignHandoff, queueResumeAi, queueTakeOver, saveHandoffNote } from "./actions";

type Handoff = {
  id: string; conversation_id: string; source: HandoffSource; reason: string | null; ai_summary: string | null;
  status: HandoffStatus; assigned_to: string | null; assigned_user_id: string | null; internal_notes: string | null; created_at: string; resolved_at: string | null;
};

// A focused queue: who needs a person, who has it, and a way into the conversation. The chat itself lives in Conversations.
const VIEWS = ["all", "waiting", "assigned", "resolved"] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABELS: Record<View, string> = { all: "All", waiting: "Waiting", assigned: "Assigned", resolved: "Resolved" };

export default async function HumanHandoff({ searchParams }: { searchParams: Promise<{ notice?: string; q?: string; view?: string; page?: string }> }) {
  const { notice, q, view: viewRaw, page: pageRaw } = await searchParams;
  const view: View = (VIEWS as readonly string[]).includes(viewRaw ?? "") ? (viewRaw as View) : "all";
  const { db, user, clientId } = await requireClient(); // RLS: only this business's rows can come back
  const team = await listTeam(clientId);
  const nameOf = (id: string | null) => (id ? team.find((m) => m.id === id)?.label ?? "Former team member" : null);

  const { data, error } = await db.from("handoff_requests")
    .select("id, conversation_id, source, reason, ai_summary, status, assigned_to, assigned_user_id, internal_notes, created_at, resolved_at")
    .order("created_at", { ascending: false }).limit(500);
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

  const toRow = (h: Handoff) => {
    const conv = convById.get(h.conversation_id);
    const contact = conv ? contactById.get(conv.contact_id as string) : undefined;
    return { h, conv, name: contact?.name ?? null, phone: contact?.phone ?? "", last: lastMessage.get(h.conversation_id) ?? "" };
  };
  const rows = all.map(toRow);
  // The cards are counted from the same rows as the list, so they always agree with it.
  const isOpen = (h: Handoff) => h.status !== "resolved";
  const counts = {
    waiting: rows.filter((r) => r.h.status === "requested" || r.h.status === "assigned").length,
    unassigned: rows.filter((r) => isOpen(r.h) && !r.h.assigned_user_id).length,
    mine: rows.filter((r) => isOpen(r.h) && r.h.assigned_user_id === user.id).length,
    resolved: rows.filter((r) => r.h.status === "resolved").length,
  };
  const inView = (h: Handoff) => view === "all" ? true : view === "waiting" ? (h.status === "requested" || h.status === "assigned") : view === "assigned" ? (isOpen(h) && !!h.assigned_user_id) : h.status === "resolved";
  // Open requests first (oldest waiting first), then resolved ones, newest first.
  const matching = rows
    .filter((r) => inView(r.h) && matches(q, r.name, r.phone, r.last, r.h.ai_summary, r.h.reason, nameOf(r.h.assigned_user_id)))
    .sort((a, b) => (isOpen(a.h) === isOpen(b.h) ? (isOpen(a.h) ? a.h.created_at.localeCompare(b.h.created_at) : b.h.created_at.localeCompare(a.h.created_at)) : isOpen(a.h) ? -1 : 1));
  const paged = paginate(matching, pageRaw, 10);
  const here = `/dashboard/handoff${buildQuery({ view: view === "all" ? null : view, q, page: paged.page > 1 ? paged.page : null })}`;

  return (
    <>
      <PageHeader title="Human handoff" description="Customers who need a person. Open a request to reply in Conversations. The assistant stays silent in a chat until you resume it; your other chats are not affected." />
      <Notice code={notice} />
      <div className="stat-grid" style={{ marginBottom: 14 }}>
        <div className="stat"><b>{counts.waiting}</b><span>Waiting</span></div>
        <div className="stat"><b>{counts.unassigned}</b><span>Unassigned</span></div>
        <div className="stat"><b>{counts.mine}</b><span>Assigned to me</span></div>
        <div className="stat"><b>{counts.resolved}</b><span>Resolved</span></div>
      </div>
      <div className="filters">
        <div className="conv-filters" role="group" aria-label="Filter requests">
          {VIEWS.map((v) => <Link key={v} className={`pill${v === view ? " on" : ""}`} aria-current={v === view ? "true" : undefined} href={`/dashboard/handoff${buildQuery({ view: v === "all" ? null : v, q })}`}>{VIEW_LABELS[v]}</Link>)}
        </div>
        <SearchBox q={q} placeholder="Search by name, phone, message, summary or assignee" keep={{ view: view === "all" ? [] : [view] }} />
      </div>

      {error ? <ErrorState>Your handoff requests could not be loaded.</ErrorState> : paged.items.length === 0 ? (
        q || view !== "all"
          ? <EmptyState icon="search" title="Nothing here" action={{ href: "/dashboard/handoff", label: "Show open requests" }}>No handoff requests match this view.</EmptyState>
          : <EmptyState icon="shield" title="No chats are waiting for you">When a customer asks for a person, or the assistant can&apos;t help, the chat appears here and you get an email.</EmptyState>
      ) : (
        <ul className="handoff-list">
          {paged.items.map(({ h, name, phone, last }) => {
            const open = isOpen(h);
            const mine = h.assigned_user_id === user.id;
            const owner = nameOf(h.assigned_user_id) ?? h.assigned_to;
            return (
              <li key={h.id} className="card handoff-card">
                <div className="handoff-top">
                  <div style={{ minWidth: 0 }}>
                    <h2><Link href={`/dashboard/conversations/${h.conversation_id}`}>{name || "Unknown customer"}</Link></h2>
                    <p className="muted">+{phone} · {open ? `waiting ${ago(h.created_at).replace(" ago", "")}` : `resolved ${fmt(h.resolved_at)}`}</p>
                  </div>
                  <Badge tone={STATUS_TONES[h.status]}>{!open ? "Resolved" : owner ? (mine ? "Assigned to you" : `Assigned to ${owner}`) : "Waiting for human"}</Badge>
                </div>
                <dl className="handoff-facts">
                  <div><dt>Reason</dt><dd>{h.reason ?? SOURCE_LABELS[h.source]}</dd></div>
                  <div><dt>AI summary</dt><dd>{h.ai_summary || "-"}</dd></div>
                  <div><dt>Last message</dt><dd>{last ? clip(last, 200) : "-"}</dd></div>
                  <div><dt>Assigned to</dt><dd>{owner ?? "Nobody yet"}</dd></div>
                  {h.internal_notes && <div><dt>Internal note</dt><dd className="note">{h.internal_notes}</dd></div>}
                </dl>
                <div className="handoff-actions">
                  <Link className="btn btn-secondary btn-sm" href={`/dashboard/conversations/${h.conversation_id}`}>Open conversation</Link>
                  {open && (!h.assigned_user_id || mine) && !(h.status === "human_active" && mine) && (
                    <form action={queueTakeOver}>
                      <input type="hidden" name="id" value={h.id} /><input type="hidden" name="back" value={here} />
                      <SubmitButton small pendingText="Taking over...">Take over</SubmitButton>
                    </form>
                  )}
                  {open && (!h.assigned_user_id || mine) && (
                    <form action={queueResumeAi}>
                      <input type="hidden" name="id" value={h.id} /><input type="hidden" name="back" value={here} />
                      <SubmitButton small variant="secondary" pendingText="Resuming...">Resume AI</SubmitButton>
                    </form>
                  )}
                </div>
                {open && (
                  <details className="handoff-more">
                    <summary>Assign or add a note</summary>
                    <div className="handoff-forms">
                      <form action={assignHandoff} className="row">
                        <input type="hidden" name="id" value={h.id} /><input type="hidden" name="back" value={here} />
                        <label className="sr-only" htmlFor={`as-${h.id}`}>Assign to</label>
                        <select id={`as-${h.id}`} name="assignee" defaultValue={h.assigned_user_id ?? ""}>
                          <option value="">Unassigned</option>
                          {team.map((m) => <option key={m.id} value={m.id}>{m.label}{m.id === user.id ? " (you)" : ""}</option>)}
                        </select>
                        <SubmitButton small variant="secondary" pendingText="Saving...">Save</SubmitButton>
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
      {!error && <Pagination p={paged} label="Handoff requests" hrefFor={(n) => `/dashboard/handoff${buildQuery({ view: view === "all" ? null : view, q, page: n > 1 ? n : null })}`} />}
    </>
  );
}
