"""Connect a project to Jira through Atlassian's official MCP server, with OAuth and no pre-registered app.

How it works (the same dance Claude Code does when a developer clicks "Authenticate" on a remote MCP):
1. discover: read the MCP server's OAuth metadata (.well-known) to learn the authorize/token/register endpoints;
2. register: POST once to the registration endpoint ("dynamic client registration") -> a client_id for this dashboard,
   stored in the AppRegistration table, so no id/secret has to be copied into a config file;
3. authorize: send the user to the provider's "Allow?" page with PKCE and the MCP server as `resource`;
4. callback: exchange the code for tokens, stored encrypted per project in Integration.secret_enc;
5. use: open an MCP client session to the provider with the bearer token and call its tools
   (Jira: get an issue).
"""
import base64
import hashlib
import json
import os
import secrets
import time
from urllib.parse import urlencode, urlparse

import httpx
from sqlmodel import Session, select

from app import db
from app.crypto import decrypt, encrypt

# Figma is not here on purpose: its MCP server only registers approved AI tools (Claude Code, Cursor, ...), so the
# developer's AI connects Figma itself from the project's .mcp.json; the dashboard hands out that config.
PROVIDERS = {
    "jira": {"name": "Jira", "mcp_url": "https://mcp.atlassian.com/v1/sse", "transport": "sse"},
}
CLIENT_NAME = "Agents Dashboard"
_pending: dict[str, dict] = {}  # state -> {project_id, provider, verifier, expiry}


def public_url() -> str:
    """The address people and AIs reach: PUBLIC_BASE_URL, else the URL Render assigns. Empty when neither is set."""
    return (os.getenv("PUBLIC_BASE_URL") or os.getenv("RENDER_EXTERNAL_URL") or "").rstrip("/")


def base_url() -> str:
    return public_url() or "http://localhost:8000"


def redirect_uri(provider: str) -> str:
    return f"{base_url()}/api/oauth/{provider}/callback"


# ---- discovery + registration ----
async def _get_json(client: httpx.AsyncClient, url: str) -> dict | None:
    try:
        r = await client.get(url, headers={"Accept": "application/json"})
        return r.json() if r.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None


async def discover(provider: str) -> dict:
    """OAuth endpoints for the provider's MCP server (RFC 9728 + RFC 8414)."""
    mcp_url = PROVIDERS[provider]["mcp_url"]
    u = urlparse(mcp_url)
    origin = f"{u.scheme}://{u.netloc}"
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as c:
        prm = (await _get_json(c, f"{origin}/.well-known/oauth-protected-resource{u.path}")
               or await _get_json(c, f"{origin}/.well-known/oauth-protected-resource") or {})
        candidates = list(prm.get("authorization_servers") or []) + [origin]
        for auth_server in candidates:
            meta = await _get_json(c, f"{auth_server.rstrip('/')}/.well-known/oauth-authorization-server")
            if meta and meta.get("authorization_endpoint") and meta.get("token_endpoint"):
                meta["scopes"] = prm.get("scopes_supported") or meta.get("scopes_supported") or []
                return meta
    raise RuntimeError(f"{PROVIDERS[provider]['name']}'s MCP server did not publish OAuth metadata")


async def registration(s: Session, provider: str) -> db.AppRegistration:
    """Our client_id at the provider; created on first use, re-created when our public address changed."""
    reg = s.exec(select(db.AppRegistration).where(db.AppRegistration.provider == provider)).first()
    if reg and reg.redirect_uri == redirect_uri(provider):
        return reg
    meta = await discover(provider)
    if not meta.get("registration_endpoint"):
        raise RuntimeError(f"{PROVIDERS[provider]['name']} does not allow automatic app registration")
    body = {"client_name": CLIENT_NAME, "redirect_uris": [redirect_uri(provider)], "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"], "token_endpoint_auth_method": "none"}
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(meta["registration_endpoint"], json=body, headers={"Accept": "application/json"})
        r.raise_for_status()
        d = r.json()
    reg = reg or db.AppRegistration(provider=provider)
    reg.client_id, reg.redirect_uri = d["client_id"], redirect_uri(provider)
    reg.client_secret_enc = encrypt(d.get("client_secret") or "")
    reg.metadata_json = json.dumps(meta)
    s.add(reg)
    s.commit()
    s.refresh(reg)
    return reg


# ---- authorize + callback ----
def _pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


async def authorize_url(s: Session, project_id: int, provider: str) -> str:
    reg = await registration(s, provider)
    meta = json.loads(reg.metadata_json)
    verifier, challenge = _pkce()
    state = secrets.token_urlsafe(16)
    _pending[state] = {"project_id": project_id, "provider": provider, "verifier": verifier, "expiry": time.time() + 600}
    q = {"response_type": "code", "client_id": reg.client_id, "redirect_uri": reg.redirect_uri, "state": state,
         "code_challenge": challenge, "code_challenge_method": "S256", "resource": PROVIDERS[provider]["mcp_url"]}
    if meta.get("scopes"):
        q["scope"] = " ".join(meta["scopes"])
    return meta["authorization_endpoint"] + "?" + urlencode(q)


