import Link from "next/link";
import SubmitButton from "../../../components/SubmitButton";
import { Avatar } from "../../../components/ConversationList";
import Icon from "../../../components/Icon";
import Pagination from "../../../components/Pagination";
import { Badge, EmptyState, ErrorState, PageHeader, SearchBox } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import { clip, fmt, matches, windowStatus } from "../../../lib/dashboard";
import { ago, shortName, whenText } from "../../../lib/notifications";
import { listTeam } from "../../../lib/team";
import {
  allowedActions, HANDOFF_STATUSES, SHORT_SOURCE_LABELS, SOURCE_LABELS, STATUS_LABELS, STATUS_TONES, type HandoffSource, type HandoffStatus,
} from "../../../lib/handoff";
import { buildQuery, paginate } from "../../../lib/paginate";
import Notice from "../Notice";
import { queueTakeOver } from "./actions";

type Handoff = {
  id: string; conversation_id: string; source: HandoffSource; reason: string | null; ai_summary: string | null;
  status: HandoffStatus; assigned_to: string | null; assigned_user_id: string | null; internal_notes: string | null; created_at: string; resolved_at: string | null;
};

// A focused queue: who needs a person, who has it, and a way into the conversation. The chat itself lives in Conversations.
const VIEWS = ["open", "waiting", "assigned", "resolved"] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABELS: Record<View, string> = { open: "Open", waiting: "Waiting", assigned: "Assigned", resolved: "Resolved" };

