import { after } from "next/server";
import { notifyClosedWhilePaused, runBatches } from "../../../../lib/batch";
import { env } from "../../../../lib/env";
import { recordEvents } from "../../../../lib/inbound";
import { supabaseBatchDeps } from "../../../../lib/supabase-batch";
import { supabaseInboundDeps } from "../../../../lib/supabase-deps";
import { parseWebhookPayload } from "../../../../lib/whatsapp/payload";
import { safeEqual, verifySignature } from "../../../../lib/whatsapp/signature";

export const runtime = "nodejs"; // we need node:crypto
export const dynamic = "force-dynamic";
// after() work shares this limit on Vercel: batch wait (~5s) + model call (<=25s x2 attempts).
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

  // 1) Store the messages BEFORE answering Meta. This is a quick DB-only step;
  //    if it fails we return 500 so Meta retries, and the unique wamid dedupes.
  const { conversationIds, pausedConversationIds = [], failed } = await recordEvents(events, supabaseInboundDeps());

  // 2) Answer 200 right away and do the slow work (wait for the batch window,
  //    call the model, send the reply) with after(). On Vercel after() is backed
  //    by waitUntil, so the function stays alive until it finishes (maxDuration).
  //    The same call also sweeps stranded batches, so every webhook (even a mere
  //    delivery status) helps recover work a crashed worker left behind.
  after(async () => {
    const deps = supabaseBatchDeps();
    await Promise.all([runBatches(conversationIds, deps), ...pausedConversationIds.map((id) => notifyClosedWhilePaused(id, deps))]);
  });

  return failed > 0 ? new Response("Temporary error", { status: 500 }) : new Response("ok", { status: 200 });
}
