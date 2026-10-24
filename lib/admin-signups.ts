// Sorts platform users into "waiting for approval" and "approved sign-ups" for the
// admin page. Pure, so the rules are unit-tested.

export type AuthUserRow = {
  id: string;
  email?: string | null;
  created_at?: string | null;
  email_confirmed_at?: string | null;
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
};

export type SignupRow = {
  id: string;
  email: string;
  business: string;
  createdAt: string;
  verified: boolean;
  hasBusiness: boolean;
};

const toRow = (u: AuthUserRow, linked: Set<string>): SignupRow => ({
  id: u.id,
  email: u.email ?? "(no email)",
  business: String(u.user_metadata?.business_name ?? "").slice(0, 100) || "(not given)",
  createdAt: u.created_at ?? "",
  verified: Boolean(u.email_confirmed_at),
  hasBusiness: linked.has(u.id),
});

const newestFirst = (a: SignupRow, b: SignupRow) => b.createdAt.localeCompare(a.createdAt);

export function classifySignups(users: AuthUserRow[], linkedUserIds: string[], approvedLimit = 20) {
  const linked = new Set(linkedUserIds);
  const waiting: SignupRow[] = [];
  const approved: SignupRow[] = [];

  for (const u of users) {
    if (u.app_metadata?.is_admin === true) continue; // admins are not sign-ups
    const isApproved = u.app_metadata?.approved === true || linked.has(u.id);
    (isApproved ? approved : waiting).push(toRow(u, linked));
  }
  // Verified people first: they are the ones who can actually be approved and use it.
  waiting.sort((a, b) => Number(b.verified) - Number(a.verified) || newestFirst(a, b));
  approved.sort(newestFirst);
  return { waiting, approved: approved.slice(0, approvedLimit) };
}
