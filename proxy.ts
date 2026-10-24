import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, REFRESH_COOKIE, REFRESH_MAX_AGE, anonClient, cookieOptions, jwtExp } from "./lib/auth/anon";

// Keeps the dashboard session fresh. Server Components cannot set cookies, so
// the refresh happens here, before the page renders. This is NOT the security
// check: pages and server actions verify the user themselves (requireUser).
export async function proxy(request: NextRequest) {
  const inAdmin = request.nextUrl.pathname.startsWith("/admin");
  if (request.nextUrl.pathname === "/admin/login") return NextResponse.next(); // the admin sign-in page itself
  const access = request.cookies.get(ACCESS_COOKIE)?.value;
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
  const secondsLeft = access ? jwtExp(access) - Date.now() / 1000 : 0;
  if (access && secondsLeft > 60) return NextResponse.next();

  const toLogin = () => {
    // Remember where they were going, so signing in brings them straight back (e.g. the link in an email).
    const login = new URL(inAdmin ? "/admin/login" : "/login", request.url);
    if (request.method === "GET") login.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
    const res = NextResponse.redirect(login);
    res.cookies.delete(ACCESS_COOKIE);
    res.cookies.delete(REFRESH_COOKIE);
    return res;
  };
  if (!refresh) return toLogin();

  const { data, error } = await anonClient().auth.refreshSession({ refresh_token: refresh });
  if (error || !data.session) return toLogin();

  // Update the request too, so this same render already sees the new token.
  request.cookies.set(ACCESS_COOKIE, data.session.access_token);
  request.cookies.set(REFRESH_COOKIE, data.session.refresh_token);
  const res = NextResponse.next({ request });
  res.cookies.set(ACCESS_COOKIE, data.session.access_token, cookieOptions(data.session.expires_in));
  res.cookies.set(REFRESH_COOKIE, data.session.refresh_token, cookieOptions(REFRESH_MAX_AGE));
  return res;
}

export const config = { matcher: ["/dashboard/:path*", "/onboarding/:path*", "/pending", "/admin/:path*"] };
