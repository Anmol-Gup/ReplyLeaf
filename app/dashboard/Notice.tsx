import { NOTICES } from "../../lib/dashboard";
import { EXTRACT_MESSAGES } from "../../lib/kb/extract";

// `why` is looked up in a fixed table, so URLs can never inject message text.
export default function Notice({ code, why }: { code?: string; why?: string }) {
  const n = code ? NOTICES[code] : undefined;
  if (!n) return null;
  const detail = why && why in EXTRACT_MESSAGES ? EXTRACT_MESSAGES[why as keyof typeof EXTRACT_MESSAGES] : null;
  return <p className={`notice ${n.kind}`}>{n.text}{detail && <> {detail}</>}</p>;
}
