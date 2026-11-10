# Using the Agents Dashboard from Codex

Codex connects to the same MCP server as Claude Code. Nothing else to install.

## Connect (per project)

Copy the Codex command from the project page in the dashboard. Its URL carries the project id and
a secret key:

```
codex mcp add agents-dashboard --url "http://localhost:8000/mcp?project=<id>&key=<key>"
```

The **One command** or **Config file** options instead save a project-local `.codex/config.toml`.
That config includes Figma and an instruction to verify its access on the first message in each new
session. Open and trust the same project folder in Codex so it loads the config. After signing in to
Figma once, use Codex normally: the agent checks Figma with a read-only call and reports the result
to the dashboard without starting a run. The manual verification prompt is optional.

The dashboard connection itself is detected when Codex initializes its MCP server. Figma verification
is an agent action on the first message, not a background check merely from opening an empty chat.

## Use

Inside the project folder, ask for anything in plain words, for example `implement ABC-123 and
review it`. On the first request Codex writes AGENTS.md for the project (and adds the dashboard's
routing note to it), then does the work. Codex has no subagents, so it plays each role (planner,
implementer, tester, reviewer, summarizer) in turn using the role prompts the dashboard returns.
Token usage is whatever Codex reports in `finish_run` (approximate).
