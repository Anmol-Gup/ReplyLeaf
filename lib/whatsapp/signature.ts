import { createHmac, timingSafeEqual } from "node:crypto";

// Meta signs the exact bytes of the POST body with the app secret and sends
// "sha256=<hex>" in X-Hub-Signature-256. We must hash the RAW bytes, not a
// re-serialised JSON object, or the signature will not match.
export function verifySignature(
  rawBody: Uint8Array,
  header: string | null,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const received = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  // timingSafeEqual throws on length mismatch, so check length first.
  return received.length === expected.length && timingSafeEqual(received, expected);
}

// Constant-time string comparison for the GET verify token.
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
