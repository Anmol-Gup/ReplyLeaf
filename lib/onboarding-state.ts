import { createHmac } from "node:crypto";
import { safeEqual } from "./whatsapp/signature";

// Stateless CSRF token for the onboarding flow: HMAC(userId, timestamp), valid
// for 30 minutes and bound to the signed-in user, so a callback request can't be
// forged by another site or replayed for a different account.
export function makeState(userId: string, secret: string, nowMs = Date.now()): string {
  const ts = Math.floor(nowMs / 1000);
  return `${ts}.${mac(userId, ts, secret)}`;
}

export function verifyState(state: string, userId: string, secret: string, nowMs = Date.now(), maxAgeSec = 1800): boolean {
  const [tsRaw, given] = state.split(".");
  const ts = Number(tsRaw);
  if (!Number.isInteger(ts) || !given) return false;
  const age = nowMs / 1000 - ts;
  if (age < 0 || age > maxAgeSec) return false;
  return safeEqual(given, mac(userId, ts, secret));
}

const mac = (userId: string, ts: number, secret: string) =>
  createHmac("sha256", secret).update(`onboarding.${userId}.${ts}`).digest("base64url");
