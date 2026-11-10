import { useEffect, useState, type ReactNode } from "react";
import type { Project, Run } from "../api";
import { Dialog, Icon, type IconName } from "./ui";

const NAV: { href: string; key: string; label: string; icon: IconName }[] = [
  { href: "#/", key: "", label: "Overview", icon: "overview" },
  { href: "#/projects", key: "projects", label: "Projects", icon: "projects" },
  { href: "#/runs", key: "runs", label: "Runs", icon: "runs" },
  { href: "#/approvals", key: "approvals", label: "Approvals", icon: "approval" },
  { href: "#/connect", key: "connect", label: "Connection guide", icon: "connect" },
];

export function AppShell({ active, projects, runs, children }: { active: string; projects: Project[]; runs: Run[]; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const waiting = runs.filter((r) => r.status === "awaiting_approval").length;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearchOpen((v) => !v); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
  const sidebar = <>
    <a href="#/" className="brand" aria-label="Agents Dashboard overview" onClick={() => setMobileOpen(false)}><span className="brand-mark"><Icon name="branch" /></span><span>Agents Dashboard</span></a>
    <div className="nav-caption">WORKSPACE</div>
    <nav className="sidebar-nav" aria-label="Main navigation">{NAV.map((item) => <a key={item.key} href={item.href} className={active === item.key ? "active" : ""} aria-label={item.key === "approvals" && waiting ? `Approvals, ${waiting} pending` : item.label} aria-current={active === item.key ? "page" : undefined} onClick={() => setMobileOpen(false)}><Icon name={item.icon} /><span>{item.label}</span>{item.key === "approvals" && waiting > 0 && <span className="nav-count">{waiting}</span>}</a>)}</nav>
  </>;
  return <div className="app-shell">
    <a className="skip-link" href="#main-content" onClick={(e) => { e.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to content</a>
    <aside className="sidebar">{sidebar}</aside>
    {mobileOpen && <Dialog title="Navigation" className="navigation-dialog" onClose={() => setMobileOpen(false)}>{sidebar}</Dialog>}
    <div className="app-workspace">
      <header className="topbar">
        <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Icon name="menu" /></button>
        <button className="workspace-search" onClick={() => setSearchOpen(true)} aria-label="Search workspace"><Icon name="search" /><span>Search projects and runs…</span><kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} K</kbd></button>
        <div className="topbar-right"><a className="review-shortcut" href="#/approvals" aria-label={`${waiting} pending approvals`}><Icon name="approval" />{waiting > 0 && <span>{waiting}</span>}</a></div>
      </header>
      <main id="main-content" className="main-content" tabIndex={-1}><div className="page-content">{children}</div></main>
    </div>
    {searchOpen && <WorkspaceSearch projects={projects} runs={runs} onClose={() => setSearchOpen(false)} />}
  </div>;
}

function WorkspaceSearch({ projects, runs, onClose }: { projects: Project[]; runs: Run[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const pages = NAV.filter((item) => item.label.toLowerCase().includes(q));
  const matchedProjects = projects.filter((p) => `${p.name} ${p.repo_url} ${p.local_path}`.toLowerCase().includes(q)).slice(0, 5);
  const matchedRuns = runs.filter((r) => `${r.title} ${r.goal} ${r.project_name ?? ""} ${r.number}`.toLowerCase().includes(q)).slice(0, 5);
  const result = (href: string, label: string, hint: string, icon: IconName) => <a key={href} className="search-result" href={href} onClick={onClose}><Icon name={icon} /><span><strong>{label}</strong><small>{hint}</small></span><Icon name="arrow" /></a>;
  return <Dialog title="Search workspace" onClose={onClose} className="search-dialog">
    <label className="search-field"><Icon name="search" /><input autoFocus aria-label="Search projects and runs" placeholder="Find a project, ticket, or run…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
    <div className="search-results">
      {!!pages.length && <><div className="nav-caption">PAGES</div>{pages.map((p) => result(p.href, p.label, "Workspace", p.icon))}</>}
      {!!matchedProjects.length && <><div className="nav-caption">PROJECTS</div>{matchedProjects.map((p) => result(`#/projects/${p.id}`, p.name, p.repo_url || "Project", "projects"))}</>}
      {!!matchedRuns.length && <><div className="nav-caption">RUNS</div>{matchedRuns.map((r) => result(`#/runs/${r.id}`, r.title || r.goal, `${r.project_name || "Project"} · Run #${r.number || r.id}`, "runs"))}</>}
      {!pages.length && !matchedProjects.length && !matchedRuns.length && <p className="search-empty" role="status">No matches for “{query}”. Try a project name or ticket key.</p>}
    </div>
    <div className="search-footer">Tab to a result, then Enter to open <span>Esc to close</span></div>
  </Dialog>;
}
