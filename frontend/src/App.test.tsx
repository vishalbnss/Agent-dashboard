import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { api, type Approval, type Project, type ProjectDetail, type Run, type RunAgent, type LogEntry } from "./api";

vi.mock("./api", () => ({ api: {
  projects: vi.fn(), runs: vi.fn(), project: vi.fn(), approvals: vi.fn(), run: vi.fn(),
  createProject: vi.fn(), deleteProject: vi.fn(), decide: vi.fn(), rotateKey: vi.fn(),
  authorizeUrl: vi.fn((kind: string, id: number) => `/api/oauth/${kind}/authorize?project=${id}`),
  deleteIntegration: vi.fn(),
  createTicket: vi.fn(), putTicket: vi.fn(), deleteTicket: vi.fn(), logs: vi.fn(), patchProject: vi.fn(),
} }));

const timestamp = "2026-10-22T08:30:00Z";
const makeProject = (id: number, name: string, connected = false): Project => ({
  id, name, repo_url: `https://github.com/test/${name.toLowerCase()}`, local_path: "", agents_md: "# Guide", caps_json: "{}",
  ai: connected ? "claude" : "", connected_at: connected ? timestamp : null,
  claude_connected_at: connected ? timestamp : null, codex_connected_at: null, copilot_connected_at: null, setup_complete: true,
  onboarding_status: "done", onboarding_stage: "done", onboarding_log: "", created_at: timestamp,
});
const makeRun = (id: number, title: string, status: string): Run => ({
  id, title, status, project_id: 1, project_name: "Atlas", number: id, goal: title,
  client: id === 3 ? "codex" : "claude", branch: "feature/AT-1", pr_url: "", summary_md: "", usage: {},
  started_at: timestamp, finished_at: status === "done" ? timestamp : null, phases: [], approvals: [],
});
const makeApproval = (version = 1): Approval => ({
  id: version, run_id: 2, version, content_md: "# Implementation plan\n\n## Goal\nAdd the empty state.\n\n## Risks\nCheck small screens.",
  status: "pending", decided_by: "", comment: "", section_comments: {}, created_at: timestamp, decided_at: null,
});
const connect: ProjectDetail["connect"] = {
  setup_ps: "iwr -useb test-setup-ps | iex", setup_sh: "curl -fsSL test-setup-sh | sh",
  copilot: 'copilot mcp add --transport http agents-dashboard-1 "test-copilot-url"',
  copilot_url: 'http://localhost:8000/mcp?project=1&key=test-key&client=copilot', copilot_server_name: 'agents-dashboard-1',
  copilot_json: '{"mcpServers":{}}', download_copilot: '/api/projects/1/mcp-config?key=test-key&client=copilot',
  download_copilot_agent: '/api/projects/1/copilot-agent?key=test-key',
  vscode_json: '{"servers":{}}', download_vscode: '/api/projects/1/mcp-config?key=test-key&client=vscode',
  url: "http://localhost:8000/mcp?project=1&key=test-key",
  claude: 'claude mcp add agents-dashboard "test-url"', codex: 'codex mcp add agents-dashboard --url "test-url"',
  mcp_json: '{"mcpServers":{"agents-dashboard":{"url":"test-url"}}}', codex_toml: '[mcp_servers.agents-dashboard]\nurl = "test-url"',
  download_claude: "/api/projects/1/mcp-config?key=test-key&client=claude", download_codex: "/api/projects/1/mcp-config?key=test-key&client=codex",
  oneliner_claude_ps: "iwr test-url -OutFile .mcp.json", oneliner_claude_sh: "curl test-url -o .mcp.json",
  oneliner_codex_ps: "iwr test-url -OutFile config.toml", oneliner_codex_sh: "curl test-url -o config.toml",
};
let projects: Project[];
let runs: Run[];
let integrations: ProjectDetail["integrations"];
let tickets: ProjectDetail["tickets"];

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  window.history.replaceState(null, "", "/#/");
  projects = [makeProject(1, "Atlas", true), makeProject(2, "Beacon")];
  runs = [makeRun(1, "AT-1: Add navigation", "running"), makeRun(2, "AT-2: Empty state", "awaiting_approval"), makeRun(3, "AT-3: Update footer", "done")];
  integrations = [];
  tickets = [];
  runs[1].approvals = [makeApproval()];
  projects[0].latest_run = runs[1];
  vi.mocked(api.projects).mockImplementation(async () => [...projects]);
  vi.mocked(api.runs).mockImplementation(async (id) => runs.filter((r) => !id || r.project_id === id));
  vi.mocked(api.project).mockImplementation(async (id) => ({ ...projects.find((p) => p.id === id)!, connect, caps: {}, integrations: id === 1 ? integrations : [], tickets: id === 1 ? [...tickets] : [] }));
  vi.mocked(api.createTicket).mockImplementation(async (_pid, key, title, body_md) => {
    const ticket = { id: 1, key, title, body_md, source: "pasted" }; tickets.push(ticket); return ticket;
  });
  vi.mocked(api.putTicket).mockImplementation(async (_pid, key, title, body_md) => {
    const ticket = tickets.find((t) => t.key === key)!; Object.assign(ticket, { title, body_md }); return { ...ticket };
  });
  vi.mocked(api.deleteTicket).mockImplementation(async (_pid, key) => { tickets = tickets.filter((t) => t.key !== key); });
  vi.mocked(api.approvals).mockResolvedValue([]);
  vi.mocked(api.run).mockImplementation(async (id) => ({ ...runs.find((r) => r.id === id)! }));
  vi.mocked(api.createProject).mockImplementation(async (name, repo_url) => { const p = { ...makeProject(3, name), repo_url: repo_url || "" }; projects.push(p); return p; });
  vi.mocked(api.decide).mockImplementation(async (rid, version, decision, name, comment, notes) => {
    const r = runs.find((run) => run.id === rid)!;
    const approval = r.approvals!.find((a) => a.version === version)!;
    Object.assign(approval, { status: decision, decided_by: name, comment, section_comments: notes, decided_at: timestamp });
    r.status = "running";
    return { ...approval };
  });
  vi.mocked(api.rotateKey).mockResolvedValue(connect);
  vi.mocked(api.logs).mockResolvedValue({ items: [], more: false });
  vi.stubGlobal("confirm", vi.fn(() => true));
});

