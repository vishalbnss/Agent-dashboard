import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Editable production deployment target, reconstructed from the reviewed diagram.
// Reference service documentation:
// https://learn.microsoft.com/azure/api-management/mcp-server-overview
// https://learn.microsoft.com/azure/container-apps/manage-secrets
// https://learn.microsoft.com/azure/databricks/oltp/projects/
// https://learn.microsoft.com/azure/databricks/oltp/projects/point-in-time-restore

const W = 2400, H = 1745;
const OUTPUT_BASE = 'agents-dashboard-production-final';
const C = { ink: '#102840', muted: '#49647f', teal: '#008b92', blue: '#236aa9', orange: '#a45212', line: '#657f9f' };
const parts = [];
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const nodes = new Map();
const edges = [];

function rect(x, y, w, h, { fill = '#fff', stroke = '#b6cbdc', sw = 1.6, r = 13, id = '' } = {}) {
  parts.push(`<rect ${id ? `id="${id}"` : ''} x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
}
function text(x, y, value, size = 22, { fill = C.ink, weight = 400, anchor = 'start', family = 'Segoe UI, Arial, sans-serif' } = {}) {
  parts.push(`<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" font-family="${family}">${esc(value)}</text>`);
}
function lines(x, y, values, size = 22, options = {}) {
  values.forEach((v, i) => text(x, y + i * (options.leading ?? size * 1.4), v, size, options));
}
function box(id, x, y, w, h, title, body = [], opts = {}) {
  nodes.set(id, { x, y, w, h });
  rect(x, y, w, h, { stroke: C.teal, id, ...opts });
  text(x + 22, y + 37, title, opts.titleSize ?? 25, { weight: 600, fill: opts.titleColor ?? C.ink });
  lines(x + 22, y + 70, body, opts.bodySize ?? 21, { fill: C.muted, leading: opts.leading ?? 29 });
}
function label(x, y, values, { size = 19, fill = C.muted, anchor = 'middle' } = {}) {
  if (typeof values === 'string') values = [values];
  const width = Math.max(...values.map(v => [...v].length)) * size * .53 + 22;
  const height = values.length * size * 1.32 + 8;
  const left = anchor === 'middle' ? x - width / 2 : x - 9;
  rect(left, y - size - 3, width, height, { fill: '#ffffff', stroke: 'none', r: 5 });
  lines(x, y, values, size, { fill, anchor, leading: size * 1.32 });
}
function edge(id, from, to, points, { color = C.line, both = false, dashed = false } = {}) {
  edges.push({ id, from, to, points });
  const path = points.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' ');
  const marker = color === C.teal ? 'teal' : color === C.orange ? 'orange' : 'blue';
  parts.push(`<path id="${id}" data-from="${from}" data-to="${to}" d="${path}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" ${dashed ? 'stroke-dasharray="7 5"' : ''} marker-end="url(#${marker})" ${both ? `marker-start="url(#${marker}Start)"` : ''}/>`);
}

// Columns and headings.
rect(0, 0, W, H, { stroke: 'none', r: 0 });
text(40, 65, 'Agents Dashboard — System Architecture', 42, { weight: 650 });
text(40, 105, 'Production deployment target on Azure · developer-run agents · personas and external services', 23, { fill: C.muted });
rect(40, 130, 2325, 87, { fill: '#edf8f6', stroke: '#b4dfdc', r: 12, id: 'run-initiation' });
text(62, 158, 'DEVELOPER-INITIATED WORKFLOW', 17, { fill: C.teal, weight: 650 });
text(62, 194, 'Developer request → local Claude Code / Codex → start_run via Dashboard MCP → backend creates the run and returns workflow instructions', 25, { weight: 500 });
parts.push('<g id="architecture-detail" transform="translate(0 105)">');
nodes.set('workstation', { x: 40, y: 240, w: 485, h: 1165 });
rect(40, 240, 485, 1165, { fill: '#f6fafc', stroke: '#d6e3ee', id: 'workstation' });
rect(600, 240, 1150, 1190, { fill: '#f4f9fc', stroke: '#d6e3ee' });
nodes.set('personas', { x: 1790, y: 240, w: 290, h: 560 });
rect(1790, 240, 290, 560, { fill: '#fff9f0', stroke: '#efcfa9', id: 'personas' });
rect(2100, 240, 265, 1165, { fill: '#f6f8fc', stroke: '#d6e3ee' });
text(62, 271, 'DEVELOPER WORKSTATION', 19, { fill: C.teal, weight: 650 });
text(62, 299, 'One per developer', 20, { fill: C.muted });
text(625, 271, 'AZURE — AGENTS DASHBOARD', 19, { fill: C.teal, weight: 650 });
text(1810, 271, 'PERSONAS', 19, { fill: C.orange, weight: 650 });
text(2118, 271, 'EXTERNAL SERVICES', 18, { fill: C.blue, weight: 650 });

