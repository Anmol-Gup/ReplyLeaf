import { Alert, Badge, Card, EmptyState, ErrorState, PageHeader } from "../../../../components/ui";
import Pagination from "../../../../components/Pagination";
import SubmitButton from "../../../../components/SubmitButton";
import { classifySignups, type AuthUserRow } from "../../../../lib/admin-signups";
import { requireAdmin } from "../../../../lib/auth/session";
import { fmtDay, fmtTime } from "../../../../lib/dashboard";
import { buildQuery, paginate } from "../../../../lib/paginate";
import { supabaseAdmin } from "../../../../lib/supabase-admin";
import { approveSignup, rejectSignup } from "../../actions";

const NOTICES: Record<string, { kind: "ok" | "warn" | "error"; text: string }> = {
  approved: { kind: "ok", text: "Approved. We emailed them to let them know." },
  approved_no_email: { kind: "warn", text: "Approved, but the email could not be sent (check the Gmail settings). Tell them yourself." },
  rejected: { kind: "ok", text: "Rejected and deleted." },
  not_verified: { kind: "warn", text: "They have not verified their email yet, so they cannot sign in. Approve them after they verify." },
  not_found: { kind: "error", text: "That account no longer exists." },
  has_business: { kind: "error", text: "That person already has a business, so it can't be deleted from here." },
  invalid: { kind: "error", text: "Tick the confirmation box to reject someone." },
  failed: { kind: "error", text: "Something went wrong. Nothing was changed." },
};

async function loadUsers(): Promise<{ users: AuthUserRow[]; linked: string[] }> {
  const db = supabaseAdmin();
  const users: AuthUserRow[] = [];
  for (let page = 1; page <= 25; page++) { // up to 5,000 accounts
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    users.push(...(data.users as AuthUserRow[]));
    if (data.users.length < 200) break;
  }
  const { data: links } = await db.from("client_users").select("user_id");
  return { users, linked: (links ?? []).map((l) => l.user_id as string) };
}

export default async function AdminSignups({ searchParams }: { searchParams: Promise<{ notice?: string; wp?: string; ap?: string }> }) {
  await requireAdmin(); // layouts do not re-run on every navigation, so check again here
  const { notice, wp: wpRaw, ap: apRaw } = await searchParams;
  const n = notice ? NOTICES[notice] : undefined;

  let data: ReturnType<typeof classifySignups> | null = null;
  try {
    const { users, linked } = await loadUsers();
    data = classifySignups(users, linked, Number.MAX_SAFE_INTEGER); // every approved sign-up; the page paginates
  } catch (e) {
    console.error("admin sign-up list failed", e instanceof Error ? e.message : e);
  }

  const waiting = paginate(data?.waiting ?? [], wpRaw, 10);
  const approved = paginate(data?.approved ?? [], apRaw, 10);
  // Moving through one list keeps the other list on its current page.
  const href = (w: number, a: number) => `/admin/signups${buildQuery({ wp: w > 1 ? w : null, ap: a > 1 ? a : null })}`;

  return (
    <>
      <PageHeader title="Sign-ups" description="People who created an account. Approve a verified person to let them use the dashboard and connect WhatsApp." />
      {n && <Alert kind={n.kind}>{n.text}</Alert>}
      {!data ? <ErrorState>The sign-up list could not be loaded.</ErrorState> : (
        <>
          <Card title={`Waiting for approval (${data.waiting.length})`}>
            {data.waiting.length === 0 ? (
              <EmptyState icon="check" title="Nobody is waiting">New sign-ups appear here once they have verified their email.</EmptyState>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Business</th><th>Email</th><th>Signed up</th><th>Email</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {waiting.items.map((u) => (
                      <tr key={u.id}>
                        <td>{u.business}</td>
                        <td>{u.email}</td>
                        <td>{fmtDay(u.createdAt)} {fmtTime(u.createdAt)}</td>
                        <td>{u.verified ? <Badge tone="success">Verified</Badge> : <Badge tone="warn">Not verified yet</Badge>}</td>
                        <td>
                          <div className="row">
                            <form action={approveSignup}>
                              <input type="hidden" name="id" value={u.id} />
                              <SubmitButton small disabled={!u.verified} pendingText="Approving...">Approve</SubmitButton>
                            </form>
                            <form action={rejectSignup} className="row">
                              <input type="hidden" name="id" value={u.id} />
                              <label className="check"><input type="checkbox" name="confirm" value="yes" required aria-label={`Confirm rejecting ${u.email}`} /> <small>Sure?</small></label>
                              <SubmitButton small variant="secondary" pendingText="Rejecting...">Reject</SubmitButton>
                            </form>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pagination p={waiting} label="Waiting for approval" hrefFor={(n) => href(n, approved.page)} />
          </Card>

          <Card title="Approved sign-ups" description="Rejecting deletes the account permanently, so it is only offered for people still waiting.">
            {data.approved.length === 0 ? <EmptyState icon="users" title="No approved sign-ups yet" /> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Business</th><th>Email</th><th>Signed up</th><th>Status</th></tr></thead>
                  <tbody>
                    {approved.items.map((u) => (
                      <tr key={u.id}>
                        <td>{u.business}</td><td>{u.email}</td><td>{fmtDay(u.createdAt)}</td>
                        <td>{u.hasBusiness ? <Badge tone="success">Has a business</Badge> : <Badge tone="brand">Approved, not connected yet</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pagination p={approved} label="Approved sign-ups" hrefFor={(n) => href(waiting.page, n)} />
          </Card>
        </>
      )}
    </>
  );
}
