import Link from "next/link";
import { Alert } from "../../components/ui";
import { STEP_REASONS } from "../../lib/onboarding-plan";

// The REAL state of the WhatsApp connection, from clients.onboarding_status.
//   manual    = set up by the platform admin (nothing to show)
//   pending   = our side is done (or still running); waiting for Meta's confirmation
//   connected = Meta confirmed via the account_update webhook
//   failed    = a step failed or the token expired: reason + a way to retry
export default function OnboardingBanner({ status, step }: { status?: string | null; step?: string | null }) {
  if (!status || status === "manual") return null;
  if (status === "connected") return <Alert kind="ok">WhatsApp is connected and confirmed.</Alert>;
  if (status === "failed") {
    return (
      <Alert kind="error">
        WhatsApp is not connected. {STEP_REASONS[step ?? ""] ?? "The last attempt did not finish."}{" "}
        <Link href="/onboarding">Reconnect WhatsApp</Link>
      </Alert>
    );
  }
  return (
    <Alert kind="warn">
      {step === "complete"
        ? "WhatsApp is connected on our side. Waiting for WhatsApp to confirm; this can take a few minutes."
        : "Connecting your WhatsApp number..."}
    </Alert>
  );
}