// Developer machine. The developer installs their client and configures remote MCP.
box('ai', 65, 325, 430, 405, 'Claude Code / Codex', ['Local coding client · provider login', 'Project MCP configuration'], { titleSize: 28, bodySize: 21 });
box('coordinator', 88, 450, 384, 95, 'Coordinator agent', ['Drives the run, stage by stage'], { fill: '#e9f8f6', stroke: '#b4dfdc', bodySize: 20, titleSize: 23 });
box('agents', 88, 570, 384, 136, '9 stage agents', ['Claude: Haiku · Sonnet · Opus', 'Codex: Luna · Terra · Sol', 'Model selected per stage'], { fill: '#e9f8f6', stroke: '#b4dfdc', bodySize: 20, titleSize: 23, leading: 26 });
box('repo', 65, 825, 430, 275, 'Local Git repository', [], { titleSize: 28 });
rect(88, 885, 384, 42, { fill: '#e9f8f6', stroke: 'none', r: 6 });
text(105, 913, 'feature/<ticket> branch', 20, { family: 'Consolas, monospace' });
rect(88, 945, 384, 42, { fill: '#e9f8f6', stroke: 'none', r: 6 });
text(105, 973, '.agent-runs/<ticket>/ evidence', 19, { family: 'Consolas, monospace' });
rect(88, 1005, 384, 70, { fill: '#e9f8f6', stroke: 'none', r: 6 });
lines(105, 1033, ['AGENTS.md + CLAUDE.md routing note', '(written by the AI)'], 19, { family: 'Consolas, monospace', leading: 27 });
box('hook', 65, 1155, 430, 140, 'Usage hook (optional)', ['Reports token usage to backend', 'POST /api/runs/{id}/usage', 'Backend stores usage in the database'], { titleSize: 24, bodySize: 19, leading: 25 });
lines(65, 1320, ['Local AI client + Git required', '(+ optional usage hook).', 'Project MCP configuration added.'], 21, { fill: C.muted, leading: 29 });

// Managed ingress and identity services are outside the application containers.
box('apim', 655, 310, 560, 115, 'API gateway', ['Azure API Management (APIM)', 'HTTPS/TLS · /mcp + /api · access policies'], { stroke: C.teal, sw: 2.3, titleSize: 27, bodySize: 23, leading: 28 });
box('sso', 1330, 310, 370, 115, 'SSO — Microsoft Entra ID', ['Company login', 'Dashboard / API access'], { stroke: C.blue, titleSize: 24, bodySize: 21, leading: 27 });
box('ingress', 1330, 470, 370, 65, 'HTTPS web ingress', [], { stroke: C.blue, titleSize: 26 });

