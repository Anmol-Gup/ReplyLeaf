import Link from "next/link";
import Icon, { type IconName } from "./Icon";

// Small presentational pieces shared by every page. No data access in here.

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Card({ title, description, children, actions }: { title?: string; description?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p className="muted">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export type Tone = "brand" | "success" | "warn" | "danger" | "muted";
export const Badge = ({ tone = "muted", children }: { tone?: Tone; children: React.ReactNode }) => (
  <span className={`badge badge-${tone}`}>{children}</span>
);

export function EmptyState({ icon = "info", title, children, action }: { icon?: IconName; title: string; children?: React.ReactNode; action?: { href: string; label: string } }) {
  return (
    <div className="empty">
      <span className="empty-icon"><Icon name={icon} size={22} /></span>
      <p className="empty-title">{title}</p>
      {children && <p className="muted">{children}</p>}
      {action && <Link className="btn btn-secondary btn-sm" href={action.href}>{action.label}</Link>}
    </div>
  );
}

export function ErrorState({ title = "We couldn't load this", children }: { title?: string; children?: React.ReactNode }) {
  return (
    <div className="empty" role="alert">
      <span className="empty-icon danger"><Icon name="alert" size={22} /></span>
      <p className="empty-title">{title}</p>
      <p className="muted">{children ?? "Please refresh the page. If it keeps happening, contact support."}</p>
    </div>
  );
}

export const Skeleton = ({ w = "100%", h = 16, r }: { w?: number | string; h?: number; r?: number }) => (
  <span className="skeleton" style={{ width: w, height: h, borderRadius: r }} aria-hidden="true" />
);

export const Stat = ({ value, label, href }: { value: React.ReactNode; label: string; href?: string }) => {
  const body = (<><b>{value}</b><span>{label}</span></>);
  return href ? <Link className="stat" href={href}>{body}</Link> : <div className="stat">{body}</div>;
};

export const SearchBox = ({ q, placeholder }: { q?: string; placeholder: string }) => (
  <form method="get" role="search" className="search">
    <Icon name="search" size={16} />
    <input name="q" type="search" defaultValue={q ?? ""} placeholder={placeholder} aria-label={placeholder} />
    <button className="btn btn-secondary btn-sm" type="submit">Search</button>
  </form>
);

// Inline status message (success / warning / error). `role` makes screen readers announce errors.
export function Alert({ kind = "info", children }: { kind?: "ok" | "warn" | "error" | "info"; children: React.ReactNode }) {
  const icon: IconName = kind === "ok" ? "check" : kind === "info" ? "info" : "alert";
  return (
    <div className={`notice ${kind === "info" ? "" : kind}`} role={kind === "error" || kind === "warn" ? "alert" : "status"}>
      <Icon name={icon} size={18} />
      <div>{children}</div>
    </div>
  );
}
