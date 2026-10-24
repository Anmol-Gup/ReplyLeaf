import Link from "next/link";
import Icon from "../components/Icon";

export default function NotFound() {
  return (
    <main className="auth" id="main">
      <div className="empty">
        <span className="empty-icon"><Icon name="search" size={22} /></span>
        <h1 style={{ fontSize: "1.25rem" }}>Page not found</h1>
        <p className="muted">That page doesn&apos;t exist, or you don&apos;t have access to it.</p>
        <Link className="btn btn-primary" href="/dashboard">Go to dashboard</Link>
      </div>
    </main>
  );
}
