import { randomInt } from "node:crypto";
import { z } from "zod";
import { encryptSecret } from "../../../lib/crypto";
import { env } from "../../../lib/env";
import { getUserOrNull } from "../../../lib/auth/session";
import { verifyState } from "../../../lib/onboarding-state";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { raiseAlert } from "../../../lib/supabase-deps";
import {
  exchangeCodeForToken, OnboardingError, registerPhoneNumber, subscribeAppToWaba, verifyPhoneAccess,
} from "../../../lib/whatsapp/onboarding";

// ============================ TECH PROVIDER APPROVAL REQUIRED ============================
// This is the Embedded Signup v4 callback. Real customers can only complete it after
// Meta approves our app as a Tech Provider (App Review: advanced access to
// whatsapp_business_management and whatsapp_business_messaging). Until then it works
// only for people with a role on our own Meta app. The code is written and ready, but
// it has not been run against Meta.
// =========================================================================================

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

  // One business per login for now, and one connection per phone number.
  const { data: existing } = await db.from("client_users").select("client_id").eq("user_id", user.id).limit(1);
  if (existing?.length) return fail(409, "Your account is already connected to a business.");
  const { data: taken } = await db.from("clients").select("id").eq("wa_phone_number_id", b.phoneNumberId).maybeSingle();
  if (taken) return fail(409, "This WhatsApp number is already connected.");

  let token: string;
  const pin = String(randomInt(100000, 1000000));
  try {
    // 1. code -> business token (the code lives ~30 seconds, so this happens first)
    token = await exchangeCodeForToken({ graphVersion, appId, appSecret: env().WHATSAPP_APP_SECRET, code: b.code });
    // 2. the token must be able to reach this number, or the client is claiming someone else's
    await verifyPhoneAccess({ graphVersion, token, phoneNumberId: b.phoneNumberId });
    // 3. send this customer's webhooks to us
    await subscribeAppToWaba({ graphVersion, token, wabaId: b.wabaId });
  } catch (e) {
    const step = e instanceof OnboardingError ? e.step : "unknown";
    console.error("onboarding failed at", step); // detail goes to the admin alert, never the browser
    await raiseAlert(null, "onboarding_failed", `step=${step} ${e instanceof Error ? e.message : ""}`).catch(() => {});
    return fail(502, "WhatsApp could not complete the connection. Please try again, or contact support.");
  }

  // 4. register the number. If this step fails the connection can still work (the number
  //    may already be registered), so keep going and tell the admin.
  let registered = true;
  try {
    await registerPhoneNumber({ graphVersion, token, phoneNumberId: b.phoneNumberId, pin });
  } catch (e) {
    registered = false;
    await raiseAlert(null, "onboarding_register_failed", e instanceof Error ? e.message : "register failed").catch(() => {});
  }

  // 5. create the client, store the encrypted secrets, link the owner. Undo on failure.
  const { data: client, error } = await db.from("clients")
    .insert({ name: b.name, wa_phone_number_id: b.phoneNumberId, wa_waba_id: b.wabaId, owner_email: user.email ?? null })
    .select("id").single();
  if (error || !client) return fail(500, "Could not save your connection. Please try again.");

  const key = env().ENCRYPTION_KEY;
  const { error: secretErr } = await db.from("client_secrets").insert({
    client_id: client.id, wa_access_token_enc: encryptSecret(token, key), wa_pin_enc: encryptSecret(pin, key),
  });
  const { error: linkErr } = secretErr ? { error: secretErr } : await db.from("client_users").insert({ client_id: client.id, user_id: user.id, role: "owner" });
  if (secretErr || linkErr) {
    await db.from("clients").delete().eq("id", client.id); // cascades to secrets and links
    await raiseAlert(null, "onboarding_save_failed", (secretErr ?? linkErr)?.message ?? "").catch(() => {});
    return fail(500, "Could not save your connection. Please try again.");
  }

  await raiseAlert(client.id, registered ? "client_onboarded" : "client_onboarded_unregistered", `Connected ${b.name}`).catch(() => {});
  return Response.json({ ok: true });
}
