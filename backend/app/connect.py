"""Authenticate and identify the project on every MCP request.

The connect command the dashboard shows contains `?project=<id>&key=<secret>`. This ASGI wrapper
sits in front of the MCP app and, for every request to it:

- rejects the request (401) unless the project exists and the key matches;
- injects an `x-agents-project` header so tools can identify the project via `ctx.headers`;
- on the MCP hello message (`initialize`, or the newer `server/discover` probe that Claude Code sends
  first), marks the project connected and records which AI it was.

Nothing here touches the developer's files: the server may run on another machine.
"""
import json
import re
import tomllib
from urllib.parse import parse_qs

from sqlmodel import Session

from app import db
from app.connection_instructions import session_connection_check

PROJECT_HEADER = b"x-agents-project"
CLIENT_HEADER = b"x-agents-client"


def connect_url(project: db.Project, base: str = "http://localhost:8000") -> str:
    return f"{base}/mcp?project={project.id}&key={project.key}"


FIGMA_MCP_URL = "https://mcp.figma.com/mcp"  # Figma only lets approved AI tools sign in, so the AI connects it, not the dashboard


def mcp_json(project: db.Project, base: str) -> str:
    return json.dumps({"mcpServers": {"agents-dashboard": {"type": "http", "url": connect_url(project, base)},
                                      "figma": {"type": "http", "url": FIGMA_MCP_URL}}}, indent=2) + "\n"


def codex_toml(project: db.Project, base: str) -> str:
    instructions = json.dumps(session_connection_check("codex"))
    return (f'developer_instructions = {instructions}\n\n'
            f'[mcp_servers.agents-dashboard]\nurl = "{connect_url(project, base)}"\n\n'
            f'[mcp_servers.figma]\nurl = "{FIGMA_MCP_URL}"\n')


def copilot_url(project: db.Project, base: str) -> str:
    # VS Code's Local host identifies as VS Code, not as its selected model/provider.
    return connect_url(project, base) + "&client=copilot"


def copilot_json(project: db.Project, base: str) -> str:
    return json.dumps({"mcpServers": {
        f"agents-dashboard-{project.id}": {"type": "http", "url": copilot_url(project, base)},
        "figma": {"type": "http", "url": FIGMA_MCP_URL},
    }}, indent=2) + "\n"


def vscode_json(project: db.Project, base: str) -> str:
    """Workspace .vscode/mcp.json for Copilot in VS Code (its key is "servers", not "mcpServers")."""
    return json.dumps({"servers": json.loads(copilot_json(project, base))["mcpServers"]}, indent=2) + "\n"


# ---- one setup command: a script that writes every AI's config in the project folder ----
SETUP_FILES = {"claude": ".mcp.json", "codex": ".codex/config.toml", "vscode": ".vscode/mcp.json",
               "copilot-agent": ".github/agents/agents-dashboard.agent.md"}
SECRET_FILES = [".mcp.json", ".codex/config.toml", ".vscode/mcp.json"]  # hold the key; the agent file does not


def _merge_json(existing: str, fresh: str, key: str) -> str:
    data = json.loads(existing) if existing.strip() else {}
    if not isinstance(data, dict) or not isinstance(data.get(key, {}), dict):
        raise ValueError(f'expected a JSON object with a "{key}" object')
    data.setdefault(key, {}).update(json.loads(fresh)[key])
    return json.dumps(data, indent=2) + "\n"


def _merge_toml(existing: str, fresh: str) -> str:
    """Replace our tables and instruction line, keep everything else. Top-level keys must precede tables."""
    tomllib.loads(existing)  # refuse to edit a file that is already broken
    head, *tables = re.split(r"(?m)^(?=[ \t]*\[)", existing)
    fresh_head, *fresh_tables = re.split(r"(?m)^(?=\[)", fresh)
    tables = [t for t in tables if not re.match(r"[ \t]*\[\s*mcp_servers\.(agents-dashboard|figma)\s*[\].]", t)]
    head = re.sub(r'(?m)^developer_instructions = ".*report_connection.*"\n?', "", head)  # our previous line
    parts = [head.strip()] if head.strip() else []
    if not re.search(r"(?m)^[ \t]*developer_instructions\s*=", head):  # the user's own instructions win
        parts.append(fresh_head.strip())
    merged = "\n\n".join(parts + [t.strip() for t in tables + fresh_tables]) + "\n"
    tomllib.loads(merged)
    return merged


def setup_file(project: db.Project, base: str, client: str, existing: str = "") -> str:
    """The new content of one config file, merged into what the developer already has. ValueError if it cannot be."""
    from app import copilot
    existing = existing.lstrip("﻿")
    if client == "claude":
        return _merge_json(existing, mcp_json(project, base), "mcpServers")
    if client == "vscode":
        return _merge_json(existing, vscode_json(project, base), "servers")
    if client == "codex":
        return _merge_toml(existing, codex_toml(project, base))
    if client == "copilot-agent":
        return copilot.agent_profile(project.id, project.name)
    raise ValueError("unknown client")


