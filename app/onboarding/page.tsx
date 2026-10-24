import { redirect } from "next/navigation";
import { requireUser } from "../../lib/auth/session";
import { anonClient } from "../../lib/auth/anon";
import { env } from "../../lib/env";
import { makeState } from "../../lib/onboarding-state";
import EmbeddedSignup from "./EmbeddedSignup";

// STAGE 6: Embedded Signup v4. Connects a business's own WhatsApp number.
// REAL CLIENTS CAN ONLY ONBOARD AFTER META APPROVES US AS A TECH PROVIDER
// (App Review). Until then only people with a role on our Meta app can finish it.
export default async function Onboarding() {
  const { user, token } = await requireUser();
  const { data } = await anonClient(token).from("client_users").select("client_id").limit(1);
  if (data?.length) redirect("/dashboard"); // already connected

  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  const configId = process.env.NEXT_PUBLIC_META_ES_CONFIG_ID;
  const ready = Boolean(appId && configId);

  return (
    <main className="card narrow">
      <h1>Connect your WhatsApp number</h1>
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
