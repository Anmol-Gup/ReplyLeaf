import { safeEqual } from "./whatsapp/signature";

// Vercel sends "Authorization: Bearer $CRON_SECRET" to cron routes. Without a
// configured secret the routes refuse everything.
export function isCronAuthorized(req: Request, secret = process.env.CRON_SECRET): boolean {
  if (!secret || secret.length < 16) return false;
  return safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`);
}
