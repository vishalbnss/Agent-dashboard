"""MCP tools the coding agent calls. One MCPServer instance, registered here.

The project is identified on every call from the `x-agents-project` header that `ProjectAuth`
injects after validating `?project=<id>&key=<secret>` in the MCP URL. Tools therefore never need a
folder path or repo URL to know which project they serve; those are only recorded for display.
"""
import asyncio
import concurrent.futures
import json
import re
from pathlib import Path

from mcp.server.mcpserver import Context, MCPServer
from sqlmodel import Session, select

from app import db, onboarding
from app.logs import logged
from app.connection_instructions import session_connection_check
from app.crypto import decrypt
from app.integrations import figma, github, jira, mcp_oauth
from app.summary import build_summary, fill_estimates

AGENTS_DIR = Path(__file__).resolve().parent.parent / "agents"
TICKET_KEY_RE = re.compile(r"\b[A-Z][A-Z0-9]+-\d+\b")

mcp = MCPServer(
    "agents-dashboard",
    instructions=(
        session_connection_check() + "\n\n"
        "This project is managed by the Agents Dashboard. Whenever the user asks to implement, build, fix or "
        "review a ticket, feature or design, call `start_run` FIRST with the request verbatim and follow the "
        "coordinator instructions it returns: a nine-stage Jira-to-PR workflow whose stage prompts come from "
        "`get_stage(name)`. Read tickets with `get_ticket` and Figma links with the `figma` MCP server (call "
        "`get_figma_design` first for the file and node ids). Before any stage, submit the design document with "
        "`submit_design_document` and wait for approval (`check_approval`). Report each stage with "
        "`log_phase`; end with `finish_run`."
    ),
)


def _project_id(ctx: Context | None) -> int:
    pid = (ctx.headers or {}).get("x-agents-project") if ctx is not None else None
    if not pid:
        raise ValueError("No project on this connection. Connect with the URL from the dashboard (it carries project and key).")
    return int(pid)


def _client_hint(ctx: Context | None) -> str:
    return (ctx.headers or {}).get("x-agents-client", "") if ctx is not None else ""


def _integration(s: Session, project_id: int, kind: str) -> tuple[dict, str] | None:
    i = s.exec(select(db.Integration).where(db.Integration.project_id == project_id, db.Integration.kind == kind)).first()
    return (json.loads(i.config_json or "{}"), decrypt(i.secret_enc)) if i else None


def _run(s: Session, run_id: int) -> db.Run:
    run = s.get(db.Run, run_id)
    if not run:
        raise ValueError(f"Unknown run_id {run_id}. Call start_run first.")
    return run


def _sync(coro):
    """Run a coroutine from a sync tool. ponytail: tools are sync for simplicity; make them async if this blocks."""
    with concurrent.futures.ThreadPoolExecutor(1) as ex:
        return ex.submit(asyncio.run, coro).result()


# ---- implementations (project id explicit, so tests can call them directly) ----

def short_title(goal: str, title: str = "") -> str:
    """The AI's title when given; otherwise the first sentence of the request, cut at 90 characters."""
    t = (title or "").strip().splitlines()[0] if (title or "").strip() else ""
    if not t:
        first = re.split(r"(?<=[.!?])\s|\n|\s+Ticket\s+[A-Z][A-Z0-9]+-\d+:", goal.strip(), maxsplit=1)[0].strip().rstrip(".")
        t = first
    return (t[:87] + "…") if len(t) > 90 else t


