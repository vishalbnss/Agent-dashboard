"""REST API for the dashboard. The server never touches a developer's files: everything project-side
happens through the MCP tools, so this API is the same whether it runs on a laptop or a company server."""
import json
import os
import re

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from app import connect, db, copilot
from app.logs import LEVELS, record
from app.crypto import encrypt
from app.integrations import mcp_oauth

router = APIRouter(prefix="/api")


def _base_url(request: Request) -> str:
    return mcp_oauth.public_url() or str(request.base_url).rstrip("/")


def _get(s: Session, model, id_: int):
    obj = s.get(model, id_)
    if not obj:
        raise HTTPException(404, f"{model.__name__} {id_} not found")
    return obj


# ---- projects ----
class ProjectIn(BaseModel):
    name: str
    repo_url: str = ""   # optional; needed only to open pull requests
    caps: dict | None = None


def _current_stage(s: Session, run_id: int) -> dict | None:
    """The most recent stage report of a run, so lists can say 'running · implementation'."""
    ph = s.exec(select(db.RunPhase).where(db.RunPhase.run_id == run_id).order_by(db.RunPhase.ts.desc(), db.RunPhase.id.desc())).first()
    return {"name": ph.name, "status": ph.status, "notes": ph.notes[:160], "ts": ph.ts} if ph else None


def _run_row(s: Session, r: db.Run) -> dict:
    project = s.get(db.Project, r.project_id)
    return {**r.model_dump(), "usage": json.loads(r.usage_json or "{}"), "current_stage": _current_stage(s, r.id),
            "project_name": project.name if project else ""}


@router.get("/projects")
def list_projects(s: Session = Depends(db.get_session)):
    out = []
    for p in s.exec(select(db.Project).order_by(db.Project.created_at.desc())).all():
        latest = s.exec(select(db.Run).where(db.Run.project_id == p.id).order_by(db.Run.started_at.desc())).first()
        out.append({**p.model_dump(exclude={"key"}), "latest_run": _run_row(s, latest) if latest else None})
    return out


@router.post("/projects", status_code=201)
def create_project(body: ProjectIn, s: Session = Depends(db.get_session)):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Give the project a name")
    repo_url = db.normalize_repo_url(body.repo_url)
    if repo_url and db.find_project(s, repo_url):
        raise HTTPException(409, "A project with this repository URL already exists")
    p = db.Project(name=name, repo_url=repo_url, caps_json=json.dumps({**db.DEFAULT_CAPS, **(body.caps or {})}))
    s.add(p)
    s.commit()
    s.refresh(p)
    return p.model_dump(exclude={"key"})


@router.get("/projects/{pid}")
def get_project(pid: int, request: Request, s: Session = Depends(db.get_session)):
    p = _get(s, db.Project, pid)
    integrations = s.exec(select(db.Integration).where(db.Integration.project_id == pid)).all()
    tickets = s.exec(select(db.Ticket).where(db.Ticket.project_id == pid).order_by(db.Ticket.created_at.desc())).all()
    return {**p.model_dump(exclude={"key"}), "caps": p.caps,
            "connect": connect.connect_commands(p, _base_url(request)),
            "integrations": [{"id": i.id, "kind": i.kind, "config": json.loads(i.config_json or "{}"),
                              "has_secret": bool(i.secret_enc)} for i in integrations],
            "tickets": tickets}


class ProjectPatch(BaseModel):
    name: str | None = None
    agents_md: str | None = None
    caps: dict | None = None
    repo_url: str | None = None
    setup_complete: bool | None = None


@router.patch("/projects/{pid}")
def patch_project(pid: int, body: ProjectPatch, s: Session = Depends(db.get_session)):
    p = _get(s, db.Project, pid)
    if body.name is not None:
        p.name = body.name
    if body.agents_md is not None:
        p.agents_md = body.agents_md
        if body.agents_md and p.onboarding_status != "done":
            p.onboarding_status, p.onboarding_stage = "done", "done"
    if body.caps is not None:
        p.caps_json = json.dumps({**p.caps, **body.caps})
    if body.repo_url is not None:
        p.repo_url = db.normalize_repo_url(body.repo_url)
    if body.setup_complete is not None:
        p.setup_complete = body.setup_complete
    s.add(p)
    s.commit()
    s.refresh(p)
    return p.model_dump(exclude={"key"})


