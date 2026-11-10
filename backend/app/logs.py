"""Project activity log: every MCP tool call from the developer's AI, plus dashboard actions.

The agents' LLM calls happen inside Claude Code / Codex / Copilot on the developer's machine, so the dashboard logs
what it can actually observe: the tool calls those agents make to it, and what people do on the dashboard.
ponytail: rows are kept forever; add a retention sweep (e.g. delete older than 90 days) when the table gets big.
"""
import functools
import inspect
import json
import time

from sqlmodel import Session

from app import db

LEVELS = ["debug", "info", "warn", "error"]
SECRET_ARGS = {"key", "token", "secret", "password"}


def _trim(v, limit: int = 300):
    """Keep log rows small: long text becomes a prefix plus its length; nested values are trimmed too."""
    if isinstance(v, str):
        return v if len(v) <= limit else v[:limit] + f"… ({len(v):,} chars)"
    if isinstance(v, dict):
        return {k: "[hidden]" if k in SECRET_ARGS else _trim(x, limit) for k, x in list(v.items())[:30]}
    if isinstance(v, list):
        return [_trim(x, limit) for x in v[:20]] + ([f"… {len(v) - 20} more"] if len(v) > 20 else [])
    return v


def record(project_id: int, event: str, message: str, *, level: str = "info", source: str = "dashboard",
           run_id: int | None = None, client: str = "", detail: dict | None = None, duration_ms: int | None = None) -> None:
    """Write one log row. Never raises: logging must not break the action it describes."""
    try:
        with Session(db.engine) as s:
            s.add(db.LogEntry(project_id=project_id, run_id=run_id, level=level if level in LEVELS else "info",
                              source=source, event=event, client=client, message=message[:500],
                              detail_json=json.dumps(_trim(detail or {}), default=str)[:8000], duration_ms=duration_ms))
            s.commit()
    except Exception:
        pass


def _message(tool: str, a: dict, r) -> tuple[str, str]:
    """(level, human-readable line) for one tool call."""
    r = r if isinstance(r, dict) else {}
    if r.get("error"):
        return "warn", str(r["error"])
    if tool == "start_run":
        return "info", f"Started run: {a.get('title') or str(a.get('goal', ''))[:90]}"
    if tool == "get_stage":
        return "info", f"Fetched the {a.get('name')} stage prompt"
    if tool == "get_connection_status":
        return "debug", "Checked the dashboard connection"
    if tool == "get_ticket":
        return "info", f"Read ticket {r.get('key') or a.get('key')} ({r.get('source', '?')})"
    if tool == "get_figma_design":
        return "info", f"Parsed Figma link (file {r.get('file_key')}, node {r.get('node_id')})"
    if tool == "log_phase":
        st = a.get("status", "done")
        return ("warn" if st == "failed" else "info"), f"{a.get('phase')}: {st}" + (f" — {a['notes']}" if a.get("notes") else "")
    if tool == "report_connection":
        ok = a.get("connected")
        return ("info" if ok else "warn"), f"{a.get('kind')} {'reachable' if ok else 'not reachable'}" + (f": {a['detail']}" if a.get("detail") else "")
    if tool == "submit_design_document":
        return "info", f"Submitted design document v{r.get('version', '?')} for approval"
    if tool == "check_approval":
        st = r.get("status", "?")
        return ("debug" if st == "pending" else "info"), f"Approval check: {st.replace('_', ' ')}"
    if tool == "open_pull_request":
        return "info", f"Opened pull request {r.get('pr_url', '')}"
    if tool == "finish_run":
        return "info", f"Finished the run ({a.get('status', 'done')})"
    if tool == "save_agents_md":
        return "info", f"Saved AGENTS.md ({r.get('chars', '?')} chars)"
    return "info", f"Called {tool}"


def _context(ctx) -> tuple[int | None, str]:
    headers = (ctx.headers or {}) if ctx is not None else {}
    pid = headers.get("x-agents-project")
    return (int(pid) if pid else None), headers.get("x-agents-client", "")


def _client(project_id: int, run_id, hint: str) -> str:
    with Session(db.engine) as s:
        run = s.get(db.Run, run_id) if isinstance(run_id, int) else None
        if run and run.client in ("claude", "codex", "copilot"):
            return run.client
        p = s.get(db.Project, project_id)
        return hint or (p.ai if p else "")


def logged(fn):
    """Wrap an MCP tool so every call is logged with its outcome and duration. Keeps the signature for the MCP schema."""
    sig = inspect.signature(fn)

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        bound = sig.bind_partial(*args, **kwargs)
        a = {k: v for k, v in bound.arguments.items() if k != "ctx"}
        pid, hint = _context(bound.arguments.get("ctx"))
        t0 = time.perf_counter()
        try:
            result = fn(*args, **kwargs)
        except Exception as e:
            if pid:
                record(pid, fn.__name__, f"{fn.__name__} failed: {e}", level="error", source="mcp",
                       run_id=a.get("run_id"), client=_client(pid, a.get("run_id"), hint), detail={"args": a},
                       duration_ms=int((time.perf_counter() - t0) * 1000))
            raise
        if pid:
            level, msg = _message(fn.__name__, a, result)
            run_id = a.get("run_id") or (result.get("run_id") if isinstance(result, dict) else None)
            record(pid, fn.__name__, msg, level=level, source="mcp", run_id=run_id,
                   client=_client(pid, run_id, hint), detail={"args": a, "result": result},
                   duration_ms=int((time.perf_counter() - t0) * 1000))
        return result

    return wrapper
