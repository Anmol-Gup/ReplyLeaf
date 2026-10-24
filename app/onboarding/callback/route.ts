import { randomInt } from "node:crypto";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../../../lib/crypto";
import { env } from "../../../lib/env";
import { getUserOrNull } from "../../../lib/auth/session";
import { planOnboarding, STEP_REASONS, type ClientRow } from "../../../lib/onboarding-plan";
import { isApproved, signupMode } from "../../../lib/signup";
import { verifyState } from "../../../lib/onboarding-state";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { notifyOwner, raiseAlert } from "../../../lib/supabase-deps";
import {
  ASSUMED_TOKEN_LIFETIME_SECONDS, exchangeCodeForToken, OnboardingError, registerPhoneNumber,
  subscribeAppToWaba, verifyPhoneAccess,
} from "../../../lib/whatsapp/onboarding";

// ============================ TECH PROVIDER APPROVAL REQUIRED ============================
// This is the Embedded Signup v4 callback. Real customers can only complete it after
// Meta approves our app as a Tech Provider (App Review: advanced access to
// whatsapp_business_management and whatsapp_business_messaging). Until then it works
// only for people with a role on our own Meta app. The code is written and unit-tested
// but has NOT been run against Meta.
// =========================================================================================
//
// The flow is resumable. The client row is created FIRST, then each step records where
// it got to (clients.onboarding_step). A failure marks the row 'failed' with the step,
// and a retry (with a fresh popup code, because codes live ~30s and work once) resumes
// the SAME row, so a login can never end up with two clients. Rules (one client per
// login; a WABA or number belongs to exactly one client) live in lib/onboarding-plan.ts.
//
//   pending + step 'started'..'save'  = running (or crashed; resumable after 2 minutes)
//   pending + step 'complete'         = our steps are done; waiting for Meta's account_update
//   connected                         = account_update PARTNER_ADDED received
//   failed                            = a step failed or the token expired; owner can retry

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z.object({
  code: z.string().min(1).max(1000),
  wabaId: z.string().regex(/^\d{5,30}$/),
  phoneNumberId: z.string().regex(/^\d{5,30}$/),
  name: z.string().trim().min(1).max(100),
  state: z.string().max(200),
});

const fail = (status: number, error: string) => Response.json({ ok: false, error }, { status });
const COLUMNS = "id, onboarding_status, onboarding_step, onboarding_updated_at";

type Row = { id: string; onboarding_status: ClientRow["onboardingStatus"]; onboarding_step: string | null; onboarding_updated_at: string | null };
const toRow = (r: Row | null): ClientRow | null =>
  r ? { id: r.id, onboardingStatus: r.onboarding_status, onboardingStep: r.onboarding_step, updatedAt: r.onboarding_updated_at ? new Date(r.onboarding_updated_at) : null } : null;