rect(625, 595, 1100, 480, { fill: '#eef8fb', stroke: '#7ab8cc', r: 14 });
text(650, 627, 'AZURE CONTAINER DEPLOYMENT', 18, { fill: C.teal, weight: 650 });
text(650, 655, 'Separate backend and web dashboard containers', 21, { fill: C.muted });
box('backend', 650, 685, 640, 340, 'Backend container — FastAPI (Python)', [], { titleSize: 26 });
box('mcp', 675, 745, 280, 100, 'MCP endpoint /mcp', ['Project ID + secret key', 'checked on every call'], { fill: '#e9f8f6', stroke: '#b4dfdc', titleSize: 22, bodySize: 19, leading: 25 });
box('rest', 975, 745, 285, 100, 'REST API /api', ['Projects · connections', 'Approvals · runs'], { fill: '#e9f8f6', stroke: '#b4dfdc', titleSize: 22, bodySize: 19, leading: 25 });
box('workflow', 675, 900, 280, 105, 'Workflow service', ['Coordinator + 9 prompts', 'Approvals · run tracking'], { fill: '#e9f8f6', stroke: '#b4dfdc', titleSize: 22, bodySize: 19, leading: 25 });
box('integrations', 975, 900, 285, 105, 'Integration clients', ['Jira (Atlassian MCP)', 'GitHub'], { fill: '#e9f8f6', stroke: '#b4dfdc', titleSize: 22, bodySize: 19, leading: 25 });
box('web', 1380, 685, 310, 195, 'Web dashboard container', ['React'], { titleSize: 22, bodySize: 21 });
['Projects', 'Connections', 'Approvals', 'Runs'].forEach((v, i) => {
  const x = 1398 + (i % 2) * 142, y = 785 + Math.floor(i / 2) * 41;
  rect(x, y, 133, 31, { fill: '#e9f8f6', stroke: '#c5e8e4', r: 6 });
  text(x + 66, y + 22, v, 18, { fill: C.muted, anchor: 'middle' });
});

// Production state, secrets and operations.
box('database', 650, 1130, 640, 150, 'Database — primary + configured fallback', [], { stroke: C.blue, titleSize: 24 });
text(673, 1203, 'Primary: Databricks Lakebase PostgreSQL', 26, { weight: 600 });
text(673, 1236, 'Fallback: PostgreSQL (configuration-based)', 22, { fill: C.muted });
text(673, 1264, 'Projects · tickets · runs · phases · approvals', 20, { fill: C.muted });
box('vault', 1330, 1130, 370, 150, 'Azure Key Vault', ['APP_SECRET · integration / DB secrets', 'Managed identity access', 'Backend encrypts stored tokens'], { stroke: C.blue, titleSize: 26, bodySize: 18, leading: 27 });
box('logs', 650, 1310, 535, 110, 'Logs & monitoring', ['Azure Monitor / Application Insights', 'APIM + container telemetry'], { stroke: C.blue, titleSize: 25, bodySize: 20, leading: 25 });
box('backups', 1220, 1310, 480, 110, 'Database backups & recovery', ['Lakebase snapshots / point-in-time restore', 'PostgreSQL backup & restore policy'], { stroke: C.blue, titleSize: 24, bodySize: 18, leading: 25 });

// Humans access the web app through their browser and company SSO.
box('browser', 1810, 310, 250, 80, 'Browser · HTTPS', [], { stroke: '#df9f54', titleColor: C.orange, titleSize: 25 });
box('developer', 1810, 470, 250, 140, 'Developer', ['Sets up project + AI', 'Initiates start_run', 'Authorizes push / PR'], { stroke: '#df9f54', titleColor: C.orange, titleSize: 26, bodySize: 21, leading: 26 });
box('reviewer', 1810, 650, 250, 125, 'Product Owner / FDE', ['Reviews and approves', 'design documents'], { stroke: '#df9f54', titleColor: C.orange, titleSize: 19, bodySize: 21, leading: 27 });

box('providers', 2120, 325, 225, 150, 'AI providers', ['Anthropic / OpenAI', 'Coding client login'], { stroke: '#b6cbdc', titleSize: 25, bodySize: 21, leading: 28 });
box('figma', 2120, 550, 225, 140, 'Figma MCP', ['Designs', 'Client OAuth sign-in'], { stroke: '#b6cbdc', titleSize: 25, bodySize: 20, leading: 29 });
box('atlassian', 2120, 805, 225, 150, 'Atlassian MCP', ['Jira tickets', 'Project OAuth', 'connection'], { stroke: '#b6cbdc', titleSize: 24, bodySize: 21, leading: 28 });
box('github', 2120, 1120, 225, 135, 'GitHub', ['Branches +', 'pull requests'], { stroke: '#b6cbdc', titleSize: 25, bodySize: 22, leading: 30 });

