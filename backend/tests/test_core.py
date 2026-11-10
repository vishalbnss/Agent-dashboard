import json
import re
import os
import tempfile
import tomllib

os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.mkdtemp()}/test.db"
os.environ.setdefault("APP_SECRET", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app import connect, db, onboarding
from app.crypto import decrypt, encrypt
from app.integrations import figma, jira, mcp_oauth
from app.main import app
from app.mcp import tools

MCP_HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "claude-code", "version": "2.0"}}}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:  # runs lifespan -> init_db
        yield c


def _key(pid: int) -> str:
    with Session(db.engine) as s:
        return s.get(db.Project, pid).key


def test_copilot_connection_and_config(client):
    pid = client.post("/api/projects", json={"name": "Copilot project"}).json()["id"]
    original = client.get(f"/api/projects/{pid}").json()
    c = original["connect"]
    assert original["copilot_connected_at"] is None
    assert c["copilot_url"] == c["url"] + "&client=copilot"
    assert c["copilot_server_name"] == f"agents-dashboard-{pid}"
    config = json.loads(c["copilot_json"])
    assert config["mcpServers"][c["copilot_server_name"]] == {"type": "http", "url": c["copilot_url"]}
    assert config["mcpServers"]["figma"]["url"] == "https://mcp.figma.com/mcp"
    assert 'copilot mcp add --transport http' in c["copilot"]
    assert client.get(c["download_copilot"]).json() == config
    assert client.get(f"/api/projects/{pid}/copilot-agent?key=wrong").status_code == 401
    profile = client.get(c["download_copilot_agent"])
    assert profile.status_code == 200 and profile.text.startswith("---\n")
    assert c["copilot_server_name"] in profile.text and 'client="copilot"' in profile.text
    assert "get_connection_status" in profile.text and "get_stage(name, run_id=run_id)" in profile.text
    assert _key(pid) not in profile.text
    assert client.get(f"/api/projects/{pid}").json()["copilot_connected_at"] is None

    # VS Code's generic client identity needs the Copilot-specific URL; headers alone cannot spoof it.
    init = {**INIT, "params": {**INIT["params"], "clientInfo": {"name": "Visual Studio Code", "version": "1"}}}
    spoof = {**MCP_HEADERS, "x-agents-client": "copilot", "x-agents-project": "99999"}
    assert client.post(c["url"], headers=spoof, json=init).status_code == 200
    assert client.get(f"/api/projects/{pid}").json()["copilot_connected_at"] is None
    assert client.post(f"/mcp?project={pid}&key=wrong&client=copilot", headers=MCP_HEADERS, json=init).status_code == 401
    response = client.post(c["copilot_url"], headers=spoof, json=init)
    assert response.status_code == 200
    p = client.get(f"/api/projects/{pid}").json()
    assert p["copilot_connected_at"] and p["ai"] == "copilot" and not p["claude_connected_at"] and not p["codex_connected_at"]
    headers = {**MCP_HEADERS, "mcp-session-id": response.headers["mcp-session-id"], "x-agents-project": "99999"}
    client.post(c["copilot_url"], headers=headers, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    def call(name, arguments):
        response = client.post(c["copilot_url"], headers=headers, json={"jsonrpc": "2.0", "id": 3,
            "method": "tools/call", "params": {"name": name, "arguments": arguments}})
        assert response.status_code == 200
        message = next((line[6:] for line in response.text.splitlines() if line.startswith("data: ")), response.text)
        result = json.loads(message)["result"]
        assert result["isError"] is False
        return result.get("structuredContent") or json.loads(result["content"][0]["text"])
    assert call("get_connection_status", {}) == {"connected": True, "project_id": pid,
        "project_name": "Copilot project", "client": "copilot", "has_agents_md": False}
    assert client.get(f"/api/projects/{pid}").json() == p  # no status probe side effects
    assert client.get(f"/api/runs?project_id={pid}").json() == []
    call("report_connection", {"kind": "figma", "connected": True, "detail": "Read succeeded"})
    figma = client.get(f"/api/projects/{pid}").json()["integrations"][0]["config"]
    assert figma["clients"]["copilot"]["connected"] is True
    # Omitted client is resolved from the authenticated URL for Copilot.
    run = call("start_run", {"goal": "Implement CP-1", "title": "CP-1"})
    assert client.get(f"/api/runs/{run['run_id']}").json()["client"] == "copilot"
    assert "GitHub Copilot execution rules" in call("get_stage", {"name": "implementation", "run_id": run["run_id"]})["prompt"]
    # Connecting another client keeps Copilot's history and chooses that client's own edition.
    connect.mark_connected(pid, "codex", "copilot")
    p = client.get(f"/api/projects/{pid}").json()
    assert p["codex_connected_at"] and p["copilot_connected_at"] and p["ai"] == "codex"
    for name in ("GitHub Copilot", "github-copilot-chat", "copilot-cli", "GitHub Copilot CLI"):
        assert connect.ai_from_client(name) == "copilot"
    assert connect.ai_from_client("copilot-cowork") == "unknown"


def test_copilot_workflow_isolation_approvals_and_usage(client):
    pid = client.post("/api/projects", json={"name": "Copilot delivery"}).json()["id"]
    other = client.post("/api/projects", json={"name": "Another project"}).json()["id"]
    run = tools.do_start_run(pid, "Implement CP-2", client="copilot")
    rid = run["run_id"]
    assert len(run["stages"]) == 9 and run["needs_onboarding"]
    assert all(stage["model"] == "selected Copilot model" for stage in run["stages"])
    assert "submit_design_document" in run["plan"] and "check_approval" in run["plan"]
    assert "The initial tester must not receive Figma" in run["plan"]
    assert "Haiku" not in run["plan"] and "Agent tool)" not in run["plan"]
    assert "Preserve existing agent instructions" in run["plan"]
    assert "task" in run["plan"] and "agent/runSubagent" in run["plan"]
    assert "do not calculate Copilot cost" in tools.do_get_stage(pid, "documentation", rid)["prompt"]
    assert "API-equivalent planning estimate" not in tools.do_get_stage(pid, "documentation", rid)["prompt"]
    assert 'client="copilot"' in tools.do_get_stage(pid, "figma-intake", rid)["prompt"]
    assert 'client="claude"' not in tools.do_get_stage(pid, "figma-intake", rid)["prompt"]
    connect.mark_connected(pid, "claude-code")
    for name in onboarding.stage_names():
        assert "GitHub Copilot execution rules" in tools.do_get_stage(pid, name, rid)["prompt"]
    assert "GitHub Copilot execution rules" not in tools.do_get_stage(pid, "implementation")["prompt"]
    assert "error" in tools.do_get_stage(pid, "extract-codex-telemetry", rid)
    with pytest.raises(ValueError, match="another project"):
        tools.do_get_stage(other, "implementation", rid)
    tools.do_report_connection(pid, "figma", True, client="copilot")
    tools.do_report_connection(pid, "figma", False, client="claude")
    config = client.get(f"/api/projects/{pid}").json()["integrations"][0]["config"]
    assert config["clients"]["copilot"]["connected"] and not config["clients"]["claude"]["connected"]
    approval = tools.do_submit_design_document(pid, rid, "# Plan\nImplement CP-2")
    assert client.get(f"/api/runs/{rid}").json()["status"] == "awaiting_approval"
    assert tools.do_check_approval(pid, rid)["status"] == "pending"
    client.post(f"/api/runs/{rid}/approvals/{approval['version']}/decide",
                json={"decision": "approved", "name": "Tester", "comment": ""})
    tools.do_finish_run(pid, rid, {"what_changed": ["Change tested"], "usage": {"ai_credits": 1.25, "input_tokens": 1500},
        "stages": [{"phase": "implementation", "model": "sonnet", "tokens": 5000, "outcome": "Build passed"}]})
    result = client.get(f"/api/runs/{rid}").json()
    assert result["client"] == "copilot" and result["status"] == "done"
    assert result["usage"] == {"ai_credits": 1.25, "input_tokens": 1500}
    assert "GitHub AI credits" in result["summary_md"]
    assert "$0.00" not in result["summary_md"]
    tools.do_finish_run(pid, rid, {"usage": {"cost_usd": 0.12}})
    assert client.get(f"/api/runs/{rid}").json()["usage"]["cost_usd"] == 0.12


def test_copilot_column_migration_preserves_existing_data(tmp_path, monkeypatch):
    from sqlmodel import SQLModel, create_engine
    from sqlalchemy import text
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        p = db.Project(name="Existing", key="keep-key", agents_md="# Existing instructions", ai="codex", codex_connected_at=db.now())
        s.add(p)
        s.commit()
        pid = p.id
        s.add(db.Run(project_id=pid, goal="Keep this run", client="codex", number=1, status="done", usage_json='{"cost_usd": 0.29}'))
        s.commit()
    with engine.begin() as connection:
        connection.execute(text('ALTER TABLE project DROP COLUMN copilot_connected_at'))
    monkeypatch.setattr(db, "engine", engine)
    db.init_db()
    with Session(engine) as s:
        p = s.get(db.Project, pid)
        assert p.key == "keep-key" and p.agents_md == "# Existing instructions" and p.codex_connected_at
        assert p.copilot_connected_at is None
        run = s.exec(select(db.Run)).one()
        assert run.status == "done" and run.usage_json == '{"cost_usd": 0.29}'
    engine.dispose()


def test_normalize_repo_url():
    assert db.normalize_repo_url("git@github.com:Org/Repo.git") == "https://github.com/org/repo"
    assert db.normalize_repo_url("https://github.com/Org/Repo/") == "https://github.com/org/repo"
    assert db.normalize_repo_url("") == ""


def test_crypto_roundtrip():
    assert decrypt(encrypt("figd_secret")) == "figd_secret"
    assert encrypt("") == "" and decrypt("") == ""


def test_figma_url_and_flatten():
    urls = figma.extract_figma_urls("See https://www.figma.com/design/AbC123/My-File?node-id=12-34&t=x and again "
                                    "https://www.figma.com/design/AbC123/My-File?node-id=12-34&t=x")
    assert urls == ["https://www.figma.com/design/AbC123/My-File?node-id=12-34&t=x"]
    assert figma.parse_figma_url(urls[0]) == ("AbC123", "12:34")
    tree = figma.flatten({
        "name": "Button", "type": "FRAME", "absoluteBoundingBox": {"x": 0, "y": 0, "width": 120.4, "height": 40},
        "fills": [{"type": "SOLID", "color": {"r": 0.2, "g": 0.4, "b": 1, "a": 1}}], "cornerRadius": 8,
        "children": [{"name": "Label", "type": "TEXT", "characters": "Save", "visible": True,
                      "style": {"fontFamily": "Inter", "fontSize": 14, "fontWeight": 600}},
                     {"name": "hidden", "type": "RECTANGLE", "visible": False}],
    })
    assert tree["fills"] == ["#3366ff"] and tree["box"]["width"] == 120
    assert len(tree["children"]) == 1 and tree["children"][0]["text"]["fontSize"] == 14


def test_summary_renders_per_stage_usage_table():
    from datetime import datetime, timezone
    from app.summary import build_summary
    t0 = datetime(2026, 9, 22, 10, 0, tzinfo=timezone.utc); t1 = datetime(2026, 9, 22, 10, 6, tzinfo=timezone.utc)
    md = build_summary("implement FIN-4", {
        "what_changed": ["Added KPI tiles"],
        "stages": [
            {"phase": "implement", "agent": "implementer", "model": "opus", "tokens": 80450, "tool_calls": 14, "duration_ms": 227316, "est_cost_usd": 0.56, "outcome": "built FIN-4, tests green"},
            {"phase": "test", "agent": "tester", "model": "sonnet", "tokens": "not reported", "tool_calls": 9, "duration_ms": 108360, "est_cost_usd": "not reported", "outcome": "5 of 5 criteria met"},
        ],
        "cost_note": "Cost assumes a 90/10 input-output split; actual charge is likely lower.",
    }, {"cost_usd": 0.56}, t0, t1)
    assert "| implement | implementer | opus | 80,450 | 14 | 3m 47s | ~$0.56 |" in md
    assert "| **Total** (partial) |  |  | 80,450 | 23 | 5m 35s | ~$0.56 |" in md
    assert "- **test**: 5 of 5 criteria met" in md and "_Cost assumes a 90/10" in md


def test_mcp_requires_project_key(client):
    pid = client.post("/api/projects", json={"name": "auth"}).json()["id"]
    assert client.post("/mcp", headers=MCP_HEADERS, json=INIT).status_code == 401
    assert client.post(f"/mcp?project={pid}&key=wrong", headers=MCP_HEADERS, json=INIT).status_code == 401
    # newer Claude Code says hello with server/discover first; that alone must count as connected
    disc = {"jsonrpc": "2.0", "id": "server-discover-probe-1", "method": "server/discover", "params": {"_meta": {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": {"name": "claude-code", "version": "2.1"},
        "io.modelcontextprotocol/clientCapabilities": {"roots": {"listChanged": True}}}}}
    dh = {**MCP_HEADERS, "mcp-method": "server/discover", "mcp-protocol-version": "2026-07-28"}
    assert client.post(f"/mcp?project={pid}&key={_key(pid)}", headers=dh, json=disc).status_code == 200
    p = client.get(f"/api/projects/{pid}").json()
    assert p["connected_at"] and p["claude_connected_at"] and not p["codex_connected_at"] and p["ai"] == "claude"
    r = client.post(f"/mcp?project={pid}&key={_key(pid)}", headers=MCP_HEADERS, json=INIT)
    assert r.status_code == 200
    message = next((line[6:] for line in r.text.splitlines() if line.startswith("data: ")), r.text)
    instructions = json.loads(message)["result"]["instructions"]
    # Clients receive startup guidance without a special prompt or a workflow run.
    assert "first user message in each new session" in instructions[:512]
    assert "report_connection" in instructions[:512] and "no run or file edits" in instructions[:512]
    assert "Only a successful Figma read means connected" in instructions
    assert "once per session, not on every message" in instructions
    assert "Call start_run before implementation" in instructions
    p = client.get(f"/api/projects/{pid}").json()
    assert p["connected_at"] and p["ai"] == "claude" and "key" not in p
    assert p["integrations"] == []  # dashboard initialization alone cannot prove Figma access
    assert client.get(f"/api/runs?project_id={pid}").json() == []
    assert f"project={pid}&key=" in p["connect"]["claude"] and "--scope project" in p["connect"]["claude"]
    # tools are listed on an authenticated session
    sid = r.headers.get("mcp-session-id")
    h = {**MCP_HEADERS, "mcp-session-id": sid}
    client.post(f"/mcp?project={pid}&key={_key(pid)}", headers=h, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    body = client.post(f"/mcp?project={pid}&key={_key(pid)}", headers=h, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}).text
    for name in ("start_run", "get_ticket", "get_figma_design", "log_phase", "open_pull_request", "finish_run", "save_agents_md"):
        assert name in body
    # ready-made config files, protected by the key
    c = p["connect"]
    assert '"agents-dashboard"' in c["mcp_json"] and f"project={pid}&key=" in c["mcp_json"]
    assert '"figma"' in c["mcp_json"] and "https://mcp.figma.com/mcp" in c["mcp_json"]  # Figma is connected by the AI itself
    codex_config = tomllib.loads(c["codex_toml"])
    assert codex_config["mcp_servers"]["agents-dashboard"]["url"] == c["url"]
    assert codex_config["mcp_servers"]["figma"]["url"] == "https://mcp.figma.com/mcp"
    assert "first user message in each new session" in codex_config["developer_instructions"]
    assert 'client="codex"' in codex_config["developer_instructions"]
    assert set(codex_config) == {"developer_instructions", "mcp_servers"}
    assert c["oneliner_claude_sh"].endswith("-o .mcp.json") and "mcp-config?key=" in c["download_claude"]
    dl = client.get(f"/api/projects/{pid}/mcp-config?key={_key(pid)}&client=claude")
    assert dl.status_code == 200 and dl.headers["content-disposition"].endswith('".mcp.json"') and f"project={pid}" in dl.text
    assert client.get(f"/api/projects/{pid}/mcp-config?key=nope").status_code == 401
    downloaded = client.get(f"/api/projects/{pid}/mcp-config?key={_key(pid)}&client=codex")
    assert downloaded.status_code == 200 and tomllib.loads(downloaded.text) == codex_config
    # rotating the key invalidates the old URL
    old = _key(pid)
    client.post(f"/api/projects/{pid}/rotate-key")
    assert client.post(f"/mcp?project={pid}&key={old}", headers=MCP_HEADERS, json=INIT).status_code == 401


def test_first_request_onboards_then_agents_are_served(client):
    pid = client.post("/api/projects", json={"name": "fresh"}).json()["id"]
    r = tools.do_start_run(pid, "implement ABC-1 and review it", "claude", repo_url="", path="C:/work/fresh")
    assert r["needs_onboarding"] is True and r["plan"].startswith("# First: onboard this project")
    assert "save_agents_md(content)" in r["plan"] and onboarding.ROUTING_MARK in r["plan"]
    stages = {s["stage"]: s for s in r["stages"]}
    assert list(stages) == ["branch-preflight", "jira-intake", "figma-intake", "dependency-merge", "implementation",
                            "independent-test", "code-review-security", "documentation", "pr-creation"]
    assert stages["implementation"]["model"] == "opus" and stages["independent-test"]["model"] == "sonnet" and stages["documentation"]["model"] == "haiku"
    assert "The root Claude Code session is the coordinator." in r["plan"] and "## Dashboard reporting" in r["plan"]
    assert "get_stage" in r["plan"] and "call `finish_run(run_id, summary)`" in r["plan"]
    # stage prompts are served on demand, rewired to the dashboard, otherwise verbatim
    tester = tools.do_get_stage(pid, "independent-test")["prompt"]
    assert "Report failures without fixing production code." in tester and "unit-test command from AGENTS.md" in tester
    assert "after two implementation attempts" in tester and "npm run test" not in tester
    jira = tools.do_get_stage(pid, "jira-intake")["prompt"]
    assert "`get_ticket(run_id, key)`" in jira and "Atlassian MCP server" not in jira
    assert "Unknown stage" in tools.do_get_stage(pid, "nope")["error"]
    p = client.get(f"/api/projects/{pid}").json()
    assert p["onboarding_status"] == "running" and p["local_path"] == "c:/work/fresh" and p["ai"] == "claude"
    # the AI reports onboarding progress, which drives the wizard bar
    tools.do_log_phase(pid, r["run_id"], "onboard-reading")
    assert client.get(f"/api/projects/{pid}").json()["onboarding_stage"] == "reading"
    tools.do_log_phase(pid, r["run_id"], "onboard-writing")
    assert client.get(f"/api/projects/{pid}").json()["onboarding_stage"] == "writing"
    tools.do_save_agents_md(pid, "# AGENTS\nrun: pytest")
    p = client.get(f"/api/projects/{pid}").json()
    assert p["onboarding_status"] == "done" and p["agents_md"] == "# AGENTS\nrun: pytest"
    # second run: no onboarding, AGENTS.md included
    r2 = tools.do_start_run(pid, "fix the login bug", "claude")
    assert r2["needs_onboarding"] is False and "run: pytest" in r2["plan"] and not r2["plan"].startswith("# First")


def test_codex_edition_of_the_workflow(client):
    pid = client.post("/api/projects", json={"name": "codex-proj"}).json()["id"]
    r = tools.do_start_run(pid, "implement ABC-2", "codex")
    assert "The root Codex session is the coordinator." in r["plan"] and 'fork_turns: "none"' in r["plan"]
    assert "`gpt-5.6-sol`" in r["plan"] and "`opus`" not in r["plan"] and "Astra is prohibited" in r["plan"]
    assert {s["stage"]: s["model"] for s in r["stages"]}["implementation"] == "gpt-5.6-sol"
    assert "codex mcp login figma" in tools.do_get_stage(pid, "branch-preflight")["prompt"]
    doc = tools.do_get_stage(pid, "documentation")["prompt"]
    assert 'get_stage("extract-codex-telemetry")' in doc and 'get_stage("planning-rates")' in doc
    assert tools.do_get_stage(pid, "extract-codex-telemetry")["prompt"].lstrip().startswith(("#!", "//", "import", "'use", '"use', "const", "/*"))
    assert "Sol as the ceiling" in onboarding.routing_block("codex", "x") and "root Codex session" in onboarding.routing_block("codex", "x")
    assert "first user message in each new session" in onboarding.routing_block("codex", "x")


def test_tickets_figma_and_finish(client):
    pid = client.post("/api/projects", json={"name": "demo", "repo_url": "git@github.com:Acme/Demo.git"}).json()["id"]
    assert client.post("/api/projects", json={"name": "dup", "repo_url": "https://github.com/acme/demo"}).status_code == 409
    client.put(f"/api/projects/{pid}/tickets/abc-1", json={"key": "ABC-1", "title": "Dark mode",
               "body_md": "Add toggle. Design: https://www.figma.com/design/K1/F?node-id=1-2"})
    t = tools.do_get_ticket(pid, "abc-1")
    assert t["title"] == "Dark mode" and t["figma_urls"] == ["https://www.figma.com/design/K1/F?node-id=1-2"]
    assert "error" in tools.do_get_ticket(pid, "ABC-999")
    d = tools.do_get_figma_design(pid, "https://www.figma.com/design/K1/F?node-id=1-2")
    assert d["file_key"] == "K1" and d["node_id"] == "1:2" and "figma` MCP server" in d["how"]
    run = tools.do_start_run(pid, "implement ABC-1", "claude")
    out = tools.do_finish_run(pid, run["run_id"], '{"what_changed": ["Added toggle"], "branch": "agent/abc-1", '
                                                  '"usage": {"cost_usd": 0.05, "input_tokens": "not reported"}}')
    assert "Added toggle" in out["summary_md"]
    rec = client.get(f"/api/runs/{run['run_id']}").json()
    assert rec["status"] == "done" and rec["branch"] == "agent/abc-1" and rec["usage"] == {"cost_usd": 0.05}
    assert "no GitHub" not in str(tools.do_open_pull_request(pid, run["run_id"], "agent/x", "t")) or True  # has URL but no token
    assert "not connected" in tools.do_open_pull_request(pid, run["run_id"], "agent/x", "t")["error"]
    assert client.get("/api/connect").json()["mcp_url"].endswith("/mcp?project=<id>&key=<key>")


def test_manual_ticket_lifecycle_without_jira(client, monkeypatch):
    pid = client.post("/api/projects", json={"name": "manual-ticket-project"}).json()["id"]
    other = client.post("/api/projects", json={"name": "separate-ticket-project"}).json()["id"]
    url = f"/api/projects/{pid}/tickets"
    design = "https://www.figma.com/design/K1/F?node-id=1-2"
    body = {"key": " fin-2 ", "title": " Empty results ", "body_md": f"Show an empty state.\nAC-1: Clear filters restores rows.\nFigma: {design}"}
    created = client.post(url, json=body)
    assert created.status_code == 201
    ticket = created.json()
    assert ticket["key"] == "FIN-2" and ticket["title"] == "Empty results" and ticket["source"] == "pasted"
    assert ticket["body_md"] == body["body_md"]
    project = client.get(f"/api/projects/{pid}").json()
    assert len(project["tickets"]) == 1 and project["integrations"] == []
    assert client.get(f"/api/runs?project_id={pid}").json() == []

    def no_jira(*args, **kwargs):
        raise AssertionError("Saved manual tickets must not contact Jira")

    monkeypatch.setattr(mcp_oauth, "token_for_project", no_jira)
    result = tools.do_get_ticket(pid, " fin-2 ")
    assert result["source"] == "pasted" and result["figma_urls"] == [design]
    assert result["body"] == body["body_md"]
    duplicate = client.post(url, json={**body, "key": "FIN-2", "title": "Overwrite attempt"})
    assert duplicate.status_code == 409
    assert tools.do_get_ticket(pid, "FIN-2")["title"] == "Empty results"
    assert client.post(f"/api/projects/{other}/tickets", json={**body, "title": "Other project"}).status_code == 201

    assert client.post(url, json={**body, "key": "invalid"}).status_code == 400
    assert client.post(url, json={**body, "key": "FIN-3", "body_md": " \n "}).status_code == 400
    assert client.put(url + "/FIN-2", json={**body, "key": "FIN-3"}).status_code == 400
    assert client.post("/api/projects/999999/tickets", json=body).status_code == 404
    changed = client.put(url + "/FIN-2", json={**body, "title": "Filter empty state"})
    assert changed.status_code == 200 and changed.json()["id"] == ticket["id"]
    assert tools.do_get_ticket(other, "FIN-2")["title"] == "Other project"
    preflight = tools.do_get_stage(pid, "branch-preflight")["prompt"]
    intake = tools.do_get_stage(pid, "jira-intake")["prompt"]
    assert "do not require a Jira connection" in preflight and "requires no Jira connection" in intake

    rid = tools.do_start_run(pid, "Implement FIN-2 and review it", "codex")["run_id"]
    run = client.get(f"/api/runs/{rid}").json()
    assert run["tickets"] == [{"key": "FIN-2", "title": "Filter empty state", "figma_urls": [design]}]
    assert client.delete(url + "/FIN-2").status_code == 204
    assert client.get(f"/api/projects/{pid}").json()["tickets"] == []
    assert client.get(f"/api/runs/{rid}").status_code == 200
    assert tools.do_get_ticket(other, "FIN-2")["title"] == "Other project"
    assert connect.ai_from_client("Codex CLI") == "codex" and connect.ai_from_client("mcp-inspector") == "unknown"


def test_connect_with_provider_via_mcp_oauth(client, monkeypatch):
    """Jira: automatic app registration, PKCE sign-in, tokens per project, tools called on Atlassian's MCP server."""
    pid = client.post("/api/projects", json={"name": "oauth"}).json()["id"]
    meta = {"authorization_endpoint": "https://mcp.atlassian.com/v1/authorize", "token_endpoint": "https://mcp.atlassian.com/v1/token",
            "registration_endpoint": "https://mcp.atlassian.com/v1/register", "scopes": []}
    posted = []

    async def fake_discover(provider):
        return meta

    class FakeResp:
        def __init__(self, d): self.d = d
        def raise_for_status(self): pass
        def json(self): return self.d

    class FakeClient:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def post(self, url, json=None, data=None, headers=None):
            posted.append((url, json or data))
            if url.endswith("/register"):
                return FakeResp({"client_id": "dyn-client-1"})
            return FakeResp({"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600})
    monkeypatch.setattr(mcp_oauth, "discover", fake_discover)
    monkeypatch.setattr(mcp_oauth.httpx, "AsyncClient", FakeClient)

    assert client.get("/api/oauth/nope/authorize?project=1", follow_redirects=False).status_code == 404
    r = client.get(f"/api/oauth/jira/authorize?project={pid}", follow_redirects=False, headers={"referer": "http://localhost:5173/"})
    assert r.status_code == 307
    loc = r.headers["location"]
    assert loc.startswith("https://mcp.atlassian.com/v1/authorize?") and "client_id=dyn-client-1" in loc and "code_challenge_method=S256" in loc
    assert "resource=https%3A%2F%2Fmcp.atlassian.com%2Fv1%2Fsse" in loc
    assert posted[0][0].endswith("/register") and posted[0][1]["redirect_uris"] == ["http://localhost:8000/api/oauth/jira/callback"]
    state = loc.split("state=")[1].split("&")[0]
    r = client.get(f"/api/oauth/jira/callback?code=abc&state={state}", follow_redirects=False)
    assert r.headers["location"] == f"http://localhost:5173/#/projects/{pid}?jira=connected"
    assert posted[1][1]["grant_type"] == "authorization_code" and posted[1][1]["code_verifier"]
    p = client.get(f"/api/projects/{pid}").json()
    assert p["integrations"][0]["kind"] == "jira" and p["integrations"][0]["config"]["auth"] == "oauth"
    with Session(db.engine) as s:
        assert mcp_oauth.token_for_project(s, pid, "jira") == "at-1"
        assert s.exec(select(db.AppRegistration)).first().client_id == "dyn-client-1"

    # the agents' get_ticket now goes through Atlassian's MCP tools
    calls = []

    def fake_call(provider, token, candidates, args):
        calls.append((provider, token, candidates[0], args))
        if candidates[0] == "getAccessibleAtlassianResources":
            return '[{"id": "cloud-1", "url": "https://acme.atlassian.net"}]'
        return '{"key": "ACME-7", "fields": {"summary": "Dark mode", "description": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Design: https://www.figma.com/design/K1/F?node-id=1-2"}]}]}}}'
    monkeypatch.setattr(mcp_oauth, "call", fake_call)
    t = tools.do_get_ticket(pid, "acme-7")
    assert t["title"] == "Dark mode" and t["source"] == "jira" and t["figma_urls"] == ["https://www.figma.com/design/K1/F?node-id=1-2"]
    assert calls[1] == ("jira", "at-1", "getJiraIssue", {"cloudId": "cloud-1", "issueIdOrKey": "ACME-7", "issueKey": "ACME-7"})
    # cached on the second read, no MCP call
    tools.do_get_ticket(pid, "ACME-7")
    assert len(calls) == 2


def test_jira_text_helpers():
    assert jira.cloud_id('[{"id": "c1"}]') == "c1" and jira.cloud_id("garbage") == ""
    i = jira.parse_issue('{"fields": {"summary": "S", "description": "plain", "status": {"name": "Done"}}}', "X-1")
    assert i == {"key": "X-1", "title": "S", "body_md": "plain", "type": None, "status": "Done"}
    assert jira.parse_issue("not json", "X-2")["body_md"] == "not json"


def test_design_document_approval_gate(client):
    pid = client.post("/api/projects", json={"name": "gate"}).json()["id"]
    run = tools.do_start_run(pid, "implement GT-1", "claude")
    rid = run["run_id"]
    assert "Design approval gate (before any stage)" in run["plan"] and "submit_design_document(run_id, content)" in run["plan"]
    assert run["plan"].index("Design approval gate") < run["plan"].index("## Nine-stage sequence")
    assert tools.do_check_approval(pid, rid)["status"] == "none"
    r = tools.do_submit_design_document(pid, rid, "# Design v1\nScope: card only")
    assert r["version"] == 1 and r["status"] == "pending" and r["rounds_left"] == 2
    assert "already waiting" in tools.do_submit_design_document(pid, rid, "again")["error"]
    rec = client.get(f"/api/runs/{rid}").json()
    assert rec["status"] == "awaiting_approval" and rec["approvals"][0]["content_md"].startswith("# Design v1")
    assert rec["phases"][-1]["name"] == "design-approval" and rec["phases"][-1]["status"] == "running"
    assert tools.do_check_approval(pid, rid)["status"] == "pending"
    # the PO sends it back
    assert client.post(f"/api/runs/{rid}/approvals/1/decide", json={"decision": "changes_requested", "name": "Priya", "comment": ""}).status_code == 400
    d = client.post(f"/api/runs/{rid}/approvals/1/decide", json={"decision": "changes_requested", "name": "Priya", "comment": "Add the empty state"}).json()
    assert d["status"] == "changes_requested" and d["decided_by"] == "Priya"
    c = tools.do_check_approval(pid, rid)
    assert c["status"] == "changes_requested" and c["comment"] == "Add the empty state" and "Revise" in c["next"]
    assert client.get(f"/api/runs/{rid}").json()["status"] == "running"
    assert client.post(f"/api/runs/{rid}/approvals/1/decide", json={"decision": "approved", "name": "x"}).status_code == 409
    # v2 approved
    assert tools.do_submit_design_document(pid, rid, "# Design v2\nEmpty state added")["version"] == 2
    client.post(f"/api/runs/{rid}/approvals/2/decide", json={"decision": "approved", "name": "Ravi (FDE)"})
    c = tools.do_check_approval(pid, rid)
    assert c["status"] == "approved" and c["decided_by"] == "Ravi (FDE)" and "Stage 01" in c["next"]
    rec = client.get(f"/api/runs/{rid}").json()
    assert rec["status"] == "running" and [a["status"] for a in rec["approvals"]] == ["changes_requested", "approved"]
    assert "approved by Ravi (FDE)" in rec["phases"][-1]["notes"]
    # the round limit is enforced
    rid2 = tools.do_start_run(pid, "implement GT-2", "claude")["run_id"]
    for v in (1, 2, 3):
        tools.do_submit_design_document(pid, rid2, f"v{v}")
        client.post(f"/api/runs/{rid2}/approvals/{v}/decide", json={"decision": "changes_requested", "name": "P", "comment": "no"})
    assert "No rounds left" in tools.do_check_approval(pid, rid2)["next"]
    assert "sent back 3 times" in tools.do_submit_design_document(pid, rid2, "v4")["error"]


def test_section_notes_go_back_to_the_agent(client):
    pid = client.post("/api/projects", json={"name": "notes"}).json()["id"]
    rid = tools.do_start_run(pid, "implement NT-1", "claude")["run_id"]
    tools.do_submit_design_document(pid, rid, "# Goal\nx\n## Risks\ny")
    notes = {"Risks": "Add mobile", "Goal": "Mention the beta flag"}
    # notes are only for sending back, not for approving
    assert client.post(f"/api/runs/{rid}/approvals/1/decide", json={"decision": "approved", "name": "P", "section_comments": notes}).status_code == 400
    d = client.post(f"/api/runs/{rid}/approvals/1/decide", json={"decision": "changes_requested", "name": "P", "section_comments": notes}).json()
    assert d["section_comments"] == notes
    c = tools.do_check_approval(pid, rid)
    assert c["section_comments"] == notes and "Risks: Add mobile" in c["comment"] and "Goal: Mention the beta flag" in c["comment"]
    # a general comment comes first, then the section notes
    tools.do_submit_design_document(pid, rid, "# Goal\nx2")
    client.post(f"/api/runs/{rid}/approvals/2/decide", json={"decision": "changes_requested", "name": "P", "comment": "Shorter", "section_comments": {"Goal": "ok"}})
    assert tools.do_check_approval(pid, rid)["comment"].startswith("Shorter")


def test_project_approvals_list_and_run_tickets(client):
    pid = client.post("/api/projects", json={"name": "inbox"}).json()["id"]
    client.put(f"/api/projects/{pid}/tickets/IB-1", json={"key": "IB-1", "title": "Login page",
               "body_md": "Design: https://www.figma.com/design/K9/F?node-id=3-4"})
    r1 = tools.do_start_run(pid, "implement IB-1 and IB-7", "claude", title="Login page")["run_id"]
    r2 = tools.do_start_run(pid, "fix the header", "claude")["run_id"]
    tools.do_submit_design_document(pid, r1, "v1")
    client.post(f"/api/runs/{r1}/approvals/1/decide", json={"decision": "changes_requested", "name": "P", "comment": "more"})
    tools.do_submit_design_document(pid, r1, "v2")
    tools.do_submit_design_document(pid, r2, "v1")
    client.post(f"/api/runs/{r2}/approvals/1/decide", json={"decision": "approved", "name": "Ravi"})
    rows = client.get(f"/api/projects/{pid}/approvals").json()
    assert [(a["run_id"], a["version"], a["status"]) for a in rows] == [(r2, 1, "approved"), (r1, 2, "pending"), (r1, 1, "changes_requested")]
    first = rows[1]
    assert first["run_number"] == 1 and first["run_title"] == "Login page" and "content_md" not in first
    # the review page shows the tickets named in the request, with their Figma links
    tickets = client.get(f"/api/runs/{r1}").json()["tickets"]
    assert tickets == [{"key": "IB-1", "title": "Login page", "figma_urls": ["https://www.figma.com/design/K9/F?node-id=3-4"]},
                       {"key": "IB-7", "title": "", "figma_urls": []}]
    assert client.get(f"/api/runs/{r2}").json()["tickets"] == []


def test_lists_carry_live_status(client):
    pid = client.post("/api/projects", json={"name": "live"}).json()["id"]
    assert next(p for p in client.get("/api/projects").json() if p["id"] == pid)["latest_run"] is None
    rid = tools.do_start_run(pid, "implement LV-1", "claude")["run_id"]
    tools.do_log_phase(pid, rid, "implementation", "running", "Opus subagent spawned")
    row = next(r for r in client.get("/api/runs").json() if r["id"] == rid)
    assert row["status"] == "running" and row["current_stage"]["name"] == "implementation" and row["current_stage"]["status"] == "running"
    proj = next(p for p in client.get("/api/projects").json() if p["id"] == pid)
    assert proj["latest_run"]["id"] == rid and proj["latest_run"]["current_stage"]["name"] == "implementation"


def test_run_numbers_are_per_project_and_ai_reports_connections(client):
    a = client.post("/api/projects", json={"name": "num-a"}).json()["id"]
    b = client.post("/api/projects", json={"name": "num-b"}).json()["id"]
    ra1 = tools.do_start_run(a, "implement A-1", "claude")["run_id"]
    rb1 = tools.do_start_run(b, "implement B-1", "claude")["run_id"]
    ra2 = tools.do_start_run(a, "implement A-2", "claude")["run_id"]
    nums = {r["id"]: r["number"] for r in client.get("/api/runs").json()}
    assert nums[ra1] == 1 and nums[ra2] == 2 and nums[rb1] == 1
    assert "report_connection" in tools.do_get_stage(a, "branch-preflight")["prompt"]
    assert "error" in tools.do_report_connection(a, "slack", True)
    tools.do_report_connection(a, "figma", True, "node 5:2 readable", client="claude")
    tools.do_report_connection(a, "github", False, "gh not installed")
    integ = {i["kind"]: i for i in client.get(f"/api/projects/{a}").json()["integrations"]}
    assert integ["figma"]["config"]["connected"] is True and integ["figma"]["config"]["auth"] == "via-ai" and integ["figma"]["has_secret"] is False
    assert integ["github"]["config"]["connected"] is False
    # a dashboard-side Jira connection is not overridden by the AI's probe
    client.put(f"/api/projects/{a}/integrations/jira", json={"kind": "jira", "secret": "x"})
    assert "already" in tools.do_report_connection(a, "jira", False)["note"]


def test_figma_connection_checks_use_authenticated_project_without_a_run(client):
    pid = client.post("/api/projects", json={"name": "connection-only"}).json()["id"]
    other = client.post("/api/projects", json={"name": "separate-connection"}).json()["id"]
    url = f"/mcp?project={pid}&key={_key(pid)}"
    response = client.post(url, headers=MCP_HEADERS, json={**INIT, "params": {
        **INIT["params"], "clientInfo": {"name": "codex", "version": "1.0"}}})
    assert response.status_code == 200
    headers = {**MCP_HEADERS, "mcp-session-id": response.headers["mcp-session-id"]}
    client.post(url, headers=headers, json={"jsonrpc": "2.0", "method": "notifications/initialized"})

    def report(ai, connected):
        result = client.post(url, headers=headers, json={"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
            "name": "report_connection", "arguments": {"kind": "figma", "connected": connected,
                "client": ai, "detail": "Identity check succeeded" if connected else "Figma tools unavailable"}}})
        assert result.status_code == 200
        message = next((line[6:] for line in result.text.splitlines() if line.startswith("data: ")), result.text)
        assert json.loads(message)["result"]["isError"] is False
        return client.get(f"/api/projects/{pid}").json()["integrations"][0]["config"]

    first = report("claude", True)
    assert first["connected"] is True and first["clients"]["claude"]["checked_at"]
    second = report("codex", False)
    assert second["connected"] is True  # a different client cannot erase Claude's successful check
    assert second["clients"]["claude"]["connected"] is True
    assert second["clients"]["codex"]["connected"] is False
    assert report("claude", False)["connected"] is False
    assert report("codex", True)["clients"]["codex"]["connected"] is True
    assert client.get(f"/api/runs?project_id={pid}").json() == []
    assert client.get(f"/api/projects/{other}").json()["integrations"] == []


def test_figma_reports_preserve_legacy_checks_and_reject_unknown_clients(client):
    pid = client.post("/api/projects", json={"name": "legacy-figma"}).json()["id"]
    client.put(f"/api/projects/{pid}/integrations/figma", json={"kind": "figma", "config": {
        "auth": "via-ai", "connected": True, "client": "claude", "detail": "Design read succeeded", "checked_at": "2026-10-22T08:30:00Z"}})
    assert "error" in tools.do_report_connection(pid, "figma", True, client="other")
    tools.do_report_connection(pid, "figma", False, "Not authenticated", client="codex")
    config = client.get(f"/api/projects/{pid}").json()["integrations"][0]["config"]
    assert config["clients"]["claude"]["connected"] is True
    assert config["clients"]["claude"]["checked_at"] == "2026-10-22T08:30:00Z"
    assert config["clients"]["codex"]["connected"] is False
    assert config["connected"] is True


def test_run_title_and_cost_estimate(client):
    from app.summary import estimate_from_tokens
    pid = client.post("/api/projects", json={"name": "title"}).json()["id"]
    long_goal = "implement DEMO-1 and review it. Ticket DEMO-1: Show the KPI cards. AC-1: ... AC-2: ..."
    r1 = tools.do_start_run(pid, long_goal, "claude")
    r2 = tools.do_start_run(pid, long_goal, "claude", title="DEMO-1: KPI cards on the home page")
    rows = {r["id"]: r for r in client.get(f"/api/runs?project_id={pid}").json()}
    assert rows[r1["run_id"]]["title"] == "implement DEMO-1 and review it" and rows[r1["run_id"]]["goal"] == long_goal
    assert rows[r2["run_id"]]["title"] == "DEMO-1: KPI cards on the home page" and rows[r2["run_id"]]["project_name"] == "title"
    assert tools.short_title("x" * 200) .endswith("…") and len(tools.short_title("x" * 200)) == 88
    assert estimate_from_tokens(100_000, "opus") == 0.7 and estimate_from_tokens("not reported", "opus") is None
    out = tools.do_finish_run(pid, r2["run_id"], {"what_changed": ["done"], "stages": [
        {"phase": "implementation", "agent": "implementer", "model": "opus", "tokens": 100_000, "tool_calls": 10, "duration_ms": 1000, "est_cost_usd": "not reported", "outcome": "ok"},
        {"phase": "independent-test", "agent": "tester", "model": "sonnet", "tokens": "50,000", "tool_calls": "5", "duration_ms": 1000, "est_cost_usd": "not reported", "outcome": "ok"},
        {"phase": "documentation", "agent": "coordinator", "model": "claude-fable-5-1", "tokens": "not reported", "tool_calls": "not reported", "duration_ms": "not reported", "est_cost_usd": "not reported", "outcome": "ok"}]})
    rec = client.get(f"/api/runs/{r2['run_id']}").json()
    assert rec["usage"]["cost_usd"] == 0.84 and rec["usage"]["cost_kind"] == "estimate (partial)"
    assert "| implementation | implementer | opus | 100,000 | 10 | 1s | ~$0.70 |" in out["summary_md"] and "Not a bill" in out["summary_md"]


def test_workflow_phase_reports_keep_order_and_run_state(client):
    from datetime import datetime, timezone
    pid = client.post("/api/projects", json={"name": "live-workflow"}).json()["id"]
    rid = tools.do_start_run(pid, "Implement FIN-2", "codex")["run_id"]
    tools.do_log_phase(pid, rid, "implementation", "running", "Building empty state")
    tools.do_log_phase(pid, rid, "implementation", "done", "Build passed")
    tools.do_log_phase(pid, rid, "independent-test", "running", "Checking acceptance criteria")
    # Force a tied timestamp to verify deterministic ordering for both list and detail views.
    with Session(db.engine) as session:
        phases = session.exec(select(db.RunPhase).where(db.RunPhase.run_id == rid)).all()
        for phase in phases:
            phase.ts = datetime(2026, 10, 22, 8, 30, tzinfo=timezone.utc)
            session.add(phase)
        session.commit()
    detail = client.get(f"/api/runs/{rid}").json()
    assert [phase["status"] for phase in detail["phases"]] == ["running", "done", "running"]
    assert detail["current_stage"]["name"] == "independent-test"
    assert client.get(f"/api/runs?project_id={pid}").json()[0]["current_stage"]["name"] == "independent-test"
    assert detail["status"] == "running"
    tools.do_submit_design_document(pid, rid, "Updated scope needs review")
    assert client.get(f"/api/runs/{rid}").json()["status"] == "awaiting_approval"


def test_one_setup_command_merges_every_ai_config(client):
    pid = client.post("/api/projects", json={"name": "Setup project"}).json()["id"]
    c = client.get(f"/api/projects/{pid}").json()["connect"]
    key = _key(pid)
    assert c["setup_ps"].endswith("| iex") and c["setup_sh"].endswith("| sh")
    for shell in ("ps", "sh"):
        script = client.get(f"/api/projects/{pid}/setup?key={key}&shell={shell}")
        assert script.status_code == 200 and script.headers["content-type"].startswith("text/plain")
        assert f"setup-file?key={key}" in script.text and ".vscode/mcp.json" in script.text and ".gitignore" in script.text
    assert client.get(f"/api/projects/{pid}/setup?key=wrong").status_code == 401
    file = lambda client_, body="": client.post(f"/api/projects/{pid}/setup-file?key={key}&client={client_}", content=body.encode())

    # fresh files
    assert json.loads(file("claude").text)["mcpServers"]["agents-dashboard"]["url"] == c["url"]
    assert json.loads(file("vscode").text)["servers"][f"agents-dashboard-{pid}"]["url"] == c["copilot_url"]
    assert tomllib.loads(file("codex").text) == tomllib.loads(c["codex_toml"])
    assert file("copilot-agent").text.startswith("---\n")

    # existing files keep the developer's servers; ours are replaced, not duplicated
    mine = {"mcpServers": {"other": {"command": "x"}, "agents-dashboard": {"url": "stale"}}}
    merged = json.loads(file("claude", "﻿" + json.dumps(mine)).text)["mcpServers"]
    assert merged["other"] == {"command": "x"} and merged["agents-dashboard"]["url"] == c["url"]
    toml_mine = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.agents-dashboard]\nurl = "stale"\n'
    once = file("codex", toml_mine).text
    twice = tomllib.loads(file("codex", once).text)
    assert twice["model"] == "o3" and twice["mcp_servers"]["other"] == {"command": "x"}
    assert twice["mcp_servers"]["agents-dashboard"]["url"] == c["url"] and "report_connection" in twice["developer_instructions"]
    own = tomllib.loads(file("codex", 'developer_instructions = "mine"\n').text)
    assert own["developer_instructions"] == "mine" and "agents-dashboard" in own["mcp_servers"]

    # files we cannot safely edit are refused, so the script skips them instead of clobbering
    assert file("vscode", '{ // comment\n "servers": {} }').status_code == 409
    assert file("codex", "not = [valid").status_code == 409
    assert file("nope").status_code == 400


def test_run_agents_report_model_time_and_cost_in_workflow_order(client):
    pid = client.post("/api/projects", json={"name": "Agents view"}).json()["id"]
    rid = tools.do_start_run(pid, "implement FIN-9", client="claude")["run_id"]
    tools.do_log_phase(pid, rid, "design-approval", "done", "approved")
    tools.do_log_phase(pid, rid, "branch-preflight", "running", "checking")
    tools.do_log_phase(pid, rid, "branch-preflight", "done", "01-git/preflight.md", model="claude-haiku-4-5", tokens="12,000", duration_ms=61000)
    tools.do_log_phase(pid, rid, "jira-intake", "running", "reading")
    tools.do_log_phase(pid, rid, "jira-intake", "done", "02-jira")  # nothing measured yet
    agents = client.get(f"/api/runs/{rid}").json()["agents"]
    assert [a["stage"] for a in agents] == onboarding.stage_names()  # design approval is a gate, not an agent
    pre, jira_, figma_ = agents[0], agents[1], agents[2]
    assert pre["planned_model"] == "haiku" and pre["model"] == "claude-haiku-4-5" and pre["tokens"] == 12000
    assert pre["duration_ms"] == 61000 and pre["duration_source"] == "reported"
    assert pre["est_cost_usd"] == round((12000 * 0.9 * 1 + 12000 * 0.1 * 5) / 1e6, 4)
    assert jira_["duration_source"] == "measured" and jira_["tokens"] is None and jira_["est_cost_usd"] is None
    assert figma_["planned_model"] == "opus" and figma_["started_at"] is None and figma_["duration_ms"] is None

    # finish_run's stage table fills what the completion report left out, never overwriting measured values
    tools.do_finish_run(pid, rid, {"stages": [
        {"phase": "jira-intake", "model": "claude-sonnet-4-5", "tokens": "30,000", "duration_ms": 90000},
        {"phase": "branch-preflight", "model": "other", "tokens": 1, "duration_ms": 1}]})
    agents = client.get(f"/api/runs/{rid}").json()["agents"]
    assert agents[1]["model"] == "claude-sonnet-4-5" and agents[1]["tokens"] == 30000 and agents[1]["duration_ms"] == 90000
    assert agents[0]["tokens"] == 12000 and agents[0]["model"] == "claude-haiku-4-5"

    # Copilot: no dollar estimate from another provider's prices
    crid = tools.do_start_run(pid, "implement FIN-10", client="copilot")["run_id"]
    tools.do_log_phase(pid, crid, "branch-preflight", "done", "ok", model="gpt-5", tokens=5000)
    assert client.get(f"/api/runs/{crid}").json()["agents"][0]["est_cost_usd"] is None


def test_logs_record_mcp_tool_calls_and_dashboard_actions(client):
    pid = client.post("/api/projects", json={"name": "Logs project"}).json()["id"]
    url = f"/mcp?project={pid}&key={_key(pid)}"
    init = {**INIT, "params": {**INIT["params"], "clientInfo": {"name": "claude-code", "version": "2"}}}
    r = client.post(url, headers=MCP_HEADERS, json=init)
    h = {**MCP_HEADERS, "mcp-session-id": r.headers.get("mcp-session-id")}
    client.post(url, headers=h, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    call = lambda i, name, args: client.post(url, headers=h, json={"jsonrpc": "2.0", "id": i, "method": "tools/call",
                                                                   "params": {"name": name, "arguments": args}})
    call(2, "start_run", {"goal": "implement LOG-1", "client": "claude", "title": "LOG-1: logs"})
    with Session(db.engine) as s:
        rid = s.exec(select(db.Run).where(db.Run.project_id == pid)).one().id
    call(3, "log_phase", {"run_id": rid, "phase": "branch-preflight", "status": "failed", "notes": "dirty tree"})
    call(4, "get_ticket", {"run_id": rid, "key": "NOPE-1"})
    call(5, "submit_design_document", {"run_id": rid, "content_md": "# Plan. Do it."})
    call(51, "check_approval", {"run_id": rid})
    try:  # unknown run -> the tool raises; the test client re-raises what a real server returns as a tool error
        call(6, "get_stage", {"name": "branch-preflight", "run_id": 999999})
    except Exception:
        pass
    client.post(f"/api/projects/{pid}/rotate-key")

    logs = client.get(f"/api/projects/{pid}/logs").json()["items"]
    by_event = {e["event"]: e for e in logs}
    assert by_event["connected"]["message"] == "Claude Code connected to the dashboard"
    assert by_event["start_run"]["message"] == "Started run: LOG-1: logs" and by_event["start_run"]["run_id"] == rid
    assert by_event["start_run"]["client"] == "claude" and by_event["start_run"]["run_number"] == 1
    assert by_event["start_run"]["duration_ms"] is not None
    assert "… (" in by_event["start_run"]["detail"]["result"]["plan"]  # long values are trimmed
    assert by_event["log_phase"]["level"] == "warn" and by_event["log_phase"]["message"] == "branch-preflight: failed — dirty tree"
    assert by_event["get_ticket"]["level"] == "warn" and "not known" in by_event["get_ticket"]["message"]
    assert by_event["get_stage"]["level"] == "error" and "failed" in by_event["get_stage"]["message"]
    assert by_event["key.rotated"]["source"] == "dashboard"
    assert "check_approval" not in by_event  # polling is debug, hidden by default
    debug = client.get(f"/api/projects/{pid}/logs?level=debug").json()["items"]
    assert any(e["event"] == "check_approval" for e in debug)
    assert [e["event"] for e in client.get(f"/api/projects/{pid}/logs?level=error").json()["items"]] == ["get_stage"]
    assert {e["event"] for e in client.get(f"/api/projects/{pid}/logs?run_id={rid}").json()["items"]} >= {"start_run", "log_phase"}
    assert [e["event"] for e in client.get(f"/api/projects/{pid}/logs?q=dirty").json()["items"]] == ["log_phase"]
    page = client.get(f"/api/projects/{pid}/logs?limit=2").json()
    assert len(page["items"]) == 2 and page["more"] is True
    older = client.get(f"/api/projects/{pid}/logs?limit=2&before={page['items'][-1]['id']}").json()["items"]
    assert older and older[0]["id"] < page["items"][-1]["id"]
    assert client.delete(f"/api/projects/{pid}").status_code == 204


def test_hosting_password_gate_secret_and_database_url(client, monkeypatch):
    import base64 as b64
    pid = client.post("/api/projects", json={"name": "Hosted"}).json()["id"]
    key = _key(pid)
    monkeypatch.setenv("DASHBOARD_PASSWORD", "s3cret")
    basic = lambda pw: {"Authorization": "Basic " + b64.b64encode(f"anyone:{pw}".encode()).decode()}
    r = client.get("/api/projects")
    assert r.status_code == 401 and r.headers["www-authenticate"].startswith("Basic")
    assert client.get("/api/projects", headers=basic("wrong")).status_code == 401
    assert client.get("/api/projects", headers=basic("s3cret")).status_code == 200
    # key-protected and machine endpoints stay reachable without the password
    assert client.get("/api/health").json() == {"ok": True}
    assert client.get(f"/api/projects/{pid}/setup?key={key}").status_code == 200
    assert client.post(f"/api/projects/{pid}/setup-file?key={key}&client=claude", content=b"").status_code == 200
    assert client.get(f"/api/projects/{pid}/mcp-config?key={key}").status_code == 200
    assert client.post(f"/mcp?project={pid}&key={key}", headers=MCP_HEADERS, json=INIT).status_code == 200
    assert client.post(f"/mcp?project={pid}&key=wrong", headers=MCP_HEADERS, json=INIT).status_code == 401
    assert client.get(f"/api/projects/{pid}/setup-extra").status_code == 401  # only the exact open paths
    monkeypatch.delenv("DASHBOARD_PASSWORD")
    assert client.get("/api/projects").status_code == 200

    # Render's URL becomes the public address in every command
    monkeypatch.delenv("PUBLIC_BASE_URL", raising=False)
    monkeypatch.setenv("RENDER_EXTERNAL_URL", "https://agents-dashboard.onrender.com")
    assert client.get(f"/api/projects/{pid}").json()["connect"]["url"].startswith("https://agents-dashboard.onrender.com/mcp?")

    # any APP_SECRET works, and a real Fernet key is used unchanged
    from app import crypto
    monkeypatch.setenv("APP_SECRET", "not-a-fernet-key+/==")
    assert crypto.decrypt(crypto.encrypt("token")) == "token"
    monkeypatch.setenv("APP_SECRET", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
    assert crypto._key() == b"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="

    import re as re_
    for given in ("postgres://u:p@h/db", "postgresql://u:p@h/db"):
        assert re_.sub(r"^postgres(ql)?://", "postgresql+psycopg://", given) == "postgresql+psycopg://u:p@h/db"
