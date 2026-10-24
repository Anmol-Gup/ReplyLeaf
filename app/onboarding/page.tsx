import { redirect } from "next/navigation";
import { requireUser } from "../../lib/auth/session";
import { anonClient } from "../../lib/auth/anon";
import { env } from "../../lib/env";
import { makeState } from "../../lib/onboarding-state";
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
    <main className="card narrow">
      <h1>{failedStep ? "Reconnect your WhatsApp number" : "Connect your WhatsApp number"}</h1>
      {failedStep && <p className="notice error">{STEP_REASONS[failedStep] ?? "The last attempt did not finish."} You can try again below; nothing is duplicated.</p>}
      {ready ? (
        <EmbeddedSignup
          appId={appId!} configId={configId!} graphVersion={env().GRAPH_API_VERSION}
          state={makeState(user.id, env().WHATSAPP_APP_SECRET)} defaultName=""
        />
      ) : (
        <p className="notice warn">Self-service connection is not switched on yet. Please contact the platform admin to connect your number.</p>
      )}
    </main>
  );
}
