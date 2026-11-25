export type Project = {
  latest_run?: Run | null;
  id: number; name: string; owner?: string; repo_url: string; local_path: string; agents_md: string; caps_json: string; ai: string; connected_at: string | null; claude_connected_at: string | null; codex_connected_at: string | null; copilot_connected_at: string | null; setup_complete: boolean; onboarding_status: string; onboarding_stage: string; onboarding_log: string; created_at: string;
};
export type Integration = { id: number; kind: string; config: Record<string, unknown>; has_secret: boolean };
export type Ticket = { id: number; key: string; title: string; body_md: string; source: string };
export type ProjectDetail = Project & { caps: Record<string, string | number>; integrations: Integration[]; tickets: Ticket[]; connect: { setup_ps: string; setup_sh: string; copilot: string; copilot_url: string; copilot_server_name: string; copilot_json: string; download_copilot: string; download_copilot_agent: string; vscode_json: string; download_vscode: string; url: string; claude: string; codex: string; mcp_json: string; codex_toml: string; download_claude: string; download_codex: string; oneliner_claude_ps: string; oneliner_claude_sh: string; oneliner_codex_ps: string; oneliner_codex_sh: string } };
export type Phase = { id: number; name: string; status: string; notes: string; ts: string };
/* a run artifact (design document, stage outputs); lists carry no text, the document page loads it */
export type DocumentRow = { id: number; run_id: number; path: string; chars: number; updated_at: string; run_number?: number; run_title?: string };
export type DocumentFull = { id: number; run_id: number; path: string; content: string; updated_at: string };
export type RunTicket = { key: string; title: string; figma_urls: string[] };
/* one stage agent of a run, from the API: planned route, reported model, time and estimated cost */
export type RunAgent = { stage: string; planned_model: string; model: string; tokens: number | null; started_at: string | null; ended_at: string | null; duration_ms: number | null; duration_source: string; est_cost_usd: number | null };
export type Run = {
  id: number; project_id: number; number: number; goal: string; title: string; project_name?: string; client: string; status: string; branch: string; pr_url: string;
  routing?: string; project_owner?: string; started_by?: string; summary_md: string; started_at: string; finished_at: string | null; usage: Record<string, number | string>;
  phases?: Phase[];
  documents?: DocumentRow[];
  tickets?: RunTicket[];
  agents?: RunAgent[];
  current_stage?: { name: string; status: string; notes: string; ts: string } | null;
};

/* one line of a project's Logs tab */
export type LogEntry = { id: number; project_id: number; run_id: number | null; run_number: number | null; ts: string; level: "debug" | "info" | "warn" | "error"; source: "mcp" | "dashboard" | "system"; event: string; client: string; user?: string; message: string; detail: Record<string, unknown>; duration_ms: number | null };

export type User = { name: string; role: "admin" | "developer"; must_change_password?: boolean };
/* a row of the admin's Users page; source "env" is an account from DASHBOARD_USERS */
export type Account = { name: string; role: "admin" | "developer"; source: "env" | "db"; must_change_password: boolean; created_by: string; created_at: string | null };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, { headers: { "Content-Type": "application/json" }, ...init });
  if (r.status === 401 && !path.startsWith("/auth/")) dispatchEvent(new Event("auth-required"));  // session ended
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.status === 204 ? (undefined as T) : r.json();
}

export const api = {
  me: () => req<{ auth: boolean; user: User | null }>("/auth/me"),
  login: (username: string, password: string) => req<{ auth: boolean; user: User | null }>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => req<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  changePassword: (current_password: string, new_password: string) =>
    req<{ auth: boolean; user: User }>("/auth/password", { method: "POST", body: JSON.stringify({ current_password, new_password }) }),
  users: () => req<Account[]>("/users"),
  createUser: (name: string, role: string) => req<{ name: string; role: string; temporary_password: string }>("/users", { method: "POST", body: JSON.stringify({ name, role }) }),
  resetUserPassword: (name: string) => req<{ name: string; temporary_password: string }>(`/users/${encodeURIComponent(name)}/reset-password`, { method: "POST", body: "{}" }),
  projects:() => req<Project[]>("/projects"),
  project: (id: number) => req<ProjectDetail>(`/projects/${id}`),
  createProject: (name: string, repo_url = "") => req<Project>("/projects", { method: "POST", body: JSON.stringify({ name, repo_url }) }),
  patchProject: (id: number, body: Partial<{ name: string; agents_md: string; caps: Record<string, string | number>; repo_url: string; local_path: string; setup_complete: boolean }>) =>
    req<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteProject: (id: number) => req<void>(`/projects/${id}`, { method: "DELETE" }),
  putIntegration: (pid: number, kind: string, config: Record<string, string>, secret: string) =>
    req<Integration>(`/projects/${pid}/integrations/${kind}`, { method: "PUT", body: JSON.stringify({ kind, config, secret }) }),
  deleteIntegration: (pid: number, kind: string) => req<void>(`/projects/${pid}/integrations/${kind}`, { method: "DELETE" }),
  putTicket: (pid: number, key: string, title: string, body_md: string) =>
    req<Ticket>(`/projects/${pid}/tickets/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ key, title, body_md }) }),
  createTicket: (pid: number, key: string, title: string, body_md: string) =>
    req<Ticket>(`/projects/${pid}/tickets`, { method: "POST", body: JSON.stringify({ key, title, body_md }) }),
  deleteTicket: (pid: number, key: string) => req<void>(`/projects/${pid}/tickets/${encodeURIComponent(key)}`, { method: "DELETE" }),
  runs: (project_id?: number) => req<Run[]>(`/runs${project_id ? `?project_id=${project_id}` : ""}`),
  run: (id: number) => req<Run>(`/runs/${id}`),
  stopRun: (rid: number) => req<Run>(`/runs/${rid}/stop`, { method: "POST" }),
  documents: (pid: number) => req<DocumentRow[]>(`/projects/${pid}/documents`),
  document: (id: number) => req<DocumentFull>(`/documents/${id}`),
  connect: () => req<Record<string, unknown>>("/connect"),
  rotateKey: (id: number) => req<ProjectDetail["connect"]>(`/projects/${id}/rotate-key`, { method: "POST" }),
  logs: (pid: number, f: { level: string; run_id: string; q: string; limit: number }) =>
    req<{ items: LogEntry[]; more: boolean }>(`/projects/${pid}/logs?${new URLSearchParams({ level: f.level, q: f.q, limit: String(f.limit), ...(f.run_id ? { run_id: f.run_id } : {}) })}`),
  authorizeUrl: (kind: "jira", id: number) => `/api/oauth/${kind}/authorize?project=${id}`,
};
