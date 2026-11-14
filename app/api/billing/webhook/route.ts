import { billingDeps } from "../../../../lib/billing/supabase-billing";
import { handleStripeEvent, type StripeEvent } from "../../../../lib/billing/service";
import { verifyStripeSignature } from "../../../../lib/billing/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/billing/webhook: Stripe's events. Register this URL in the Stripe Dashboard (see the README).
// 1) The signature is verified over the RAW body before anything is parsed. 2) Each event id is processed once.
// 3) A processing failure answers 500 so Stripe retries; duplicates and ignored events answer 200.
export async function POST(req: Request) {
  const raw = await req.text(); // the exact bytes Stripe signed: never re-serialised JSON
  if (!verifyStripeSignature(raw, req.headers.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET)) {
    return new Response("invalid signature", { status: 400 });
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(raw) as StripeEvent;
    if (typeof event.id !== "string" || typeof event.type !== "string" || typeof event.created !== "number" || !event.data?.object) throw new Error("shape");
  } catch {
    return new Response("bad payload", { status: 400 });
  }
  try {
    const outcome = await handleStripeEvent(event, billingDeps());
    return Response.json({ received: true, outcome });
  } catch (e) {
    console.error("stripe event failed", event.type, e instanceof Error ? e.message : "error"); // no payload, no secrets
    return new Response("processing failed", { status: 500 });
  }
}