@router.get("/projects/{pid}/mcp-config")
def download_mcp_config(pid: int, key: str, request: Request, client: str = "claude", s: Session = Depends(db.get_session)):
    """MCP config for this project (.mcp.json for Claude/Copilot, config.toml for Codex).
    Protected by the project key so the URL itself is safe to show only on the project page."""
    from fastapi.responses import Response
    p = _get(s, db.Project, pid)
    if key != p.key:
        raise HTTPException(401, "Wrong key")
    base = _base_url(request)
    if client == "codex":
        return Response(connect.codex_toml(p, base), media_type="application/toml",
                        headers={"Content-Disposition": 'attachment; filename="config.toml"'})
    if client == "vscode":
        return Response(connect.vscode_json(p, base), media_type="application/json",
                        headers={"Content-Disposition": 'attachment; filename="mcp.json"'})
    if client == "copilot":
        return Response(connect.copilot_json(p, base), media_type="application/json",
                        headers={"Content-Disposition": 'attachment; filename=".mcp.json"'})
    if client != "claude":
        raise HTTPException(400, "Unknown coding client")
    return Response(connect.mcp_json(p, base), media_type="application/json",
                    headers={"Content-Disposition": 'attachment; filename=".mcp.json"'})


@router.get("/projects/{pid}/copilot-agent")
def download_copilot_agent(pid: int, key: str, s: Session = Depends(db.get_session)):
    from fastapi.responses import Response
    project = _get(s, db.Project, pid)
    if key != project.key:
        raise HTTPException(401, "Wrong key")
    return Response(copilot.agent_profile(project.id, project.name), media_type="text/markdown",
                    headers={"Content-Disposition": 'attachment; filename="agents-dashboard.agent.md"'})


@router.get("/projects/{pid}/setup")
def setup_script(pid: int, key: str, request: Request, shell: str = "ps", s: Session = Depends(db.get_session)):
    """The one setup command's script (PowerShell or sh). It writes every AI's config in the current folder."""
    from fastapi.responses import PlainTextResponse
    p = _get(s, db.Project, pid)
    if key != p.key:
        raise HTTPException(401, "Wrong key")
    if shell not in ("ps", "sh"):
        raise HTTPException(400, "shell must be ps or sh")
    record(pid, "setup.downloaded", f"Setup script downloaded ({'PowerShell' if shell == 'ps' else 'bash'})", source="system")
    return PlainTextResponse(connect.setup_script(p, _base_url(request), shell))


@router.post("/projects/{pid}/setup-file")
async def setup_file(pid: int, key: str, client: str, request: Request, s: Session = Depends(db.get_session)):
    """Body: the developer's current file (empty if none). Returns it with our servers merged in."""
    from fastapi.responses import PlainTextResponse
    p = _get(s, db.Project, pid)
    if key != p.key:
        raise HTTPException(401, "Wrong key")
    if client not in connect.SETUP_FILES:
        raise HTTPException(400, "Unknown coding client")
    body = await request.body()
    if len(body) > 1_000_000:
        raise HTTPException(413, "Config file too large")
    try:
        return PlainTextResponse(connect.setup_file(p, _base_url(request), client, body.decode("utf-8", errors="replace")))
    except ValueError as e:
        raise HTTPException(409, f"Could not merge {connect.SETUP_FILES[client]}: {e}")


@router.post("/projects/{pid}/rotate-key")
def rotate_key(pid: int, request: Request, s: Session = Depends(db.get_session)):
    """Invalidate the current connect URL and issue a new one."""
    import secrets
    p = _get(s, db.Project, pid)
    p.key = secrets.token_urlsafe(24)
    s.add(p)
    s.commit()
    record(pid, "key.rotated", "Issued a new project key; the previous setup command and config files stopped working", level="warn")
    return connect.connect_commands(p, _base_url(request))


@router.delete("/projects/{pid}", status_code=204)
def delete_project(pid: int, s: Session = Depends(db.get_session)):
    p = _get(s, db.Project, pid)
    for model in (db.Integration, db.Ticket, db.LogEntry):
        for row in s.exec(select(model).where(model.project_id == pid)).all():
            s.delete(row)
    for run in s.exec(select(db.Run).where(db.Run.project_id == pid)).all():
        for ph in s.exec(select(db.RunPhase).where(db.RunPhase.run_id == run.id)).all():
            s.delete(ph)
        s.delete(run)
    s.delete(p)
    s.commit()


# ---- integrations (tokens stored encrypted on the server) ----
class IntegrationIn(BaseModel):
    kind: str  # figma | github | jira
    config: dict = {}
    secret: str = ""