// Exterior routes: direct provider/Figma access and authorized Git writes.
edge('model-calls', 'ai', 'providers', [[150, 325], [150, 150], [2095, 150], [2095, 365], [2120, 365]]);
label(1230, 145, 'Model calls from the local Claude Code / Codex client', { size: 20 });
edge('figma-access', 'ai', 'figma', [[320, 325], [320, 195], [2085, 195], [2085, 590], [2120, 590]]);
label(1230, 190, 'Figma designs · Claude Code / Codex calls Figma MCP using client OAuth', { size: 20 });
edge('local-code-work', 'ai', 'repo', [[280, 730], [280, 825]], { both: true });
label(357, 782, ['reads · edits', 'commits'], { size: 20 });
edge('git-writes', 'workstation', 'github', [[300, 1405], [300, 1475], [2085, 1475], [2085, 1205], [2120, 1205]]);
label(1265, 1467, 'git push (HTTPS / SSH) · gh pr create fallback · developer authorization required', { size: 20 });

// Client -> gateway -> exact application endpoint. Web content uses its own ingress.
edge('ai-mcp', 'ai', 'apim', [[495, 395], [550, 395], [550, 345], [655, 345]], { color: C.teal, both: true });
label(550, 440, ['MCP /', 'HTTPS', 'ID + key'], { size: 18 });
edge('usage-post', 'hook', 'apim', [[495, 1205], [575, 1205], [575, 405], [655, 405]], { color: C.teal });
label(550, 1105, ['Usage', 'REST /api'], { size: 16 });
edge('gateway-mcp', 'apim', 'mcp', [[810, 425], [810, 565], [635, 565], [635, 795], [675, 795]], { color: C.teal, both: true });
label(810, 493, ['start_run · developer-initiated', '/mcp · Streamable HTTP'], { size: 19 });
edge('gateway-rest', 'apim', 'rest', [[1100, 425], [1100, 565], [1308, 565], [1308, 795], [1260, 795]]);
label(1100, 507, '/api · HTTPS', { size: 21 });
edge('web-api', 'web', 'apim', [[1518, 685], [1518, 570], [1247, 570], [1247, 390], [1215, 390]]);
label(1420, 566, 'REST /api through APIM', { size: 20 });
edge('browser-web', 'browser', 'ingress', [[1810, 365], [1770, 365], [1770, 500], [1700, 500]]);
label(1796, 441, ['Browser', 'HTTPS'], { size: 19 });
edge('web-content', 'ingress', 'web', [[1655, 535], [1655, 675], [1580, 675], [1580, 685]]);
label(1660, 588, 'Web content', { size: 18 });
edge('developer-browser', 'developer', 'browser', [[1860, 470], [1860, 390]], { color: C.orange });
edge('reviewer-browser', 'reviewer', 'browser', [[2060, 710], [2071, 710], [2071, 350], [2060, 350]], { color: C.orange });
edge('personas-auth', 'sso', 'personas', [[1515, 310], [1515, 226], [1935, 226], [1935, 240]], { color: C.orange, both: true });
label(1750, 223, 'Authenticate · all personas', { size: 18, fill: C.orange });
edge('sso-access', 'sso', 'apim', [[1330, 355], [1215, 355]], { color: C.blue });
label(1272, 337, 'SSO', { size: 18 });

