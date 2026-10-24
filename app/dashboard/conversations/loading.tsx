import { Skeleton } from "../../../components/ui";

export default function Loading() {
  return (
    <div className="chat-panel" aria-busy="true" aria-label="Loading conversation">
      <div className="chat-head"><Skeleton w="40%" h={22} /><Skeleton w="60%" h={14} /></div>
      <div className="chat-log" style={{ gap: 12 }}>
        <Skeleton w="55%" h={44} r={16} />
        <span style={{ alignSelf: "flex-end", width: "62%" }}><Skeleton h={54} r={16} /></span>
        <Skeleton w="38%" h={40} r={16} />
      </div>
    </div>
  );
}
