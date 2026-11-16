import Link from "next/link";
import { Alert } from "../../components/ui";
import { keyProblem, type AiMode, type KeyStatus } from "../../lib/ai-keys";

// Shown when the business uses its own AI key and it is missing or was refused: the assistant is off until it is fixed.
export default function AiKeyBanner({ mode, hasKey, status, onSettings = false }: { mode: AiMode; hasKey: boolean; status: KeyStatus; onSettings?: boolean }) {
  const problem = keyProblem(mode, hasKey, status);
  if (!problem) return null;
  return (
    <Alert kind="error">
      <b>Your assistant is switched off.</b>{" "}
      {problem === "missing" ? "Add your AI key to switch it on." : "Your AI provider refused your key. Add a working key to switch it on."}
      {" "}Until then, customers get a short &quot;our team will reply&quot; message and their chats wait in Human handoff.
      {!onSettings && <> <Link href="/dashboard/settings?tab=ai">Open Settings</Link></>}
    </Alert>
  );
}