def do_start_run(project_id: int, goal: str, client: str = "unknown", repo_url: str = "", path: str = "", title: str = "") -> dict:
    with Session(db.engine) as s:
        project = s.get(db.Project, project_id)
        if not project:
            raise ValueError("Unknown project")
        if client in ("claude", "codex", "copilot"):
            project.ai = client
        if path and not project.local_path:
            project.local_path = db.normalize_path(path)
        if repo_url and not project.repo_url:
            project.repo_url = db.normalize_repo_url(repo_url)
        count = len(s.exec(select(db.Run).where(db.Run.project_id == project.id)).all())
        low_cost = project.caps.get("routing") == "low-cost"
        run = db.Run(project_id=project.id, goal=goal, client=client, number=count + 1, title=short_title(goal, title),
                     routing="low-cost" if low_cost else "standard")
        s.add(run)
        s.commit()
        s.refresh(run)
        needs_onboarding = not project.agents_md
        if needs_onboarding and project.onboarding_status != "done":
            project.onboarding_status, project.onboarding_stage = "running", "starting"
        s.add(project)
        s.commit()
        ai = client if client in ("claude", "codex", "copilot") else project.ai or "claude"
        agents_md = project.agents_md or "(AGENTS.md is being written in the onboarding step above; use it once written.)"
        plan = (f"# Jira-to-PR workflow for run {run.id}\n\nYou are the coordinator. Fetch each stage prompt with `get_stage(name)` "
                f"when that stage starts; stages and their model routes are listed in `stages`.\n\n"
                + onboarding.coordinator(ai, low_cost)
                + "\n\n## AGENTS.md (project guide, recorded by the dashboard)\n\n" + agents_md + "\n")
        if needs_onboarding:
            plan = onboarding.onboarding_block(ai, project.name) + "\n" + plan
        if ai == "copilot":
            plan = plan.replace("`get_stage(name)`", "`get_stage(name, run_id=run_id)`")
        return {
            "run_id": run.id,
            "project": {"id": project.id, "name": project.name, "repo_url": project.repo_url,
                        "local_path": project.local_path, "has_agents_md": bool(project.agents_md)},
            "ticket_keys": TICKET_KEY_RE.findall(goal),
            "needs_onboarding": needs_onboarding,
            "routing": "low-cost" if low_cost else "standard",
            "stages": onboarding.stage_table(ai, low_cost),
            "plan": plan,
        }


def do_get_stage(project_id: int, name: str, run_id: int | None = None, client_hint: str = "") -> dict:
    with Session(db.engine) as s:
        project = s.get(db.Project, project_id)
        ai = client_hint or (project.ai if project else "") or "claude"
        if run_id is not None:
            run = _run(s, run_id)
            if run.project_id != project_id:
                raise ValueError("This run belongs to another project.")
            if run.client in ("claude", "codex", "copilot"):
                ai = run.client
    text = onboarding.stage_prompt(name, ai)
    if text is None:
        return {"error": f"Unknown stage {name!r}. Stages: {', '.join(onboarding.stage_names())}."}
    return {"stage": name, "prompt": text}


def do_get_connection_status(project_id: int, client_hint: str = "") -> dict:
    """A read-only probe with no credentials or run side effects."""
    with Session(db.engine) as s:
        project = s.get(db.Project, project_id)
        if not project:
            raise ValueError("Unknown project")
        return {"connected": True, "project_id": project.id, "project_name": project.name,
                "client": client_hint or project.ai or "unknown", "has_agents_md": bool(project.agents_md)}


JIRA_SITES = ["getAccessibleAtlassianResources"]
JIRA_ISSUE = ["getJiraIssue", "get_issue", "jira_get_issue"]


def do_get_ticket(project_id: int, key: str) -> dict:
    key = key.strip().upper()
    with Session(db.engine) as s:
        t = s.exec(select(db.Ticket).where(db.Ticket.project_id == project_id, db.Ticket.key == key)).first()
        if not t:
            token = mcp_oauth.token_for_project(s, project_id, "jira")
            if not token:
                return {"error": f"Ticket {key} is not known and Jira is not connected for this project. Ask the user to click "
                                 f"Add ticket in the project's Tickets tab, connect Jira, or paste the ticket text in this chat, then continue."}
            try:
                cloud = jira.cloud_id(mcp_oauth.call("jira", token, JIRA_SITES, {}))
                issue = jira.parse_issue(mcp_oauth.call("jira", token, JIRA_ISSUE, {"cloudId": cloud, "issueIdOrKey": key, "issueKey": key}), key)
            except Exception as e:
                return {"error": f"Could not read {key} from Jira: {e}. Ask the user to check the Jira connection on the project page "
                                 f"or paste the ticket text, then continue."}
            t = db.Ticket(project_id=project_id, key=key, title=issue["title"], body_md=issue["body_md"], source="jira")
            s.add(t)
            s.commit()
        return {"key": t.key, "title": t.title, "body": t.body_md, "source": t.source,
                "figma_urls": figma.extract_figma_urls(t.body_md)}


