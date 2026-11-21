import Link from "next/link";
import MultiSelectFilter from "../../../components/MultiSelectFilter";
import BulkDelete from "../../../components/BulkDelete";
import Pagination from "../../../components/Pagination";
import { Badge, EmptyState, ErrorState, PageHeader, SearchBox, type Tone } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import { fmtDay, matches } from "../../../lib/dashboard";
import { effectiveSelection } from "../../../lib/filters";
import { buildQuery, paginate } from "../../../lib/paginate";
import Notice from "../Notice";
import { bulkDeleteContacts } from "../actions";

const STATUS_TONE: Record<string, Tone> = { new: "muted", lead: "brand", customer: "success", lost: "danger" };
const CONTACT_STATUSES = ["new", "lead", "customer", "lost"] as const;
const CONTACT_LABELS: Record<string, string> = { new: "New", lead: "Lead", customer: "Customer", lost: "Lost" };

export default async function Contacts({ searchParams }: { searchParams: Promise<{ notice?: string; q?: string; status?: string | string[]; page?: string }> }) {
  const { notice, q, status: statusRaw, page: pageRaw } = await searchParams;
  const { selected: statuses, explicit } = effectiveSelection(statusRaw, CONTACT_STATUSES, []); // nothing chosen = every status
  const { db } = await requireClient();
  const { data, error } = await db.from("contacts")
    .select("id, name, phone, email, status, tags, suggested, created_at")
    .eq("spoke", true) // someone who has only sent a photo or a voice note is listed once they type something
    .order("created_at", { ascending: false }).limit(500);
  const everyone = data ?? [];
  const options = CONTACT_STATUSES.map((s) => ({ value: s as string, label: CONTACT_LABELS[s], count: everyone.filter((c) => c.status === s).length }));
  const matching = everyone.filter((c) => (statuses.length === 0 || statuses.includes(c.status)) && matches(q, c.name, c.phone, c.email, c.status, (c.tags as string[]).join(" ")));
  const paged = paginate(matching, pageRaw, 25);
  const rows = paged.items;

  return (
    <>
      <PageHeader title="Contacts" description="Everyone who has sent a text message to your WhatsApp number." />
      <Notice code={notice} />
      <div className="filters">
        <MultiSelectFilter action="/dashboard/contacts" options={options} selected={statuses} hidden={{ q }} />
        <SearchBox q={q} placeholder="Search by name, phone, email, status or tag" keep={{ status: explicit ? statuses : [] }} />
      </div>
      {error ? <ErrorState>Your contacts could not be loaded.</ErrorState> : (
        <BulkDelete action={bulkDeleteContacts} noun="contact">
        <div className="table-wrap">
          <table>
            <thead><tr><th className="check-col"><input type="checkbox" data-all aria-label="Select all" /></th><th>Name</th><th>Phone</th><th>Email</th><th>Status</th><th>Tags</th><th>Added</th><th></th></tr></thead>
            <tbody>
              {rows.map((c) => {
                const pending = Object.keys((c.suggested as object) ?? {}).length;
                return (
                  <tr key={c.id}>
                    <td className="check-col"><input type="checkbox" name="ids" value={c.id} aria-label="Select row" /></td>
                    <td>
                      <Link href={`/dashboard/contacts/${c.id}`}>{c.name || "(no name)"}</Link>
                      {pending > 0 && <> <Badge tone="warn">{pending} suggestion{pending > 1 ? "s" : ""}</Badge></>}
                    </td>
                    <td>+{c.phone}</td>
                    <td>{c.email ?? "-"}</td>
                    <td><Badge tone={STATUS_TONE[c.status] ?? "muted"}>{c.status}</Badge></td>
                    <td>{(c.tags as string[]).join(", ") || "-"}</td>
                    <td>{fmtDay(c.created_at)}</td>
                    <td><Link className="btn btn-secondary btn-sm" href={`/dashboard/contacts/${c.id}#edit`}>Edit</Link></td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={8}>
                  {q || explicit
                    ? <EmptyState icon="search" title="No matching contacts" action={{ href: "/dashboard/contacts", label: "Clear search" }}>Nothing matches &quot;{q}&quot;.</EmptyState>
                    : <EmptyState icon="users" title="No contacts yet">People are added automatically when they message you.</EmptyState>}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        </BulkDelete>
      )}
      {!error && <Pagination p={paged} label="Contacts" hrefFor={(n) => `/dashboard/contacts${buildQuery({ status: explicit ? statuses : [], q, page: n > 1 ? n : null })}`} />}
    </>
  );
}
