// The email to show the owner for a customer: the one the owner confirmed on the contact, else the one the customer gave in chat.
// Read on its own so that a database that has not had the migration adding `notify_email` yet just shows fewer emails
// instead of failing the whole page.
type Db = { from: (table: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export const bestEmail = (c: { email?: string | null; notify_email?: string | null } | null | undefined): string | null =>
  (c?.email?.trim() || c?.notify_email?.trim() || null);

/** contact id -> best email, for the given contacts. Never throws. */
export async function emailsByContact(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (list.length === 0) return out;
  try {
    const { data, error } = await db.from("contacts").select("id, email, notify_email").in("id", list);
    if (!error) for (const c of (data ?? []) as { id: string; email: string | null; notify_email: string | null }[]) { const e = bestEmail(c); if (e) out.set(c.id, e); }
    else {
      const basic = await db.from("contacts").select("id, email").in("id", list); // the older shape
      for (const c of (basic.data ?? []) as { id: string; email: string | null }[]) { const e = bestEmail(c); if (e) out.set(c.id, e); }
    }
  } catch { /* show no emails rather than fail the page */ }
  return out;
}
