"""Prompt material served to the developer's AI through the MCP.

Nothing here writes to the developer's machine. The AI receives the coordinator prompt, fetches the nine
stage prompts with `get_stage`, plus the onboarding instructions and the routing note, and does the work
itself in its own folder. That is what lets the dashboard run on a remote server.
"""
from pathlib import Path

from app.connection_instructions import session_connection_check
from app import copilot

AGENTS_DIR = Path(__file__).resolve().parent / "agents"
ONBOARD_STAGES = ["starting", "reading", "preparing", "writing", "done"]

# The nine-stage Jira-to-PR workflow (agent-workflows), served verbatim apart from the dashboard rewiring.
STAGES = [  # (name, model, reasoning)
    ("branch-preflight", "haiku", "low"),
    ("jira-intake", "sonnet", "medium"),
    ("figma-intake", "opus", "high"),
    ("dependency-merge", "opus", "high"),
    ("implementation", "opus", "high"),
    ("independent-test", "sonnet", "high"),
    ("code-review-security", "sonnet", "high"),
    ("documentation", "haiku", "low"),
    ("pr-creation", "sonnet", "medium"),
]
CODEX_MODELS = {"haiku": "gpt-5.6-luna", "sonnet": "gpt-5.6-terra", "opus": "gpt-5.6-sol"}
EXTRAS = {"extract-codex-telemetry": "codex/extract-codex-telemetry.mjs", "planning-rates": "codex/planning-rates.md"}
ONBOARD_PHASES = {"onboard-reading": "reading", "onboard-preparing": "preparing", "onboard-writing": "writing"}

ROUTING_MARK = "<!-- agents-dashboard:routing -->"


def routing_block(ai: str, project_name: str) -> str:
    """Appended to CLAUDE.md (or AGENTS.md for Codex) during onboarding: the agent-workflows snippet, rewired to the dashboard."""
    if ai == "copilot":
        return (f"{ROUTING_MARK}\n## Agents Dashboard — GitHub Copilot\n"
                + session_connection_check("copilot") + "\n"
                + 'For ticket implementation, call start_run(client="copilot", goal=the full request, title=a short title, path=the project folder). '
                + 'Follow its plan, fetch each stage with get_stage(name, run_id=run_id), and keep human approvals.\n'
                + copilot.HOST_RULES)
    client = ai if ai in ("claude", "codex") else "claude"
    session = "Claude Code" if client == "claude" else "Codex"
    models = ("Only Haiku, Sonnet, and Opus are permitted, with Opus as the ceiling." if client == "claude"
              else "Only Luna, Terra, and Sol are permitted, with Sol as the ceiling; never use Astra.")
    fresh = "fresh routed stage subagents" if client == "claude" else "fresh routed stage agents"
    return f"""
{ROUTING_MARK}
## Jira-to-PR Agent Workflow (Agents Dashboard)

{session_connection_check(client)}

This project ({project_name}) is managed by the Agents Dashboard. For any request to implement, build, fix or review a ticket, feature or design (for example "implement FIN-1"), call the `agents-dashboard` MCP tool `start_run(goal, title, client="{client}", repo_url, path)` FIRST with the request verbatim as `goal`, a short `title` for the dashboard (max 90 characters, e.g. "DEMO-1: KPI cards on the home page"), the output of `git remote get-url origin` (empty if none) and this folder's absolute path, without being asked to use any tool by name. It returns the coordinator instructions for the nine sequential stages; each stage prompt comes from `get_stage(name)`. The root {session} session is the coordinator: it launches {fresh}, validates file-based handoffs and gates, and routes failures without duplicating specialist work. {models} Stage 01 branch preflight must verify Jira/Figma access and create or verify an isolated delivery branch before Jira intake or ticket edits, and must stop on pre-existing work. Independent tickets use separate pipelines; dependent tickets that must ship atomically are fully ingested and synthesized in Stage 04 before one combined implementation. Stage 06 tests run as a fresh agent with no implementation/design context and derive tests only from `04-merge/functional-contract.md`. Test failures return to Stage 05, then the same tester reruns its frozen scope and complete final gates. Stage 07 permits exactly one follow-up review after remediation. Stage 08 documents the complete evidence trail and provenance-safe model, reasoning, token, and cost data without presenting planning estimates as actual billing; the coordinator reports each stage with `log_phase` and the result with `finish_run`. Do not update Jira or create external GitHub state without explicit authorization.
"""