export default async function HumanHandoff({ searchParams }: { searchParams: Promise<{ notice?: string; q?: string; view?: string; page?: string }> }) {
  const { notice, q, view: viewRaw, page: pageRaw } = await searchParams;
  const view: View = (VIEWS as readonly string[]).includes(viewRaw ?? "") ? (viewRaw as View) : "open";
  const { db, user, clientId } = await requireClient(); // RLS: only this business's rows can come back
  const team = await listTeam(clientId);
  const nameOf = (id: string | null) => (id ? shortName(team.find((m) => m.id === id)?.label) || "Former team member" : null);

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
  const lastAt = new Map<string, string>();
  for (const m of inbound.data ?? []) if (!lastMessage.has(m.conversation_id as string) && m.body) { lastMessage.set(m.conversation_id as string, m.body as string); lastAt.set(m.conversation_id as string, m.created_at as string); }

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
  const viewCount: Record<View, number> = { open: rows.filter((r) => isOpen(r.h)).length, waiting: counts.waiting, assigned: rows.filter((r) => isOpen(r.h) && !!r.h.assigned_user_id).length, resolved: counts.resolved };
  const inView = (h: Handoff) => view === "open" ? isOpen(h) : view === "waiting" ? (h.status === "requested" || h.status === "assigned") : view === "assigned" ? (isOpen(h) && !!h.assigned_user_id) : h.status === "resolved";
  // Open requests first (oldest waiting first), then resolved ones, newest first.
  const matching = rows
    .filter((r) => inView(r.h) && matches(q, r.name, r.phone, r.last, r.h.ai_summary, r.h.reason, nameOf(r.h.assigned_user_id)))
    .sort((a, b) => (isOpen(a.h) === isOpen(b.h) ? (isOpen(a.h) ? a.h.created_at.localeCompare(b.h.created_at) : b.h.created_at.localeCompare(a.h.created_at)) : isOpen(a.h) ? -1 : 1));
  const paged = paginate(matching, pageRaw, 10);
  const here = `/dashboard/handoff${buildQuery({ view: view === "open" ? null : view, q, page: paged.page > 1 ? paged.page : null })}`;

  return (
    <>
      <PageHeader title="Human handoff" description="Conversations where the assistant has stepped aside for a human response." />
      <Notice code={notice} />
      <div className="stat-grid" style={{ marginBottom: 14 }}>
        <div className="stat stat-card stat-danger"><span className="stat-icon"><Icon name="alert" /></span><div><span>Waiting</span><b>{counts.waiting}</b><small>Customers waiting for a human</small></div></div>
        <div className="stat stat-card stat-blue"><span className="stat-icon"><Icon name="users" /></span><div><span>Unassigned</span><b>{counts.unassigned}</b><small>Waiting to be taken over</small></div></div>
        <div className="stat stat-card stat-green"><span className="stat-icon"><Icon name="users" /></span><div><span>Assigned to me</span><b>{counts.mine}</b><small>Conversations you are handling</small></div></div>
        <div className="stat stat-card"><span className="stat-icon"><Icon name="check" /></span><div><span>Resolved</span><b>{counts.resolved}</b><small>Completed handoffs</small></div></div>
      </div>
      <div className="filters">
        <div className="conv-filters" role="group" aria-label="Filter requests">
          {VIEWS.map((v) => <Link key={v} className={`pill${v === view ? " on" : ""}`} aria-current={v === view ? "true" : undefined} href={`/dashboard/handoff${buildQuery({ view: v === "open" ? null : v, q })}`}>{VIEW_LABELS[v]} <span className="pill-count">{viewCount[v]}</span></Link>)}
        </div>
        <SearchBox live q={q} placeholder="Search by name, phone, message, summary or assignee" keep={{ view: view === "open" ? [] : [view] }} />
      </div>

      {error ? <ErrorState>Your handoff requests could not be loaded.</ErrorState> : paged.items.length === 0 ? (
        q || view !== "open"
          ? <EmptyState icon="search" title="Nothing here" action={{ href: "/dashboard/handoff", label: "Show open requests" }}>No handoff requests match this view.</EmptyState>
          : <EmptyState icon="shield" title="No open handoffs" action={counts.resolved > 0 ? { href: "/dashboard/handoff?view=resolved", label: `View ${counts.resolved} resolved` } : undefined}>When a customer asks for a person, or the assistant can&apos;t help, the chat appears here and you are notified.</EmptyState>
      ) : (
        <ul className="handoff-cards">
          {paged.items.map(({ h, name, phone, last }) => {
            const open = isOpen(h);
            const owner = nameOf(h.assigned_user_id) ?? h.assigned_to;
            const mine = h.assigned_user_id === user.id;
            const waiting = open && !owner;
            return (
              <li key={h.id} className={`hcard${waiting ? " hcard-waiting" : ""}`}>
                <div className="hcard-top">
                  <div className="who-cell"><Avatar name={name || "?"} phone={!name} />
                    <div><Link href={`/dashboard/handoff/${h.id}`}><b>{name || `+${phone}`}</b></Link>{name && <span className="muted">+{phone}</span>}</div></div>
                  <Badge tone={!open ? "success" : owner ? "brand" : "warn"}>{!open ? "Resolved" : owner ? "Assigned" : "Waiting"}</Badge>
                </div>
                <div><span className="reason-chip" title={h.reason ?? SOURCE_LABELS[h.source]}>{SHORT_SOURCE_LABELS[h.source]}</span></div>
                <p className="hcard-summary">{clip(h.ai_summary || "No summary.", 180)}</p>
                <p className="hcard-last"><span className="muted">Customer said:</span> {last ? clip(last, 110) : "-"}</p>
                <div className="hcard-foot">
                  <span className="muted">
                    {open ? <><span className={waiting ? "since-hot" : undefined}>Waiting {ago(h.created_at).replace(" ago", "")}</span> · </> : <>Resolved {whenText(h.resolved_at)} · </>}
                    {owner ? (mine ? "Assigned to you" : `Assigned to ${owner}`) : "Unassigned"}
                  </span>
                  <div className="row" style={{ flexWrap: "nowrap", marginLeft: "auto" }}>
                    {waiting && (
                      <form action={queueTakeOver}><input type="hidden" name="id" value={h.id} /><input type="hidden" name="back" value={here} /><SubmitButton small pendingText="Taking over...">Take over</SubmitButton></form>
                    )}
                    <Link className={`btn btn-sm ${!open || waiting ? "btn-secondary" : "btn-primary"}`} href={`/dashboard/conversations/${h.conversation_id}`}>Open conversation</Link>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!error && <Pagination p={paged} label="Handoff requests" hrefFor={(n) => `/dashboard/handoff${buildQuery({ view: view === "open" ? null : view, q, page: n > 1 ? n : null })}`} />}
    </>
  );
}