def consume_state(state: str) -> dict | None:
    p = _pending.pop(state, None)
    return p if p and p["expiry"] > time.time() else None


async def _token_request(reg: db.AppRegistration, data: dict) -> dict:
    meta = json.loads(reg.metadata_json)
    data = {**data, "client_id": reg.client_id, "resource": PROVIDERS[reg.provider]["mcp_url"]}
    if secret := decrypt(reg.client_secret_enc):
        data["client_secret"] = secret
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(meta["token_endpoint"], data=data, headers={"Accept": "application/json"})
        r.raise_for_status()
        d = r.json()
    return {"access_token": d["access_token"], "refresh_token": d.get("refresh_token"),
            "expires_at": time.time() + int(d.get("expires_in") or 3600), "scope": d.get("scope", "")}


async def finish(s: Session, pending: dict, code: str) -> None:
    """Exchange the code and store the tokens on the project."""
    provider, pid = pending["provider"], pending["project_id"]
    reg = await registration(s, provider)
    tokens = await _token_request(reg, {"grant_type": "authorization_code", "code": code, "redirect_uri": reg.redirect_uri,
                                        "code_verifier": pending["verifier"]})
    i = s.exec(select(db.Integration).where(db.Integration.project_id == pid, db.Integration.kind == provider)).first()
    if not i:
        i = db.Integration(project_id=pid, kind=provider)
    i.config_json = json.dumps({"auth": "oauth", "via": PROVIDERS[provider]["mcp_url"]})
    i.secret_enc = encrypt(json.dumps(tokens))
    s.add(i)
    s.commit()


def _run(coro):
    import asyncio
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(1) as ex:
        return ex.submit(asyncio.run, coro).result()


def token_for_project(s: Session, project_id: int, provider: str) -> str | None:
    """A valid access token for the project's connection, refreshed when about to expire; None if not connected."""
    i = s.exec(select(db.Integration).where(db.Integration.project_id == project_id, db.Integration.kind == provider)).first()
    if not i or not i.secret_enc:
        return None
    try:
        tokens = json.loads(decrypt(i.secret_enc))
    except json.JSONDecodeError:
        return None
    if not isinstance(tokens, dict) or "access_token" not in tokens:
        return None
    if tokens.get("refresh_token") and tokens.get("expires_at", 0) < time.time() + 60:
        reg = s.exec(select(db.AppRegistration).where(db.AppRegistration.provider == provider)).first()
        if reg:
            fresh = _run(_token_request(reg, {"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]}))
            tokens = {**tokens, **fresh, "refresh_token": fresh.get("refresh_token") or tokens["refresh_token"]}
            i.secret_enc = encrypt(json.dumps(tokens))
            s.add(i)
            s.commit()
    return tokens["access_token"]


# ---- using the provider's MCP tools ----
async def _session(provider: str, token: str):
    from contextlib import asynccontextmanager
    from mcp.client.session import ClientSession
    cfg = PROVIDERS[provider]
    headers = {"Authorization": f"Bearer {token}"}

    @asynccontextmanager
    async def open_session():
        if cfg["transport"] == "sse":
            from mcp.client.sse import sse_client
            async with sse_client(cfg["mcp_url"], headers=headers, timeout=30, sse_read_timeout=120) as (read, write):
                async with ClientSession(read, write) as sess:
                    await sess.initialize()
                    yield sess
        else:
            from mcp.client.streamable_http import streamable_http_client
            async with httpx.AsyncClient(headers=headers, timeout=httpx.Timeout(60, read=120)) as hc:
                async with streamable_http_client(cfg["mcp_url"], http_client=hc) as streams:
                    async with ClientSession(streams[0], streams[1]) as sess:
                        await sess.initialize()
                        yield sess
    return open_session()


def _content_text(result) -> str:
    parts = []
    for c in getattr(result, "content", []) or []:
        if getattr(c, "type", "") == "text":
            parts.append(c.text)
    return "\n".join(parts)


async def call_tool(provider: str, token: str, candidates: list[str], args: dict) -> str:
    """Call the first tool the provider offers from `candidates`, passing only the arguments its schema names.
    Argument names are matched case-insensitively and ignoring underscores (fileKey == file_key)."""
    def norm(k: str) -> str:
        return k.replace("_", "").lower()
    async with await _session(provider, token) as sess:
        tools = {t.name: t for t in (await sess.list_tools()).tools}
        name = next((n for n in candidates if n in tools), None)
        if not name:
            raise RuntimeError(f"{PROVIDERS[provider]['name']} MCP offers none of {candidates}; available: {sorted(tools)}")
        props = ((tools[name].inputSchema or {}).get("properties") or {})
        wanted = {norm(k): k for k in props}
        call_args = {wanted[norm(k)]: v for k, v in args.items() if norm(k) in wanted} if props else args
        result = await sess.call_tool(name, call_args)
        text = _content_text(result)
        if getattr(result, "isError", False):
            raise RuntimeError(text or f"{name} failed")
        return text


def call(provider: str, token: str, candidates: list[str], args: dict) -> str:
    return _run(call_tool(provider, token, candidates, args))
