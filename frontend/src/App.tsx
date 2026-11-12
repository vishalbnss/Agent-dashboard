import { useCallback, useEffect, useState } from "react";
import { api, type Approval, type ApprovalRow, type Phase, type Project, type ProjectDetail, type Run, type RunAgent } from "./api";
import { AppShell } from "./components/AppShell";
import { ProjectSummary, RunSummary } from "./components/ActivitySummary";
import { Dialog, EmptyState, ErrorNotice, Icon, LoadingState, MetricCard, PageHeader } from "./components/ui";
import { usePolling } from "./hooks/usePolling";
import { figmaReports } from "./connections";
import { TicketsTab } from "./components/TicketsTab";
import { LogsTab } from "./components/LogsTab";
import { Cost, RunUsage, type AgentCost } from "./components/RunUsage";
import "./index.css";
import "./workspace.css";

/* ponytail: hash routing, no router dependency. Add react-router if pages multiply. */
function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#\/?/, "");
}

const loadWorkspace = async () => {
  const [projects, runs] = await Promise.all([api.projects(), api.runs()]);
  return { projects, runs };
};

export default function App() {
  const route = useHash();
  const [pathname, query = ""] = route.split("?");
  const [seg, id, sub] = pathname.split("/");
  const { data, error, reload } = usePolling(loadWorkspace);
  const projects = data?.projects ?? [], runs = data?.runs ?? [];
  const detail = !!id && (seg === "projects" || seg === "runs");
  return <AppShell active={sub === "review" ? "approvals" : seg} projects={projects} runs={runs}>
    {error && <ErrorNotice message={error} onRetry={reload} />}
    {!data && !detail && seg !== "connect" ? (!error && <LoadingState />)
      : seg === "projects" && id ? <ProjectPage key={id} id={+id} tab={sub} />
      : seg === "runs" && id && sub === "review" ? <ReviewPage key={id} id={+id} />
      : seg === "runs" && id ? <RunPage key={id} id={+id} />
      : seg === "runs" ? <RunsPage key={query} runs={runs} initialStatus={new URLSearchParams(query).get("status") ?? ""} />
      : seg === "approvals" ? <ApprovalInbox runs={runs} />
      : seg === "connect" ? <ConnectPage />
      : seg === "projects" ? <ProjectsPage projects={projects} reload={reload} />
      : <HomePage projects={projects} runs={runs} />}
  </AppShell>;
}

/* ---------- the agent roster ---------- */

type AgentStatus = "waiting" | "running" | "done" | "failed" | "interrupted";
// Explicit, per-run presentation override for the user's local completed-run preview.
// Execution events, summaries and agent behavior remain unchanged.
const isCompletedPreview = (run?: Run | null) => run?.status === "done" && run.usage._display_mode === "completed_preview";
const isManuallyCompleted = (run?: Run | null) => run?.status === "done" && !isCompletedPreview(run) && /^\*\*Closure:\*\* Manually marked completed at the user's request\b/m.test(run.summary_md);
// The nine stage agents of the Jira-to-PR workflow, in order. `face` picks the line-art character.
// Design approval is a human gate before them; the run page shows it as the approval card.
const AGENTS = [
  { key: "branch-preflight", face: "orchestrator", name: "Branch preflight", job: "Checks access and creates the delivery branch", phases: ["branch-preflight"] },
  { key: "jira-intake", face: "planner", name: "Ticket intake", job: "Reads the tickets into testable contracts", phases: ["jira-intake"] },
  { key: "figma-intake", face: "implementer", name: "Figma intake", job: "Indexes every design node and asset", phases: ["figma-intake"] },
  { key: "dependency-merge", face: "planner", name: "Design synthesis", job: "Merges tickets and designs into one target", phases: ["dependency-merge"] },
  { key: "implementation", face: "implementer", name: "Implementation", job: "Builds the change from the merged contracts", phases: ["implementation"] },
  { key: "independent-test", face: "tester", name: "Independent tests", job: "Derives and runs tests from the contract alone", phases: ["independent-test"] },
  { key: "code-review-security", face: "reviewer", name: "Review and security", job: "Reviews correctness, accessibility and security", phases: ["code-review-security"] },
  { key: "documentation", face: "summarizer", name: "Documentation", job: "Summarises evidence, tokens and cost", phases: ["documentation"] },
  { key: "pr-creation", face: "orchestrator", name: "Pull request", job: "Pushes and opens the PR once you approve", phases: ["pr-creation"] },
];

function rosterFor(run?: Run | null) {
  if (isCompletedPreview(run)) return AGENTS.map((agent) => ({ ...agent, status: "done" as AgentStatus, note: "", count: 0 }));
  const phases = run?.phases ?? [];
  const rows = AGENTS.map((a) => {
    const mine = phases.filter((p) => a.phases.includes(p.name));
    const last = mine[mine.length - 1];
    let status: AgentStatus = "waiting";
    if (last) status = last.status === "done" ? "done" : last.status === "failed" ? "failed" : "running";
    return { ...a, status: status as AgentStatus, note: last?.notes ?? "", count: mine.length };
  });
  const agentStarted = phases.some((p) => AGENTS.some((a) => a.phases.includes(p.name)));
  const gate = phases[phases.length - 1]?.name === "design-approval";
  if (run?.status === "running" && agentStarted && !gate && !rows.some((r) => r.status === "running")) {
    const next = rows.find((r) => r.status === "waiting");
    if (next) next.status = "running";
  }
  if (run && run.status !== "running" && run.status !== "awaiting_approval") rows.forEach((r) => { if (r.status === "running") r.status = isManuallyCompleted(run) ? "interrupted" : run.status === "done" ? "done" : "failed"; });
  return rows;
}

