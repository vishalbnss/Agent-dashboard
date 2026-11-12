# Agents Dashboard

Turn a ticket plus a Figma design into reviewed code, using the developer's own Claude Code, Codex or GitHub Copilot.
The dashboard is an **MCP server** the AI connects to, plus a web UI for setup and run history.
Nothing from the dashboard is installed on the developer's machine, so the same server can run on a
laptop for testing or on a company server for a team.

```
Claude Code / Codex (in the developer's repo)  --MCP (project id + key)-->  FastAPI + SQLite/Postgres  <--REST--  React dashboard
```

## How it works

1. **Add project** in the dashboard: a name, and optionally the GitHub URL (only needed for pull requests).
2. **Connect**: the project's Connections tab shows **one setup command** for all three AIs, e.g.
   `iwr -useb "http://localhost:8000/api/projects/3/setup?key=...&shell=ps" | iex` (or `curl ... | sh`).
   Run it once in the project folder. It writes `.mcp.json` (Claude Code), `.codex/config.toml` (Codex),
   `.vscode/mcp.json` and `.github/agents/agents-dashboard.agent.md` (Copilot), merging into files that
   already exist, and adds the files that hold the key to `.gitignore`. Then open a new chat in the AI.
   For a single AI, click its box instead. It shows one command, e.g.
   `claude mcp add --scope project --transport http agents-dashboard "http://localhost:8000/mcp?project=3&key=..."`.
   Run it once in the project folder. The URL carries the project id and a secret key; the server
   rejects any other request. The AI approves the server on its next start, and the box turns green.
3. **First request**: in the AI, say `implement ABC-123 and review it`. The AI calls `start_run` and
   receives the coordinator instructions of the nine-stage Jira-to-PR workflow (from the agent-workflows
   repo, served by the dashboard; each stage prompt comes from `get_stage`), and, the first time, the
   onboarding instructions. It reads the project, writes `AGENTS.md` (plus a routing note in
   `CLAUDE.md` so future sessions route automatically), saves it to the dashboard with
   `save_agents_md`, then does the work.
4. **Nine stages** run one at a time in fresh stage agents with the model the workflow routes
   (Haiku / Sonnet / Opus, or Luna / Terra / Sol on Codex): branch preflight, Jira intake, Figma intake,
   dependency/design synthesis, implementation, independent tests, review and security, documentation,
   pull request, on a `feature/<ticket>` branch with evidence under `.agent-runs/<ticket>/`. Before any
   stage the agent reads the ticket, the design and the code, submits a **design document** (approach,
   scope, files, test plan, risks) and waits until a product owner or FDE approves it. Waiting documents
   show in the project's **Approvals** tab; the review page highlights what changed since the last
   version, shows the ticket and Figma link beside it, and lets the reviewer leave notes on single
   sections. "Request changes" sends the notes and comment back and the agent revises, up to three rounds. Two
   remediation attempts per failing criterion and one review follow-up, then it stops. Each stage is
   reported with `log_phase`; the documentation stage's summary and provenance-safe telemetry go to
   `finish_run`. Pushing and opening the PR always waits for the developer's go-ahead.
5. **Jira** is connected on the project page with one click: the dashboard signs in to Atlassian's MCP
   server (mcp.atlassian.com) with OAuth, registering itself automatically, so nobody copies app ids or
   tokens anywhere. The agents read tickets with `get_ticket`, which calls that MCP server on the
   project's behalf. Without Jira, open the project's **Tickets** tab and choose **Add ticket**.
   Enter an ID such as `FIN-2`, a title, and details containing requirements, acceptance criteria, and
   Figma links. Save, then ask your connected AI to `Implement FIN-2 and review it` (or use **Copy request**).
   Saved manual tickets are read before Jira, and saving a ticket does not start a run. The AI submits
   its design document to **Approvals** before implementation. Ticket text can also be pasted into chat.
