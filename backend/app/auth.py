"""Dashboard sign-in and per-user access.

Users come from DASHBOARD_USERS, e.g. "vishal:pw1,rakesh:pw2,admin:pw3:admin" (role defaults to developer).
Developers see and change only the projects they created; the admin sees every project, read-only.
With no users configured (local use) sign-in is off and everything is open, as before.
The MCP endpoint and the setup downloads keep using the project key, so a developer's AI reaches only that
developer's project. ponytail: users live in an env var; move them to a table when people sign up themselves.
"""
import hashlib
import hmac
import json
import os
import re
import time

from sqlmodel import Session, select

from app import db

COOKIE = "ad_session"
MAX_AGE = 7 * 86400
ROLES = ("admin", "developer")


def users() -> dict[str, dict]:
    """{name: {"password", "role"}}. A password may contain ':'; only a trailing :admin / :developer is a role."""
    out = {}
    for item in os.getenv("DASHBOARD_USERS", "").split(","):
        name, _, rest = item.strip().partition(":")
        role = "developer"
        for r in ROLES:
            if rest.endswith(":" + r):
                rest, role = rest[: -len(r) - 1], r
        if name.strip() and rest:
            out[name.strip().lower()] = {"password": rest, "role": role}
    if not out and os.getenv("DASHBOARD_PASSWORD"):  # older single-password setups: one read-only admin
        out["admin"] = {"password": os.environ["DASHBOARD_PASSWORD"], "role": "admin"}
    return out


def enabled() -> bool:
    return bool(users())


def _sign(text: str) -> str:
    from app.crypto import _key
    return hmac.new(_key(), text.encode(), hashlib.sha256).hexdigest()


def _fingerprint(user: dict) -> str:  # changing a password signs everyone out of that account
    return hashlib.sha256(user["password"].encode()).hexdigest()[:16]


def check_password(name: str, password: str) -> dict | None:
    u = users().get(name.strip().lower())
    if u and hmac.compare_digest(u["password"].encode(), password.encode()):
        return {"name": name.strip().lower(), "role": u["role"]}
    return None


def session_cookie(name: str) -> str:
    u = users()[name]
    exp = int(time.time()) + MAX_AGE
    body = f"{name}.{exp}"
    return f"{body}.{_sign(body + '.' + _fingerprint(u))}"


def session_user(cookie: str) -> dict | None:
    name, _, rest = cookie.partition(".")
    exp, _, sig = rest.partition(".")
    u = users().get(name)
    if not u or not exp.isdigit() or int(exp) < time.time():
        return None
    if not hmac.compare_digest(sig, _sign(f"{name}.{exp}.{_fingerprint(u)}")):
        return None
    return {"name": name, "role": u["role"]}


def cookie_from(scope) -> str:
    raw = dict(scope.get("headers", [])).get(b"cookie", b"").decode(errors="replace")
    for part in raw.split(";"):
        k, _, v = part.strip().partition("=")
        if k == COOKIE:
            return v
    return ""


def owner_filter(request) -> str | None:
    """The owner whose projects a list shows, or None for all (admin, or sign-in off)."""
    user = getattr(request.state, "user", None)
    return user["name"] if user and user["role"] != "admin" else None


def current_name(request) -> str:
    user = getattr(request.state, "user", None)
    return user["name"] if user else ""


def claim_unowned() -> None:
    """Projects created before sign-in existed belong to the first developer listed in DASHBOARD_USERS."""
    devs = [n for n, u in users().items() if u["role"] == "developer"]
    if not devs:
        return
    with Session(db.engine) as s:
        for p in s.exec(select(db.Project).where(db.Project.owner == "")).all():
            p.owner = devs[0]
            s.add(p)
        s.commit()
        for r in s.exec(select(db.Run).where(db.Run.started_by == "")).all():  # older runs: their project's owner
            if (p := s.get(db.Project, r.project_id)) and p.owner:
                r.started_by = p.owner
                s.add(r)
        s.commit()


# ---- the gate in front of /api ----
# Open without a session: sign-in itself, the host's health check, the OAuth callback (checks its state), and the
# calls a developer's machine makes with the project key (setup command, hooks, document upload).
_OPEN = re.compile(r"^/(mcp(/.*)?|api/health|api/auth/(login|logout|me)|api/oauth/[^/]+/callback|"
                   r"api/projects/\d+/(setup|setup-file|mcp-config|copilot-agent|figma-check|documents/upload))$")
_PROJECT = re.compile(r"^/api/projects/(\d+)(/|$)")
_RUN = re.compile(r"^/api/runs/(\d+)(/|$)")
_DOC = re.compile(r"^/api/documents/(\d+)$")


def _owner_of(path: str, query: str) -> str | None:
    """Owner of the project a request is about, "" for unknown ids, None when the path names no project."""
    with Session(db.engine) as s:
        if m := _PROJECT.match(path):
            p = s.get(db.Project, int(m[1]))
        elif m := _RUN.match(path):
            r = s.get(db.Run, int(m[1]))
            p = s.get(db.Project, r.project_id) if r else None
        elif m := _DOC.match(path):
            d = s.get(db.Document, int(m[1]))
            p = s.get(db.Project, d.project_id) if d else None
        elif path.startswith("/api/oauth/") and (m := re.search(r"(?:^|&)project=(\d+)", query)):
            p = s.get(db.Project, int(m[1]))
        else:
            return None
        return p.owner if p else ""


class Gate:
    """Signed-in users only on /api; developers only on their own projects; the admin reads everything."""

    def __init__(self, app):
        self.app = app

    async def _deny(self, send, status: int, message: str):
        await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": json.dumps({"detail": message}).encode()})

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope["type"] != "http" or not path.startswith("/api/") or not enabled() or _OPEN.match(path):
            return await self.app(scope, receive, send)
        user = session_user(cookie_from(scope))
        if not user:
            return await self._deny(send, 401, "Sign in to the Agents Dashboard.")
        scope.setdefault("state", {})["user"] = user
        if user["role"] == "admin":
            if scope["method"] not in ("GET", "HEAD"):
                return await self._deny(send, 403, "The admin view is read-only.")
            return await self.app(scope, receive, send)
        owner = _owner_of(path, scope.get("query_string", b"").decode(errors="replace"))
        if owner is not None and owner != user["name"]:  # someone else's project, or no such project
            return await self._deny(send, 404, "Not found")
        return await self.app(scope, receive, send)
