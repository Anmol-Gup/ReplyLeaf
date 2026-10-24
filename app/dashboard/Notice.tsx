import { NOTICES } from "../../lib/dashboard";

export default function Notice({ code }: { code?: string }) {
  const n = code ? NOTICES[code] : undefined;
  return n ? <p className={`notice ${n.kind}`}>{n.text}</p> : null;
}