_SETUP_PS = r"""& {
$ErrorActionPreference = 'Stop'
$api = '__API__'
Write-Host "Agents Dashboard: setting up project __ID__ in $PWD"
if (-not (Test-Path .git)) { Write-Host '  Note: no .git folder here. Run this in your project root.' }
function Put($client, $file) {
  $path = Join-Path $PWD $file
  $old = if (Test-Path $path) { [IO.File]::ReadAllText($path) } else { '' }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$api&client=$client" -ContentType 'text/plain; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($old))
    New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
    [IO.File]::WriteAllText($path, $r.Content)  # UTF-8 without BOM, which the AI tools need
    Write-Host "  wrote $file"
  } catch { Write-Host "  skipped $file ($($_.Exception.Message)). Add it from the dashboard's config tab." }
}
__PUTS_PS__
$gi = Join-Path $PWD '.gitignore'
$text = if (Test-Path $gi) { [IO.File]::ReadAllText($gi) } else { '' }
$add = @(__SECRETS_PS__) | Where-Object { ($text -split "`r?`n") -notcontains $_ }
if ($add) {
  if ($text -and -not $text.EndsWith("`n")) { $text += "`n" }
  [IO.File]::WriteAllText($gi, $text + ($add -join "`n") + "`n")
  Write-Host "  added $($add -join ', ') to .gitignore (they contain the project key)"
}
Write-Host ''
Write-Host 'Done. Open a NEW session in this folder:'
__NEXT__
}
"""

_SETUP_SH = r"""#!/bin/sh
api='__API__'
echo "Agents Dashboard: setting up project __ID__ in $(pwd)"
[ -d .git ] || echo "  Note: no .git folder here. Run this in your project root."
put() {
  mkdir -p "$(dirname "$2")"
  src=/dev/null; [ -f "$2" ] && src="$2"
  if curl -fsS -H 'Content-Type: text/plain; charset=utf-8' --data-binary "@$src" "$api&client=$1" -o "$2.tmp"; then
    mv "$2.tmp" "$2"; echo "  wrote $2"
  else
    rm -f "$2.tmp"; echo "  skipped $2. Add it from the dashboard's config tab."
  fi
}
__PUTS_SH__
touch .gitignore
[ -s .gitignore ] && [ -n "$(tail -c1 .gitignore)" ] && echo >> .gitignore
for f in __SECRETS_SH__; do
  grep -qxF "$f" .gitignore || { echo "$f" >> .gitignore; echo "  added $f to .gitignore (it contains the project key)"; }
done
echo
echo "Done. Open a NEW session in this folder:"
__NEXT__
"""


def setup_script(project: db.Project, base: str, shell: str) -> str:
    api = f"{base}/api/projects/{project.id}/setup-file?key={project.key}"
    copilot_cli = f'copilot mcp add --transport http agents-dashboard-{project.id} "{copilot_url(project, base)}"'
    next_steps = ["  Claude Code:     run claude, approve agents-dashboard and figma when asked",
                  "  Codex:           trust this folder, then start a new session",
                  "  Copilot VS Code: reload the window, start the servers, pick the Agents Dashboard agent",
                  f"  Copilot CLI:     {copilot_cli}"]
    if shell == "ps":
        puts = "\n".join(f"Put '{c}' '{f}'" for c, f in SETUP_FILES.items())
        secrets_ = ", ".join(f"'{f}'" for f in SECRET_FILES)
        nxt = "\n".join("Write-Host '" + line.replace("'", "''") + "'" for line in next_steps)
        tpl = _SETUP_PS.replace("__PUTS_PS__", puts).replace("__SECRETS_PS__", secrets_)
    else:
        puts = "\n".join(f"put {c} '{f}'" for c, f in SETUP_FILES.items())
        secrets_ = " ".join(SECRET_FILES)
        nxt = "\n".join("echo '" + line.replace("'", "'\\''") + "'" for line in next_steps)
        tpl = _SETUP_SH.replace("__PUTS_SH__", puts).replace("__SECRETS_SH__", secrets_)
    return tpl.replace("__API__", api).replace("__ID__", str(project.id)).replace("__NEXT__", nxt)


