import Link from "next/link";
import Pagination from "../../../components/Pagination";
import { Badge, EmptyState, ErrorState, PageHeader, SearchBox, type Tone } from "../../../components/ui";
import { requireClient } from "../../../lib/auth/session";
import { fmtDay, matches } from "../../../lib/dashboard";
import { buildQuery, paginate } from "../../../lib/paginate";
import Notice from "../Notice";

const STATUS_TONE: Record<string, Tone> = { new: "muted", lead: "brand", customer: "success", lost: "danger" };

export default async function Contacts({ searchParams }: { searchParams: Promise<{ notice?: string; q?: string; page?: string }> }) {
  const { notice, q, page: pageRaw } = await searchParams;
  const { db } = await requireClient();
  const { data, error } = await db.from("contacts")
    .select("id, name, phone, email, status, tags, suggested, created_at")
    .order("created_at", { ascending: false }).limit(500);
  const matching = (data ?? []).filter((c) => matches(q, c.name, c.phone, c.email, c.status, (c.tags as string[]).join(" ")));
  const paged = paginate(matching, pageRaw, 25);
  const rows = paged.items;

  return (
    <>
      <PageHeader title="Contacts" description="Everyone who has messaged your WhatsApp number." />
      <Notice code={notice} />
      <SearchBox q={q} placeholder="Search by name, phone, email, status or tag" />
      {error ? <ErrorState>Your contacts could not be loaded.</ErrorState> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Status</th><th>Tags</th><th>Added</th></tr></thead>
            <tbody>
              {rows.map((c) => {
                const pending = Object.keys((c.suggested as object) ?? {}).length;
                return (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/dashboard/contacts/${c.id}`}>{c.name || "(no name)"}</Link>
                      {pending > 0 && <> <Badge tone="warn">{pending} suggestion{pending > 1 ? "s" : ""}</Badge></>}
                    </td>
                    <td>+{c.phone}</td>
                    <td>{c.email ?? "-"}</td>
                    <td><Badge tone={STATUS_TONE[c.status] ?? "muted"}>{c.status}</Badge></td>
                    <td>{(c.tags as string[]).join(", ") || "-"}</td>
                    <td>{fmtDay(c.created_at)}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={6}>
                  {q
                    ? <EmptyState icon="search" title="No matching contacts" action={{ href: "/dashboard/contacts", label: "Clear search" }}>Nothing matches &quot;{q}&quot;.</EmptyState>
                    : <EmptyState icon="users" title="No contacts yet">People are added automatically when they message you.</EmptyState>}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {!error && <Pagination p={paged} label="Contacts" hrefFor={(n) => `/dashboard/contacts${buildQuery({ q, page: n > 1 ? n : null })}`} />}
    </>
  );
}