6. **Figma** is connected by the developer's AI itself: the project config we hand out also lists Figma's
   MCP server (Figma only lets approved AI tools such as Claude Code sign in). In Claude Code: `/mcp`,
   pick figma, Authenticate, once. `get_figma_design` gives the agents the file and node ids to read.
   The Figma connection card shows the latest verified access for each coding client. The MCP server
   instructs the agent to check Figma on the first user message of each new session and after sign-in,
   then report the result through `report_connection`, without creating a run. Downloaded Codex configs
   also include this instruction, and onboarding preserves it in the project guide. No special prompt
   is needed for normal use; the Figma card's **Manual recheck** is an optional troubleshooting fallback.
   The setup command also installs session-start hooks for Claude Code (`.claude/settings.json`), Codex
   (`.codex/hooks.json`) and Copilot CLI (`.github/hooks/agents-dashboard.json`). Each runs the shared
   `.agents-dashboard/figma-check.mjs` in the background when a session starts: it reads `claude mcp list`,
   `codex mcp list --json` or `copilot mcp list` and reports Figma's sign-in status to `/api/projects/{id}/figma-check`,
   so the card is current before the first message, with no model call. Copilot's list output is undocumented, so
   that check reports only when it can clearly read the Figma line. The in-session check still confirms with a real
   Figma read. Codex may ask you to trust the project's hooks once.
   A new empty chat does not run an agent check until the first message. Codex must trust the project
   folder to load its local config; initial Figma OAuth sign-in or renewed authorization still requires the user.
   The card refreshes automatically and shows when the check happened. A configured server or
   completed browser sign-in alone is not verification, and later revocation appears after the next check.

7. **Logs**: the project's **Logs** tab records every MCP tool call the AI makes (with its arguments, result,
   duration and run) and every dashboard action (approvals, key rotation, Jira sign-in, tickets, setup
   downloads, AI connections), newest first, with search and level/run filters. Approval polling is logged at
   debug level and hidden unless "Everything" is selected. The agents' own LLM calls run inside the coding client,
   so they are not visible to the dashboard; their per-agent model, tokens and time come from `log_phase`.

## GitHub Copilot

Open **Project → Connections → GitHub Copilot** for the setup guide. Use GitHub Copilot in VS Code or
GitHub Copilot CLI. The ordinary Microsoft Copilot Windows chat app does not use this integration.

1. Open the target project folder in VS Code. Install **GitHub Copilot Chat** by GitHub if missing, then
   sign in with your GitHub account. You need Copilot access and permission to use MCP and custom agents.
2. Run **MCP: Add Server** from the command palette, choose **HTTP**, and paste the project's Copilot URL.
   Use the generated `agents-dashboard-<project-id>` server name and save to your user configuration.
   Start/trust the server when prompted. The URL is a credential; keep it out of committed files.
3. Download the agent from the same dialog and save it as `.github/agents/agents-dashboard.agent.md`
   in the target project. It contains instructions and project identity, not the connection key.
4. Start a new Copilot chat and select **Agents Dashboard** in the agent picker (Copilot or Local host).
   Send the connection-check message in the dialog. This performs a read-only check and creates no run.
5. Copy a request from the **Tickets** tab into that chat. Review the submitted design in **Approvals**.

For terminal use, the dialog supplies the install command and `copilot mcp add --transport http` command.
Open Copilot in the target folder, sign in, select the downloaded profile with `/agent`, and allow the MCP tools.
The **Figma connection** instructions in the dialog add Figma separately; its status changes only after a
successful Figma tool call reported by that client.

Copilot uses the same stage contracts, independent tests, review, retry limits and human approval gates.
The host adapter uses Copilot's selected model and available subagent mechanism. It preserves the existing
Claude/Codex agent files. If isolated subagents are unavailable, the workflow stops and explains the requirement.
Tokens and GitHub AI credits appear when reported by the host. Dollar cost requires applicable billing
evidence; the dashboard does not turn another provider's API prices into Copilot charges.

The card records the latest authenticated MCP contact, not a persistent online heartbeat. Merely installing
Copilot or downloading a config does not mark it connected. Keep the dashboard backend running. If needed,
use **MCP: List Servers** in VS Code to inspect the server output and ensure its tools are enabled in the chat.

