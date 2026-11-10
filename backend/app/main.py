"""FastAPI app: REST for the dashboard + authenticated MCP endpoint for Claude Code / Codex."""
import base64
import os
import re
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from mcp.server.transport_security import TransportSecuritySettings

from app import db
from app.api.routes import router
from app.connect import ProjectAuth
from app.mcp.tools import mcp

# ponytail: DNS-rebinding protection off while local; set allowed_hosts when deployed behind a real hostname.
mcp_app = mcp.streamable_http_app(
    streamable_http_path="/mcp",
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    async with mcp.session_manager.run():
        yield


app = FastAPI(title="Agents Dashboard", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://localhost:5174"],
                   allow_methods=["*"], allow_headers=["*"])
app.include_router(router)

# Hosted: one address serves the built dashboard (frontend/dist), /api and /mcp. Locally, Vite serves the UI.
_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
_mcp = ProjectAuth(mcp_app)  # every MCP request must carry ?project=<id>&key=<secret>
_ui = StaticFiles(directory=_dist, html=True) if _dist.is_dir() else None


async def _root(scope, receive, send):
    path = scope.get("path", "")
    if _ui is None or scope["type"] != "http" or path == "/mcp" or path.startswith("/mcp/"):
        return await _mcp(scope, receive, send)
    return await _ui(scope, receive, send)

app.mount("/", _root)

# Open without the dashboard password: MCP and the setup/config downloads check the project key themselves,
# the OAuth callback checks its one-time state, and the host's health check needs no credentials.
_OPEN = re.compile(r"^/(mcp(/.*)?|api/health|api/oauth/[^/]+/callback|api/projects/\d+/(setup|setup-file|mcp-config|copilot-agent))$")


class PasswordGate:
    """When DASHBOARD_PASSWORD is set, the dashboard UI and REST API ask for it (browser sign-in prompt; any user name).
    ponytail: one shared password; per-user accounts when teams need separate access."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        password = os.getenv("DASHBOARD_PASSWORD", "")
        if not password or scope["type"] != "http" or _OPEN.match(scope.get("path", "")):
            return await self.app(scope, receive, send)
        auth = dict(scope.get("headers", [])).get(b"authorization", b"").decode(errors="replace")
        given = ""
        if auth.lower().startswith("basic "):
            try:
                given = base64.b64decode(auth[6:]).decode().partition(":")[2]
            except ValueError:
                pass
        if secrets.compare_digest(given.encode(), password.encode()):
            return await self.app(scope, receive, send)
        await send({"type": "http.response.start", "status": 401, "headers": [
            (b"www-authenticate", b'Basic realm="Agents Dashboard", charset="UTF-8"'), (b"content-type", b"text/plain")]})
        await send({"type": "http.response.body", "body": b"Sign in to the Agents Dashboard."})


app.add_middleware(PasswordGate)