def do_get_figma_design(project_id: int, figma_url: str) -> dict:
    """Figma designs are read by the AI's own `figma` MCP server (listed in the project's .mcp.json), because Figma
    only lets approved AI tools sign in. This tool parses the link and tells the AI exactly what to call."""
    file_key, node_id = figma.parse_figma_url(figma_url)
    return {"url": figma_url, "file_key": file_key, "node_id": node_id,
            "how": "Read this design with the `figma` MCP server available in this session (tools such as get_design_context, "
                   "get_screenshot or get_metadata, with the fileKey and nodeId above). Report the result with "
                   "report_connection(kind=\"figma\", connected=true or false, client=\"codex\", \"claude\" or \"copilot\", "
                   "detail=\"brief result without credentials\"). A parsed URL alone is not a successful check. "
                   "If that server is missing or not "
                   "authenticated, ask the user to sign in to Figma through their coding client's MCP settings, then continue. Without a design, "
                   "implement from the ticket text and say so in the summary."}


def _count(v) -> int | None:
    """Harness totals arrive as 37744, "37,744" or "not reported"."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(v) if v >= 0 else None
    t = str(v or "").replace(",", "").replace("_", "").strip()
    return int(t) if t.isdigit() else None


def do_log_phase(project_id: int, run_id: int, phase: str, status: str = "done", notes: str = "",
                 model: str = "", tokens=None, duration_ms=None) -> dict:
    with Session(db.engine) as s:
        run = _run(s, run_id)
        if run.project_id != project_id:
            raise ValueError("This run belongs to another project.")
        s.add(db.RunPhase(run_id=run_id, name=phase, status=status, notes=notes[:2000], model=str(model or "")[:80],
                          tokens=_count(tokens), duration_ms=_count(duration_ms)))
        if phase in onboarding.ONBOARD_PHASES:  # drive the wizard's progress bar
            p = s.get(db.Project, project_id)
            p.onboarding_status, p.onboarding_stage = "running", onboarding.ONBOARD_PHASES[phase]
            s.add(p)
        s.commit()
    return {"ok": True}


REPORTABLE = ("figma", "github", "jira")


def do_report_connection(project_id: int, kind: str, connected: bool, detail: str = "", client: str = "") -> dict:
    """The AI tells the dashboard whether a service it checked itself (Figma MCP, gh) is usable, so the box can show it."""
    if kind not in REPORTABLE:
        return {"error": f"kind must be one of {REPORTABLE}"}
    if client not in ("", "claude", "codex", "copilot"):
        return {"error": "client must be claude, codex or copilot"}
    with Session(db.engine) as s:
        project = s.get(db.Project, project_id)
        if not project:
            raise ValueError("Unknown project")
        i = s.exec(select(db.Integration).where(db.Integration.project_id == project_id, db.Integration.kind == kind)).first()
        if i and i.secret_enc:  # connected through the dashboard itself; the AI's probe does not override that
            return {"ok": True, "note": f"{kind} is connected on the dashboard already"}
        if not i:
            i = db.Integration(project_id=project_id, kind=kind)
        reporter = client or (project.ai if project.ai in ("claude", "codex", "copilot") else "unknown")
        report = {"connected": bool(connected), "detail": detail[:200],
                  "client": reporter, "checked_at": db.now().isoformat()}
        config = {"auth": "via-ai", **report}
        if kind == "figma":
            previous = json.loads(i.config_json or "{}")
            reports = dict(previous.get("clients") or {})
            # Preserve checks saved before per-client reporting existed.
            if not reports and previous.get("auth") == "via-ai" and isinstance(previous.get("connected"), bool):
                old_client = previous.get("client") or "unknown"
                reports[old_client] = {key: previous.get(key, "") for key in report}
            if reporter != "unknown":
                reports.pop("unknown", None)
            reports[reporter] = report
            config["clients"] = reports
            config["connected"] = any(r.get("connected") is True for r in reports.values())
        i.config_json = json.dumps(config)
        s.add(i)
        s.commit()
    return {"ok": True}


MAX_APPROVAL_ROUNDS = 3


def _approvals(s: Session, run_id: int) -> list[db.Approval]:
    return list(s.exec(select(db.Approval).where(db.Approval.run_id == run_id).order_by(db.Approval.version)).all())


def _approval_view(a: db.Approval) -> dict:
    return {"version": a.version, "status": a.status, "decided_by": a.decided_by, "comment": a.comment,
            "section_comments": json.loads(a.section_comments_json or "{}"), "submitted_at": a.created_at.isoformat(), "decided_at": a.decided_at.isoformat() if a.decided_at else None}


def do_submit_design_document(project_id: int, run_id: int, content_md: str) -> dict:
    """The agent hands in the design document; the run waits until someone decides on the dashboard."""
    with Session(db.engine) as s:
        run = _run(s, run_id)
        if run.project_id != project_id:
            raise ValueError("This run belongs to another project.")
        existing = _approvals(s, run_id)
        if any(a.status == "pending" for a in existing):
            return {"error": "A design document is already waiting for a decision. Call check_approval instead of submitting again."}
        if len(existing) >= MAX_APPROVAL_ROUNDS:
            return {"error": f"The design document was sent back {MAX_APPROVAL_ROUNDS} times. Stop the run and report the last comment to the user."}
        a = db.Approval(run_id=run_id, version=len(existing) + 1, content_md=content_md)
        run.status = "awaiting_approval"
        s.add(a)
        s.add(run)
        s.add(db.RunPhase(run_id=run_id, name="design-approval", status="running",
                          notes=f"Design document v{a.version} submitted, waiting for approval on the dashboard"))
        s.commit()
        return {"version": a.version, "status": "pending", "rounds_left": MAX_APPROVAL_ROUNDS - a.version,
                "next": "Call check_approval(run_id) every 20 seconds (sleep in between) until status is approved or changes_requested."}


def do_check_approval(project_id: int, run_id: int) -> dict:
    with Session(db.engine) as s:
        run = _run(s, run_id)
        if run.project_id != project_id:
            raise ValueError("This run belongs to another project.")
        existing = _approvals(s, run_id)
        if not existing:
            return {"status": "none", "next": "Call submit_design_document first."}
        a = existing[-1]
        out = _approval_view(a)
        out["rounds_left"] = MAX_APPROVAL_ROUNDS - a.version
        if a.status == "approved":
            out["next"] = "Approved. Start Stage 01 (branch preflight) and run the workflow."
        elif a.status == "changes_requested":
            out["next"] = ("Revise the design document according to the comment and call submit_design_document again."
                           if a.version < MAX_APPROVAL_ROUNDS else
                           "No rounds left. Stop the run (finish_run with status stopped) and report the comment to the user.")
        else:
            out["next"] = "Still waiting. Sleep 20 seconds and call check_approval again."
        return out


def decide_approval(s: Session, run_id: int, version: int, decision: str, name: str, comment: str,
                    section_comments: dict[str, str] | None = None) -> db.Approval:
    """Dashboard side: record the decision and let the run continue. Section notes are folded into the comment
    the agent reads ("Risks: add mobile"), and also kept apart so the dashboard can show them per section."""
    a = s.exec(select(db.Approval).where(db.Approval.run_id == run_id, db.Approval.version == version)).first()
    if not a:
        raise ValueError("Unknown design document version")
    if a.status != "pending":
        raise ValueError("This version was already decided")
    notes = {k.strip()[:200]: v.strip()[:2000] for k, v in (section_comments or {}).items() if k.strip() and v.strip()}
    full = "\n".join([comment.strip()] * bool(comment.strip()) + [f"- {k}: {v}" for k, v in notes.items()])
    a.status, a.decided_by, a.comment, a.decided_at = decision, name.strip()[:120], full[:8000], db.now()
    a.section_comments_json = json.dumps(notes)
    run = _run(s, run_id)
    run.status = "running"
    s.add(a)
    s.add(run)
    s.add(db.RunPhase(run_id=run_id, name="design-approval", status="done" if decision == "approved" else "failed",
                      notes=(f"v{version} approved by {a.decided_by}" if decision == "approved"
                             else f"v{version}: changes requested by {a.decided_by}: {a.comment[:150]}")))
    s.commit()
    s.refresh(a)
    return a


def do_open_pull_request(project_id: int, run_id: int, branch: str, title: str, body: str = "", base: str | None = None) -> dict:
    with Session(db.engine) as s:
        run = _run(s, run_id)
        project = s.get(db.Project, project_id)
        g = _integration(s, project_id, "github")
        if not project.repo_url:
            return {"error": "This project has no GitHub URL. Ask the user to add it on the project page, or leave the branch local."}
        if not g:
            return {"error": "GitHub is not connected for this project. Ask the user to add a GitHub token in the "
                             "dashboard, or open the PR yourself with `gh pr create`."}
        url = _sync(github.open_pr(g[1], project.repo_url, branch, title, body, base))
        run.pr_url, run.branch = url, branch
        s.add(run)
        s.commit()
    return {"pr_url": url}


def do_finish_run(project_id: int, run_id: int, summary, status: str = "done") -> dict:
    if isinstance(summary, str):
        try:
            summary = json.loads(summary)
        except json.JSONDecodeError:
            summary = {"what_changed": [summary]}
    if not isinstance(summary, dict):
        summary = {"what_changed": [str(summary)]}
    with Session(db.engine) as s:
        run = _run(s, run_id)
        if run.project_id != project_id:
            raise ValueError("This run belongs to another project.")
        run.status = status
        run.finished_at = db.now()
        run.branch = str(summary.get("branch") or run.branch or "")
        reported = summary.get("usage") if isinstance(summary.get("usage"), dict) else {}
        usage = {**json.loads(run.usage_json or "{}"), **{k: v for k, v in reported.items() if v not in (None, "not reported")}}
        for st in summary.get("stages") or []:  # "37,744" -> 37744 so estimates and totals work
            if isinstance(st, dict):
                for k in ("tokens", "tool_calls", "duration_ms"):
                    v = st.get(k)
                    if isinstance(v, str) and v.replace(",", "").replace("_", "").strip().isdigit():
                        st[k] = int(v.replace(",", "").replace("_", "").strip())
        for st in summary.get("stages") or []:
            if not isinstance(st, dict):
                continue
            ph = s.exec(select(db.RunPhase).where(db.RunPhase.run_id == run_id, db.RunPhase.name == str(st.get("phase", "")),
                                                  db.RunPhase.status != "running").order_by(db.RunPhase.ts.desc(), db.RunPhase.id.desc())).first()
            if ph:
                model = str(st.get("model") or "")
                ph.model = ph.model or ("" if model.lower() in ("", "not reported") else model[:80])
                ph.tokens = ph.tokens if ph.tokens is not None else _count(st.get("tokens"))
                ph.duration_ms = ph.duration_ms if ph.duration_ms is not None else _count(st.get("duration_ms"))
                s.add(ph)
        if run.client != "copilot" and not isinstance(usage.get("cost_usd"), (int, float)):
            usage.update(fill_estimates(summary))
        run.usage_json = json.dumps(usage)
        started = run.started_at if run.started_at.tzinfo else run.started_at.replace(tzinfo=run.finished_at.tzinfo)
        try:
            run.summary_md = build_summary(run.goal, summary, usage, started, run.finished_at, run.pr_url)
        except Exception as e:  # never lose the record over a formatting problem
            raw = json.dumps(summary, indent=2)[:6000]
            run.summary_md = ("# Run summary\n\n**Goal:** " + run.goal + "\n\n(Summary could not be formatted: "
                              + str(e) + ")\n\n```json\n" + raw + "\n```\n")
        s.add(run)
        s.commit()
        return {"summary_md": run.summary_md, "run_id": run_id}


def do_save_agents_md(project_id: int, content: str) -> dict:
    with Session(db.engine) as s:
        p = s.get(db.Project, project_id)
        p.agents_md = content
        p.onboarding_status, p.onboarding_stage = "done", "done"
        s.add(p)
        s.commit()
    return {"ok": True, "chars": len(content)}


# ---- MCP surface (thin wrappers; the project comes from the connection) ----

@mcp.tool()
@logged
def start_run(goal: str, client: str = "unknown", repo_url: str = "", path: str = "", title: str = "", ctx: Context = None) -> dict:
    """Start a run. Call this FIRST for any implement/build/fix/review request. goal = the user's request verbatim;
    title = a short line for the dashboard, max 90 characters, e.g. "DEMO-1: KPI cards on the home page";
    client = "claude", "codex" or "copilot"; repo_url = `git remote get-url origin` (empty if none); path = this folder's absolute path.
    Returns run_id, the coordinator instructions to follow, and the nine stages with their model routes."""
    return do_start_run(_project_id(ctx), goal, _client_hint(ctx) if client == "unknown" and _client_hint(ctx) else client, repo_url, path, title)


@mcp.tool()
@logged
def get_stage(name: str, run_id: int | None = None, ctx: Context = None) -> dict:
    """The full prompt for one workflow stage (branch-preflight, jira-intake, figma-intake, dependency-merge, implementation,
    independent-test, code-review-security, documentation, pr-creation). Paste it into the stage agent's first message.
    Include run_id to keep the run's coding-client edition when several clients share the project."""
    return do_get_stage(_project_id(ctx), name, run_id, _client_hint(ctx))


