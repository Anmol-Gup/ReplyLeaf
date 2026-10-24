import { cookies } from "next/headers";
import { redirect } from "next/navigation";
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

/** The verified signed-in user (token checked with Supabase on every call), or a redirect to /login. */
export async function requireUser() {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) redirect("/login");
  const { data, error } = await anonClient().auth.getUser(token);
  if (error || !data.user) redirect("/login");
  return { user: data.user, token };
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