export async function POST(req: Request) {
  // Must be a signed-in owner, and JSON only (a cross-site form post cannot send this).
  if (!req.headers.get("content-type")?.includes("application/json")) return fail(415, "Unsupported request.");
  const user = await getUserOrNull();
  if (!user) return fail(401, "Please sign in again.");

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "The setup information was incomplete. Please try again.");
  const b = parsed.data;
  if (!verifyState(b.state, user.id, env().WHATSAPP_APP_SECRET)) return fail(400, "This setup session expired. Please reload the page and try again.");

  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  if (!appId) return fail(503, "Self-service connection is not switched on yet.");
  const db = supabaseAdmin();
  const graphVersion = env().GRAPH_API_VERSION;
  const key = env().ENCRYPTION_KEY;

  // ---- 1. Decide what to do (create, resume, or refuse) BEFORE talking to Meta.
  const { data: link } = await db.from("client_users").select("client_id").eq("user_id", user.id).limit(1);
  // The page hides this for unapproved sign-ups, but the endpoint can be called directly.
  if (!isApproved(user, { mode: signupMode(), hasMembership: Boolean(link?.length) })) return fail(403, "Your account is waiting for approval.");
  const [mine, wabaOwner, phoneOwner] = await Promise.all([
    link?.[0] ? db.from("clients").select(COLUMNS).eq("id", link[0].client_id).single() : Promise.resolve({ data: null }),
    db.from("clients").select(COLUMNS).eq("wa_waba_id", b.wabaId).maybeSingle(),
    db.from("clients").select(COLUMNS).eq("wa_phone_number_id", b.phoneNumberId).maybeSingle(),
  ]);
  const plan = planOnboarding({ mine: toRow(mine.data as Row | null), wabaOwner: toRow(wabaOwner.data as Row | null), phoneOwner: toRow(phoneOwner.data as Row | null) });
  if (plan.action === "conflict") return fail(409, "This WhatsApp account is already connected to a different business.");
  if (plan.action === "already_connected") return fail(409, "Your account is already connected to a business.");
  if (plan.action === "in_progress") return fail(409, "A connection is already in progress. Please wait a minute and check your dashboard.");

  // ---- 2. Create the client row first (or reuse the failed one), so every failure has somewhere to be recorded.
  const now = () => new Date().toISOString();
  const fields = {
    name: b.name, wa_phone_number_id: b.phoneNumberId, wa_waba_id: b.wabaId,
    status: "paused", onboarding_status: "pending", onboarding_step: "started", onboarding_updated_at: now(),
  };
  let clientId: string;
  if (plan.action === "resume") {
    clientId = plan.clientId;
    const { error } = await db.from("clients").update(fields).eq("id", clientId);
    if (error) return fail(error.code === "23505" ? 409 : 500, error.code === "23505" ? "This WhatsApp account is already connected." : "Could not start the connection. Please try again.");
  } else {
    const { data: created, error } = await db.from("clients").insert({ ...fields, owner_email: user.email ?? null }).select("id").single();
    if (error || !created) return fail(error?.code === "23505" ? 409 : 500, error?.code === "23505" ? "This WhatsApp account is already connected." : "Could not start the connection. Please try again.");
    clientId = created.id;
    const { error: linkErr } = await db.from("client_users").insert({ client_id: clientId, user_id: user.id, role: "owner" });
    if (linkErr) {
      await db.from("clients").delete().eq("id", clientId);
      return fail(500, "Could not start the connection. Please try again.");
    }
  }

  const step = async (name: string) => { await db.from("clients").update({ onboarding_step: name, onboarding_updated_at: now() }).eq("id", clientId); };
  let current = "token_exchange";
  try {
    // ---- 3. code -> business token (the code lives ~30 seconds, so this comes first)
    await step(current);
    const issued = await exchangeCodeForToken({ graphVersion, appId, appSecret: env().WHATSAPP_APP_SECRET, code: b.code });
    const token = issued.token;
    const expiryAssumed = issued.expiresInSeconds === undefined; // DOCS UNCLEAR: see exchangeCodeForToken
    const expiresAt = new Date(Date.now() + (issued.expiresInSeconds ?? ASSUMED_TOKEN_LIFETIME_SECONDS) * 1000);

    // ---- 4. the token must be able to reach this number, or the client is claiming someone else's
    current = "phone_access"; await step(current);
    await verifyPhoneAccess({ graphVersion, token, phoneNumberId: b.phoneNumberId });

    // ---- 5. send this customer's webhooks to us
    current = "subscribe"; await step(current);
    await subscribeAppToWaba({ graphVersion, token, wabaId: b.wabaId });

    // ---- 6. register the number. Reuse the PIN from an earlier attempt: re-registering with a
    //         different PIN could be refused. A failure here is not fatal (the number may already
    //         be registered), so keep going and tell the admin.
    current = "register"; await step(current);
    const { data: existingSecret } = await db.from("client_secrets").select("wa_pin_enc").eq("client_id", clientId).maybeSingle();
    const pin = existingSecret?.wa_pin_enc ? decryptSecret(existingSecret.wa_pin_enc, key) : String(randomInt(100000, 1000000));
    try {
      await registerPhoneNumber({ graphVersion, token, phoneNumberId: b.phoneNumberId, pin });
    } catch (e) {
      await raiseAlert(clientId, "onboarding_register_failed", e instanceof Error ? e.message : "register failed").catch(() => {});
    }

    // ---- 7. store the encrypted token (with its expiry) and PIN. Never logged, never sent to the browser.
    current = "save"; await step(current);
    const { error: secretErr } = await db.from("client_secrets").upsert({
      client_id: clientId, wa_access_token_enc: encryptSecret(token, key), wa_pin_enc: encryptSecret(pin, key),
      wa_token_expires_at: expiresAt.toISOString(), wa_token_expiry_assumed: expiryAssumed,
    }, { onConflict: "client_id" });
    if (secretErr) throw new Error("saving secrets failed"); // recorded under step 'save' by the catch below

    // ---- 8. go live. Meta's account_update may already have arrived (it can beat us here).
    const { count } = await db.from("whatsapp_account_events").select("id", { count: "exact", head: true })
      .eq("waba_id", b.wabaId).eq("event", "PARTNER_ADDED");
    await db.from("clients").update({
      status: "active", onboarding_status: count ? "connected" : "pending", onboarding_step: "complete", onboarding_updated_at: now(),
    }).eq("id", clientId);
  } catch (e) {
    // Record WHICH step failed. The owner sees a plain-language reason and a Retry; the admin gets the detail.
    await db.from("clients").update({ onboarding_status: "failed", onboarding_step: current, onboarding_updated_at: now() }).eq("id", clientId);
    console.error("onboarding failed at", current); // never the error body: it could carry request details
    await raiseAlert(clientId, "onboarding_failed", `step=${current} ${e instanceof Error ? e.message.slice(0, 300) : ""}`).catch(() => {});
    return fail(502, STEP_REASONS[current] ?? "WhatsApp could not complete the connection. Please try again.");
  }

  // ---- 9. tell the owner, and the admin.
  await notifyOwner(clientId, { type: "onboarded", businessName: b.name }).catch((e) => console.warn("onboarding email failed", e instanceof Error ? e.message : e));
  await raiseAlert(clientId, "client_onboarded", `Connected ${b.name}`).catch(() => {});
  return Response.json({ ok: true });
}
