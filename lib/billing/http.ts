import { makeLimiter } from "../rate-limit";

// Shared guards for the billing endpoints.

/** A browser POST must come from our own site. Requests without an Origin must not be marked cross-site by the browser. */
export function sameOrigin(req: Request, appUrl: string | undefined = process.env.APP_URL): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const o = new URL(origin).origin;
      if (appUrl && o === new URL(appUrl).origin) return true;
      return o === new URL(req.url).origin;
    } catch {
      return false;
    }
  }
  return req.headers.get("sec-fetch-site") !== "cross-site";
}

export const isJson = (req: Request) => (req.headers.get("content-type") ?? "").includes("application/json");

/** Common POST checks. Returns an error Response, or null when the request may continue. */
export function checkPost(req: Request): Response | null {
  if (!isJson(req)) return Response.json({ error: "unsupported" }, { status: 415 });
  if (!sameOrigin(req)) return Response.json({ error: "forbidden" }, { status: 403 });
  return null;
}

// 10 billing actions a minute per business is far more than a person needs.
export const billingLimiter = makeLimiter(10, 60_000);