@mcp.tool()
@logged
def get_connection_status(ctx: Context = None) -> dict:
    """Verify this dashboard MCP connection and its project identity. Read-only: never starts a run or edits files."""
    return do_get_connection_status(_project_id(ctx), _client_hint(ctx))


@mcp.tool()
@logged
def get_ticket(run_id: int, key: str, ctx: Context = None) -> dict:
    """Fetch a ticket by key (e.g. ABC-123) from the dashboard (pasted) or Jira when connected. Returns title, body and Figma URLs."""
    return do_get_ticket(_project_id(ctx), key)


@mcp.tool()
@logged
def get_figma_design(run_id: int, figma_url: str, ctx: Context = None) -> dict:
    """Parse a Figma link into file key and node id and get the instructions for reading it with the `figma` MCP server."""
    return do_get_figma_design(_project_id(ctx), figma_url)


@mcp.tool()
@logged
def log_phase(run_id: int, phase: str, status: str = "done", notes: str = "", model: str = "",
              tokens: int | str | None = None, duration_ms: int | str | None = None, ctx: Context = None) -> dict:
    """Report running immediately before starting/resuming a stage, then done or failed when it ends.
    Stages: design-approval, branch-preflight, jira-intake, figma-intake, dependency-merge, implementation,
    independent-test, code-review-security, documentation, pr-creation; onboarding uses onboard-reading, onboard-preparing,
    onboard-writing). status: done | failed | running.
    On done/failed, pass the stage agent's measured totals the harness printed with its result: model (effective model),
    tokens (cumulative total for that agent so far) and duration_ms (its cumulative working time). Omit what was not measured."""
    return do_log_phase(_project_id(ctx), run_id, phase, status, notes, model, tokens, duration_ms)


