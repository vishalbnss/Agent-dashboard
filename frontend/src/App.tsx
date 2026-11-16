import { useCallback, useEffect, useState } from "react";
import { api, type DocumentRow, type Phase, type Project, type ProjectDetail, type Run, type RunAgent } from "./api";
import { AppShell } from "./components/AppShell";
import { AuthGate, useAuth } from "./components/Auth";
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
  return <AuthGate><Workspace /></AuthGate>;
}

function Workspace() {
  const route = useHash();
  const [pathname, query = ""] = route.split("?");
  const [seg, id, sub] = pathname.split("/");
  const { data, error, reload } = usePolling(loadWorkspace);
  const projects = data?.projects ?? [], runs = data?.runs ?? [];
  const detail = !!id && (seg === "projects" || seg === "runs");
  return <AppShell active={seg === "documents" ? "projects" : seg} projects={projects} runs={runs}>
    {error && <ErrorNotice message={error} onRetry={reload} />}
    {!data && !detail && seg !== "connect" && seg !== "documents" ? (!error && <LoadingState />)
      : seg === "projects" && id ? <ProjectPage key={id} id={+id} tab={sub} />
      : seg === "documents" && id ? <DocumentPage key={id} id={+id} />
      : seg === "runs" && id ? <RunPage key={id} id={+id} />
      : seg === "runs" ? <RunsPage key={query} runs={runs} initialStatus={new URLSearchParams(query).get("status") ?? ""} />
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
// Design approval is a human gate before them, given by the developer in the AI chat.
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
  const { readOnly } = useAuth();
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
  if (readOnly) return <span className="tag">Admin view · read-only</span>;
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
  return <>
    <PageHeader title="Workspace overview" actions={<AddProjectForm />} />
    <ProjectSummary projects={projects}>
      <MetricCard label="Projects" value={projects.length} icon="projects" href="#/projects" />
      <MetricCard label="Active runs" value={runs.filter((r) => r.status === "running").length} icon="runs" href="#/runs?status=running" />
      <MetricCard label="Stopped or failed" value={runs.filter((r) => r.status === "stopped" || r.status === "failed").length} icon="close" href="#/runs?status=stopped" />
      <MetricCard label="Completed runs" value={runs.filter((r) => r.status === "done").length} icon="check" tone="ok" href="#/runs?status=done" />
    </ProjectSummary>
    <section className="panel recent-panel"><div className="section-heading"><h2>Recent runs</h2><a className="text-link" href="#/runs">View all <Icon name="arrow" /></a></div>
        {runs.length ? <div className="recent-runs">{runs.slice(0, 6).map((r) => <a key={r.id} href={`#/runs/${r.id}`} className="recent-run"><span className={`run-marker ${r.status}`}><Icon name={r.status === "done" ? "check" : r.status === "awaiting_approval" ? "approval" : "runs"} /></span><span className="recent-run-main"><strong>{runTitle(r)}</strong><small>{r.project_name || "Project"} · Run #{r.number || r.id} · {ago(r.started_at)}</small></span><RunStatus run={r} /><Icon name="chevron" /></a>)}</div>
          : <EmptyState title="No runs yet" description={projects.length ? "Start a run from your connected coding agent." : "Add a project to start a run."} icon="runs" />}
    </section>
  </>;
}

function ProjectsPage({ projects, reload }: { projects: Project[]; reload: () => void }) {
  const { readOnly, user } = useAuth();
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
      <ul className="project-cards">{visible.map((p) => <li key={p.id} className="project-card"><div className="project-card-top"><span className="project-symbol"><Icon name="projects" /></span><span className={`tag ${isConnected(p) ? "ok" : ""}`}>{isConnected(p) ? "AI connected" : "Setup needed"}</span>{!readOnly && <button className="icon-button delete-project" aria-label={`Delete ${p.name}`} onClick={() => remove(p)}><Icon name="close" /></button>}</div><a className="project-card-title" href={`#/projects/${p.id}`}>{p.name}</a>{user?.role === "admin" && p.owner && <p className="project-owner"><Icon name="projects" />Owner: {p.owner}</p>}<p className="repo-label" title={p.repo_url || p.local_path}>{p.repo_url ? p.repo_url.replace(/^https?:\/\//, "") : p.local_path || "Repository details appear when your AI connects"}</p><div className="project-clients">{p.claude_connected_at && <span><ConnIcon kind="claude" />Claude Code</span>}{p.codex_connected_at && <span><ConnIcon kind="codex" />Codex</span>}{p.copilot_connected_at && <span><ConnIcon kind="copilot" />GitHub Copilot</span>}{!isConnected(p) && <span><Icon name="connect" />Ready to connect</span>}</div><div className="project-latest"><span className="eyebrow">LATEST ACTIVITY</span>{p.latest_run ? <><a href={`#/runs/${p.latest_run.id}`}>{runTitle(p.latest_run)}</a><RunStatus run={p.latest_run} /></> : <p>{p.agents_md ? "Project guide ready. Start your first run." : "Connect an AI to set up your project guide."}</p>}</div><div className="project-card-footer"><a href={`#/projects/${p.id}`}>Open project <Icon name="arrow" /></a></div></li>)}</ul>}
  </>;
}

type ProjectTab = "connections" | "tickets" | "documents" | "runs" | "logs";
const PROJECT_TABS: ProjectTab[] = ["connections", "tickets", "documents", "runs", "logs"];

function ProjectPage({ id, tab: routeTab }: { id: number; tab?: string }) {
  const fetcher = useCallback(() => Promise.all([api.project(id), api.runs(id), api.documents(id)]), [id]);
  const { data, error, reload } = usePolling(fetcher, 4000);
  return <>{error && <ErrorNotice message={error} onRetry={reload} />}{data ? <ProjectContent p={data[0]} runs={data[1]} documents={data[2]} routeTab={routeTab} load={reload} /> : !error && <LoadingState />}</>;
}

function ProjectContent({ p, runs, documents, routeTab, load }: { p: ProjectDetail; runs: Run[]; documents: DocumentRow[]; routeTab?: string; load: () => void }) {
  const id = p.id;
  // Pick the default once, so background refreshes never switch the selected tab.
  const [firstTab] = useState<ProjectTab>(() => !(p.claude_connected_at || p.codex_connected_at || p.copilot_connected_at) ? "connections" : "runs");
  const [deleteError, setDeleteError] = useState("");
  const { readOnly, user } = useAuth();
  const aiOn = p.claude_connected_at || p.codex_connected_at || p.copilot_connected_at;
  const tab = PROJECT_TABS.includes(routeTab as ProjectTab) ? (routeTab as ProjectTab) : firstTab ?? "runs";
  return (
    <>
      <PageHeader title={p.name} breadcrumbs={[{ label: "Projects", href: "#/projects" }]} actions={<>{user?.role === "admin" && p.owner && <span className="tag">Owner: {p.owner}</span>}<span className={`tag ${aiOn ? "ok" : "warn"}`}>{aiOn ? "AI connected" : "Setup needed"}</span></>} />
      {deleteError && <ErrorNotice message={deleteError} onRetry={() => setDeleteError("")} />}
      <div className="project-context"><span><Icon name="branch" />{p.repo_url || p.local_path || "Repository details will appear after connecting"}</span><span>{runs.length} runs</span><span>{documents.length} documents</span>
        {readOnly ? <span>Models: {p.caps.routing === "low-cost" ? "Low-cost test" : "Standard"}</span> : <RoutingSwitch p={p} onChanged={load} />}</div>
      <div className="ptabs" role="tablist">
        <a role="tab" aria-selected={tab === "connections"} href={`#/projects/${id}/connections`}>Connections</a>
        <a role="tab" aria-selected={tab === "tickets"} href={`#/projects/${id}/tickets`}>Tickets <span className="count">{p.tickets.length}</span></a>
        <a role="tab" aria-selected={tab === "documents"} href={`#/projects/${id}/documents`}>Documents <span className="count">{documents.length}</span></a>
        <a role="tab" aria-selected={tab === "runs"} href={`#/projects/${id}/runs`}>Runs <span className="count">{runs.length}</span></a>
        <a role="tab" aria-selected={tab === "logs"} href={`#/projects/${id}/logs`}>Logs</a>
      </div>
      {tab === "connections" && <><div className="section-heading"><h2>Connected tools</h2><a className="text-link" href="#/connect">Setup guide <Icon name="arrow" /></a></div><AgentSetup p={p} onChanged={load} /><ConnectionBoxes p={p} onChanged={load} /></>}
      {tab === "tickets" && <TicketsTab projectId={id} tickets={p.tickets} onChanged={load} readOnly={readOnly} />}
      {tab === "documents" && <DocumentsTab documents={documents} />}
      {tab === "runs" && <RunsTable runs={runs} />}
      {tab === "logs" && <LogsTab projectId={id} runs={runs} />}
      {!readOnly && <div className="project-danger"><button className="link" onClick={() => { if (confirm("Delete this project and its runs? Your code folder is not touched.")) api.deleteProject(id).then(() => (location.hash = "#/projects")).catch(() => setDeleteError("Could not delete this project. Please try again.")); }}>Delete project</button></div>}
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
  const { readOnly } = useAuth();
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
      {!readOnly && <button className="link setup-key" disabled={rotating} onClick={rotate}>Issue a new key</button>}
    </section>
  );
}

function RunsPage({ runs, initialStatus }: { runs: Run[]; initialStatus: string }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [client, setClient] = useState("");
  const visible = runs.filter((r) => (!status || r.status === status) && (!client || r.client === client) && `${r.title} ${r.goal} ${r.project_name ?? ""} ${r.number}`.toLowerCase().includes(query.toLowerCase()));
  return <><PageHeader title="Runs" />
    <RunSummary runs={runs}><MetricCard label="Total runs" value={runs.length} icon="runs" /><MetricCard label="In progress" value={runs.filter((r) => r.status === "running").length} icon="clock" /><MetricCard label="Completed" value={runs.filter((r) => r.status === "done").length} icon="check" tone="ok" /><MetricCard label="Stopped" value={runs.filter((r) => r.status === "stopped").length} icon="close" /></RunSummary>
    <div className="filter-bar"><label className="search-field"><Icon name="search" /><input aria-label="Search runs" placeholder="Search runs or tickets…" value={query} onChange={(e) => setQuery(e.target.value)} /></label><select aria-label="Run status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{Object.entries(STATUS_LABEL).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><select aria-label="AI client" value={client} onChange={(e) => setClient(e.target.value)}><option value="">All AI clients</option><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="copilot">GitHub Copilot</option></select>{(query || status || client) && <button className="link" onClick={() => { setQuery(""); setStatus(""); setClient(""); }}>Clear filters</button>}<span className="results-count">{visible.length} of {runs.length} runs</span></div>
    {runs.length && !visible.length ? <EmptyState title="No matching runs" description="Try a different search or clear the filters." icon="search" /> : <RunsTable runs={visible} showProject />}
  </>;
}

function runTitle(r: Run) {
  if (r.title) return r.title;
  const first = r.goal.split(/(?<=[.!?])\s|\n/)[0].trim();
  return first.length > 90 ? first.slice(0, 87) + "…" : first;
}

function RunsTable({ runs, showProject = false }: { runs: Run[]; showProject?: boolean }) {
  const showOwner = useAuth().user?.role === "admin";
  if (!runs.length) return <EmptyState title="No runs yet" description="Start a run from your connected coding agent." icon="runs" />;
  return (
    <div className="table-scroll" role="region" aria-label="Run history" tabIndex={0}>
    <table className="runs">
      <thead><tr><th>Run</th>{showProject && <th>Project</th>}{showOwner && <th>Owner</th>}<th>Goal</th><th>Status</th><th>Started</th><th>Duration</th><th>Cost</th><th>PR</th></tr></thead>
      <tbody>{runs.map((r) => (
        <tr key={r.id}>
          <td><a href={`#/runs/${r.id}`}>#{r.number || r.id}</a></td>
          {showProject && <td><a href={`#/projects/${r.project_id}`}>{r.project_name || r.project_id}</a></td>}
          {showOwner && <td>{r.project_owner || "–"}</td>}
          <td><a className="run-title" href={`#/runs/${r.id}`} title={r.goal}>{runTitle(r)}</a><span className="muted" style={{ fontSize: 12 }}> · {AI_LABEL[r.client] ?? r.client}</span></td>
          <td><RunStatus run={r} /></td>
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
  const { readOnly } = useAuth();
  if (!r) return error ? <ErrorNotice message={error} onRetry={reload} /> : <LoadingState />;
  const phases: Phase[] = r.phases ?? [];
  const preview = isCompletedPreview(r);
  const manual = isManuallyCompleted(r);
  const summary = preview ? String(r.usage._preview_summary_md || "") : r.summary_md;
  const title = manual ? "Manually completed" : r.status === "running" ? "Agents are working…" : r.status === "awaiting_approval" ? "Waiting for approval" : r.status === "done" ? "Run completed" : "Run stopped";
  const live = r.status === "running" || r.status === "awaiting_approval";
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
        {r.project_owner && <span><strong>Owner</strong> {r.project_owner}</span>}
        {live && !readOnly && <StopRun run={r} onStopped={reload} />}
      </div>
      <div className="grid run-detail-grid">
        <Roster run={r} title={title} subtitle={sub} />
        <section>
          <RunUsage usage={usage} duration={duration(r)} agents={agentCosts} />
          <h2>Summary</h2>
          {summary ? <div className="panel run-summary">{manual ? <>
            <p className="closure-note">Closed manually. Stage results reflect the work recorded before closure.</p>
            <details className="execution-report"><summary>Execution report</summary><Markdown text={summary} runSummary /></details>
          </> : <Markdown text={summary} runSummary />}</div> : <EmptyState title="No summary yet" icon="document" />}
          <h2>Documents</h2>
          {r.documents?.length ? <DocList documents={r.documents} /> : <EmptyState title="No documents yet" description="The design document and each stage's artifacts appear here as the agents save them." icon="document" />}
        </section>
      </div>
    </>
  );
}

/* ---------- Markdown ---------- */

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

function ago(s: string) {
  const m = Math.round((Date.now() - utc(s).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : utc(s).toLocaleDateString();
}

/* The run's status is the dashboard's record; the agent itself is stopped in the developer's AI session. */
function StopRun({ run, onStopped }: { run: Run; onStopped: () => void }) {
  const [err, setErr] = useState("");
  const stop = async () => {
    if (!confirm(`Mark run #${run.number || run.id} as stopped? This updates the dashboard only; stop the agent in your AI session too.`)) return;
    try { await api.stopRun(run.id); onStopped(); } catch { setErr("Could not stop the run. Try again."); }
  };
  return <span><button className="secondary" onClick={stop}>Stop run</button>{err && <span className="err"> {err}</span>}</span>;
}

/* ---------- documents: the design document and every stage artifact the agents uploaded ---------- */

const kb = (chars: number) => chars < 1024 ? `${chars} chars` : `${(chars / 1024).toFixed(1)} KB`;

function DocList({ documents }: { documents: DocumentRow[] }) {
  return <ul className="doc-list">{documents.map((d) => <li key={d.id}>
    <a href={`#/documents/${d.id}`}><Icon name="document" /><span className="doc-path">{d.path}</span></a>
    <span className="muted">{kb(d.chars)} · {ago(d.updated_at)}</span>
  </li>)}</ul>;
}

function DocumentsTab({ documents }: { documents: DocumentRow[] }) {
  if (!documents.length) return <EmptyState title="No documents yet" description="When a run starts, its design document and each stage's artifacts appear here." icon="document" />;
  const runs = new Map<number, DocumentRow[]>();
  for (const d of documents) runs.set(d.run_id, [...(runs.get(d.run_id) ?? []), d]);
  return <>{[...runs.entries()].map(([rid, docs]) => <section key={rid} className="panel doc-group">
    <div className="section-heading"><h2><a href={`#/runs/${rid}`}>Run #{docs[0].run_number ?? rid}</a>{docs[0].run_title ? ` · ${docs[0].run_title}` : ""}</h2><span className="count-pill">{docs.length}</span></div>
    <DocList documents={docs} />
  </section>)}</>;
}

function DocumentPage({ id }: { id: number }) {
  const fetcher = useCallback(async () => {
    const d = await api.document(id);
    return { d, run: await api.run(d.run_id) };
  }, [id]);
  const { data, error, reload } = usePolling(fetcher, 15000);
  if (!data) return error ? <ErrorNotice message={error} onRetry={reload} /> : <LoadingState />;
  const { d, run } = data;
  const isMd = /\.(md|markdown)$/i.test(d.path);
  const isJson = /\.json$/i.test(d.path);
  const pretty = isJson ? (() => { try { return JSON.stringify(JSON.parse(d.content), null, 2); } catch { return d.content; } })() : d.content;
  return <>
    <PageHeader title={d.path.split("/").pop() || d.path}
      breadcrumbs={[{ label: run.project_name || "Project", href: `#/projects/${run.project_id}/documents` }, { label: `Run #${run.number || run.id}`, href: `#/runs/${run.id}` }]}
      description={`${d.path} · updated ${ago(d.updated_at)}`} />
    <div className="panel doc-view">{isMd ? <Markdown text={d.content} /> : <pre className="doc-raw">{pretty}</pre>}</div>
    {(run.documents?.length ?? 0) > 1 && <><h2>Other documents of this run</h2><DocList documents={run.documents!.filter((x) => x.id !== d.id)} /></>}
  </>;
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
