import { Skeleton } from "../../components/ui";

// Shown while any dashboard page loads: placeholders instead of a blank screen.
export default function Loading() {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      <div className="stack-sm"><Skeleton w={220} h={28} /><Skeleton w="50%" h={14} /></div>
      <div className="stat-grid">
        {[0, 1, 2, 3].map((i) => <div key={i} className="stat"><Skeleton w={70} h={30} /><Skeleton w="80%" h={12} /></div>)}
      </div>
      <div className="card stack"><Skeleton w="30%" h={18} /><Skeleton h={14} /><Skeleton h={14} /><Skeleton w="70%" h={14} /></div>
    </div>
  );
}