@mcp.tool()
@logged
def report_connection(kind: str, connected: bool, detail: str = "", client: str = "", ctx: Context = None) -> dict:
    """Tell the dashboard whether a service you checked yourself is usable from this session: kind = figma (your figma MCP
    server) or github (gh auth status). Use during connection setup, after sign-in, and after access succeeds or fails.
    No run is required: do not call start_run just to check a connection. client = codex, claude or copilot (this session).
    connected=true requires a successful read-only service call, not just installed tools or a config file.
    For Figma use an available identity tool, or metadata for a user-supplied design; ask for a design link if needed.
    If tools are missing or the check fails, report false with a short reason. Never include credentials in detail."""
    return do_report_connection(_project_id(ctx), kind, connected, detail, client or _client_hint(ctx))


@mcp.tool()
@logged
def submit_design_document(run_id: int, content_md: str, ctx: Context = None) -> dict:
    """Hand in the design document (Markdown) for human approval on the dashboard before any implementation.
    Then poll check_approval every 20 seconds. Sections: goal, scope of changes (in/out), how the implementation
    will be done (approach, components, files to touch, data/state, mapping to Figma nodes), test plan, risks and
    assumptions, open questions, acceptance-criteria mapping."""
    return do_submit_design_document(_project_id(ctx), run_id, content_md)