def _codex_variant(text: str) -> str:
    """The Codex edition of a Claude Code prompt (same edits the agent-workflows repo makes in its codex/ folder)."""
    reps = [
        ("The root Claude Code session is the coordinator.", "The root Codex session is the coordinator."),
        ("as a fresh subagent (Agent tool) that receives no parent transcript, only its stage prompt", 'with `fork_turns: "none"`, only its stage prompt'),
        ("Haiku → Sonnet → Opus is the only escalation ladder; Opus is the ceiling.", "Luna → Terra → Sol is the only escalation ladder; Sol is the ceiling and Astra is prohibited."),
        ("Do not downgrade Stages 03–05 below Opus. Tests/review may retry with Opus. Stop if Opus cannot complete its assigned stage.",
         "Do not downgrade Stages 03–05 below Sol. Tests/review may retry with Sol. Stop if Sol cannot complete its assigned stage."),
        ("Initial stage agents are fresh subagents with no parent transcript.", 'Initial stage agents use `fork_turns: "none"`.'),
        ("as a fresh subagent with no parent transcript", 'with `fork_turns: "none"`'),
        ("`/mcp` → figma → Authenticate for Figma", "`codex mcp login figma` for Figma"),
        ("When telemetry is incomplete, record only what the harness exposes and mark the rest unavailable; never copy conversation content.",
         "When telemetry is incomplete but coordinator-recorded thread IDs exist, perform a targeted recovery with the `extract-codex-telemetry.mjs` script (fetch it with `get_stage(\"extract-codex-telemetry\")` and save it under `.agent-runs/<DELIVERY-ID>/scripts/`); read only the sanitized output and never copy conversation content from rollout logs."),
        ("distinct from the effective model/reasoning measured by the harness.", "distinct from the effective model/reasoning measured in the host rollout's `turn_context`."),
        ("When cumulative per-thread usage records are available, use the final value once per thread.", "For Codex rollout records, use the final cumulative `thread_token_usage` once per thread."),
        ("use current official Anthropic per-token rates for the effective models (record the rate source and date)", "read the planning rates (fetch them with `get_stage(\"planning-rates\")`)"),
        ("No telemetry extraction script is available on Claude Code; record what the harness exposes and mark other fields unavailable.",
         "Use the `extract-codex-telemetry.mjs` script (see the documentation stage) for targeted per-thread lookups."),
        ("Claude Code", "Codex"),
    ]
    for old, new in reps:
        text = text.replace(old, new)
    for claude_model, codex_model in CODEX_MODELS.items():
        text = text.replace(f"`{claude_model}`", f"`{codex_model}`")
    return text


def coordinator(ai: str) -> str:
    text = (AGENTS_DIR / "coordinator.md").read_text(encoding="utf-8")
    if ai == "copilot":
        return copilot.variant(text)
    return _codex_variant(text) if ai == "codex" else text


def stage_names() -> list[str]:
    return [n for n, _, _ in STAGES]


def stage_prompt(name: str, ai: str) -> str | None:
    """The prompt for one stage (or a Codex helper file), in the edition matching the AI. None if unknown."""
    for i, (n, _, _) in enumerate(STAGES, 1):
        if n == name:
            text = (AGENTS_DIR / "stages" / f"{i:02d}-{n}.md").read_text(encoding="utf-8")
            if ai == "copilot":
                return copilot.variant(text)
            return _codex_variant(text) if ai == "codex" else text
    if name in EXTRAS:
        if ai == "copilot":
            return None  # Codex telemetry and pricing helpers do not apply to Copilot.
        return (AGENTS_DIR / EXTRAS[name]).read_text(encoding="utf-8")
    return None


def stage_table(ai: str) -> list[dict]:
    """What start_run announces: the stages, their model route, and how to fetch each prompt."""
    return [{"stage": n, "order": i, "model": "selected Copilot model" if ai == "copilot" else CODEX_MODELS[m] if ai == "codex" else m,
             "reasoning": "host setting" if ai == "copilot" else r,
             "prompt": f'get_stage("{n}", run_id=run_id)' if ai == "copilot" else f'get_stage("{n}")'}
            for i, (n, m, r) in enumerate(STAGES, 1)]


def onboarding_block(ai: str, project_name: str) -> str:
    """Prepended to the plan when the project has no AGENTS.md yet. The AI writes it, then continues."""
    onboard = (AGENTS_DIR / "onboard.md").read_text(encoding="utf-8")
    if ai == "copilot":
        return ("# First: read the project guide\n\n"
                "If AGENTS.md exists, read it and save_agents_md with its contents without editing it. "
                "Otherwise inspect README, manifests, source layout and test commands, write a concise AGENTS.md, "
                "then save_agents_md. Report onboard-reading, onboard-preparing and onboard-writing as appropriate. "
                "Preserve existing agent instructions, CLAUDE.md and .codex configuration. Copilot routing lives "
                "in .github/agents/agents-dashboard.agent.md. Then continue the approved workflow below.\n\n---\n")
    routing = routing_block(ai, project_name).strip()
    return f"""# First: onboard this project (no AGENTS.md yet)

Before the request below, do the onboarding once. Report progress so the dashboard can show it:
call `log_phase(run_id, "onboard-reading", "running")` when you start reading the repo,
`log_phase(run_id, "onboard-preparing", "running")` when you start drafting, and
`log_phase(run_id, "onboard-writing", "running")` when you write the files.
Report each phase with status `done` when it finishes, or `failed` if blocked, before starting the next phase.

{onboard}

Also add this block to the end of `{ "CLAUDE.md" if ai != "codex" else "AGENTS.md" }` verbatim (create the
file if missing), so every future session routes work through the dashboard automatically:

{routing}

When AGENTS.md is written, call `save_agents_md(content)` with its full text, then continue with the
request below using that AGENTS.md.

---
"""
