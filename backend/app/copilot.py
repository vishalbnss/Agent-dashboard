"""Copilot host adaptation. Shared Claude/Codex agent files are never rewritten."""
import json

from app.connection_instructions import session_connection_check


HOST_RULES = """## GitHub Copilot execution rules

You are running in GitHub Copilot (VS Code or Copilot CLI). Use client="copilot" in dashboard reports.
Use the selected Copilot model; inherit it for specialists unless the host exposes an explicitly selected model.
Record requested and observed models separately. Never assume a Claude/Codex model identifier is available here.
If capability is insufficient, stop and ask the user to select an available stronger model; do not pretend to escalate.

Delegate each stage to a fresh isolated subagent using the host's available tool: `task` in the Copilot
harness/CLI, or `agent/runSubagent` in VS Code Local. Discover the actual schema; do not copy arguments
from Claude's Agent tool or Codex's spawn_agent. If isolated delegation is unavailable, stop and explain
that agent mode/subagent tools must be enabled. Do not silently implement and independently test in one context.
Pass only the stage instructions, run_id, stage-specific artifact paths and allowed authorization facts.
Stage agents never call start_run: use the supplied run_id. Client-specific routing in existing AGENTS.md
or CLAUDE.md applies to its named client, not to this Copilot coordinator.

Fetch stages with get_stage(name, run_id=run_id), so another connected client cannot change this run's edition.
For retry/follow-up, reuse the worker if the host supports it. VS Code Local calls are stateless: otherwise
launch a fresh same-role worker with the frozen contract, checkpoint and failure evidence. Keep all existing
approval gates, independent-test boundaries, retry limits and external-write authorization requirements.

Collect only usage exposed by this Copilot session or its worker results. Report model, token counts and
ai_credits when available; leave unavailable fields absent. Never read Codex session logs or treat Claude
API prices as Copilot billing. Do not derive cost from elapsed time or tokens using another provider's rates.
Missing usage does not prevent a truthful completion report. Do not report test success without test evidence.
"""


def variant(text: str) -> str:
    text = text.replace("The root Claude Code session is the coordinator.", "The root GitHub Copilot session is the coordinator.")
    start = text.find("## Agent routing\n")
    end = text.find("## Design approval gate", start)
    if start >= 0 and end > start:
        text = text[:start] + text[end:]
    start = text.find("## API-equivalent planning estimate\n")
    end = text.find("## Manifest Update", start)
    if start >= 0 and end > start:
        text = (text[:start] + "## Copilot usage\n\n"
                "Record GitHub AI credits and model/token usage only when this host exposes them. "
                "Keep credits separate from dollars. Dollar cost requires applicable GitHub billing evidence; "
                "do not calculate Copilot cost with public model API prices.\n\n" + text[end:])
    text = text.replace("(Agent tool)", "(the Copilot host's isolated subagent tool)")
    text = text.replace('client="claude"', 'client="copilot"')
    text = text.replace(' (use `client="codex"` in Codex)', '')
    text = text.replace('get_stage(name)', 'get_stage(name, run_id=run_id)')
    text = text.replace('the `figma` MCP server', 'the available Figma MCP server')
    text = text.replace('`/mcp` → figma → Authenticate for Figma', 'the Copilot/VS Code Figma MCP sign-in action')
    text = text.replace('use current official Anthropic per-token rates for the effective models (record the rate source and date)',
                        'use a Copilot billing source only if it supplies an applicable rate and coverage; otherwise leave cost unavailable')
    text = text.replace('the dashboard computes a clearly labelled estimate from the tokens',
                        'Copilot costs are not inferred from generic model API prices')
    text = text.replace('No telemetry extraction script is available on Claude Code;', 'For GitHub Copilot,')
    return HOST_RULES + "\n" + text


def agent_profile(project_id: int, project_name: str) -> str:
    return f'''---
name: Agents Dashboard
description: Deliver project tickets through approved stages, independent tests and review.
---

# Agents Dashboard — GitHub Copilot

Use MCP server `agents-dashboard-{project_id}` for project {json.dumps(project_name)}, ID {project_id}.
Before work, call its get_connection_status tool and verify the returned project ID is {project_id}.
If that server is missing or the project differs, stop and restore the connection from this project's dashboard.

{session_connection_check("copilot")}

For a connection check, report the connection only: do not start a run or change project files.
For implementation, fixes or review, call start_run with the user's full request as goal, a concise title,
client="copilot", the repository URL if present, and the current project folder. Follow its plan and
get_stage(name, run_id=run_id) prompts. Do not replace the workflow with a direct code edit.
When the user asks to resume a known run, continue that run rather than creating a duplicate.

{HOST_RULES}
'''
