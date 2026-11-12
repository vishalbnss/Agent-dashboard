// Agents Dashboard: when a coding-agent session starts, report whether its Figma MCP server is signed in.
// Usage: node .agents-dashboard/figma-check.mjs <claude|codex|copilot>
// Runs in the background (the session does not wait), uses no model tokens and is silent on any failure.
// The dashboard address, project and key come from the project's MCP config, so this file holds no secret.
import { exec, spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const client = process.argv[2];
if (!["claude", "codex", "copilot"].includes(client)) process.exit(0);
if (process.argv[3] !== "--run") {
  spawn(process.execPath, [process.argv[1], client, "--run"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  process.exit(0);
}

// The dashboard URL written by the setup command: http(s)://host/mcp?project=<id>&key=<secret>
function dashboardUrl() {
  for (const file of [".mcp.json", ".codex/config.toml", ".vscode/mcp.json"]) {
    try {
      const m = readFileSync(file, "utf8").match(/https?:\/\/[^"'\s]+\/mcp\?project=\d+&key=[\w-]+/);
      if (m) return new URL(m[0]);
    } catch { /* not there; try the next one */ }
  }
  return null;
}

const isFigma = (name) => /figma/i.test(name);

// Each parser returns { connected, detail } or null when the output does not say clearly (then nothing is reported).
const parsers = {
  // `claude mcp list` lines: "<name>: <url> (HTTP) - √ Connected" / "! Needs authentication" / "Pending approval"
  claude(out) {
    const rows = out.split(/\r?\n/).filter((l) => /(^|[:\s])figma: /i.test(l.trim()));
    const ok = rows.filter((l) => /\bConnected\b/.test(l) && !/Needs|Failed|Pending/i.test(l));
    const names = (r) => r.map((l) => l.trim().split(": ")[0]).join(", ");
    if (ok.length) return { connected: true, detail: `Figma MCP server connected at session start (${names(ok)})` };
    if (rows.length) return { connected: false, detail: `Figma MCP server not ready at session start: ${rows.map((l) => l.split(" - ").pop().trim()).join("; ")}` };
    return { connected: false, detail: "No Figma MCP server is configured in Claude Code" };
  },
  // `codex mcp list --json`: [{ name, enabled, auth_status: "o_auth" | "bearer_token" | "not_logged_in" | "unsupported", ... }]
  codex(out) {
    let list;
    try { list = JSON.parse(out); } catch { return null; }
    if (!Array.isArray(list)) list = list?.servers ?? list?.data ?? [];
    const rows = list.filter((s) => s && isFigma(String(s.name ?? "")));
    if (!rows.length) return { connected: false, detail: "No Figma MCP server is configured in Codex" };
    const status = (s) => String(s.auth_status ?? s.authStatus ?? s.auth ?? "").toLowerCase().replace(/[^a-z]/g, "");
    const ok = rows.filter((s) => s.enabled !== false && ["oauth", "bearertoken", "authenticated"].includes(status(s)));
    if (ok.length) return { connected: true, detail: `Figma MCP server signed in at session start (${ok.map((s) => s.name).join(", ")})` };
    if (rows.some((s) => s.enabled === false || ["notloggedin", "oauthavailable", "none"].includes(status(s))))
      return { connected: false, detail: `Figma MCP server not signed in at session start (${rows.map((s) => `${s.name}: ${s.enabled === false ? "disabled" : status(s) || "unknown"}`).join("; ")})` };
    return null;
  },
  // `copilot mcp list`: format not documented, so report only what is unambiguous.
  copilot(out) {
    const rows = out.split(/\r?\n/).filter((l) => isFigma(l));
    if (!rows.length) return null;
    const bad = rows.filter((l) => /needs|not (logged|signed|authenticated)|unauthenticated|failed|error|disabled|pending/i.test(l));
    const ok = rows.filter((l) => /\b(connected|authenticated|signed in|logged in)\b/i.test(l) && !bad.includes(l));
    if (ok.length) return { connected: true, detail: "Figma MCP server connected at session start (copilot mcp list)" };
    if (bad.length) return { connected: false, detail: `Figma MCP server not ready at session start: ${bad[0].trim().slice(0, 120)}` };
    return null;
  },
};

const commands = { claude: "claude mcp list", codex: "codex mcp list --json", copilot: "copilot mcp list" };  // fixed strings, no user input
const url = dashboardUrl();
if (!url) process.exit(0);
exec(commands[client], { timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, async (_err, stdout) => {
  const out = String(stdout || "");
  if (!out.trim()) return;
  const result = parsers[client](out);
  if (!result) return;
  const project = url.searchParams.get("project"), key = url.searchParams.get("key");
  try {
    await fetch(`${url.origin}/api/projects/${project}/figma-check?key=${encodeURIComponent(key)}&client=${client}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connected: result.connected, detail: result.detail.slice(0, 200) }),
    });
  } catch { /* the dashboard may be offline; the in-session check reports later */ }
});