// Backend tools, state, secrets and external integrations.
edge('mcp-workflow', 'mcp', 'workflow', [[815, 845], [815, 900]], { color: C.teal });
label(863, 878, 'tool calls', { size: 18 });
edge('ticket-fetch', 'workflow', 'integrations', [[955, 955], [975, 955]], { color: C.teal });
label(965, 890, 'get_ticket', { size: 17 });
edge('state-storage', 'backend', 'database', [[835, 1025], [835, 1130]], { both: true });
label(1018, 1105, 'reads / writes · PostgreSQL over TLS', { size: 20 });
edge('secret-resolution', 'backend', 'vault', [[1180, 1025], [1180, 1090], [1515, 1090], [1515, 1130]]);
label(1515, 1081, 'Managed identity · secret references', { size: 18 });
edge('jira-mcp', 'integrations', 'atlassian', [[1260, 930], [1320, 930], [1320, 905], [2120, 905]]);
label(1822, 897, 'HTTPS · project OAuth', { size: 20 });
edge('pr-api', 'integrations', 'github', [[1260, 970], [1320, 970], [1320, 1060], [2070, 1060], [2070, 1160], [2120, 1160]]);
label(1810, 1052, 'PR API · saved token · developer authorization', { size: 19 });
edge('db-recovery', 'database', 'backups', [[1260, 1280], [1260, 1293], [1460, 1293], [1460, 1310]]);

// A compact, unambiguous protocol and deployment note.
text(40, 1506, 'Requirement intake: developer prompt → local Claude Code/Codex → start_run + get_ticket → backend returns requirements and workflow instructions.', 20, { fill: C.muted });
text(40, 1535, 'First run: local client writes AGENTS.md and saves it through the backend. MCP replies carry prompts and approvals; approval polling is every 20 seconds.', 20, { fill: C.muted });
text(40, 1564, 'Production target: SSO, containers and Azure services are deployment requirements. PostgreSQL fallback is selected via DATABASE_URL; no automatic failover is implied.', 20, { fill: C.muted });
text(40, 1604, 'LEGEND', 18, { weight: 650, fill: C.blue });
[
  [160, C.teal, '#e9f8f6', 'Containers / application'],
  [595, C.blue, '#f4f9fc', 'Azure managed services'],
  [1050, '#df9f54', '#fff9f0', 'Personas'],
  [1330, '#b6cbdc', '#f6f8fc', 'External services'],
].forEach(([x, stroke, fill, title]) => {
  rect(x, 1587, 34, 24, { stroke, fill, r: 5 });
  text(x + 48, 1606, title, 19, { fill: C.muted });
});
parts.push('</g>');

// Check every connector starts/ends on its declared component boundary.
function onBoundary([px, py], n) {
  const inX = px >= n.x && px <= n.x + n.w;
  const inY = py >= n.y && py <= n.y + n.h;
  return (inX && (py === n.y || py === n.y + n.h)) || (inY && (px === n.x || px === n.x + n.w));
}
for (const e of edges) {
  const start = nodes.get(e.from), end = nodes.get(e.to);
  if (!start || !end || !onBoundary(e.points[0], start) || !onBoundary(e.points.at(-1), end)) {
    throw new Error(`Connector ${e.id} does not land on its declared components.`);
  }
}
const markers = ['blue', 'teal', 'orange'].flatMap(name => {
  const color = name === 'teal' ? C.teal : name === 'orange' ? C.orange : C.line;
  return [
    `<marker id="${name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/></marker>`,
    `<marker id="${name}Start" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 10 0 L 0 5 L 10 10 z" fill="${color}"/></marker>`,
  ];
}).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title description"><title id="title">Agents Dashboard — production architecture on Azure</title><desc id="description">Developer-run agents connect to Azure API Management, which routes MCP and REST to a FastAPI container. A separate React container serves the web dashboard. Company SSO uses Microsoft Entra ID, secrets use Azure Key Vault, and the primary database is Databricks Lakebase PostgreSQL with a configurable PostgreSQL fallback. Provider, Figma, Jira and authorized GitHub connections are shown separately.</desc><defs>${markers}</defs>${parts.join('\n')}</svg>`;
writeFileSync(fileURLToPath(new URL(`./${OUTPUT_BASE}.svg`, import.meta.url)), svg, 'utf8');
writeFileSync(fileURLToPath(new URL(`./${OUTPUT_BASE}.html`, import.meta.url)), `<!doctype html><html><head><meta charset="utf-8"><title>Agents Dashboard — Production Architecture</title><style>html,body{margin:0;padding:0;background:#fff;width:${W}px;height:${H}px;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`, 'utf8');
console.log(`Saved editable SVG and HTML (${W} × ${H}); checked ${edges.length} connector endpoints.`);
