import { decryptSecret, encryptSecret } from "./crypto";
import { env } from "./env";
import { supabaseAdmin } from "./supabase-admin";
import { raiseAlert } from "./supabase-deps";
import type { RefreshDeps } from "./token-refresh";
import { ASSUMED_TOKEN_LIFETIME_SECONDS, refreshBusinessToken } from "./whatsapp/onboarding";

// Production RefreshDeps. Tokens are decrypted only inside refresh(), used for one
// Graph call, and never logged or put into alerts.
export function supabaseRefreshDeps(): RefreshDeps {
  const db = supabaseAdmin();
  return {
    async listExpiring(days) {
      const until = new Date(Date.now() + days * 86_400_000).toISOString();
      const { data, error } = await db.from("client_secrets")
        .select("client_id, wa_token_expires_at, clients!inner(name, status)")
        .not("wa_token_expires_at", "is", null).lte("wa_token_expires_at", until);
      if (error) throw new Error(`listing expiring tokens failed: ${error.message}`);
      return (data ?? [])
        .filter((r) => (r.clients as unknown as { status: string }).status !== "left")
        .map((r) => ({
          clientId: r.client_id as string,
          clientName: (r.clients as unknown as { name: string }).name,
          expiresAt: new Date(r.wa_token_expires_at as string),
        }));
    },

    async refresh(clientId) {
      const { data, error } = await db.from("client_secrets").select("wa_access_token_enc").eq("client_id", clientId).single();
      if (error || !data?.wa_access_token_enc) throw new Error("no stored token");
      const key = env().ENCRYPTION_KEY;
      const appId = process.env.NEXT_PUBLIC_META_APP_ID;
      if (!appId) throw new Error("NEXT_PUBLIC_META_APP_ID is not set");

      const issued = await refreshBusinessToken({
        graphVersion: env().GRAPH_API_VERSION, appId, appSecret: env().WHATSAPP_APP_SECRET,
        token: decryptSecret(data.wa_access_token_enc, key),
      });
      const assumed = issued.expiresInSeconds === undefined;
      const expiresAt = new Date(Date.now() + (issued.expiresInSeconds ?? ASSUMED_TOKEN_LIFETIME_SECONDS) * 1000);
      const { error: saveErr } = await db.from("client_secrets").update({
        wa_access_token_enc: encryptSecret(issued.token, key),
        wa_token_expires_at: expiresAt.toISOString(),
        wa_token_expiry_assumed: assumed,
      }).eq("client_id", clientId);
      if (saveErr) throw new Error(`saving refreshed token failed: ${saveErr.message}`);
      return { expiresAt, assumed };
    },

    async markExpired(clientId) {
      await db.from("clients").update({
        onboarding_status: "failed", onboarding_step: "token_expired", onboarding_updated_at: new Date().toISOString(),
      }).eq("id", clientId);
    },

    alert: (clientId, kind, detail) => raiseAlert(clientId, kind, detail),
    now: () => new Date(),
  };
}
