"""FastAPI app: REST for the dashboard + authenticated MCP endpoint for Claude Code / Codex."""
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from mcp.server.transport_security import TransportSecuritySettings

from app import db
from app.auth import Gate, claim_unowned
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
    claim_unowned()
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

app.add_middleware(Gate)  # sign-in and per-user project access, see app/auth.py