@mcp.tool()
@logged
def check_approval(run_id: int, ctx: Context = None) -> dict:
    """Current decision on the latest design document: pending | approved | changes_requested, with the approver's
    name and comment. Poll every 20 seconds while pending."""
    return do_check_approval(_project_id(ctx), run_id)


@mcp.tool()
@logged
def open_pull_request(run_id: int, branch: str, title: str, body: str = "", base: str | None = None, ctx: Context = None) -> dict:
    """Open a GitHub pull request for an already-pushed branch using the project's GitHub token."""
    return do_open_pull_request(_project_id(ctx), run_id, branch, title, body, base)


@mcp.tool()
@logged
def finish_run(run_id: int, summary: dict | str, status: str = "done", ctx: Context = None) -> dict:
    """Finish the run. summary keys: what_changed (list), changed_files (list), tests ({command,result}),
    decisions (list), questions (list), remaining (list), branch (str),
    stages (list of {phase, agent, model, tokens, tool_calls, duration_ms, est_cost_usd, outcome}; missing = "not reported"),
    usage ({input_tokens, output_tokens, cache_read_tokens, cost_usd, model, fix_cycles, duration_ms}),
    cost_note (str). status: done | failed | stopped. Returns Markdown summary."""
    return do_finish_run(_project_id(ctx), run_id, summary, status)


