// Agents Dashboard: upload a run's artifacts (text files) so they show in the project's Documents tab.
// Usage: node .agents-dashboard/upload-docs.mjs <run_id> <folder>     e.g. ... 12 .agent-runs/FIN-2
// The file text goes straight to the dashboard, so the agent spends no tokens on it. Uploading again replaces
// files with the same path. The dashboard address and key come from the project's MCP config (no secret here).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const [runId, folder] = process.argv.slice(2);
if (!/^\d+$/.test(runId || "") || !folder) {
  console.log("Usage: node .agents-dashboard/upload-docs.mjs <run_id> <folder>");
  process.exit(0);
}

function dashboardUrl() {
  for (const file of [".mcp.json", ".codex/config.toml", ".vscode/mcp.json"]) {
    try {
      const m = readFileSync(file, "utf8").match(/https?:\/\/[^"'\s]+\/mcp\?project=\d+&key=[\w-]+/);
      if (m) return new URL(m[0]);
    } catch { /* not there; try the next one */ }
  }
  return null;
}

const MAX_CHARS = 500_000;
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) collect(full, out);
    else if (st.size <= MAX_CHARS * 4) {
      const buf = readFileSync(full);
      if (buf.includes(0)) continue; // binary (screenshots etc.)
      const content = buf.toString("utf8");
      if (content.length <= MAX_CHARS) out.push({ path: relative(folder, full).split(sep).join("/"), content });
    }
  }
  return out;
}

const url = dashboardUrl();
if (!url) { console.log("Agents Dashboard: no dashboard connection in this folder; run the setup command first."); process.exit(0); }
let files;
try { files = collect(folder); } catch (e) { console.log(`Agents Dashboard: cannot read ${folder}: ${e.message}`); process.exit(0); }

const project = url.searchParams.get("project"), key = url.searchParams.get("key");
let saved = 0;
try {
  for (let i = 0; i < files.length; i += 50) { // small batches keep each request well under proxy limits
    const res = await fetch(`${url.origin}/api/projects/${project}/documents/upload?key=${encodeURIComponent(key)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: Number(runId), files: files.slice(i, i + 50) }),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    saved += (await res.json()).saved;
  }
  console.log(`Agents Dashboard: uploaded ${saved} document(s) from ${folder} for run ${runId}.`);
} catch (e) {
  console.log(`Agents Dashboard: upload failed after ${saved} document(s): ${e.message}`);
}
