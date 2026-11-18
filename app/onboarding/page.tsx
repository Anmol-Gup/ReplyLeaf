import { redirect } from "next/navigation";
import { requireUser } from "../../lib/auth/session";
import { anonClient } from "../../lib/auth/anon";
import { env } from "../../lib/env";
import { makeState } from "../../lib/onboarding-state";
import { Alert } from "../../components/ui";
import Logo from "../../components/Logo";
import { STEP_REASONS } from "../../lib/onboarding-plan";
import EmbeddedSignup from "./EmbeddedSignup";

// STAGE 6: Embedded Signup v4. Connects a business's own WhatsApp number.
// REAL CLIENTS CAN ONLY ONBOARD AFTER META APPROVES US AS A TECH PROVIDER
// (App Review). Until then only people with a role on our Meta app can finish it.
export default async function Onboarding() {
  const { user, token } = await requireUser();
  const db = anonClient(token);
  const { data } = await db.from("client_users").select("client_id").limit(1);
  let failedStep: string | null = null;
  if (data?.length) {
    // Already linked to a business. Only a FAILED connection (or an expired token) can be retried.
    const { data: c } = await db.from("clients").select("onboarding_status, onboarding_step").eq("id", data[0].client_id).single();
    if (c?.onboarding_status !== "failed") redirect("/dashboard");
    failedStep = c.onboarding_step ?? "unknown";
  }

  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  const configId = process.env.NEXT_PUBLIC_META_ES_CONFIG_ID;
  const ready = Boolean(appId && configId);

  return (
    <main className="auth" id="main">
      <div className="card" style={{ maxWidth: 480 }}>
        <div className="auth-brand">
          <Logo size={48} />
          <h1>{failedStep ? "Reconnect your WhatsApp number" : "Connect your WhatsApp number"}</h1>
        </div>
        {failedStep && (
          <div style={{ marginBottom: 16 }}>
            <Alert kind="error">{STEP_REASONS[failedStep] ?? "The last attempt did not finish."} You can try again below; nothing is duplicated.</Alert>
          </div>
        )}
        <p className="hint" style={{ marginBottom: 14 }}>
          Your WhatsApp Business Account will be connected to Replyleaf. Meta messaging charges are separate from your Replyleaf subscription and are managed through your WhatsApp Business Account or messaging provider.
        </p>
        {ready ? (
          <EmbeddedSignup
            appId={appId!} configId={configId!} graphVersion={env().GRAPH_API_VERSION}
            state={makeState(user.id, env().WHATSAPP_APP_SECRET)} defaultName=""
          />
        ) : (
          <Alert kind="warn">Self-service connection is not switched on yet. Please contact the platform admin to connect your number.</Alert>
        )}
      </div>
    </main>
  );
}