Official setup references: [VS Code Copilot](https://code.visualstudio.com/docs/setup/copilot/),
[VS Code MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers), and
[Copilot CLI MCP servers](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers).

## Run locally

Backend (Python 3.11+):

```
cd backend
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt      # Windows
.venv\Scripts\python -m uvicorn app.main:app --port 8000
```

Do not use `--reload` on Windows: the reloader leaves the old process holding the port.

Frontend (Node 20+):

```
cd frontend
npm install
npm run dev            # http://localhost:5173 (or the next free port); proxies /api to :8000
```

Tests: `cd backend && .venv\Scripts\python -m pytest`.

Configuration (`backend/.env`, all optional):

| Variable | Purpose |
|---|---|
| `APP_SECRET` | Encrypts stored tokens; any stable string (generated into `.env` on first local run) |
| `DATABASE_URL` | SQLite by default (`backend/data/app.db`); a Postgres URL (`postgres://...` works) for a shared server |
| `PUBLIC_BASE_URL` | Public address of the backend, used in connect commands and as the OAuth callback for Figma and Jira; on Render, `RENDER_EXTERNAL_URL` is used when this is unset |
| `DASHBOARD_PASSWORD` | When set, the dashboard UI and REST API ask for this password (browser sign-in, any user name). MCP, setup downloads and OAuth callbacks stay key-protected instead |

## Host it

One process serves the dashboard UI, `/api` and `/mcp` on one address, so every developer's AI and
browser use the same URL and nothing needs CORS.

```
cd frontend && npm ci && npm run build          # backend serves frontend/dist when it exists
cd backend
# .env: PUBLIC_BASE_URL=https://dashboard.yourcompany.com, APP_SECRET=..., DATABASE_URL=postgresql+psycopg://...
.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*'
```

Put it behind HTTPS (nginx, Caddy or a cloud load balancer): the project key travels in the URL.
`PUBLIC_BASE_URL` is what the setup command, config files and the Jira/Figma OAuth callbacks contain.
Set `DASHBOARD_PASSWORD` on any server reachable from the internet: without it anyone with the URL can open
projects and copy their connection keys.

### Render

The repo carries a `Dockerfile` (builds the UI, runs the backend on `$PORT`) and a `render.yaml` Blueprint.
Push the repo to GitHub, then in Render choose **New → Blueprint**, pick the repo, and enter a
`DASHBOARD_PASSWORD` when asked. It creates the web service and a free Postgres database and generates
`APP_SECRET`. Open `https://<service>.onrender.com`, sign in, and use the setup command from a project.

Free-plan limits: the service sleeps after about 15 minutes idle and takes up to a minute to wake, so the first
AI connection after a pause can time out once (retry it); Render's free Postgres expires after 30 days.
Jira must be connected again on the hosted dashboard, because its sign-in returns to the hosted URL.

## Layout

```
backend/app/main.py           FastAPI app; REST + authenticated MCP endpoint
backend/app/connect.py        validates ?project=&key= on every MCP request, marks connections
backend/app/db.py             SQLModel models (Project with key, Integration, Ticket, Run, RunPhase)
backend/app/api/routes.py     REST for the dashboard, Figma OAuth
backend/app/mcp/tools.py      MCP tools and prompts (project identified from the connection)
backend/app/onboarding.py     prompt material served to the AI: coordinator, stage prompts (Claude/Codex editions), onboarding, routing note
backend/app/agents/           coordinator.md, stages/01..09, onboard.md, codex helpers (from github.com/vishalbnss/Agent-work-flow-claude)
backend/app/integrations/     Figma (REST + OAuth), GitHub, Jira clients
frontend/src/App.tsx          dashboard pages; the project page shows one connection box per service (Claude Code, Codex, Figma, GitHub)
clients/claude-code-plugin/   optional Stop hook that reports exact token usage
clients/codex/README.md       Codex notes
```

## Not in v1

User accounts and per-user keys on the dashboard, Jira sync (client exists, untested), Bitbucket/GitLab.
