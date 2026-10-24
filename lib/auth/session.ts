import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { hasApprovedFlag, isApproved, signupMode } from "../signup";
import { ACCESS_COOKIE, REFRESH_COOKIE, REFRESH_MAX_AGE, anonClient, cookieOptions } from "./anon";

export async function setSessionCookies(s: { access_token: string; refresh_token: string; expires_in: number }) {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, s.access_token, cookieOptions(s.expires_in));
  jar.set(REFRESH_COOKIE, s.refresh_token, cookieOptions(REFRESH_MAX_AGE));
}

export async function clearSessionCookies() {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}

/** The verified signed-in user (token checked with Supabase on every call), or a redirect to /login. Approval is NOT checked. */
export async function requireVerifiedUser() {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) redirect("/login");
  const { data, error } = await anonClient().auth.getUser(token);
  if (error || !data.user) redirect("/login");
  return { user: data.user, token };
}

/** Approved if the admin approved them, they already belong to a business, or sign-up is open. */
export async function userIsApproved(user: { app_metadata?: Record<string, unknown> | null }, token: string): Promise<boolean> {
  const mode = signupMode();
  if (mode === "open" || hasApprovedFlag(user)) return true; // no query needed
  const { data } = await anonClient(token).from("client_users").select("client_id").limit(1);
  return isApproved(user, { mode, hasMembership: Boolean(data?.length) });
}

/** The verified user AND approved: unapproved sign-ups are sent to the waiting page. */
export async function requireUser() {
  const session = await requireVerifiedUser();
  if (!(await userIsApproved(session.user, session.token))) redirect("/pending");
  return session;
}

/**
 * The platform admin (you). `is_admin` lives in app_metadata, which users cannot edit;
 * grant it with `npm run make-admin -- you@example.com`. Everyone else gets a 404, so the
 * admin pages don't even reveal that they exist.
 */
export async function requireAdmin() {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) redirect("/admin/login");
  const { data, error } = await anonClient().auth.getUser(token);
  if (error || !data.user) redirect("/admin/login");
  if (data.user.app_metadata?.is_admin !== true) notFound();
  return data.user;
}

/**
 * The signed-in owner plus THEIR client. clientId comes from the membership
 * table read under RLS, never from form input or the URL. `db` carries the
 * owner's JWT (RLS applies). Writes in server actions use supabaseAdmin() and
 * must always filter by this clientId.
 */
export async function requireClient() {
  const { user, token } = await requireUser();
  const db = anonClient(token);
  const { data, error } = await db.from("client_users").select("client_id").limit(1);
  if (error) throw new Error(`membership lookup failed: ${error.message}`);
  const clientId = data?.[0]?.client_id as string | undefined;
  if (!clientId) redirect("/onboarding"); // signed in but not linked to a business yet
  const { data: client } = await db.from("clients").select("name").eq("id", clientId).single();
  return { user, db, clientId, clientName: (client?.name as string | undefined) ?? "Your business" };
}

/** For route handlers (no redirects): the verified user, or null. */
export async function getUserOrNull() {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) return null;
  const { data, error } = await anonClient().auth.getUser(token);
  return error || !data.user ? null : data.user;
}