@router.put("/projects/{pid}/integrations/{kind}")
def upsert_integration(pid: int, kind: str, body: IntegrationIn, s: Session = Depends(db.get_session)):
    _get(s, db.Project, pid)
    if kind not in ("figma", "github", "jira"):
        raise HTTPException(400, "kind must be figma, github or jira")
    i = s.exec(select(db.Integration).where(db.Integration.project_id == pid, db.Integration.kind == kind)).first()
    if not i:
        i = db.Integration(project_id=pid, kind=kind)
    i.config_json = json.dumps(body.config)
    if body.secret:
        i.secret_enc = encrypt(body.secret)
    s.add(i)
    s.commit()
    record(pid, "integration.saved", f"{kind.capitalize()} settings saved")
    return {"id": i.id, "kind": kind, "config": json.loads(i.config_json), "has_secret": bool(i.secret_enc)}


@router.delete("/projects/{pid}/integrations/{kind}", status_code=204)
def delete_integration(pid: int, kind: str, s: Session = Depends(db.get_session)):
    i = s.exec(select(db.Integration).where(db.Integration.project_id == pid, db.Integration.kind == kind)).first()
    if i:
        s.delete(i)
        s.commit()
        record(pid, "integration.removed", f"{kind.capitalize()} disconnected", level="warn")


# ---- Connect with Figma / Jira: OAuth against their MCP servers, no pre-registered app ----
_return_to: dict[int, str] = {}


@router.get("/oauth/{provider}/authorize")
async def oauth_authorize(provider: str, project: int, request: Request, s: Session = Depends(db.get_session)):
    """Browser entry point: registers the dashboard with the provider on first use, then sends the user to Allow."""
    if provider not in mcp_oauth.PROVIDERS:
        raise HTTPException(404, "Unknown provider")
    _get(s, db.Project, project)
    ref = request.headers.get("referer", "")
    if ref:
        _return_to[project] = ref.split("#")[0].rstrip("/")
    try:
        return RedirectResponse(await mcp_oauth.authorize_url(s, project, provider))
    except Exception as e:  # provider down, registration refused: send the user back with the reason
        back = _return_to.pop(project, mcp_oauth.public_url() or "http://localhost:5173") + f"/#/projects/{project}"
        return RedirectResponse(back + f"?{provider}=error&reason=" + str(e)[:200])


@router.get("/oauth/{provider}/callback")
async def oauth_callback(provider: str, code: str = "", state: str = "", error: str = "", s: Session = Depends(db.get_session)):
    pending = mcp_oauth.consume_state(state)
    if pending is None or pending["provider"] != provider:
        raise HTTPException(400, "This sign-in link has expired. Start again from the project page.")
    pid = pending["project_id"]
    back = _return_to.pop(pid, mcp_oauth.public_url() or "http://localhost:5173") + f"/#/projects/{pid}"
    name = mcp_oauth.PROVIDERS[provider]["name"]
    if error or not code:
        record(pid, "oauth.denied", f"{name} sign-in was cancelled or denied" + (f": {error}" if error else ""), level="warn")
        return RedirectResponse(back + f"?{provider}=denied")
    try:
        await mcp_oauth.finish(s, pending, code)
    except Exception as e:
        record(pid, "oauth.failed", f"{name} sign-in failed: {e}", level="error")
        raise
    record(pid, "oauth.connected", f"{name} connected")
    return RedirectResponse(back + f"?{provider}=connected")


# ---- tickets (pasted) ----
class TicketIn(BaseModel):
    key: str
    title: str = ""
    body_md: str


def _save_ticket(pid: int, key: str, body: TicketIn, s: Session, *, create_only: bool = False):
    _get(s, db.Project, pid)
    key = key.strip().upper()
    if not re.fullmatch(r"[A-Z][A-Z0-9]+-\d+", key):
        raise HTTPException(400, "Use a ticket ID such as FIN-2")
    if body.key.strip().upper() != key:
        raise HTTPException(400, "The ticket ID does not match")
    if not body.body_md.strip():
        raise HTTPException(400, "Enter the ticket requirements and acceptance criteria")
    t = s.exec(select(db.Ticket).where(db.Ticket.project_id == pid, db.Ticket.key == key)).first()
    if t and create_only:
        raise HTTPException(409, "A ticket with this ID already exists in this project")
    if not t:
        t = db.Ticket(project_id=pid, key=key)
    t.title, t.body_md, t.source = body.title.strip(), body.body_md.strip(), "pasted"
    s.add(t)
    s.commit()
    s.refresh(t)
    return t


