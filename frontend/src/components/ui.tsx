import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type IconName = "overview" | "projects" | "runs" | "approval" | "connect" | "search" | "arrow" | "chevron" | "plus" | "close" | "menu" | "check" | "clock" | "code" | "shield" | "document" | "branch" | "external";

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    projects: <path d="M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
    runs: <><path d="M3 12h4l3-8 4 16 3-8h4" /></>,
    approval: <><path d="M9 4H6a2 2 0 0 0-2 2v14h16V6a2 2 0 0 0-2-2h-3" /><rect x="9" y="2" width="6" height="4" rx="1" /><path d="m8 13 3 3 5-6" /></>,
    connect: <><path d="M8 3v5m8-5v5M5 8h14v3a7 7 0 0 1-14 0V8Zm7 10v4" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    check: <path d="m5 12 4 4L19 6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    code: <path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18" />,
    shield: <><path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z" /><path d="m8 12 3 3 5-6" /></>,
    document: <><path d="M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 12h8M8 16h6" /></>,
    branch: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="6" r="2" /><path d="M6 7v10m0-4h5a7 7 0 0 0 7-5" /></>,
    external: <path d="M14 3h7v7m0-7L10 14m0-10H4v16h16v-6" />,
  };
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function PageHeader({ title, description, actions, breadcrumbs = [] }: {
  title: string; description?: string; actions?: ReactNode; breadcrumbs?: { label: string; href?: string }[];
}) {
  return <div className="page-header">
    <nav className="breadcrumbs" aria-label="Breadcrumb"><a href="#/">Workspace</a>{[...breadcrumbs, { label: title }].map((crumb, i) => <span key={i}><Icon name="chevron" />{crumb.href ? <a href={crumb.href}>{crumb.label}</a> : <span aria-current={i === breadcrumbs.length ? "page" : undefined}>{crumb.label}</span>}</span>)}</nav>
    <div className="page-heading"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</div>
  </div>;
}

export function MetricCard({ label, value, icon, tone = "", href }: {
  label: string; value: ReactNode; icon: IconName; tone?: string; href?: string;
}) {
  const content = <><div className="metric-label">{label}<Icon name={icon} /></div><div className="metric-main"><div className={`metric-value ${tone}`}>{value}</div>{href && <Icon name="arrow" />}</div></>;
  return href ? <a className="metric-card" href={href}>{content}</a> : <div className="metric-card">{content}</div>;
}

export function EmptyState({ title, description, icon = "projects", action }: { title: string; description?: string; icon?: IconName; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} /></span><strong>{title}</strong>{description && <p>{description}</p>}{action && <div>{action}</div>}</div>;
}

export function LoadingState() {
  return <div className="loading-state" role="status"><span className="loading-spinner" />Loading workspace…</div>;
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="error-notice" role="alert"><span>{message}</span><button className="secondary" onClick={onRetry}>Try again</button></div>;
}

export function Dialog({ title, onClose, children, className = "" }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    const root = document.getElementById("root");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    document.body.style.overflow = "hidden";
    const element = ref.current;
    if (element && !element.contains(document.activeElement)) {
      (element.querySelector<HTMLElement>("input, textarea, button, a[href]") ?? element).focus();
    }
    return () => {
      document.body.style.overflow = overflow;
      if (root) root.inert = wasInert;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<div className="backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={ref} className={`dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={(e) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "Tab") {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]') ?? [])];
        const first = items[0], last = items[items.length - 1];
        if (!first) { e.preventDefault(); return; }
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }}>
      <div className="dialog-head"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close" /></button></div>
      {children}
    </div>
  </div>, document.body);
}