function openRoute(route: string) {
  window.history.replaceState(null, "", `/#/${route}`);
  return render(<App />);
}

describe("workspace redesign", () => {
  it("shows agent status and every connection method in one setup card", async () => {
    const user = userEvent.setup();
    openRoute("projects/1/connections");
    const setup = await screen.findByRole("region", { name: "Connect coding agents" });
    await user.click(within(setup).getByRole("button", { name: "bash" }));
    expect(within(setup).getByText(connect.setup_sh)).toBeTruthy();
    await user.click(within(setup).getByRole("button", { name: "PowerShell" }));
    await user.click(within(setup).getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe(connect.setup_ps);
    expect(within(setup).getByRole("listitem", { name: "Claude Code: Connected" })).toBeTruthy();
    expect(within(setup).getByRole("listitem", { name: "GitHub Copilot: Not connected" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^(Claude Code|Codex|GitHub Copilot):/ })).toBeNull();
    await user.click(within(setup).getByRole("button", { name: "Config files" }));
    await user.click(within(setup).getByRole("button", { name: "Codex" }));
    expect(within(setup).getByText(".codex/config.toml")).toBeTruthy();
    expect(within(setup).getByRole("link", { name: "Download" }).getAttribute("href")).toBe(connect.download_codex);
    await user.click(within(setup).getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe(connect.codex_toml);
    await user.click(within(setup).getByRole("button", { name: "CLI" }));
    expect(within(setup).getByText(connect.claude)).toBeTruthy();
    expect(within(setup).getByText(connect.copilot_url)).toBeTruthy();
    expect(api.rotateKey).not.toHaveBeenCalled();
  });

  it("counts a Copilot-only project as connected in overview and project filters", async () => {
    projects[0].claude_connected_at = null;
    projects[0].copilot_connected_at = timestamp;
    projects[0].ai = "copilot";
    const user = userEvent.setup();
    openRoute("");
    expect(await screen.findByRole("img", { name: "2 total projects. Connected: 1. Needs connection: 1." })).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Projects" }));
    await screen.findByRole("combobox", { name: "Connection status" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Connection status" }), "connected");
    expect(screen.getByRole("link", { name: "Atlas" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Beacon" })).toBeNull();
    expect(screen.getByText("GitHub Copilot")).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Atlas" }));
    expect((await screen.findByRole("tab", { name: "Runs 3" })).getAttribute("aria-selected")).toBe("true");
    await user.click(screen.getByRole("tab", { name: "Connections" }));
    expect(screen.getByRole("listitem", { name: "GitHub Copilot: Connected" })).toBeTruthy();
  });

  it("shows Copilot Figma checks independently from other clients", async () => {
    projects[0].ai = "copilot";
    integrations = [{ id: 1, kind: "figma", has_secret: false, config: { auth: "via-ai", clients: {
      copilot: { client: "copilot", connected: true, checked_at: timestamp, detail: "Figma read succeeded" },
      codex: { client: "codex", connected: false, checked_at: timestamp, detail: "Sign in needed" },
    } } }];
    const user = userEvent.setup();
    openRoute("projects/1");
    await screen.findByRole("tab", { name: "Connections" });
    await user.click(screen.getByRole("tab", { name: "Connections" }));
    await user.click(screen.getByRole("button", { name: "Figma: Connected in GitHub Copilot" }));
    const dialog = screen.getByRole("dialog", { name: "Connect Figma" });
    expect(within(dialog).getByText("Connected in GitHub Copilot")).toBeTruthy();
    expect(within(dialog).getByText("Needs attention in Codex")).toBeTruthy();
    expect((within(dialog).getByRole("combobox", { name: "Coding agent" }) as HTMLSelectElement).value).toBe("copilot");
    expect(within(dialog).queryByText("codex mcp login figma")).toBeNull();
  });

  it("filters Copilot runs and displays reported credits without inferring dollars", async () => {
    runs[2].client = "copilot";
    runs[2].usage = { ai_credits: 2.5, input_tokens: 120, output_tokens: 30 };
    const user = userEvent.setup();
    openRoute("runs");
    await screen.findByRole("combobox", { name: "AI client" });
    await user.selectOptions(screen.getByRole("combobox", { name: "AI client" }), "copilot");
    expect(screen.queryByRole("link", { name: "AT-1: Add navigation" })).toBeNull();
    await user.click(screen.getByRole("link", { name: "AT-3: Update footer" }));
    await screen.findByRole("heading", { name: "AT-3: Update footer" });
    await user.click(screen.getByText("Usage breakdown"));
    expect(screen.getByText("GitHub AI credits")).toBeTruthy();
    expect(screen.getByText("2.5")).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("renders stage outcomes compactly when usage was never reported", async () => {
    runs[2].summary_md = [
      "# Run summary", "", "## Stages", "",
      "| Phase | Agent | Model | Tokens | Calls | Time | Est. cost |",
      "|---|---|---|---:|---:|---:|---:|",
      "| design-approval | ? | not reported | not reported | not reported | not reported | not reported |",
      "| branch-preflight | ? | not reported | not reported | not reported | not reported | not reported |",
      "| **Total** (partial) | | | 0 | 0 | 0s | ~$0.00 |", "",
      "- **design-approval**: Version 2 approved",
      "- **branch-preflight**: Failed: invalid GitHub token", "",
      "## Not done / follow-ups", "", "- Implementation has not started.",
    ].join("\n");
    openRoute("runs/3");
    const results = await screen.findByRole("region", { name: "Stage results" });
    expect(within(results).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Stage", "Outcome"]);
    expect(within(results).getByRole("rowheader", { name: "Design approval" })).toBeTruthy();
    expect(within(results).getByRole("rowheader", { name: "Branch preflight" })).toBeTruthy();
    expect(screen.getAllByText("Version 2 approved")).toHaveLength(1);
    expect(within(results).getByText("Failed: invalid GitHub token")).toBeTruthy();
    expect(within(results).queryByText("~$0.00")).toBeNull();
    expect(screen.getByText("No stage usage reported.")).toBeTruthy();
    expect(screen.getByText("Implementation has not started.")).toBeTruthy();
    expect(results.tabIndex).toBe(0);
  });

  it("preserves reported usage, including zero, while making missing cells concise", async () => {
    runs[2].summary_md = [
      "## Stages", "", "| Phase | Agent | Model | Tokens | Calls | Time | Est. cost |",
      "|---|---|---|---:|---:|---:|---:|",
      "| implementation | builder | reported-model | 420 | 2 | 10s | ~$0.02 |",
      "| independent-test | ? | not reported | 0 | 0 | 0s | ~$0.00 |",
      "| **Total** (partial) | | | 420 | 2 | 10s | ~$0.02 |", "",
      "- **implementation**: Build passed", "- **independent-test**: Skipped by request",
    ].join("\n");
    openRoute("runs/3");
    const results = await screen.findByRole("region", { name: "Stage results" });
    expect(within(results).getByRole("columnheader", { name: "Tokens" })).toBeTruthy();
    expect(within(results).getByText("reported-model")).toBeTruthy();
    const row = within(results).getByRole("rowheader", { name: "Independent tests" }).closest("tr")!;
    expect(within(row).getAllByText("0")).toHaveLength(2);
    expect(within(row).getByText("~$0.00")).toBeTruthy();
    expect(within(row).getAllByLabelText("Not reported")).toHaveLength(2);
    expect(within(results).getByRole("rowheader", { name: "Total (partial)" })).toBeTruthy();
    expect(screen.queryByText("No stage usage reported.")).toBeNull();
  });

  it("lists the nine agents in order with model, time and estimated cost", async () => {
    runs[2].status = "running";
    runs[2].phases = [
      { id: 1, name: "design-approval", status: "done", notes: "Approved", ts: timestamp },
      { id: 2, name: "branch-preflight", status: "done", notes: "01-git/preflight.md", ts: timestamp },
      { id: 3, name: "jira-intake", status: "running", notes: "Reading FIN-2", ts: timestamp },
    ];
    const agent = (stage: string, planned_model: string, extra: Partial<RunAgent> = {}): RunAgent => ({ stage, planned_model, model: "", tokens: null, started_at: null, ended_at: null, duration_ms: null, duration_source: "", est_cost_usd: null, ...extra });
    runs[2].agents = [
      agent("branch-preflight", "haiku", { model: "claude-haiku-4-5", tokens: 12000, started_at: timestamp, ended_at: timestamp, duration_ms: 61000, duration_source: "reported", est_cost_usd: 0.0168 }),
      agent("jira-intake", "sonnet", { started_at: timestamp }),
      ...["figma-intake", "dependency-merge", "implementation"].map((s) => agent(s, "opus")),
      ...["independent-test", "code-review-security"].map((s) => agent(s, "sonnet")),
      agent("documentation", "haiku"), agent("pr-creation", "sonnet"),
    ];
    openRoute("runs/3");
    await screen.findByText("Agents are working…");
    const names = [...document.querySelectorAll(".roster .agent-name")].map((n) => n.firstChild?.textContent);
    expect(names).toEqual(["Branch preflight", "Ticket intake", "Figma intake", "Design synthesis", "Implementation", "Independent tests", "Review and security", "Documentation", "Pull request"]);
    const roster = document.querySelector(".roster") as HTMLElement;
    const pre = within(roster).getByText("Branch preflight").closest(".agent") as HTMLElement;
    expect(within(pre).getByText("claude-haiku-4-5")).toBeTruthy();
    expect(within(pre).getByText("12.0k tokens")).toBeTruthy();
    expect(within(pre).getByText("1m 01s")).toBeTruthy();
    expect(within(pre).getByText("~$0.02")).toBeTruthy();
    const figmaRow = within(roster).getByText("Figma intake").closest(".agent") as HTMLElement;
    expect(within(figmaRow).getByTitle(/Planned route/).textContent).toBe("Opus");
    expect(screen.getByText("Reading FIN-2")).toBeTruthy();
    expect(screen.getByText(/1 of 9 agents|2 of 9 agents/)).toBeTruthy();

    await userEvent.click(screen.getByText("Usage breakdown"));
    const table = screen.getByRole("table", { name: "Cost by agent" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4);  // header, the two agents that started, total
    expect(within(rows[1]).getByRole("rowheader").textContent).toBe("Branch preflight");
    expect(within(rows[1]).getByText("1m 01s")).toBeTruthy();
    expect(within(rows[1]).getByText("~$0.02")).toBeTruthy();
    expect(within(rows[2]).getByText("running")).toBeTruthy();
    expect(within(rows[3]).getByRole("rowheader").textContent).toBe("Total (partial)");
    expect(screen.getByText("Estimated cost (partial)")).toBeTruthy();
  });

  it("distinguishes manual completion from executed stages and keeps history expandable", async () => {
    runs[2].summary_md = "# Run summary\n\n**Closure:** Manually marked completed at the user's request on 2026-10-22.\n\nImplementation has not started.";
    runs[2].phases = [
      { id: 1, name: "design-approval", status: "running", notes: "Preparing", ts: timestamp },
      { id: 2, name: "design-approval", status: "done", notes: "Approved", ts: timestamp },
      { id: 3, name: "branch-preflight", status: "failed", notes: "Invalid token", ts: timestamp },
      { id: 4, name: "figma-intake", status: "running", notes: "Reading design", ts: timestamp },
    ];
    openRoute("runs/3");
    expect(await screen.findByText("Manually completed")).toBeTruthy();
    expect(screen.getByText("completed manually")).toBeTruthy();
    expect(screen.getByText("2 of 9 agents · 0.0 min")).toBeTruthy();
    expect(screen.getByText("Blocked before closure")).toBeTruthy();
    expect(screen.getByText("Stopped at closure")).toBeTruthy();
    expect(screen.queryAllByText("Completed")).toHaveLength(0); // only design approval finished, and it is a gate, not an agent
    const unrun = screen.getByText("7 agents not run").closest("details")!;
    expect(unrun.open).toBe(false);
    const report = screen.getByText("Execution report").closest("details")!;
    expect(report.open).toBe(false);
    await userEvent.click(screen.getByText("Execution report"));
    expect(report.open).toBe(true);
    expect(within(report).getByText("Implementation has not started.")).toBeTruthy();
    await userEvent.click(screen.getByText("7 agents not run"));
    expect(within(unrun).getAllByText("Not run")).toHaveLength(7);
  });

  it("shows recovered partial cost and token totals without counting cached tokens twice", async () => {
    runs[2].usage = { cost_usd: 0.289446, cost_kind: "API equivalent estimate (partial)", total_tokens: 2264299,
      input_tokens: 2256056, cached_input_tokens: 2180992, output_tokens: 8243, priced_tokens: 1552735, unpriced_tokens: 711564,
      model_requests: 54, model: "gpt-6.1-sol + codex-auto-review", cost_note: "Standard API equivalent, not a bill.",
      usage_note: "Recovered from execution turns.", internal_record_path: "private-record.json" };
    openRoute("runs/3");
    const panel = await screen.findByLabelText("Cost and time");
    expect(within(panel.querySelector(".usage-highlights") as HTMLElement).getByText("~$0.29")).toBeTruthy();
    expect(within(panel).getByText("Partial estimate")).toBeTruthy();
    expect(within(panel).getByText("2,264,299")).toBeTruthy();
    const details = within(panel).getByText("Usage breakdown").closest("details")!;
    expect(details.open).toBe(false);
    await userEvent.click(within(panel).getByText("Usage breakdown"));
    expect(details.open).toBe(true);
    expect(within(details).getByText("2,180,992")).toBeTruthy();
    expect(within(details).getByText("711,564")).toBeTruthy();
    expect(within(details).getByText("Standard API equivalent, not a bill.")).toBeTruthy();
    expect(screen.queryByText("private-record.json")).toBeNull();
  });

  it("presents only an explicitly selected completed run without rewriting its execution data", async () => {
    runs[2].summary_md = "**Closure:** Manually marked completed at the user's request.\nImplementation has not started.";
    runs[2].phases = [{ id: 1, name: "branch-preflight", status: "failed", notes: "Invalid token", ts: timestamp }];
    runs[2].current_stage = { name: "branch-preflight", status: "failed", notes: "Invalid token", ts: timestamp };
    runs[2].usage = { cost_usd: 0.289446, cost_kind: "estimate (partial)", _display_mode: "completed_preview", _preview_summary_md: "## What changed\n\n- Empty-results view for both reports." };
    const recorded = JSON.stringify(runs);
    openRoute("runs/3");
    expect(await screen.findByText("Run completed")).toBeTruthy();
    expect(screen.getAllByText("Completed")).toHaveLength(9);
    expect(screen.getByText("9 agents · 0.0 min")).toBeTruthy();
    expect(screen.getByText("Empty-results view for both reports.")).toBeTruthy();
    expect(screen.getAllByText("~$0.29")[0]).toBeTruthy();
    expect(screen.queryByText(/Manually completed|Blocked before closure|not run|has not started/)).toBeNull();
    expect(screen.queryByTitle("Invalid token")).toBeNull();
    expect(screen.queryByText("completed_preview")).toBeNull();
    expect(JSON.stringify(runs)).toBe(recorded);
    await act(async () => { window.location.hash = "#/runs/1"; });
    expect(await screen.findByText("Agents are working…")).toBeTruthy();
    expect(screen.queryByText("Empty-results view for both reports.")).toBeNull();
  });

  it.each([{}, { cost_usd: "invalid" }, { cost_usd: -1 }] as Run["usage"][])("does not display missing or invalid cost as zero: %j", async (usage) => {
    runs[2].usage = usage;
    openRoute("runs/3");
    const panel = await screen.findByLabelText("Cost and time");
    expect(within(panel).getByText("Unavailable")).toBeTruthy();
    expect(within(panel).getByText("Not reported")).toBeTruthy();
    expect(within(panel).queryByText(/\$0\.00|NaN/)).toBeNull();
  });

  it("preserves genuine zero usage and derives total without adding cached tokens again", async () => {
    runs[2].usage = { cost_usd: 0, input_tokens: 1000, output_tokens: 20, cache_read_tokens: 900 };
    openRoute("runs/3");
    const panel = await screen.findByLabelText("Cost and time");
    expect(within(panel.querySelector(".usage-highlights") as HTMLElement).getByText("$0.00")).toBeTruthy();
    expect(within(panel).getByText("1,020")).toBeTruthy();
  });

  it("creates, edits, copies, and deletes a manual ticket within its project", async () => {
    const user = userEvent.setup();
    openRoute("projects/1/tickets");
    await screen.findByText("No tickets yet");
    expect(screen.getByRole("tab", { name: "Tickets 0" }).getAttribute("aria-selected")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Add ticket" }));
    let dialog = screen.getByRole("dialog", { name: "Add ticket" });
    await user.type(within(dialog).getByLabelText("Ticket ID"), "fin-2");
    await user.type(within(dialog).getByLabelText("Title"), "Empty results");
    const body = "Show an empty state.\nAC-1: Clear filters restores results.\nhttps://www.figma.com/design/K1/F?node-id=1-2";
    await user.type(within(dialog).getByLabelText("Ticket details"), body);
    await user.click(within(dialog).getByRole("button", { name: "Save ticket" }));
    await screen.findByRole("heading", { name: "Empty results" });
    expect(api.createTicket).toHaveBeenCalledWith(1, "FIN-2", "Empty results", body);
    expect(screen.getByRole("tab", { name: "Tickets 1" })).toBeTruthy();
    let card = screen.getByRole("article", { name: "Empty results" });
    await user.click(within(card).getByRole("button", { name: "Copy request" }));
    expect(await navigator.clipboard.readText()).toBe("Implement FIN-2 and review it. Read the ticket from Agents Dashboard.");
    await user.click(within(card).getByRole("button", { name: "Edit" }));
    dialog = screen.getByRole("dialog", { name: "Edit FIN-2" });
    expect((within(dialog).getByLabelText("Ticket ID") as HTMLInputElement).readOnly).toBe(true);
    expect((within(dialog).getByLabelText("Ticket details") as HTMLTextAreaElement).value).toBe(body);
    await user.clear(within(dialog).getByLabelText("Title"));
    await user.type(within(dialog).getByLabelText("Title"), "Filter empty state");
    await user.click(within(dialog).getByRole("button", { name: "Save ticket" }));
    await screen.findByRole("heading", { name: "Filter empty state" });
    expect(api.putTicket).toHaveBeenCalledWith(1, "FIN-2", "Filter empty state", body);
    card = screen.getByRole("article", { name: "Filter empty state" });
    vi.mocked(confirm).mockReturnValueOnce(false);
    await user.click(within(card).getByRole("button", { name: "Delete" }));
    expect(api.deleteTicket).not.toHaveBeenCalled();
    await user.click(within(card).getByRole("button", { name: "Delete" }));
    await screen.findByText("No tickets yet");
    expect(api.deleteTicket).toHaveBeenCalledWith(1, "FIN-2");
  });

  it("rejects duplicate ticket IDs and retains the draft when saving fails", async () => {
    tickets = [{ id: 1, key: "FIN-2", title: "Existing ticket", body_md: "Existing requirements", source: "pasted" }];
    const user = userEvent.setup();
    openRoute("projects/1/tickets");
    await user.click(await screen.findByRole("button", { name: "Add ticket" }));
    const dialog = screen.getByRole("dialog", { name: "Add ticket" });
    await user.type(within(dialog).getByLabelText("Ticket ID"), "fin-2");
    await user.type(within(dialog).getByLabelText("Title"), "New ticket");
    await user.type(within(dialog).getByLabelText("Ticket details"), "New requirements");
    await user.click(within(dialog).getByRole("button", { name: "Save ticket" }));
    expect(within(dialog).getByRole("alert").textContent).toContain("already exists");
    expect(api.createTicket).not.toHaveBeenCalled();
    await user.clear(within(dialog).getByLabelText("Ticket ID"));
    await user.type(within(dialog).getByLabelText("Ticket ID"), "FIN-3");
    vi.mocked(api.createTicket).mockRejectedValueOnce(new Error("Connection lost"));
    await user.click(within(dialog).getByRole("button", { name: "Save ticket" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect((within(dialog).getByLabelText("Ticket details") as HTMLTextAreaElement).value).toBe("New requirements");
    expect(screen.getByRole("heading", { name: "Existing ticket" })).toBeTruthy();
  });

  it("explains automatic Figma checks and keeps the manual prompt optional", async () => {
    const user = userEvent.setup();
    openRoute("projects/1/connections");
    await user.click(await screen.findByRole("button", { name: "Figma: Not verified" }));
    const dialog = screen.getByRole("dialog", { name: "Connect Figma" });
    await user.selectOptions(within(dialog).getByLabelText("Coding agent"), "codex");
    expect(within(dialog).getByText(/Codex checks Figma on the first message/)).toBeTruthy();
    expect(within(dialog).getByText(/No verification prompt is needed/)).toBeTruthy();
    const manual = within(dialog).getByText("Manual recheck (optional)");
    expect(manual.closest("details")?.open).toBe(false);
    await user.click(manual);
    expect(manual.closest("details")?.open).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Copy" }));
    const prompt = await navigator.clipboard.readText();
    expect(prompt).toContain('project "Atlas" (ID 1)');
    expect(prompt).toContain('client="codex"');
    expect(prompt).toContain("read-only Figma tool call");
    expect(prompt).toContain("Do not start a run or edit files");
    expect(prompt).not.toContain("test-key");
    expect(within(dialog).getByText(/No run is needed/)).toBeTruthy();
  });

  it("shows existing Figma verification and when the agent checked it", async () => {
    integrations = [{ id: 1, kind: "figma", has_secret: false, config: {
      auth: "via-ai", connected: true, client: "codex", detail: "Identity check succeeded", checked_at: timestamp,
    } }];
    const user = userEvent.setup();
    openRoute("projects/1/connections");
    const card = await screen.findByRole("button", { name: "Figma: Connected in Codex" });
    expect(card.classList.contains("on")).toBe(true);
    await user.click(card);
    const dialog = screen.getByRole("dialog", { name: "Connect Figma" });
    expect(within(dialog).getByText("Identity check succeeded")).toBeTruthy();
    expect(dialog.querySelector("time")?.getAttribute("datetime")).toBe(timestamp);
    expect(within(dialog).queryByText(/last run/)).toBeNull();
  });

  it("keeps client checks separate and updates the card when a later check fails", async () => {
    const report = { connected: true, client: "codex", detail: "Identity check succeeded", checked_at: timestamp };
    const failed = { ...report, connected: false, client: "claude", detail: "Figma tools unavailable" };
    integrations = [{ id: 1, kind: "figma", has_secret: false, config: { auth: "via-ai", clients: { codex: report, claude: failed } } }];
    const intervals = vi.spyOn(window, "setInterval");
    const user = userEvent.setup();
    openRoute("projects/1/connections");
    const card = await screen.findByRole("button", { name: "Figma: Connected in Codex" });
    const refresh = intervals.mock.calls.find(([, delay]) => delay === 4000)![0] as () => void;
    intervals.mockRestore();
    await user.click(card);
    const dialog = screen.getByRole("dialog", { name: "Connect Figma" });
    expect(within(dialog).getByText("Connected in Codex")).toBeTruthy();
    expect(within(dialog).getByText("Needs attention in Claude Code")).toBeTruthy();
    integrations = [{ ...integrations[0], config: { auth: "via-ai", clients: { codex: { ...report, connected: false, detail: "Sign-in expired" }, claude: failed } } }];
    await act(async () => refresh());
    const updated = await screen.findByRole("button", { name: "Figma: Needs attention" });
    expect(updated.classList.contains("on")).toBe(false);
    expect(within(dialog).getByText("Sign-in expired")).toBeTruthy();
    await user.keyboard("{Escape}");
    await user.click(screen.getAllByRole("link", { name: "Projects" })[0]);
    await user.click(await screen.findByRole("link", { name: "Beacon" }));
    expect(await screen.findByRole("button", { name: "Figma: Not verified" })).toBeTruthy();
  });

  it("starts empty and lets the user create the first project", async () => {
    projects = [];
    runs = [];
    const user = userEvent.setup();
    openRoute("");
    await screen.findByRole("heading", { name: "Workspace overview" });
    for (const label of ["Projects", "Active runs", "Awaiting approval", "Completed runs"]) {
      expect(within(screen.getByRole("link", { name: `${label} 0` })).getByText("0")).toBeTruthy();
    }
    expect(screen.getByText("No runs yet")).toBeTruthy();
    expect(screen.getByText("No pending approvals")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add project" }));
    const dialog = screen.getByRole("dialog", { name: "Add a project" });
    await user.type(within(dialog).getByLabelText("Project name"), "First project");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await screen.findByRole("heading", { name: "First project" });
    expect(api.createProject).toHaveBeenCalledWith("First project", "");
    expect(screen.getByRole("tab", { name: "Connections" }).getAttribute("aria-selected")).toBe("true");
    await user.click(screen.getByRole("tab", { name: "Runs 0" }));
    await screen.findByText("No runs yet");
    expect(screen.queryByRole("region", { name: "Run history" })).toBeNull();
  });

  it("shows real workspace counts and links to the pending design", async () => {
    openRoute("");
    await screen.findByRole("heading", { name: "Workspace overview" });
    expect(within(screen.getByRole("link", { name: /Projects 2/ })).getByText("2")).toBeTruthy();
    expect(within(screen.getByRole("link", { name: /Active runs 1/ })).getByText("1")).toBeTruthy();
    expect(within(screen.getByRole("link", { name: /Awaiting approval 1/ })).getByText("1")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review AT-2: Empty state" }).getAttribute("href")).toBe("#/runs/2/review");
  });

  it("filters projects and keeps project links separate from review links", async () => {
    const user = userEvent.setup();
    openRoute("projects");
    await screen.findByRole("link", { name: "Beacon" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Connection status" }), "connected");
    expect(screen.queryByRole("link", { name: "Beacon" })).toBeNull();
    expect(screen.getByRole("link", { name: "Atlas" })).toBeTruthy();
    expect(document.querySelector("a a")).toBeNull();
    await user.type(screen.getByRole("textbox", { name: "Search projects" }), "missing");
    expect(screen.getByText("No matching projects")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("link", { name: "Beacon" })).toBeTruthy();
  });

  it("combines run search with status and AI filters", async () => {
    const user = userEvent.setup();
    openRoute("runs?status=done");
    await screen.findByRole("link", { name: "AT-3: Update footer" });
    expect(screen.queryByRole("link", { name: "AT-1: Add navigation" })).toBeNull();
    await user.selectOptions(screen.getByRole("combobox", { name: "AI client" }), "claude");
    expect(screen.getByText("No matching runs")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await user.type(screen.getByRole("textbox", { name: "Search runs" }), "AT-2");
    expect(screen.getByRole("link", { name: "AT-2: Empty state" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "AT-3: Update footer" })).toBeNull();
  });

  it("supports keyboard workspace search and navigates to the chosen run", async () => {
    const user = userEvent.setup();
    openRoute("");
    await screen.findByRole("heading", { name: "Workspace overview" });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = screen.getByRole("dialog", { name: "Search workspace" });
    await user.type(within(dialog).getByRole("textbox"), "AT-3");
    await user.click(within(dialog).getByRole("link", { name: /AT-3: Update footer/ }));
    await screen.findByRole("heading", { name: "AT-3: Update footer" });
    expect(window.location.hash).toBe("#/runs/3");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("creates a project using the existing API contract and opens its connections", async () => {
    const user = userEvent.setup();
    openRoute("projects");
    await screen.findByRole("button", { name: "Add project" });
    await user.click(screen.getByRole("button", { name: "Add project" }));
    const dialog = screen.getByRole("dialog", { name: "Add a project" });
    await user.type(within(dialog).getByLabelText("Project name"), "New portal");
    await user.type(within(dialog).getByLabelText(/GitHub repository/), "https://github.com/test/portal");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await screen.findByRole("heading", { name: "New portal" });
    expect(api.createProject).toHaveBeenCalledWith("New portal", "https://github.com/test/portal");
    expect(screen.getByRole("tab", { name: "Connections" }).getAttribute("aria-selected")).toBe("true");
  });

  it("shows project logs with filters, run links and expandable details", async () => {
    const user = userEvent.setup();
    const entry = (id: number, extra: Partial<LogEntry>): LogEntry => ({ id, project_id: 1, run_id: null, run_number: null, ts: timestamp,
      level: "info", source: "mcp", event: "start_run", client: "claude", message: "", detail: {}, duration_ms: null, ...extra });
    vi.mocked(api.logs).mockResolvedValue({ more: true, items: [
      entry(3, { level: "error", event: "get_stage", message: "get_stage failed: Unknown run_id 9", run_id: 2, run_number: 2, duration_ms: 4 }),
      entry(2, { message: "Started run: FIN-2", run_id: 2, run_number: 2, detail: { args: { goal: "implement FIN-2" } } }),
      entry(1, { source: "dashboard", event: "key.rotated", level: "warn", client: "", message: "Issued a new project key" }),
    ] });
    openRoute("projects/1/logs");
    const logs = await screen.findByRole("region", { name: "Logs" });
    expect(await within(logs).findByText("get_stage failed: Unknown run_id 9")).toBeTruthy();
    expect(within(logs).getAllByRole("link", { name: "Run #2" })[0].getAttribute("href")).toBe("#/runs/2");
    expect(within(logs).getByText("Dashboard")).toBeTruthy();
    expect(within(logs).getAllByText("Claude Code")).toHaveLength(2);
    await user.click(within(logs).getByText("Started run: FIN-2"));
    expect(within(logs).getByText(/"goal": "implement FIN-2"/)).toBeTruthy();
    await user.selectOptions(within(logs).getByLabelText("Level"), "error");
    await waitFor(() => expect(api.logs).toHaveBeenLastCalledWith(1, expect.objectContaining({ level: "error", limit: 100 })));
    await user.click(within(logs).getByRole("button", { name: "Load older" }));
    await waitFor(() => expect(api.logs).toHaveBeenLastCalledWith(1, expect.objectContaining({ limit: 200 })));
  });

  it("switches a project to low-cost test routing", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patchProject).mockResolvedValue(projects[0]);
    openRoute("projects/1/connections");
    const routing = await screen.findByRole("group", { name: "Model routing" });
    expect(within(routing).getByRole("button", { name: "Standard" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(within(routing).getByRole("button", { name: "Low-cost test" }));
    await waitFor(() => expect(api.patchProject).toHaveBeenCalledWith(1, { caps: { routing: "low-cost" } }));
  });

  it("issues a new key from the setup command", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    openRoute("projects/1/connections");
    const setup = await screen.findByRole("region", { name: "Connect coding agents" });
    await user.click(within(setup).getByRole("button", { name: "Issue a new key" }));
    await waitFor(() => expect(api.rotateKey).toHaveBeenCalledWith(1));
  });

  it("saves section notes, prevents accidental approval, and sends a change request", async () => {
    const user = userEvent.setup();
    openRoute("runs/2/review");
    await screen.findByRole("heading", { name: "Design review" });
    const section = screen.getByRole("heading", { name: "Risks" }).closest("section")!;
    await user.click(within(section).getByRole("button", { name: "+ Note" }));
    await user.type(within(section).getByRole("textbox"), "Include the mobile empty state");
    await user.click(within(section).getByRole("button", { name: "Save note" }));
    expect(JSON.parse(localStorage.getItem(`review-notes:2:${timestamp}:v1`)!)).toEqual({ Risks: "Include the mobile empty state" });
    expect(screen.getByRole("button", { name: "Approve and start" }).hasAttribute("disabled")).toBe(true);
    await user.type(screen.getByLabelText("Your name"), "Reviewer");
    await user.click(screen.getByRole("button", { name: "Request changes…" }));
    await user.click(screen.getByRole("button", { name: "Send back for changes" }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(2, 1, "changes_requested", "Reviewer", "", { Risks: "Include the mobile empty state" }));
    await screen.findByRole("heading", { name: /Sent back for changes/ });
  });

  it("does not restore old review drafts when a fresh database reuses a run ID", async () => {
    localStorage.setItem("review-notes:2:v1", JSON.stringify({ Risks: "Legacy run note" }));
    localStorage.setItem("review-notes:2:2026-10-05T08:00:00Z:v1", JSON.stringify({ Risks: "Previous run note" }));
    openRoute("runs/2/review");
    await screen.findByRole("heading", { name: "Design review" });
    expect(screen.queryByText("Legacy run note")).toBeNull();
    expect(screen.queryByText("Previous run note")).toBeNull();
    expect(screen.getByRole("button", { name: "Approve and start" }).hasAttribute("disabled")).toBe(false);
  });

  it("requires confirmation before approving and preserves the decision payload", async () => {
    const user = userEvent.setup();
    openRoute("runs/2/review");
    await screen.findByRole("heading", { name: "Design review" });
    await user.type(screen.getByLabelText("Your name"), "Reviewer");
    await user.click(screen.getByRole("button", { name: "Approve and start" }));
    const dialog = screen.getByRole("dialog", { name: "Approve design document v1?" });
    expect(api.decide).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Approve and start" }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(2, 1, "approved", "Reviewer", "", {}));
    await screen.findByRole("heading", { name: "Approved" });
  });

  it("keeps historical designs read-only and shows the revision diff", async () => {
    const user = userEvent.setup();
    const previous = { ...makeApproval(), status: "changes_requested", decided_by: "Reviewer", comment: "Add mobile", decided_at: timestamp };
    const latest = { ...makeApproval(2), content_md: "# Implementation plan\n\n## Goal\nAdd the mobile empty state.\n\n## Risks\nCheck small screens." };
    runs[1].approvals = [previous, latest];
    openRoute("runs/2/review");
    await screen.findByRole("heading", { name: "Design review" });
    expect(screen.getByText("Removed since v1")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "v1 ↩" }));
    expect(screen.queryByRole("button", { name: "Approve and start" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Go to v2" }));
    expect(screen.getByRole("button", { name: "Approve and start" })).toBeTruthy();
  });

  it("provides mobile navigation with Escape and focus restoration", async () => {
    const user = userEvent.setup();
    openRoute("");
    await screen.findByRole("heading", { name: "Workspace overview" });
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows a recoverable API error instead of a blank page", async () => {
    const user = userEvent.setup();
    vi.mocked(api.projects).mockRejectedValueOnce(new Error("Offline"));
    openRoute("");
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Workspace overview" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