@router.post("/projects/{pid}/tickets", status_code=201)
def create_ticket(pid: int, body: TicketIn, s: Session = Depends(db.get_session)):
    t = _save_ticket(pid, body.key, body, s, create_only=True)
    record(pid, "ticket.created", f"Ticket {t.key} added: {t.title}")
    return t


@router.put("/projects/{pid}/tickets/{key}")
def upsert_ticket(pid: int, key: str, body: TicketIn, s: Session = Depends(db.get_session)):
    t = _save_ticket(pid, key, body, s)
    record(pid, "ticket.saved", f"Ticket {t.key} saved: {t.title}")
    return t


@router.delete("/projects/{pid}/tickets/{key}", status_code=204)
def delete_ticket(pid: int, key: str, s: Session = Depends(db.get_session)):
    t = s.exec(select(db.Ticket).where(db.Ticket.project_id == pid, db.Ticket.key == key.upper())).first()
    if t:
        s.delete(t)
        s.commit()
        record(pid, "ticket.deleted", f"Ticket {key.upper()} deleted", level="warn")


@router.get("/health")
def health():
    """For the host's health check; open even when DASHBOARD_PASSWORD is set."""
    return {"ok": True}


# ---- logs ----
@router.get("/projects/{pid}/logs")
def list_logs(pid: int, run_id: int | None = None, level: str = "info", q: str = "", before: int | None = None,
              limit: int = 100, s: Session = Depends(db.get_session)):
    """Newest first. level = the lowest level shown; before = id of the oldest row already loaded (for "Load older")."""
    _get(s, db.Project, pid)
    query = select(db.LogEntry).where(db.LogEntry.project_id == pid,
                                      db.LogEntry.level.in_(LEVELS[LEVELS.index(level) if level in LEVELS else 1:]))
    if run_id:
        query = query.where(db.LogEntry.run_id == run_id)
    if q.strip():
        like = f"%{q.strip()}%"
        query = query.where(db.LogEntry.message.ilike(like) | db.LogEntry.event.ilike(like))
    if before:
        query = query.where(db.LogEntry.id < before)
    limit = max(1, min(limit, 500))
    rows = s.exec(query.order_by(db.LogEntry.id.desc()).limit(limit + 1)).all()
    numbers = {r.id: r.number for r in s.exec(select(db.Run).where(db.Run.project_id == pid)).all()}
    return {"items": [{**r.model_dump(exclude={"detail_json"}), "detail": json.loads(r.detail_json or "{}"),
                       "run_number": numbers.get(r.run_id)} for r in rows[:limit]],
            "more": len(rows) > limit}


# ---- runs ----
@router.get("/runs")
def list_runs(project_id: int | None = None, s: Session = Depends(db.get_session)):
    q = select(db.Run).order_by(db.Run.started_at.desc())
    if project_id:
        q = q.where(db.Run.project_id == project_id)
    return [_run_row(s, r) for r in s.exec(q).all()]


@router.get("/runs/{rid}")
def get_run(rid: int, s: Session = Depends(db.get_session)):
    r = _get(s, db.Run, rid)
    phases = s.exec(select(db.RunPhase).where(db.RunPhase.run_id == rid).order_by(db.RunPhase.ts, db.RunPhase.id)).all()
    approvals = s.exec(select(db.Approval).where(db.Approval.run_id == rid).order_by(db.Approval.version)).all()
    return {**_run_row(s, r), "phases": phases, "approvals": [a.view() for a in approvals], "tickets": _run_tickets(s, r),
            "agents": run_agents(r, phases)}


def run_agents(r: db.Run, phases: list[db.RunPhase]) -> list[dict]:
    """One row per stage agent, in workflow order: planned route, reported model, time and estimated cost."""
    from app import onboarding
    from app.summary import estimate_from_tokens
    routes = {st["stage"]: st["model"] for st in onboarding.stage_table(r.client if r.client in ("claude", "codex", "copilot") else "claude")}
    rows = []
    for name in onboarding.stage_names():
        mine = [p for p in phases if p.name == name]
        started = next((p.ts for p in mine if p.status == "running"), mine[0].ts if mine else None)
        ended = next((p.ts for p in reversed(mine) if p.status != "running"), None)
        model = next((p.model for p in reversed(mine) if p.model), "")
        tokens = next((p.tokens for p in reversed(mine) if p.tokens is not None), None)  # cumulative: latest wins
        reported_ms = next((p.duration_ms for p in reversed(mine) if p.duration_ms is not None), None)
        measured_ms = int((ended - started).total_seconds() * 1000) if started and ended and ended >= started else None
        cost = None if r.client == "copilot" else estimate_from_tokens(tokens, model or routes[name])
        rows.append({"stage": name, "planned_model": routes[name], "model": model, "tokens": tokens,
                     "started_at": started, "ended_at": ended,
                     "duration_ms": reported_ms if reported_ms is not None else measured_ms,
                     "duration_source": "reported" if reported_ms is not None else "measured" if measured_ms is not None else "",
                     "est_cost_usd": cost})
    return rows