@mcp.tool()
@logged
def save_agents_md(content: str, ctx: Context = None) -> dict:
    """Store the AGENTS.md you wrote for this project so future runs receive it from start_run."""
    return do_save_agents_md(_project_id(ctx), content)


@mcp.prompt()
def implement(goal: str) -> str:
    """Implement a ticket end to end with the Agents Dashboard's nine-stage Jira-to-PR workflow."""
    return (f"Call the agents-dashboard tool `start_run` with goal={goal!r}, client set to the assistant you are "
            f"(claude, codex or copilot), repo_url from `git remote get-url origin` (empty if none) and this folder's absolute "
            f"path. Follow the returned coordinator instructions exactly, fetching each stage prompt with `get_stage`.")


@mcp.prompt()
def review(goal: str = "review the current branch against its ticket") -> str:
    """Review the current branch against its ticket and design."""
    return (f"Call the agents-dashboard tool `start_run` with goal={goal!r}. Run only stages 01, 02, 04 (validate) and 07 "
            f"(code-review-security) on the current branch, then `finish_run` with the findings as what_changed.")


@mcp.prompt()
def onboard() -> str:
    """Generate AGENTS.md for this repository and register it with the dashboard."""
    return (AGENTS_DIR / "onboard.md").read_text(encoding="utf-8") + "\nThen call `save_agents_md(content)` with the full AGENTS.md text.\n"
