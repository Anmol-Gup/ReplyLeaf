import { getMailer } from "./email/mailer";
import { assignedEmail } from "./email/templates";
import { findMemberByEmail } from "./team";

// "Assign to" by typing an email (yourself or anyone else). Shared by tickets and appointments.
export type Assignee = { email: string | null; memberId: string | null; self: boolean };

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

/** An empty box means unassigned. A member's email (including yours) maps to that member; any other valid email is just recorded. */
export async function resolveAssignee(clientId: string, me: { id: string; email?: string | null }, raw: unknown): Promise<Assignee | null> {
  const email = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().toLowerCase();
  if (!email) return { email: null, memberId: null, self: false };
  if (email.length > 200 || !EMAIL.test(email)) return null;
  if (email === me.email?.toLowerCase()) return { email, memberId: me.id, self: true };
  return { email, memberId: await findMemberByEmail(clientId, email), self: false };
}

/** Email the new assignee. Never throws: a failed email must not undo the assignment. Returns false when it could not be sent. */
export async function emailAssignee(a: Assignee, m: { kind: "ticket" | "appointment" | "handoff"; title: string; ref?: string; customerName: string | null; phone: string; detailLabel: string; detail: string; path: string; assignedBy: string; businessName: string }): Promise<boolean> {
  if (!a.email || a.self) return true;
  const mailer = getMailer();
  if (!mailer) return false;
  try {
    await mailer.send(assignedEmail({ to: a.email, appUrl: process.env.APP_URL, ...m }));
    return true;
  } catch { return false; }
}