def _run_tickets(s: Session, r: db.Run) -> list[dict]:
    """Tickets named in the request, with title and Figma links when the dashboard has read them, for the review page."""
    from app.integrations import figma
    from app.mcp.tools import TICKET_KEY_RE
    out = []
    for key in dict.fromkeys(TICKET_KEY_RE.findall(r.goal)):
        t = s.exec(select(db.Ticket).where(db.Ticket.project_id == r.project_id, db.Ticket.key == key)).first()
        out.append({"key": key, "title": t.title if t else "", "figma_urls": figma.extract_figma_urls(t.body_md) if t else []})
    return out


@router.get("/projects/{pid}/approvals")
def list_approvals(pid: int, s: Session = Depends(db.get_session)):
    """Every design document version of the project's runs, newest first, without the document text."""
    rows = s.exec(select(db.Approval, db.Run).where(db.Approval.run_id == db.Run.id, db.Run.project_id == pid)
                  .order_by(db.Approval.id.desc())).all()
    return [{**{k: v for k, v in a.view().items() if k != "content_md"},
             "run_number": r.number, "run_title": r.title, "run_goal": r.goal[:200]} for a, r in rows]


class DecisionIn(BaseModel):
    decision: str   # approved | changes_requested
    name: str
    comment: str = ""
    section_comments: dict[str, str] = {}


@router.post("/runs/{rid}/approvals/{version}/decide")
def decide(rid: int, version: int, body: DecisionIn, s: Session = Depends(db.get_session)):
    """A PO / FDE approves the design document or sends it back with a comment. The waiting agent picks it up."""
    from app.mcp.tools import decide_approval
    if body.decision not in ("approved", "changes_requested"):
        raise HTTPException(400, "decision must be approved or changes_requested")
    if not body.name.strip():
        raise HTTPException(400, "Type your name so the decision is recorded")
    has_notes = any(v.strip() for v in body.section_comments.values())
    if body.decision == "changes_requested" and not body.comment.strip() and not has_notes:
        raise HTTPException(400, "Say what should change")
    if body.decision == "approved" and has_notes:
        raise HTTPException(400, "Section notes are sent back with a change request. Clear them to approve.")
    try:
        a = decide_approval(s, rid, version, body.decision, body.name, body.comment, body.section_comments)
    except ValueError as e:
        raise HTTPException(409, str(e))
    run = s.get(db.Run, rid)
    verb = "approved" if body.decision == "approved" else "requested changes on"
    record(run.project_id, "approval.decided", f"{body.name.strip()} {verb} design document v{version}"
           + (f": {body.comment.strip()}" if body.comment.strip() else ""), run_id=rid,
           detail={"section_comments": body.section_comments})
    return a.view()


class UsageIn(BaseModel):
    input_tokens: int | None = None
    output_tokens: int | None = None
    cache_read_tokens: int | None = None
    cost_usd: float | None = None
    model: str | None = None


from app.summary import rate_for


def estimate_cost(usage: dict) -> float | None:
    """Exact token categories from a client hook -> USD."""
    rate = rate_for(str(usage.get("model") or ""))
    if not rate:
        return None
    inp, out = rate
    return round((usage.get("input_tokens", 0) * inp + usage.get("cache_read_tokens", 0) * inp * 0.1
                  + usage.get("output_tokens", 0) * out) / 1_000_000, 4)


@router.post("/runs/{rid}/usage")
def post_usage(rid: int, body: UsageIn, s: Session = Depends(db.get_session)):
    """Exact usage from a client hook. Overrides agent-reported numbers."""
    r = _get(s, db.Run, rid)
    usage = {**json.loads(r.usage_json or "{}"), **{k: v for k, v in body.model_dump().items() if v is not None}}
    if body.cost_usd is None and (est := estimate_cost(usage)) is not None:
        usage["cost_usd"] = est
    r.usage_json = json.dumps(usage)
    s.add(r)
    s.commit()
    return usage


@router.get("/connect")
def connect_info(request: Request):
    base = _base_url(request)
    return {"mcp_url": f"{base}/mcp?project=<id>&key=<key>",
            "note": "Each project page shows its own connect command with the project's key."}