def connect_commands(project: db.Project, base: str = "http://localhost:8000") -> dict:
    """Everything the wizard shows. Three ways to connect, all equivalent:
    a CLI command, a ready-made config file to drop in the project, or a one-liner that downloads that file."""
    url = connect_url(project, base)
    dl = f"{base}/api/projects/{project.id}/mcp-config?key={project.key}"
    setup = f"{base}/api/projects/{project.id}/setup?key={project.key}"
    return {
        # one command, every AI: writes Claude, Codex, VS Code Copilot configs and the Copilot agent
        "setup_ps": f'iwr -useb "{setup}&shell=ps" | iex',
        "setup_sh": f'curl -fsSL "{setup}&shell=sh" | sh',
        "url": url,
        "claude": f'claude mcp add --scope project --transport http agents-dashboard "{url}"',
        "codex": f'codex mcp add agents-dashboard --url "{url}"',
        "copilot": f'copilot mcp add --transport http agents-dashboard-{project.id} "{copilot_url(project, base)}"',
        "copilot_url": copilot_url(project, base),
        "copilot_server_name": f"agents-dashboard-{project.id}",
        "copilot_json": copilot_json(project, base),
        "download_copilot": f"{dl}&client=copilot",
        "vscode_json": vscode_json(project, base),
        "download_vscode": f"{dl}&client=vscode",
        "download_copilot_agent": f"{base}/api/projects/{project.id}/copilot-agent?key={project.key}",
        "mcp_json": mcp_json(project, base),
        "codex_toml": codex_toml(project, base),
        "download_claude": f"{dl}&client=claude",
        "download_codex": f"{dl}&client=codex",
        # run inside the project folder; writes the file, no CLI needed
        "oneliner_claude_ps": f'iwr "{dl}&client=claude" -OutFile .mcp.json',
        "oneliner_claude_sh": f'curl -fsSL "{dl}&client=claude" -o .mcp.json',
        "oneliner_codex_ps": f'mkdir .codex -Force | Out-Null; iwr "{dl}&client=codex" -OutFile .codex/config.toml',
        "oneliner_codex_sh": f'mkdir -p .codex && curl -fsSL "{dl}&client=codex" -o .codex/config.toml',
    }


def ai_from_client(name: str) -> str:
    n = (name or "").lower()
    if any(value in n for value in ("github-copilot", "github copilot", "copilot-cli", "copilot cli")):
        return "copilot"
    return "claude" if "claude" in n else "codex" if "codex" in n else "unknown"


def authenticate(query_string: bytes) -> int | None:
    """Return the project id when project+key in the query string are valid, else None."""
    q = parse_qs(query_string.decode(errors="replace"))
    pid, key = q.get("project", [None])[0], q.get("key", [None])[0]
    if not pid or not pid.isdigit() or not key:
        return None
    with Session(db.engine) as s:
        p = s.get(db.Project, int(pid))
        return p.id if p and p.key == key else None


def mark_connected(project_id: int, client_name: str, client_hint: str = "") -> None:
    with Session(db.engine) as s:
        p = s.get(db.Project, project_id)
        if not p:
            return
        p.connected_at = db.now()
        ai = ai_from_client(client_name)
        if ai == "unknown" and client_hint == "copilot":
            ai = "copilot"
        if ai != "unknown":
            p.ai = ai
            setattr(p, f"{ai}_connected_at", p.connected_at)
        s.add(p)
        s.commit()
    from app.logs import record
    label = {"claude": "Claude Code", "codex": "Codex", "copilot": "GitHub Copilot"}.get(ai, client_name or "An AI client")
    record(project_id, "connected", f"{label} connected to the dashboard", source="system",
           client=ai if ai != "unknown" else "", detail={"client_info": client_name})


def _client_name(body: bytes) -> str | None:
    try:
        msg = json.loads(body or b"{}")
    except json.JSONDecodeError:
        return None
    if not isinstance(msg, dict):
        return None
    params = msg.get("params") or {}
    if msg.get("method") == "initialize":
        return (params.get("clientInfo") or {}).get("name", "")
    if msg.get("method") == "server/discover":  # MCP 2026-07: client info travels in _meta
        meta = params.get("_meta") or {}
        return (meta.get("io.modelcontextprotocol/clientInfo") or {}).get("name", "")
    return None


class ProjectAuth:
    """Pure ASGI wrapper around the MCP app."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        pid = authenticate(scope.get("query_string", b""))
        if pid is None:
            body = b'{"error":"Unknown project or wrong key. Copy the connect command from the dashboard again."}'
            await send({"type": "http.response.start", "status": 401,
                        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return
        query = parse_qs(scope.get("query_string", b"").decode(errors="replace"))
        client_hint = "copilot" if query.get("client") == ["copilot"] else ""
        headers = [(k, v) for k, v in scope.get("headers", []) if k.lower() not in (PROJECT_HEADER, CLIENT_HEADER)]
        headers += [(PROJECT_HEADER, str(pid).encode()), (CLIENT_HEADER, client_hint.encode())]
        scope = {**scope, "headers": headers}
        if scope.get("method") == "POST":
            chunks, more = [], True
            while more:
                message = await receive()
                chunks.append(message.get("body", b""))
                more = message.get("more_body", False)
            body = b"".join(chunks)
            client = _client_name(body)
            if client is not None:
                try:
                    mark_connected(pid, client, client_hint)
                except Exception:  # never break the handshake over bookkeeping
                    pass
            replay = [{"type": "http.request", "body": body, "more_body": False}]

            async def receive_replay():
                return replay.pop(0) if replay else await receive()

            return await self.app(scope, receive_replay, send)
        return await self.app(scope, receive, send)
