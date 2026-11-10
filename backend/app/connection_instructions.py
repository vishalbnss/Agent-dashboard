"""Session guidance shared by MCP initialization and project configuration."""


def session_connection_check(client: str = "") -> str:
    reporter = f'client="{client}"' if client in ("claude", "codex", "copilot") else 'client="codex", "claude", or "copilot" (your coding client)'
    return (
        "On the first user message in each new session, automatically check Figma with one read-only identity "
        "or supplied-design metadata call. Report the result through agents-dashboard "
        f"report_connection(kind=\"figma\", connected=..., {reporter}, detail=...). "
        "Do not wait for a special prompt. Only a successful Figma read means connected; report missing tools "
        "or failures without secrets. This check needs no run or file edits. Call start_run before implementation. "
        "Use the Figma MCP tools registered in this session, discovering them if needed. "
        "Prefer an identity tool such as whoami when available; otherwise use a design URL supplied by the user. "
        "If neither check is possible, report false with the reason; never invent a design URL or infer access "
        "from configuration, installed tools, or a previous session's report. "
        "Use this project's agents-dashboard connection. If it is unavailable, explain that the dashboard "
        "connection must be restored; do not claim to have reported the result. "
        "Do not inspect credential stores or bypass the client's tool approval settings. "
        "Continue the user's request after this check; a Figma problem must not block unrelated work. "
        "Do this once per session, not on every message. Check again after the user completes Figma sign-in, "
        "when they request a recheck, or when a later Figma call changes the observed access status."
    )
