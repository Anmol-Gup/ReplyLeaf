import { after } from "next/server";
import { env } from "../../../../lib/env";
import { processEvents } from "../../../../lib/inbound";
import { supabaseDeps } from "../../../../lib/supabase-deps";
import { parseWebhookPayload } from "../../../../lib/whatsapp/payload";
import { safeEqual, verifySignature } from "../../../../lib/whatsapp/signature";

export const runtime = "nodejs"; // we need node:crypto
export const dynamic = "force-dynamic";
// after() work shares this limit on Vercel. Stage 2 (AI replies) needs headroom.
export const maxDuration = 60;

// GET: Meta's one-time verification handshake when you save the webhook URL.
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (
    params.get("hub.mode") === "subscribe" &&
    token && challenge &&
    safeEqual(token, env().WHATSAPP_VERIFY_TOKEN)
  ) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

// POST: incoming messages and delivery statuses.
export async function POST(req: Request) {
  // Read the RAW bytes: the signature is over exactly these bytes.
  const raw = new Uint8Array(await req.arrayBuffer());
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), env().WHATSAPP_APP_SECRET)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const events = parseWebhookPayload(json);

  // Return 200 right away (Meta retries on slow/non-200 responses) and do the
  // real work with after(), which on Vercel keeps the function alive via
  // waitUntil until the callback finishes (up to maxDuration).
  after(() => processEvents(events, supabaseDeps()));

  return new Response("ok", { status: 200 });
}
