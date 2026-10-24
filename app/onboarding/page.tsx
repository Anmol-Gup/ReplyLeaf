import { requireUser } from "../../lib/auth/session";

// Interim page: replaced by the Embedded Signup flow in Stage 6.
export default async function Onboarding() {
  await requireUser();
  return (
    <main className="card narrow">
      <h1>Almost there</h1>
      <p>Your login is not linked to a business yet. Please contact the platform admin.</p>
    </main>
  );
}