function fmtMs(ms: number) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m}m ${String(sec % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
const fmtCost = (v: number) => `~$${v.toFixed(v > 0 && v < 0.01 ? 4 : 2)}`;
const fmtTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k tokens` : `${n} tokens`;
const plannedLabel = (m: string) => m === "selected Copilot model" ? "Copilot model" : /^(haiku|sonnet|opus)$/.test(m) ? m[0].toUpperCase() + m.slice(1) : m;

function AgentMetrics({ a, now }: { a?: RunAgent; now: number | null }) {
  if (!a) return null;
  const ms = a.duration_ms ?? (now != null && a.started_at && !a.ended_at ? now - utc(a.started_at).getTime() : null);
  const timeTitle = a.duration_source === "reported" ? "Measured by the agent's host" : a.duration_source === "measured" ? "From the stage's start and finish reports" : "Elapsed so far";
  return <div className="agent-side">
    <span title={ms == null ? "Not started" : timeTitle}>{ms == null ? "—" : fmtMs(ms)}</span>
    <span title={a.est_cost_usd == null ? "No measured tokens to estimate from" : `Estimated from ${a.tokens?.toLocaleString()} reported tokens at list prices. Not a bill.`}>{a.est_cost_usd == null ? "—" : fmtCost(a.est_cost_usd)}</span>
  </div>;
}

function Roster({ run, title, subtitle }: { run?: Run | null; title: string; subtitle: string }) {
  const rows = rosterFor(run);
  const live = run?.status === "running" || run?.status === "awaiting_approval";
  const manual = isManuallyCompleted(run);
  const notRun = rows.filter((r) => !r.count);
  const metrics = new Map((run?.agents ?? []).map((a) => [a.stage, a]));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {  // tick the running agent's elapsed time
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return (
    <div className="roster">
      <div className="roster-head"><span className={`dot ${live ? "running" : run ? run.status : "waiting"}`} />{title}</div>
      <p className="roster-sub">{subtitle}</p>
      {(manual ? rows.filter((r) => r.count) : rows).map((r) => {
        const a = metrics.get(r.key);
        return (
          <div className="agent" key={r.key}>
            <Face kind={r.face} />
            <div className="agent-body">
              <div className="agent-name">{r.name}</div>
              <div className={`agent-status ${r.status}`}>
                {r.status === "done" ? <Check /> : <span className={`dot ${r.status}`} />}
                {r.status === "done" ? "Completed" : r.status === "running" ? (r.note || "Working…") : r.status === "failed" ? (manual ? "Blocked before closure" : "Stopped") : r.status === "interrupted" ? "Stopped at closure" : r.job}
              </div>
              {r.status === "done" && r.note && <div className="agent-note">{r.note}</div>}
              {a && <div className="agent-meta">
                {a.model
                  ? <span className="agent-model" title="Model reported by the agent">{a.model}</span>
                  : <span className="agent-model planned" title="Planned route; the agent reports its actual model when it finishes">{plannedLabel(a.planned_model)}</span>}
                {a.tokens != null && <span>{fmtTokens(a.tokens)}</span>}
              </div>}
            </div>
            <AgentMetrics a={a} now={live && r.status === "running" ? now : null} />
          </div>
        );
      })}
      {manual && notRun.length > 0 && <details className="unrun-stages"><summary>{notRun.length} {notRun.length === 1 ? "agent" : "agents"} not run</summary>
        <ul>{notRun.map((r) => <li key={r.key}>{r.name}<span>Not run</span></li>)}</ul>
      </details>}
    </div>
  );
}

function Check() {
  return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><path d="M2.5 7.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/* Line-art faces, one accessory each so they read as different characters. */
function Face({ kind }: { kind: string }) {
  const s = { fill: "none", stroke: "#1c1a17", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg viewBox="0 0 44 44" aria-hidden>
      <path d="M12 16c-1 8 2 18 10 18s11-10 10-18" {...s} />
      <path d="M12 16c3-6 17-6 20 0" {...s} />
      {kind === "orchestrator" && <><circle cx="17" cy="20" r="1.4" fill="#1c1a17" /><circle cx="27" cy="20" r="1.4" fill="#1c1a17" /><path d="M9 13l4-5 9 3 9-3 4 5" {...s} /><path d="M18 28c2 2 6 2 8 0" {...s} /></>}
      {kind === "planner" && <><circle cx="17" cy="20" r="4" {...s} /><circle cx="27" cy="20" r="4" {...s} /><path d="M21 20h2M13 19l-3-1M31 19l3-1" {...s} /><path d="M19 28h6" {...s} /></>}
      {kind === "implementer" && <><circle cx="17" cy="20" r="1.4" fill="#1c1a17" /><circle cx="27" cy="20" r="1.4" fill="#1c1a17" /><path d="M11 11h22l-3 4H14z" {...s} /><path d="M18 28c2 3 6 3 8 0" {...s} /></>}
      {kind === "tester" && <><circle cx="17" cy="20" r="1.4" fill="#1c1a17" /><path d="M23 17h8v6h-8z" {...s} /><path d="M12 15l19 3" {...s} /><path d="M19 28h6" {...s} /></>}
      {kind === "reviewer" && <><circle cx="27" cy="20" r="4.5" {...s} /><path d="M31 23l4 5" {...s} /><circle cx="17" cy="20" r="1.4" fill="#1c1a17" /><path d="M18 28c2 1 5 1 7 0" {...s} /></>}
      {kind === "summarizer" && <><circle cx="17" cy="20" r="1.4" fill="#1c1a17" /><circle cx="27" cy="20" r="1.4" fill="#1c1a17" /><path d="M18 34l4-3 4 3-4 2z" {...s} /><path d="M18 27c2 2 6 2 8 0" {...s} /></>}
    </svg>
  );
}

const SIGN_IN = {
  jira: { name: "Jira", blurb: "Connect Jira to let agents read tickets for this project." },
};

function SignInStep({ p, kind, onSaved }: { p: ProjectDetail; kind: "jira"; onSaved: () => void }) {
  const info = SIGN_IN[kind];
  const cur = p.integrations.find((i) => i.kind === kind);
  const q = new URLSearchParams(location.hash.split("?")[1] || location.search);
  const flag = q.get(kind);
  const disconnect = () => { if (confirm(`Disconnect ${info.name} from this project?`)) api.deleteIntegration(p.id, kind).then(onSaved); };
  return (
    <div className="progress-card">
      <p style={{ marginTop: 0 }}>{info.blurb}</p>
      {cur?.has_secret && <p className="ok"><Check /> {info.name} is connected.</p>}
      {flag === "denied" && <p className="err">{info.name} sign-in was cancelled.</p>}
      {flag === "error" && <p className="err">{info.name} sign-in failed: {q.get("reason")}</p>}
      <div className="row">
        <a className="button-secondary" style={{ display: "inline-block", height: 40, lineHeight: "38px", padding: "0 20px" }} href={api.authorizeUrl(kind, p.id)}>{cur?.has_secret ? "Connect again" : `Connect with ${info.name}`}</a>
        {cur?.has_secret && <button className="link" onClick={disconnect}>Disconnect</button>}
      </div>
    </div>
  );
}

function FigmaStep({ p }: { p: ProjectDetail }) {
  const [selectedClient, setSelectedClient] = useState<"claude" | "codex" | "copilot" | null>(null);
  const ai = selectedClient ?? (p.ai === "copilot" || (p.copilot_connected_at && !p.claude_connected_at && !p.codex_connected_at) ? "copilot" : p.ai === "codex" || (p.codex_connected_at && !p.claude_connected_at) ? "codex" : "claude");
  const reports = figmaReports(p.integrations.find((i) => i.kind === "figma"));
  const prompt = `Check only the Figma MCP connection for dashboard project ${JSON.stringify(p.name)} (ID ${p.id}). `
    + `Use this project's agents-dashboard connection. Verify access with a read-only Figma tool call, then report the result `
    + `using report_connection(kind="figma", connected=true or false, client="${ai}", detail="brief result without credentials"). `
    + "Do not infer success from an installed plugin or config. If a design link is needed, ask me for it. Do not start a run or edit files.";
  return (
    <div className="progress-card">
      <div aria-live="polite">
        {!reports.length && <p className="muted" style={{ marginTop: 0 }}>Not verified</p>}
        {reports.map((report) => <div className="connection-check" key={report.client}>
          <p className={report.connected ? "ok" : "err"}>
            {report.connected && <Check />} {report.connected ? "Connected" : "Needs attention"} in {AI_LABEL[report.client] ?? "your AI"}
          </p>
          {report.detail && <p>{report.detail}</p>}
          {report.checked_at && !Number.isNaN(Date.parse(report.checked_at)) && <p className="muted">Last checked <time dateTime={report.checked_at}>{new Date(report.checked_at).toLocaleString()}</time></p>}
        </div>)}
      </div>
      <label className="connection-client">Coding agent
        <select value={ai} onChange={(e) => setSelectedClient(e.target.value as "claude" | "codex" | "copilot")}>
          <option value="codex">Codex</option><option value="claude">Claude Code</option><option value="copilot">GitHub Copilot</option>
        </select>
      </label>
      <details className="connection-setup">
        <summary>Connection setup</summary>
        <ol className="phases">
          <li>Connect {AI_LABEL[ai]} to this project using its Connections card.</li>
          <li>{ai === "copilot" ? <>Add the HTTP server <code>https://mcp.figma.com/mcp</code> in VS Code's <strong>MCP: Add Server</strong> command, or Copilot CLI's <code>/mcp</code> menu, then sign in to Figma.</> : ai === "claude" ? <>Type <code>/mcp</code>, pick <strong>figma</strong> and choose <strong>Authenticate</strong>.</> : <>In the project folder, run <code>codex mcp login figma</code>.</>}</li>
          <li>Allow access in the browser, then reopen the session if the tools are unavailable.</li>
        </ol>
      </details>
      <p>{AI_LABEL[ai]} checks Figma on the first message in a new connected session. No verification prompt is needed.</p>
      <details className="connection-setup">
        <summary>Manual recheck (optional)</summary>
        <p>Paste this into {AI_LABEL[ai]} to check again:</p>
        <pre>{prompt}</pre>
        <CopyButton text={prompt} />
      </details>
      <p className="muted" style={{ fontSize: ".85rem", marginBottom: 0 }}>Status updates after the check. No run is needed.</p>
    </div>
  );
}

function AgentFlow() {
  return <ol className="workflow-timeline">{AGENTS.map((stage, i) => <li key={stage.key}><span className="workflow-number">{i === 0 ? <Icon name="approval" /> : String(i).padStart(2, "0")}</span><div><strong>{stage.name}</strong><p>{stage.job}</p></div></li>)}</ol>;
}

/* ---------- pages ---------- */

function AddProjectForm({ className = "", onCreated }: { className?: string; onCreated?: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(""); setBusy(true);
    try {
      const p = await api.createProject(name, repo);
      setName(""); setRepo(""); setOpen(false); onCreated?.();
      location.hash = `#/projects/${p.id}`;
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  if (!open) return <button className={className} onClick={() => setOpen(true)}><Icon name="plus" />Add project</button>;
  return (
    <Dialog title="Add a project" onClose={() => { if (!busy) setOpen(false); }}>
    <form onSubmit={submit} className="add-project">
      <label className="field"><span>Project name</span><input autoFocus placeholder="e.g. Customer portal" value={name} onChange={(e) => setName(e.target.value)} required disabled={busy} /></label>
      <label className="field"><span>GitHub repository <span className="muted">(optional)</span></span><input placeholder="https://github.com/your-team/project" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={busy} /></label>
      <p className="form-hint">The repository URL is only needed for pull requests.</p>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</button><button disabled={busy}>{busy ? "Creating…" : "Create project"}<Icon name="arrow" /></button></div>
    </form>
    </Dialog>
  );
}

function HomePage({ projects, runs }: { projects: Project[]; runs: Run[] }) {
  const waiting = runs.filter((r) => r.status === "awaiting_approval");
  return <>
    <PageHeader title="Workspace overview" actions={<AddProjectForm />} />
    <ProjectSummary projects={projects}>
      <MetricCard label="Projects" value={projects.length} icon="projects" href="#/projects" />
      <MetricCard label="Active runs" value={runs.filter((r) => r.status === "running").length} icon="runs" href="#/runs?status=running" />
      <MetricCard label="Awaiting approval" value={waiting.length} icon="approval" tone={waiting.length ? "warn" : ""} href="#/approvals" />
      <MetricCard label="Completed runs" value={runs.filter((r) => r.status === "done").length} icon="check" tone="ok" href="#/runs?status=done" />
    </ProjectSummary>
    <div className="overview-grid">
      <section className="panel recent-panel"><div className="section-heading"><h2>Recent runs</h2><a className="text-link" href="#/runs">View all <Icon name="arrow" /></a></div>
        {runs.length ? <div className="recent-runs">{runs.slice(0, 6).map((r) => <a key={r.id} href={`#/runs/${r.id}`} className="recent-run"><span className={`run-marker ${r.status}`}><Icon name={r.status === "done" ? "check" : r.status === "awaiting_approval" ? "approval" : "runs"} /></span><span className="recent-run-main"><strong>{runTitle(r)}</strong><small>{r.project_name || "Project"} · Run #{r.number || r.id} · {ago(r.started_at)}</small></span><RunStatus run={r} /><Icon name="chevron" /></a>)}</div>
          : <EmptyState title="No runs yet" description={projects.length ? "Start a run from your connected coding agent." : "Add a project to start a run."} icon="runs" />}
      </section>
      <section className="panel"><div className="section-heading"><h2>Pending approvals</h2><span className="count-pill">{waiting.length}</span></div>
        {waiting.length ? <div className="review-queue">{waiting.slice(0, 3).map((r) => <a href={`#/runs/${r.id}/review`} key={r.id} aria-label={`Review ${runTitle(r)}`}><span className="tag warn">Design approval</span><strong>{runTitle(r)}</strong><span>{r.project_name} <Icon name="arrow" /></span></a>)}{waiting.length > 3 && <a className="text-link" href="#/approvals">View all {waiting.length} approvals <Icon name="arrow" /></a>}</div> : <EmptyState title="No pending approvals" icon="approval" />}
      </section>
    </div>
  </>;
}

function ProjectsPage({ projects, reload }: { projects: Project[]; reload: () => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const isConnected = (p: Project) => !!(p.claude_connected_at || p.codex_connected_at || p.copilot_connected_at);
  const visible = projects.filter((p) => `${p.name} ${p.repo_url} ${p.local_path}`.toLowerCase().includes(query.toLowerCase()) && (!filter || (filter === "connected" ? isConnected(p) : !isConnected(p))));
  const remove = async (p: Project) => {
    if (!confirm(`Delete "${p.name}" and its runs? Your code folder is not touched.`)) return;
    try { await api.deleteProject(p.id); reload(); } catch { setError("Could not delete this project. Please try again."); }
  };
  return <>
    <PageHeader title="Projects" actions={<AddProjectForm onCreated={reload} />} />
    {error && <ErrorNotice message={error} onRetry={() => setError("")} />}
    <div className="filter-bar"><label className="search-field"><Icon name="search" /><input aria-label="Search projects" placeholder="Search projects…" value={query} onChange={(e) => setQuery(e.target.value)} /></label><select aria-label="Connection status" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">All connections</option><option value="connected">Connected</option><option value="disconnected">Not connected</option></select><span className="results-count">{visible.length} project{visible.length === 1 ? "" : "s"}</span></div>
    {!projects.length ? <EmptyState title="No projects yet" description="Add a project to connect your coding agent." /> : !visible.length ? <EmptyState title="No matching projects" description="Try another name or connection filter." icon="search" action={<button className="secondary" onClick={() => { setQuery(""); setFilter(""); }}>Clear filters</button>} /> :
      <ul className="project-cards">{visible.map((p) => <li key={p.id} className="project-card"><div className="project-card-top"><span className="project-symbol"><Icon name="projects" /></span><span className={`tag ${isConnected(p) ? "ok" : ""}`}>{isConnected(p) ? "AI connected" : "Setup needed"}</span><button className="icon-button delete-project" aria-label={`Delete ${p.name}`} onClick={() => remove(p)}><Icon name="close" /></button></div><a className="project-card-title" href={`#/projects/${p.id}`}>{p.name}</a><p className="repo-label" title={p.repo_url || p.local_path}>{p.repo_url ? p.repo_url.replace(/^https?:\/\//, "") : p.local_path || "Repository details appear when your AI connects"}</p><div className="project-clients">{p.claude_connected_at && <span><ConnIcon kind="claude" />Claude Code</span>}{p.codex_connected_at && <span><ConnIcon kind="codex" />Codex</span>}{p.copilot_connected_at && <span><ConnIcon kind="copilot" />GitHub Copilot</span>}{!isConnected(p) && <span><Icon name="connect" />Ready to connect</span>}</div><div className="project-latest"><span className="eyebrow">LATEST ACTIVITY</span>{p.latest_run ? <><a href={`#/runs/${p.latest_run.id}`}>{runTitle(p.latest_run)}</a><RunStatus run={p.latest_run} /></> : <p>{p.agents_md ? "Project guide ready. Start your first run." : "Connect an AI to set up your project guide."}</p>}</div><div className="project-card-footer"><a href={`#/projects/${p.id}`}>Open project <Icon name="arrow" /></a>{p.latest_run?.status === "awaiting_approval" && <a className="text-link" href={`#/runs/${p.latest_run.id}/review`}>Review design</a>}</div></li>)}</ul>}
  </>;
}

type ProjectTab = "connections" | "tickets" | "approvals" | "runs" | "logs";
const PROJECT_TABS: ProjectTab[] = ["connections", "tickets", "approvals", "runs", "logs"];

function ProjectPage({ id, tab: routeTab }: { id: number; tab?: string }) {
  const fetcher = useCallback(() => Promise.all([api.project(id), api.runs(id), api.approvals(id)]), [id]);
  const { data, error, reload } = usePolling(fetcher, 4000);
  return <>{error && <ErrorNotice message={error} onRetry={reload} />}{data ? <ProjectContent p={data[0]} runs={data[1]} approvals={data[2]} routeTab={routeTab} load={reload} /> : !error && <LoadingState />}</>;
}

function ProjectContent({ p, runs, approvals, routeTab, load }: { p: ProjectDetail; runs: Run[]; approvals: ApprovalRow[]; routeTab?: string; load: () => void }) {
  const id = p.id;
  // Pick the default once, so background refreshes never switch the selected tab.
  const [firstTab] = useState<ProjectTab>(() => !(p.claude_connected_at || p.codex_connected_at || p.copilot_connected_at) ? "connections" : approvals.some((a) => a.status === "pending") ? "approvals" : "runs");
  const [deleteError, setDeleteError] = useState("");
  const aiOn = p.claude_connected_at || p.codex_connected_at || p.copilot_connected_at;
  const tab = PROJECT_TABS.includes(routeTab as ProjectTab) ? (routeTab as ProjectTab) : firstTab ?? "runs";
  const waiting = approvals.filter((a) => a.status === "pending").length;
  return (
    <>
      <PageHeader title={p.name} breadcrumbs={[{ label: "Projects", href: "#/projects" }]} actions={<span className={`tag ${aiOn ? "ok" : "warn"}`}>{aiOn ? "AI connected" : "Setup needed"}</span>} />
      {deleteError && <ErrorNotice message={deleteError} onRetry={() => setDeleteError("")} />}
      <div className="project-context"><span><Icon name="branch" />{p.repo_url || p.local_path || "Repository details will appear after connecting"}</span><span>{runs.length} runs</span><span>{waiting} pending approvals</span>
        <RoutingSwitch p={p} onChanged={load} /></div>
      <div className="ptabs" role="tablist">
        <a role="tab" aria-selected={tab === "connections"} href={`#/projects/${id}/connections`}>Connections</a>
        <a role="tab" aria-selected={tab === "tickets"} href={`#/projects/${id}/tickets`}>Tickets <span className="count">{p.tickets.length}</span></a>
        <a role="tab" aria-selected={tab === "approvals"} href={`#/projects/${id}/approvals`}>Approvals{waiting > 0 && <span className="badge">{waiting}</span>}</a>
        <a role="tab" aria-selected={tab === "runs"} href={`#/projects/${id}/runs`}>Runs <span className="count">{runs.length}</span></a>
        <a role="tab" aria-selected={tab === "logs"} href={`#/projects/${id}/logs`}>Logs</a>
      </div>
      {tab === "connections" && <><div className="section-heading"><h2>Connected tools</h2><a className="text-link" href="#/connect">Setup guide <Icon name="arrow" /></a></div><AgentSetup p={p} onChanged={load} /><ConnectionBoxes p={p} onChanged={load} /></>}
      {tab === "tickets" && <TicketsTab projectId={id} tickets={p.tickets} onChanged={load} />}
      {tab === "approvals" && <ApprovalsTab rows={approvals} />}
      {tab === "runs" && <RunsTable runs={runs} />}
      {tab === "logs" && <LogsTab projectId={id} runs={runs} />}
      <div className="project-danger"><button className="link" onClick={() => { if (confirm("Delete this project and its runs? Your code folder is not touched.")) api.deleteProject(id).then(() => (location.hash = "#/projects")).catch(() => setDeleteError("Could not delete this project. Please try again.")); }}>Delete project</button></div>
    </>
  );
}

/* ---------- connections: one box per service, click to connect ---------- */

type ConnKind = "claude" | "codex" | "copilot" | "jira" | "figma" | "github";

function ConnIcon({ kind }: { kind: ConnKind }) {
  const s = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      {kind === "claude" && <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4" {...s} />}
      {kind === "codex" && <><rect x="3" y="4" width="18" height="16" rx="3" {...s} /><path d="M7 9l3 3-3 3M12 15h5" {...s} /></>}
      {kind === "copilot" && <><rect x="3" y="5" width="8" height="7" rx="3" {...s} /><rect x="13" y="5" width="8" height="7" rx="3" {...s} /><path d="M11 8h2M5 12v5l7 4 7-4v-5M8 16v1M16 16v1" {...s} /></>}
      {kind === "jira" && <><path d="M12 3l4 4-4 4-4-4z" {...s} /><path d="M12 11l4 4-4 4-4-4z" {...s} /><path d="M5 10l3 3M19 10l-3 3" {...s} /></>}
      {kind === "figma" && <><path d="M8 3h4v6H8a3 3 0 0 1 0-6zM12 3h4a3 3 0 0 1 0 6h-4zM8 9h4v6H8a3 3 0 0 1 0-6zM8 15h4v3a3 3 0 1 1-4-3z" {...s} /><circle cx="15" cy="12" r="3" {...s} /></>}
      {kind === "github" && <path d="M8 21v-3.5c-3.5.8-4.5-1.5-4.5-1.5M16 21v-3.8c0-1 .3-1.7-.5-2.4 2.7-.3 5-1.3 5-5.7a4.4 4.4 0 0 0-1.2-3 4 4 0 0 0-.1-3s-1 .3-3 1.5a10.6 10.6 0 0 0-5.6 0C8.6 2.3 7.6 2.6 7.6 2.6a4 4 0 0 0-.1 3 4.4 4.4 0 0 0-1.2 3c0 4.4 2.3 5.4 5 5.7-.8.7-.8 1.4-.8 2.4V21" {...s} />}
    </svg>
  );
}

function ConnectionBoxes({ p, onChanged }: { p: ProjectDetail; onChanged: () => void }) {
  const [open, setOpen] = useState<ConnKind | null>(null);
  const jira = p.integrations.find((i) => i.kind === "jira");
  const figma = p.integrations.find((i) => i.kind === "figma");
  const figmaChecks = figmaReports(figma);
  const figmaConnected = figmaChecks.filter((report) => report.connected);
  const github = p.integrations.find((i) => i.kind === "github");
  const viaAi = (i?: { config: Record<string, unknown>; has_secret: boolean }) => !!i && !i.has_secret && i.config.auth === "via-ai";
  const boxes: { kind: ConnKind; title: string; sub: string; state: "on" | "off" | "soon"; detail: string }[] = [
    { kind: "jira", title: "Jira", sub: "Tickets", state: jira?.has_secret ? "on" : "off", detail: jira?.has_secret ? "Connected" : "Click to connect" },
    { kind: "figma", title: "Figma", sub: "Designs",
      state: figmaConnected.length ? "on" : "off",
      detail: figmaConnected.length ? `Connected in ${figmaConnected.map((report) => AI_LABEL[report.client] ?? "your AI").join(" and ")}` : figmaChecks.length ? "Needs attention" : "Not verified" },
    { kind: "github", title: "GitHub", sub: "Pull requests",
      state: viaAi(github) && github!.config.connected ? "on" : "soon",
      detail: viaAi(github) ? (github!.config.connected ? "Connected via gh" : "gh not signed in") : "Via GitHub CLI" },
  ];
  const titles = { jira: "Connect Jira", figma: "Connect Figma" };
  return (
    <>
      <div className="conn-grid">
        {boxes.map((b) => (
          <button key={b.kind} type="button" className={`conn-box ${b.state}`} aria-label={`${b.title}: ${b.detail}`} disabled={b.kind === "github"} onClick={() => setOpen(b.kind)}>
            <span className="conn-top"><span className="conn-icon"><ConnIcon kind={b.kind} /></span><span className={`tag ${b.state === "on" ? "ok" : ""}`}>{b.state === "on" && <Check />}{b.detail}</span></span>
            <span className="conn-title">{b.title}</span>
            <span className="conn-sub">{b.sub}</span>
          </button>
        ))}
      </div>
      {(open === "jira" || open === "figma") && (
        <Dialog title={titles[open]} onClose={() => setOpen(null)}>
          {open === "jira" ? <SignInStep p={p} kind={open} onSaved={onChanged} /> : <FigmaStep p={p} />}
        </Dialog>
      )}
    </>
  );
}

const AI_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", copilot: "GitHub Copilot" };
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <button className="secondary" onClick={() => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}>{done ? "Copied" : "Copy"}</button>;
}

/* Low-cost test mode: no Opus/Sol by default. Applies to runs started after the change. */
function RoutingSwitch({ p, onChanged }: { p: ProjectDetail; onChanged: () => void }) {
  const [saving, setSaving] = useState(false);
  const value = p.caps.routing === "low-cost" ? "low-cost" : "standard";
  const change = async (routing: "standard" | "low-cost") => {
    if (routing === value) return;
    setSaving(true);
    try { await api.patchProject(p.id, { caps: { routing } }); onChanged(); } finally { setSaving(false); }
  };
  return <span className="routing-switch" title="Low-cost test mode routes every stage to Haiku or Sonnet (Luna or Terra on Codex). Applies to runs started after the change.">
    Models <Seg label="Model routing" value={value} onChange={(v) => { if (!saving) void change(v); }} options={[["standard", "Standard"], ["low-cost", "Low-cost test"]]} />
  </span>;
}

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return <div className="seg" role="group" aria-label={label}>{options.map(([v, l]) => <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>)}</div>;
}

const SETUP_FILES = [["claude", "Claude Code"], ["codex", "Codex"], ["vscode", "VS Code"], ["agent", "Copilot agent"]] as [string, string][];
const SETUP_PATHS: Record<string, string> = { claude: ".mcp.json", codex: ".codex/config.toml", vscode: ".vscode/mcp.json", agent: ".github/agents/agents-dashboard.agent.md" };

function AgentSetup({ p, onChanged }: { p: ProjectDetail; onChanged: () => void }) {
  const c = p.connect;
  const [method, setMethod] = useState<"setup" | "files" | "cli">("setup");
  const [shell, setShell] = useState<"ps" | "sh">(navigator.platform.startsWith("Win") ? "ps" : "sh");
  const [file, setFile] = useState("claude");
  const [rotating, setRotating] = useState(false);
  const rotate = async () => { if (!confirm("Issue a new key? The current setup command and config files stop working.")) return; setRotating(true); try { await api.rotateKey(p.id); onChanged(); } finally { setRotating(false); } };
  const agents: [ConnKind, string, string | null][] = [["claude", "Claude Code", p.claude_connected_at], ["codex", "Codex", p.codex_connected_at], ["copilot", "GitHub Copilot", p.copilot_connected_at]];
  const cmd = shell === "ps" ? c.setup_ps : c.setup_sh;
  const content: Record<string, string> = { claude: c.mcp_json, codex: c.codex_toml, vscode: c.vscode_json, agent: "" };
  const download: Record<string, string> = { claude: c.download_claude, codex: c.download_codex, vscode: c.download_vscode, agent: c.download_copilot_agent };
  const cli: [string, string][] = [["Claude Code", c.claude], ["Codex", c.codex], ["Copilot CLI", c.copilot], ["VS Code: MCP: Add Server → HTTP", c.copilot_url]];
  return (
    <section className="setup-card" aria-label="Connect coding agents">
      <div className="setup-head">
        <ul className="agent-pills" aria-label="Coding agent status">
          {agents.map(([kind, name, at]) => (
            <li key={kind} className={at ? "on" : ""} aria-label={`${name}: ${at ? "Connected" : "Not connected"}`}>
              <ConnIcon kind={kind} /><strong>{name}</strong><span>{at && <Check />}{at ? "Connected" : "Not connected"}</span>
            </li>
          ))}
        </ul>
        <Seg label="Connection method" value={method} onChange={setMethod} options={[["setup", "Setup command"], ["files", "Config files"], ["cli", "CLI"]]} />
      </div>
      {method === "setup" && <>
        <div className="setup-sub"><p>Run once in your project folder, then start a new chat.</p><Seg label="Shell" value={shell} onChange={setShell} options={[["ps", "PowerShell"], ["sh", "bash"]]} /></div>
        <div className="setup-cmd"><code>{cmd}</code><CopyButton text={cmd} /></div>
      </>}
      {method === "files" && <>
        <div className="setup-sub"><p>Save as <code>{SETUP_PATHS[file]}</code> in your project folder.</p><Seg label="File" value={file} onChange={setFile} options={SETUP_FILES} /></div>
        {content[file] && <pre className="setup-file">{content[file]}</pre>}
        <div className="row setup-actions">{content[file] && <CopyButton text={content[file]} />}<a className="button-secondary" href={download[file]} download>Download</a></div>
      </>}
      {method === "cli" && <div className="setup-cli">
        {cli.map(([label, text]) => <div key={label}><span>{label}</span><div className="setup-cmd"><code>{text}</code><CopyButton text={text} /></div></div>)}
      </div>}
      <button className="link setup-key" disabled={rotating} onClick={rotate}>Issue a new key</button>
    </section>
  );
}

function RunsPage({ runs, initialStatus }: { runs: Run[]; initialStatus: string }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [client, setClient] = useState("");
  const visible = runs.filter((r) => (!status || r.status === status) && (!client || r.client === client) && `${r.title} ${r.goal} ${r.project_name ?? ""} ${r.number}`.toLowerCase().includes(query.toLowerCase()));
  return <><PageHeader title="Runs" />
    <RunSummary runs={runs}><MetricCard label="Total runs" value={runs.length} icon="runs" /><MetricCard label="In progress" value={runs.filter((r) => r.status === "running").length} icon="clock" /><MetricCard label="Completed" value={runs.filter((r) => r.status === "done").length} icon="check" tone="ok" /><MetricCard label="Awaiting approval" value={runs.filter((r) => r.status === "awaiting_approval").length} icon="approval" tone="warn" /></RunSummary>
    <div className="filter-bar"><label className="search-field"><Icon name="search" /><input aria-label="Search runs" placeholder="Search runs or tickets…" value={query} onChange={(e) => setQuery(e.target.value)} /></label><select aria-label="Run status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{Object.entries(STATUS_LABEL).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><select aria-label="AI client" value={client} onChange={(e) => setClient(e.target.value)}><option value="">All AI clients</option><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="copilot">GitHub Copilot</option></select>{(query || status || client) && <button className="link" onClick={() => { setQuery(""); setStatus(""); setClient(""); }}>Clear filters</button>}<span className="results-count">{visible.length} of {runs.length} runs</span></div>
    {runs.length && !visible.length ? <EmptyState title="No matching runs" description="Try a different search or clear the filters." icon="search" /> : <RunsTable runs={visible} showProject />}
  </>;
}

function ApprovalInbox({ runs }: { runs: Run[] }) {
  const waiting = runs.filter((r) => r.status === "awaiting_approval");
  return <><PageHeader title="Approvals" actions={<span className={`tag ${waiting.length ? "warn" : ""}`}>{waiting.length} pending</span>} />
    {waiting.length ? <div className="inbox">{waiting.map((r) => <a key={r.id} className="inbox-card" href={`#/runs/${r.id}/review`}><span className="approval-icon"><Icon name="approval" /></span><span className="inbox-main"><span className="inbox-title">{runTitle(r)}</span><span className="muted">{r.project_name} · Run #{r.number || r.id}</span></span><span className="inbox-cta">Review document <Icon name="arrow" /></span></a>)}</div> : <EmptyState title="No pending approvals" icon="approval" />}
    {runs.length > 0 && <div className="approval-help"><Icon name="document" /><p>Previous decisions are in each project's <strong>Approvals</strong> tab.</p><a className="text-link" href="#/projects">Open projects <Icon name="arrow" /></a></div>}
  </>;
}

function runTitle(r: Run) {
  if (r.title) return r.title;
  const first = r.goal.split(/(?<=[.!?])\s|\n/)[0].trim();
  return first.length > 90 ? first.slice(0, 87) + "…" : first;
}

function RunsTable({ runs, showProject = false }: { runs: Run[]; showProject?: boolean }) {
  if (!runs.length) return <EmptyState title="No runs yet" description="Start a run from your connected coding agent." icon="runs" />;
  return (
    <div className="table-scroll" role="region" aria-label="Run history" tabIndex={0}>
    <table className="runs">
      <thead><tr><th>Run</th>{showProject && <th>Project</th>}<th>Goal</th><th>Status</th><th>Started</th><th>Duration</th><th>Cost</th><th>PR</th></tr></thead>
      <tbody>{runs.map((r) => (
        <tr key={r.id}>
          <td><a href={`#/runs/${r.id}`}>#{r.number || r.id}</a></td>
          {showProject && <td><a href={`#/projects/${r.project_id}`}>{r.project_name || r.project_id}</a></td>}
          <td><a className="run-title" href={`#/runs/${r.id}`} title={r.goal}>{runTitle(r)}</a><span className="muted" style={{ fontSize: 12 }}> · {AI_LABEL[r.client] ?? r.client}</span></td>
          <td><RunStatus run={r} />{r.status === "awaiting_approval" && <> <a className="approve-link" href={`#/runs/${r.id}/review`}>Review and approve</a></>}</td>
          <td>{utc(r.started_at).toLocaleString()}</td><td>{duration(r)}</td>
          <td><Cost usage={r.usage} /></td>
          <td>{r.pr_url ? <a href={r.pr_url} target="_blank">open</a> : "–"}</td>
        </tr>))}</tbody>
    </table>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = { running: "running", awaiting_approval: "awaiting approval", done: "done", failed: "failed", stopped: "stopped" };
const STAGE_LABEL: Record<string, string> = { "design-approval": "Design approval", ...Object.fromEntries(AGENTS.map((a) => [a.key, a.name])) };
STAGE_LABEL["onboard-reading"] = "Reading the project"; STAGE_LABEL["onboard-preparing"] = "Preparing AGENTS.md"; STAGE_LABEL["onboard-writing"] = "Writing AGENTS.md";

/* "running · Implementation", "awaiting approval", "done", "failed at Independent tests" */
function RunStatus({ run }: { run: Run }) {
  const st = run.current_stage;
  const live = run.status === "running" || run.status === "awaiting_approval";
  const where = st ? (STAGE_LABEL[st.name] ?? st.name) : "";
  const detail = !st ? "" : run.status === "running" ? ` · ${where}` : run.status === "failed" ? ` at ${where}` : run.status === "stopped" ? ` after ${where}` : "";
  return <span className={`status ${run.status}`} title={isCompletedPreview(run) ? undefined : isManuallyCompleted(run) ? "Closed manually; execution history is preserved." : st?.notes || undefined}>{live && run.status === "running" && <span className="dot running" style={{ width: 6, height: 6, boxShadow: "none", marginRight: 6 }} />}{isManuallyCompleted(run) ? "completed manually" : STATUS_LABEL[run.status] ?? run.status}{detail}</span>;
}

/* The API stores UTC without a zone marker; treat bare timestamps as UTC. */
function utc(s: string) {
  return new Date(/Z$|[+-]\d\d:\d\d$/.test(s) ? s : s + "Z");
}

function duration(r: Run) {
  const end = r.finished_at ? utc(r.finished_at) : new Date();
  const m = (end.getTime() - utc(r.started_at).getTime()) / 60000;
  return `${m.toFixed(1)} min`;
}

function RunPage({ id }: { id: number }) {
  const fetcher = useCallback(() => api.run(id), [id]);
  const { data: r, error, reload } = usePolling(fetcher, 4000);
  if (!r) return error ? <ErrorNotice message={error} onRetry={reload} /> : <LoadingState />;
  const phases: Phase[] = r.phases ?? [];
  const preview = isCompletedPreview(r);
  const manual = isManuallyCompleted(r);
  const summary = preview ? String(r.usage._preview_summary_md || "") : r.summary_md;
  const title = manual ? "Manually completed" : r.status === "running" ? "Agents are working…" : r.status === "awaiting_approval" ? "Waiting for your approval" : r.status === "done" ? "Run completed" : "Run stopped";
  const approvals = r.approvals ?? [];
  const ran = new Set(phases.map((phase) => phase.name).filter((n) => AGENTS.some((a) => a.key === n))).size;
  const costs = (r.agents ?? []).map((a) => a.est_cost_usd).filter((v): v is number => v != null);
  const costSum = costs.reduce((x, y) => x + y, 0);
  const cost = costs.length ? ` · ${fmtCost(costSum)} est.` : "";
  const agentTokens = (r.agents ?? []).reduce((x, a) => x + (a.tokens ?? 0), 0);
  // Until finish_run reports run totals, show the agents' totals so far, labelled as a partial estimate.
  const usage = r.usage.cost_usd == null && costs.length
    ? { ...r.usage, cost_usd: costSum, cost_kind: "estimate (partial)", total_tokens: r.usage.total_tokens ?? agentTokens,
        cost_note: "Sum of the agents' estimates so far, from their reported tokens at list prices. Not a bill." }
    : r.usage;
  const agentCosts: AgentCost[] = AGENTS.flatMap((ag) => {
    const a = r.agents?.find((x) => x.stage === ag.key);
    if (!a || (!a.started_at && a.tokens == null && a.duration_ms == null)) return [];  // not run yet
    return [{ name: ag.name, model: a.model || plannedLabel(a.planned_model), tokens: a.tokens, cost: a.est_cost_usd,
              time: a.duration_ms != null ? fmtMs(a.duration_ms) : a.ended_at ? "—" : "running" }];
  });
  const sub = preview ? `${AGENTS.length} agents · ${duration(r)}` : phases.length ? `${ran} of ${AGENTS.length} agents · ${duration(r)}${cost}` : r.finished_at ? "No agents reported" : "Waiting for the first agent report";
  return (
    <>
      <PageHeader title={runTitle(r)} breadcrumbs={[{ label: "Runs", href: "#/runs" }, { label: r.project_name || "Project", href: `#/projects/${r.project_id}` }]} description={`Run #${r.number || r.id} · ${AI_LABEL[r.client] ?? r.client} · ${utc(r.started_at).toLocaleString()}`} />
      {error && <ErrorNotice message={error} onRetry={reload} />}
      {r.goal !== runTitle(r) && <details className="request"><summary className="muted">Full request</summary><pre>{r.goal}</pre></details>}
      <div className="meta">
        <span><strong>Status</strong> <RunStatus run={r} /></span>
        {r.routing === "low-cost" && <span><strong>Models</strong> <span className="tag warn">Low-cost test mode</span></span>}
        {r.branch && <span><strong>Branch</strong> {r.branch}</span>}
        {r.pr_url && <span><a href={r.pr_url} target="_blank">Open pull request</a></span>}
      </div>
      {approvals.length > 0 && <ApprovalCard run={r} approvals={approvals} />}
      <div className="grid run-detail-grid">
        <Roster run={r} title={title} subtitle={sub} />
        <section>
          <RunUsage usage={usage} duration={duration(r)} agents={agentCosts} />
          <h2>Summary</h2>
          {summary ? <div className="panel run-summary">{manual ? <>
            <p className="closure-note">Closed manually. Stage results reflect the work recorded before closure.</p>
            <details className="execution-report"><summary>Execution report</summary><Markdown text={summary} runSummary /></details>
          </> : <Markdown text={summary} runSummary />}</div> : <EmptyState title="No summary yet" icon="document" />}
        </section>
      </div>
    </>
  );
}

/* ---------- design document approval ---------- */

/* Small Markdown renderer: headings, lists, tables, code, bold/italic/inline code. No HTML passthrough. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g).filter(Boolean);
  return <>{parts.map((s, i) => s.startsWith("**") ? <strong key={i}>{s.slice(2, -2)}</strong> : s.startsWith("`") ? <code key={i}>{s.slice(1, -1)}</code> : s.startsWith("*") ? <em key={i}>{s.slice(1, -1)}</em> : <span key={i}>{s}</span>)}</>;
}

const missingReportValue = (value = "") => /^(?:\?|not reported|unavailable|n\/a|—|–|-)?$/i.test(value.trim());

function StageSummaryTable({ head, rows, outcomes }: { head: string[]; rows: string[][]; outcomes: Record<string, string> }) {
  const isTotal = (row: string[]) => /^\*\*Total\*\*/i.test(row[0]);
  const stages = rows.filter((row) => !isTotal(row));
  const columns = head.map((_, index) => index).filter((index) => index === 0 || stages.some((row) => !missingReportValue(row[index])));
  const hasOutcomes = Object.keys(outcomes).length > 0;
  const visibleRows = rows.filter((row) => !isTotal(row) || columns.some((column) => column >= 3));
  const cell = (value: string) => missingReportValue(value) ? <span className="report-missing" aria-label="Not reported" title="Not reported">—</span> : <Inline text={value} />;
  return <>
    <div className="md-table-scroll" role="region" aria-label="Stage results" tabIndex={0}>
      <table className="md stage-summary-table">
        <thead><tr><th scope="col">Stage</th>{hasOutcomes && <th scope="col">Outcome</th>}{columns.slice(1).map((column) => <th key={column} scope="col">{head[column]}</th>)}</tr></thead>
        <tbody>{visibleRows.map((row, index) => <tr key={index} className={isTotal(row) ? "stage-total" : undefined}>
          <th scope="row">{isTotal(row) ? row[0].replaceAll("**", "") : <Inline text={STAGE_LABEL[row[0]] ?? row[0]} />}</th>
          {hasOutcomes && <td className="stage-outcome">{isTotal(row) ? "" : cell(outcomes[row[0]] ?? "")}</td>}
          {columns.slice(1).map((column) => <td key={column} className={column >= 3 ? "stage-number" : undefined}>{cell(row[column] ?? "")}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
    {columns.length === 1 && <p className="stage-usage-note">No stage usage reported.</p>}
  </>;
}

/* `changed(from, to)` says whether any source line in [from, to) changed since the previous version; such blocks get highlighted. */
function Markdown({ text, changed, runSummary = false }: { text: string; changed?: (from: number, to: number) => boolean; runSummary?: boolean }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: React.ReactNode[] = [];
  let i = 0, k = 0;
  const isTable = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const cls = (from: number, base = "") => [base, changed?.(from, i) ? "chg" : ""].filter(Boolean).join(" ") || undefined;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const from = i;
    if (l.startsWith("```")) { const buf: string[] = []; i++; while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]); i++; out.push(<pre key={k++} className={cls(from)}>{buf.join("\n")}</pre>); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { i++; const L = Math.min(h[1].length + 1, 4); const c = cls(from); out.push(L === 2 ? <h2 key={k++} className={c}><Inline text={h[2]} /></h2> : L === 3 ? <h3 key={k++} className={c}><Inline text={h[2]} /></h3> : <h4 key={k++} className={c}><Inline text={h[2]} /></h4>); continue; }
    if (isTable(l)) {
      const rows: string[][] = [];
      while (i < lines.length && isTable(lines[i])) { const cells = lines[i].trim().slice(1, -1).split("|").map((c) => c.trim()); if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells); i++; }
      const [head, ...body] = rows;
      if (!head) continue;
      if (runSummary && head.join("|").toLowerCase() === "phase|agent|model|tokens|calls|time|est. cost") {
        const stageKeys = new Set(body.map((row) => row[0]));
        const outcomes: Record<string, string> = {};
        let next = i;
        while (next < lines.length && !lines[next].trim()) next++;
        while (next < lines.length) {
          const outcome = /^- \*\*([^*]+)\*\*:\s*(.*)$/.exec(lines[next]);
          if (!outcome || !stageKeys.has(outcome[1])) break;
          outcomes[outcome[1]] = outcome[2]; next++;
        }
        if (Object.keys(outcomes).length) i = next;
        out.push(<StageSummaryTable key={k++} head={head} rows={body} outcomes={outcomes} />);
      } else out.push(<div key={k++} className={cls(from, "md-table-scroll")} role="region" aria-label="Report table" tabIndex={0}><table className="md"><thead><tr>{head.map((c, j) => <th key={j} scope="col"><Inline text={c} /></th>)}</tr></thead><tbody>{body.map((r, j) => <tr key={j}>{r.map((c, m) => <td key={m}><Inline text={c} /></td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d+[.)]\s+/.test(l); const items: { text: string; at: number }[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) { items.push({ text: lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ""), at: i }); i++; }
      // list items are highlighted one by one, so a single new bullet does not light up the whole list
      const li = items.map((s, j) => <li key={j} className={changed?.(s.at, s.at + 1) ? "chg" : undefined}><Inline text={s.text} /></li>);
      out.push(ordered ? <ol key={k++}>{li}</ol> : <ul key={k++}>{li}</ul>);
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s|^```|^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) && !isTable(lines[i])) buf.push(lines[i++]);
    out.push(<p key={k++} className={cls(from)}><Inline text={buf.join(" ")} /></p>);
  }
  return <div className="md-body">{out}</div>;
}

const MAX_ROUNDS = 3;
const APPROVAL_LABEL: Record<string, string> = { pending: "Waiting for your decision", approved: "Approved", changes_requested: "Changes requested" };
const APPROVAL_STATUS: Record<string, string> = { pending: "awaiting_approval", approved: "done", changes_requested: "failed" };
const APPROVAL_MARK: Record<string, string> = { pending: "●", approved: "✓", changes_requested: "↩" };

function ago(s: string) {
  const m = Math.round((Date.now() - utc(s).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : utc(s).toLocaleDateString();
}

/* Run page: a compact pointer to the review page. */
function ApprovalCard({ run, approvals }: { run: Run; approvals: Approval[] }) {
  const a = approvals[approvals.length - 1];
  const pending = a.status === "pending";
  return (
    <a className={`approval-card ${a.status}`} href={`#/runs/${run.id}/review`}>
      <span className={`status ${APPROVAL_STATUS[a.status]}`}>{APPROVAL_LABEL[a.status]}</span>
      <span className="approval-card-text"><strong>Design document v{a.version}</strong>
        <span className="muted"> · {pending ? `submitted ${ago(a.created_at)}` : `${a.decided_by}, ${utc(a.decided_at!).toLocaleString()}`}</span></span>
      <span className="approval-card-cta">{pending ? "Review and decide →" : "Open →"}</span>
    </a>
  );
}

/* Project page, Approvals tab: waiting documents as cards, decided ones as a history table. */
function ApprovalsTab({ rows }: { rows: ApprovalRow[] }) {
  if (!rows.length) return <EmptyState title="No design documents yet" icon="document" />;
  const byRun = new Map<number, ApprovalRow[]>();
  for (const a of [...rows].reverse()) byRun.set(a.run_id, [...(byRun.get(a.run_id) ?? []), a]);  // oldest version first
  const all = [...byRun.values()].sort((x, y) => y[y.length - 1].id - x[x.length - 1].id);
  const last = (v: ApprovalRow[]) => v[v.length - 1];
  const waiting = all.filter((v) => last(v).status === "pending");
  const past = all.filter((v) => last(v).status !== "pending");
  const title = (a: ApprovalRow) => a.run_title || a.run_goal.split(/(?<=[.!?])\s|\n/)[0].slice(0, 90);
  return (
    <>
      <h2>Waiting for you</h2>
      {waiting.length ? (
        <div className="inbox">
          {waiting.map((v) => {
            const a = last(v), prev = v[v.length - 2];
            return (
              <a key={a.id} className="inbox-card" href={`#/runs/${a.run_id}/review`}>
                <span className="dot running" />
                <span className="inbox-main">
                  <span className="inbox-title">Run #{a.run_number} · {title(a)}</span>
                  <span className="muted">Version {a.version} of {MAX_ROUNDS} · submitted {ago(a.created_at)}</span>
                  {prev?.status === "changes_requested" && <span className="inbox-prev">↩ {prev.decided_by} asked: {plainLine(prev.comment.split("\n")[0]).slice(0, 140)}</span>}
                </span>
                <span className="inbox-cta">Review →</span>
              </a>
            );
          })}
        </div>
      ) : <div className="empty">Nothing is waiting for a decision.</div>}
      {past.length > 0 && (
        <>
          <h2>Past</h2>
          <div className="table-scroll" role="region" aria-label="Approval history" tabIndex={0}>
          <table className="runs">
            <thead><tr><th>Run</th><th>History</th><th>Decided</th><th></th></tr></thead>
            <tbody>{past.map((v) => {
              const a = last(v);
              return (
                <tr key={a.id}>
                  <td><a className="run-title" href={`#/runs/${a.run_id}`}>#{a.run_number} {title(a)}</a></td>
                  <td><span className="chips">{v.map((x) => <span key={x.id} className={`chip ${x.status}`} title={x.comment || undefined}>v{x.version} {APPROVAL_MARK[x.status]} {x.decided_by}</span>)}</span></td>
                  <td className="muted">{a.decided_at ? utc(a.decided_at).toLocaleString() : "–"}</td>
                  <td><a className="approve-link" style={{ color: "var(--accent)" }} href={`#/runs/${a.run_id}/review`}>View</a></td>
                </tr>
              );
            })}</tbody>
          </table>
          </div>
        </>
      )}
    </>
  );
}

/* ---------- review page: one design document, its sections, changes and the decision ---------- */

type DocSection = { title: string; head: number | null; start: number; end: number };

/* Splits a design document at its main headings. A single "# Title" above "##" sections is the title, not a section.
   Documents written with bold lines ("**Goal**") instead of headings are split at those. */
function splitSections(lines: string[]): { title: string | null; titleLine: number | null; sections: DocSection[] } {
  const heads: { i: number; level: number; text: string }[] = [];
  const bolds: { i: number; text: string }[] = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (l.startsWith("```")) { fence = !fence; return; }
    if (fence) return;
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) heads.push({ i, level: h[1].length, text: h[2].replace(/\*\*/g, "") });
    const b = /^\*\*([^*]+?)\*\*:?\s*$/.exec(l.trim());
    if (b) bolds.push({ i, text: b[1] });
  });
  let titleLine: number | null = null, title: string | null = null, cuts: { i: number; text: string }[] = [];
  if (heads.length) {
    const h1 = heads.filter((h) => h.level === 1);
    const level = h1.length === 1 && heads.some((h) => h.level === 2) ? 2 : Math.min(...heads.map((h) => h.level));
    if (level === 2 && h1.length === 1) { titleLine = h1[0].i; title = h1[0].text; }
    cuts = heads.filter((h) => h.level === level);
  } else cuts = bolds;
  const sections: DocSection[] = [];
  const first = cuts.length ? cuts[0].i : lines.length;
  if (lines.slice(0, first).some((l, i) => i !== titleLine && l.trim())) sections.push({ title: "Overview", head: null, start: 0, end: first });
  cuts.forEach((c, k) => sections.push({ title: c.text, head: c.i, start: c.i + 1, end: k + 1 < cuts.length ? cuts[k + 1].i : lines.length }));
  return { title, titleLine, sections };
}

/* Line diff (longest common subsequence). Returns the new lines that were added and the old lines that were removed,
   each removal anchored at the new-line index where it happened. Documents are a few hundred lines, so O(n·m) is fine. */
function lineDiff(a: string[], b: string[]) {
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i].trimEnd() === b[j].trimEnd() ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const added = new Set<number>(), removed: { at: number; text: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i].trimEnd() === b[j].trimEnd()) { i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) removed.push({ at: j, text: a[i++] });
    else added.add(j++);
  }
  while (i < n) removed.push({ at: m, text: a[i++] });
  while (j < m) added.add(j++);
  return { added, removed: removed.filter((r) => r.text.trim()) };
}

/* One Markdown line as plain text: no bullet or heading marker, table cells joined with "·". */
const plainLine = (l: string) => {
  const t = l.trim();
  if (/^\|.*\|$/.test(t)) return t.slice(1, -1).split("|").map((c) => c.trim()).join(" · ");
  return t.replace(/^([-*•]|\d+[.)]|#+)\s+/, "");
};

const readNotes =(key: string): Record<string, string> => { try { return JSON.parse(localStorage.getItem(key) ?? "{}"); } catch { return {}; } };
const writeNotes = (key: string, notes: Record<string, string>) => {
  try { if (Object.keys(notes).length) localStorage.setItem(key, JSON.stringify(notes)); else localStorage.removeItem(key); } catch { /* private window */ }
};

function ReviewPage({ id }: { id: number }) {
  const fetcher = useCallback(() => api.run(id), [id]);
  const { data: r, error, reload } = usePolling(fetcher, 4000);
  if (!r) return error ? <ErrorNotice message={error} onRetry={reload} /> : <LoadingState />;
  const approvals = r.approvals ?? [];
  if (!approvals.length) return (
    <>
      <h1>Design document<small>Run #{r.number || r.id} · <a href={`#/runs/${r.id}`}>{runTitle(r)}</a></small></h1>
      <div className="empty">No design document submitted yet.</div>
    </>
  );
  return <>{error && <ErrorNotice message={error} onRetry={reload} />}<Review key={`${r.id}:${r.started_at}:${approvals[approvals.length - 1].version}`} run={r} approvals={approvals} onDecided={reload} /></>;
}

function Review({ run, approvals, onDecided }: { run: Run; approvals: Approval[]; onDecided: () => void }) {
  const latest = approvals[approvals.length - 1];
  const [shown, setShown] = useState(latest.version);
  const [showChanges, setShowChanges] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  // Include creation time so a reset database cannot reuse a previous run's drafts.
  const draftKey = (v: number) => `review-notes:${run.id}:${run.started_at}:v${v}`;
  const [draft, setDraft] = useState(() => ({ key: draftKey(latest.version), notes: readNotes(draftKey(latest.version)) }));
  useEffect(() => writeNotes(draft.key, draft.notes), [draft]);
  const setNote = (title: string, text: string) => setDraft((d) => {
    const notes = { ...d.notes };
    if (text.trim()) notes[title] = text.trim(); else delete notes[title];
    return { ...d, notes };
  });

  const doc = approvals.find((a) => a.version === shown) ?? latest;
  const prev = approvals.find((a) => a.version === doc.version - 1);
  const editable = latest.status === "pending" && doc.version === latest.version;
  const notes = editable ? draft.notes : doc.section_comments ?? {};
  const lines = doc.content_md.replace(/\r/g, "").split("\n");
  const { title, titleLine, sections } = splitSections(lines);
  const diff = prev && showChanges ? lineDiff(prev.content_md.replace(/\r/g, "").split("\n"), lines) : null;
  const inSection = (s: DocSection, at: number) => at >= (s.head ?? s.start) && (at < s.end || (s === sections[sections.length - 1] && at >= s.end));
  const removedIn = (s: DocSection) => diff?.removed.filter((r) => inSection(s, r.at)) ?? [];
  const addedIn = (s: DocSection) => !!diff && [...diff.added].some((at) => at >= (s.head ?? s.start) && at < s.end);
  const jump = (t: string) => document.getElementById(`sec-${sections.findIndex((s) => s.title === t)}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <>
      <PageHeader title="Design review" breadcrumbs={[{ label: "Approvals", href: "#/approvals" }, { label: run.project_name || "Project", href: `#/projects/${run.project_id}/approvals` }]} description={`Run #${run.number || run.id} · ${runTitle(run)}`} actions={<a className="button-secondary" href={`#/runs/${run.id}`}>View run <Icon name="arrow" /></a>} />
      <div className="review-bar">
        {approvals.length > 1 && (
          <span className="tabs">{approvals.map((a) => (
            <button key={a.version} className={shown === a.version ? "" : "secondary"} onClick={() => { setShown(a.version); setEditing(null); }}>v{a.version} {APPROVAL_MARK[a.status]}</button>
          ))}</span>
        )}
        <span className={`status ${APPROVAL_STATUS[doc.status]}`}>v{doc.version}: {APPROVAL_LABEL[doc.status]}</span>
        {prev && <label className="switch"><input type="checkbox" checked={showChanges} onChange={(e) => setShowChanges(e.target.checked)} /> Show what changed since v{prev.version}</label>}
      </div>
      {prev?.status === "changes_requested" && (
        <div className="comment-box"><strong>{prev.decided_by} asked for these changes in v{prev.version}:</strong><div className="pre-line">{prev.comment}</div></div>
      )}
      <div className="review">
        <div className="review-nav" role="navigation" aria-label="Sections">
          <span className="review-nav-label">Sections</span>
          {sections.map((s) => (
            <button key={s.title} className="review-nav-item" onClick={() => jump(s.title)}>
              <span>{s.title}</span>
              {(addedIn(s) || removedIn(s).length > 0) && <span className="chg-dot" title="Changed since the previous version" />}
              {notes[s.title] && <span className="note-dot" title="Has a note">✎</span>}
            </button>
          ))}
        </div>
        <article className="review-doc">
          {title && <p className={`doc-title ${diff?.added.has(titleLine!) ? "chg" : ""}`}>{title}</p>}
          {sections.map((s, n) => {
            const body = lines.slice(s.start, s.end).map((l, k) => (s.start + k === titleLine ? "" : l)).join("\n");
            const removed = removedIn(s);
            return (
              <section key={n} id={`sec-${n}`} className="doc-sec">
                <div className="sec-head">
                  <h2 className={s.head !== null && diff?.added.has(s.head) ? "chg" : undefined}>{s.title}</h2>
                  {editable && editing !== s.title && <button className="link" onClick={() => setEditing(s.title)}>{notes[s.title] ? "Edit note" : "+ Note"}</button>}
                </div>
                {editing === s.title
                  ? <NoteEditor initial={notes[s.title] ?? ""} onSave={(t) => { setNote(s.title, t); setEditing(null); }} onCancel={() => setEditing(null)} />
                  : notes[s.title] && <div className="note"><span className="note-label">{editable ? "Your note" : `${doc.decided_by}'s note`}</span>{notes[s.title]}</div>}
                <Markdown text={body} changed={diff ? (a, b) => { for (let x = s.start + a; x < s.start + b; x++) if (diff.added.has(x)) return true; return false; } : undefined} />
                {removed.length > 0 && (
                  <div className="removed"><span className="removed-label">Removed since v{prev!.version}</span>{removed.map((r, k) => <del key={k}>{plainLine(r.text)}</del>)}</div>
                )}
              </section>
            );
          })}
        </article>
        <aside className="review-side">
          <TicketBox run={run} />
          <DecisionBox run={run} latest={latest} viewing={doc.version} notes={editable ? draft.notes : {}} onJump={jump}
            onShowLatest={() => setShown(latest.version)} onClearNotes={() => setDraft((d) => ({ ...d, notes: {} }))} onDecided={onDecided} />
        </aside>
      </div>
    </>
  );
}

function NoteEditor({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  return (
    <div className="note-editor">
      <textarea rows={3} autoFocus placeholder="What should change in this section? Goes to the agent word for word." value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onSave(text); if (e.key === "Escape") onCancel(); }} />
      <div className="row" style={{ margin: 0 }}>
        <button onClick={() => onSave(text)}>Save note</button>
        {initial && <button className="secondary" onClick={() => onSave("")}>Remove</button>}
        <button className="link" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function TicketBox({ run }: { run: Run }) {
  const tickets = run.tickets ?? [];
  return (
    <div className="side-box">
      <h3>Ticket</h3>
      {tickets.length ? tickets.map((t) => (
        <div key={t.key} className="ticket">
          <div><span className="ticket-key">{t.key}</span> {t.title || <span className="muted">not read by the dashboard yet</span>}</div>
          {t.figma_urls.map((u, i) => <a key={u} className="figma-link" href={u} target="_blank" rel="noreferrer"><ConnIcon kind="figma" /> Open Figma design{t.figma_urls.length > 1 ? ` ${i + 1}` : ""} ↗</a>)}
          {t.title && !t.figma_urls.length && <span className="muted" style={{ fontSize: 12 }}>No Figma link in the ticket.</span>}
        </div>
      )) : <p className="muted" style={{ margin: 0, fontSize: 12 }}>No ticket key in the request.</p>}
      <details className="request"><summary className="muted">Full request</summary><pre>{run.goal}</pre></details>
    </div>
  );
}

function DecisionBox({ run, latest, viewing, notes, onJump, onShowLatest, onClearNotes, onDecided }: {
  run: Run; latest: Approval; viewing: number; notes: Record<string, string>;
  onJump: (title: string) => void; onShowLatest: () => void; onClearNotes: () => void; onDecided: () => void;
}) {
  const [name, setName] = useState(() => { try { return localStorage.getItem("approver-name") ?? ""; } catch { return ""; } });
  const [comment, setComment] = useState("");
  const [mode, setMode] = useState<"idle" | "changes">("idle");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const noteList = Object.entries(notes);

  if (latest.status !== "pending") return (
    <div className={`side-box decided ${latest.status}`}>
      <h3>{latest.status === "approved" ? <><Check /> Approved</> : "↩ Sent back for changes"}</h3>
      <p>{latest.status === "approved"
        ? `${latest.decided_by} approved v${latest.version} on ${utc(latest.decided_at!).toLocaleString()}. The agents are working from this version.`
        : latest.version < MAX_ROUNDS ? `${latest.decided_by} asked for changes. The agent is revising and will submit v${latest.version + 1}; it shows up here.`
        : `${latest.decided_by} asked for changes in the last of ${MAX_ROUNDS} rounds, so the run stops here.`}</p>
      <a className="approve-link" style={{ margin: 0, color: "var(--accent)" }} href={`#/runs/${run.id}`}>Go to the run →</a>
    </div>
  );
  if (viewing !== latest.version) return (
    <div className="side-box">
      <h3>Your decision</h3>
      <p>You are looking at v{viewing}. Decisions are made on the newest version.</p>
      <button onClick={onShowLatest}>Go to v{latest.version}</button>
    </div>
  );

  const send = async (decision: "approved" | "changes_requested") => {
    setErr("");
    if (!name.trim()) { setErr("Type your name first, so the decision is recorded."); setConfirming(false); return; }
    if (decision === "changes_requested" && !comment.trim() && !noteList.length) { setErr("Write what should change, or add a note to a section."); return; }
    setBusy(true);
    try {
      try { localStorage.setItem("approver-name", name.trim()); } catch { /* ignore */ }
      await api.decide(run.id, latest.version, decision, name, comment, notes);
      onClearNotes(); setComment(""); setMode("idle"); setConfirming(false); onDecided();
    } catch (e) { setErr(String(e)); setConfirming(false); } finally { setBusy(false); }
  };

  return (
    <div className="side-box decide">
      <h3>Your decision</h3>
      <label className="field"><span>Your name</span><input placeholder="e.g. Priya (PO)" value={name} onChange={(e) => setName(e.target.value)} /></label>
      {noteList.length > 0 && (
        <div className="note-list">
          <strong>{noteList.length} section note{noteList.length > 1 ? "s" : ""}</strong>
          <ul>{noteList.map(([t, v]) => <li key={t}><button className="link" onClick={() => onJump(t)}>{t}</button> {v.length > 60 ? v.slice(0, 57) + "…" : v}</li>)}</ul>
        </div>
      )}
      {mode === "idle" ? (
        <>
          <button className="approve" disabled={busy || noteList.length > 0} onClick={() => { setErr(""); if (!name.trim()) setErr("Type your name first, so the decision is recorded."); else setConfirming(true); }}><Check /> Approve and start</button>
          {noteList.length > 0 && <p className="hint">You left notes. Send them back, or <button className="link" onClick={onClearNotes}>clear them</button> to approve.</p>}
          <button className="secondary" disabled={busy} onClick={() => setMode("changes")}>Request changes…</button>
        </>
      ) : (
        <>
          <label className="field"><span>{noteList.length ? "Anything else? (optional)" : "What should change?"}</span>
            <textarea rows={4} autoFocus placeholder="Goes to the agent word for word. Use + Note on a section for section-specific changes." value={comment} onChange={(e) => setComment(e.target.value)} /></label>
          <button disabled={busy} onClick={() => send("changes_requested")}>Send back for changes</button>
          <button className="link" disabled={busy} onClick={() => setMode("idle")}>Cancel</button>
        </>
      )}
      {err && <p className="err" style={{ margin: 0 }}>{err}</p>}
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>Round {latest.version} of {MAX_ROUNDS}</p>
      {confirming && (
        <Dialog title={`Approve design document v${latest.version}?`} onClose={() => setConfirming(false)}>
          <p style={{ marginTop: 0 }}>The agents start working from this version right away: they create the branch and implement it. Recorded as approved by <strong>{name.trim()}</strong>.</p>
          <div className="row" style={{ justifyContent: "flex-end", margin: 0 }}>
            <button className="secondary" onClick={() => setConfirming(false)}>Cancel</button>
            <button className="approve-btn" disabled={busy} autoFocus onClick={() => send("approved")}><Check /> Approve and start</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function ConnectPage() {
  return (
    <>
      <PageHeader title="Connection guide" actions={<a className="button-secondary" href="#/projects">Open projects <Icon name="arrow" /></a>} />
      <div className="setup-steps"><section className="panel"><span className="step-number">01</span><h2>Add your project</h2><p>Give it a name and optionally a GitHub URL. Open its Connections tab.</p><a className="text-link" href="#/projects">Go to projects <Icon name="arrow" /></a></section><section className="panel"><span className="step-number">02</span><h2>Connect your AI</h2><p>Copy the setup command from Connections and run it once in your project folder.</p><span className="tag">One-time setup</span></section><section className="panel"><span className="step-number">03</span><h2>Start a conversation</h2><p>Ask your AI to implement a ticket and review it. Follow the run and approve its design here.</p><code>implement ABC-123 and review it</code></section></div>
      <div className="grid guide-grid"><section className="panel"><div className="section-heading"><h2>Tools</h2><Icon name="connect" /></div><div className="guide-service"><ConnIcon kind="jira" /><div><h3>Jira</h3><p>Use Connect with Jira on the project page, or paste ticket text into your AI conversation.</p></div></div><div className="guide-service"><ConnIcon kind="figma" /><div><h3>Figma</h3><p>Authenticate the Figma server in your AI client. The project config includes it.</p></div></div><div className="guide-service"><ConnIcon kind="github" /><div><h3>GitHub</h3><p>Sign in to GitHub CLI in your project. Your AI asks before pushing code or opening a pull request.</p></div></div></section>
      <section className="panel"><div className="section-heading"><div><h2>Coding clients</h2><p>One setup command configures all three.</p></div><Icon name="code" /></div><div className="guide-service"><ConnIcon kind="claude" /><div><h3>Claude Code</h3><p>Start <code>claude</code> in the folder and approve the servers once.</p></div></div><div className="guide-service"><ConnIcon kind="codex" /><div><h3>Codex</h3><p>Trust the folder, then start a new session.</p></div></div><div className="guide-service"><ConnIcon kind="copilot" /><div><h3>GitHub Copilot</h3><p>Reload VS Code, start the servers and pick the Agents Dashboard agent.</p></div></div></section></div>
      <section className="panel workflow-guide"><div className="section-heading"><h2>Run stages</h2></div><AgentFlow /></section>
    </>
  );
}
