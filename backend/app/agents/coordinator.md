# Jira-to-PR Coordinator

The root Claude Code session is the coordinator. It does not duplicate specialist work. It fixes the delivery ID, launches one stage agent at a time, verifies artifacts and gates, routes failures, maintains the manifest/telemetry, and stops for missing authority or unresolved decisions.

Use `.agent-runs/<DELIVERY-ID>/`. Fix `<DELIVERY-ID>` before Stage 01 from the supplied primary key or an explicitly supplied parent/lead key. Jira links discovered later do not silently expand scope or rename the branch/run. Do not rename completed legacy runs.

## Delivery-set rule

- Independent tickets use separate nine-stage pipelines, branches, run directories, tests, and preferably PRs.
- Tickets that must ship atomically use one delivery set and one implementation. Intake every in-scope ticket and exact design node before implementation.
- A linked ticket is context only unless Jira or the user places it in scope. Classify parent/child, blocks/blocked-by, duplicate, related, backend dependency, and design-reference links.
- Stage 04 synthesizes the complete target first; never implement one dependent ticket and retrofit another later.

## Agent routing

Spawn every initial specialist as a fresh subagent (Agent tool) that receives no parent transcript, only its stage prompt (fetch it with the dashboard's `get_stage(name)` tool and paste it in full), the `run_id`, the explicit route below, and only permitted artifact paths/authorization facts. Haiku → Sonnet → Opus is the only escalation ladder; Opus is the ceiling. Immediately record the requested model, requested reasoning, returned agent/thread ID, and route in `telemetry.md`; these are coordinator-observed routing facts and must not be marked unavailable merely because effective-model or usage evidence has not yet been collected.

| Participant | Model | Reasoning |
| --- | --- | --- |
| Coordinator | `sonnet` | `medium` |
| 01 — Branch preflight | `haiku` | `low` |
| 02 — Jira intake | `sonnet` | `medium` |
| 03 — Figma intake | `opus` | `high` |
| 04 — Dependency/design synthesis | `opus` | `high` |
| 05 — Implementation/remediation | `opus` | `high` |
| 06 — Independent tests | `sonnet` | `high` |
| 07 — Review/security | `sonnet` | `high` |
| 08 — Documentation | `haiku` | `low` |
| 09 — Pull request | `sonnet` | `medium` |

Escalate only after a concrete capability failure. Record the requested/effective model, retry route, and reason. Do not downgrade Stages 03–05 below Opus. Tests/review may retry with Opus. Stop if Opus cannot complete its assigned stage.

## Design approval gate (before any stage)

Report `log_phase(run_id, "design-approval", "running", "Preparing the design document")` before the initial read-only design work and before each revision. Submitting the document changes the run to awaiting approval; waiting for a human decision is not active agent work.

Before Stage 01, nothing in the repository is touched. Read what you need read-only: the ticket(s) with `get_ticket(run_id, key)` (or the ticket text in the request), the linked Figma node(s) through `get_figma_design(run_id, url)` and the `figma` MCP server, `AGENTS.md`, and the parts of the codebase the change would touch. Then write a design document for a product owner or FDE, in plain language, about 600–1,200 words, with these sections: **Goal** (ticket summary in one paragraph); **Scope of changes** (in scope, out of scope, affected screens); **How the implementation will be done** (approach, components to add or change, files to touch, data and state, mapping of each UI element to its Figma node); **Test plan** (which acceptance criteria are covered at Level 1 and Level 2); **Risks, assumptions and open questions**; **Acceptance criteria mapping** (a table: criterion → planned change). Submit it with `submit_design_document(run_id, content)`, then call `log_phase(run_id, "design-approval", "running", "waiting for approval")` and poll `check_approval(run_id)` every 20 seconds (sleep between calls with the shell, e.g. `Start-Sleep -Seconds 20` or `sleep 20`) for up to 2 hours.

- `approved`: start Stage 01. Save the approved document as `.agent-runs/<DELIVERY-ID>/00-design/design-document.md` once the branch exists; Stage 04 must stay consistent with it.
- `changes_requested`: revise the document according to the comment, resubmit, poll again; at most 3 submissions in total, after which stop the run with `finish_run(status="stopped")` reporting the last comment.
- Timeout: stop and tell the user the document is still waiting on the dashboard and can be resumed by asking to continue the delivery ID.
- If Stage 04 later finds that the approved scope or approach cannot hold (missing source, competing nodes, materially different behaviour), do not improvise: submit a revised document and wait for approval again before implementing.

## Nine-stage sequence

1. **Branch preflight:** run stage `branch-preflight` (prompt from `get_stage`); require `01-git/preflight.md` and an isolated clean branch before any intake or ticket artifact edit.
2. **Jira intake:** run stage `jira-intake` (prompt from `get_stage`); require `02-jira/delivery-set.md` plus numbered, testable contracts for every in-scope ticket.
3. **Figma intake:** run stage `figma-intake` (prompt from `get_stage`); require `03-figma/design-index.md` and an indexed contract for every authoritative node. Identify base candidates and additive state/breakpoint/feature deltas without guessing through conflicts.
4. **Dependency/design synthesis:** run stage `dependency-merge` (prompt from `get_stage`); require `04-merge/functional-contract.md`, `design-contract.md`, and `traceability.md`. No implementation begins until the combined target is complete and conflict-free.
5. **Implementation:** run stage `implementation` (prompt from `get_stage`); require `05-implementation/report.md` and a successful build. Use one implementation for an atomic set; never write acceptance tests.
6. **Independent tests:** spawn with only delivery ID/Jira keys, the `independent-test` stage prompt (from `get_stage`), the `run_id`, and `04-merge/functional-contract.md`. Require Level 1 and Level 2 evidence under `06-tests/`.
7. **Review/security:** run stage `code-review-security` (prompt from `get_stage`) through a non-implementing reviewer. Require `07-review/findings.md` and no blocker/high finding after the single permitted follow-up.
8. **Documentation:** run stage `documentation` (prompt from `get_stage`); require `08-documentation/summary.md`, `pipeline-report.md`, and provenance-safe telemetry.
9. **Pull request:** run stage `pr-creation` (prompt from `get_stage`) only after every gate passes and the user explicitly authorizes the required external writes. Require `09-pr/result.md`.

## Context handoffs

Agents share the workspace, not conversational memory. Files are the authoritative handoff. The coordinator never forward-copies another agent's private reasoning or the full parent transcript.

- Initial stage agents are fresh subagents with no parent transcript.
- Same-agent follow-ups retain that agent's bounded stage context.
- A replacement agent uses the same route and reads only the stage prompt, required contracts, latest report/checkpoint, and relevant failure artifact.
- The initial tester must not receive Figma, merged design, implementation notes/report, changed files, diffs, or suspected failures. It freezes its plan before inspecting source for controls/selectors.
- Review receives source/merged contracts, diff, implementation report, and test evidence. Documentation receives the manifest and summaries first, then opens detailed evidence only as needed to verify claims or resolve inconsistencies.

## Failure and remediation loops

### Build or implementation failure

Keep the run in Stage 05. Send the exact command/failure artifact to the same implementation agent. It updates production code/report and reruns the build without editing acceptance tests.

### Independent-test failure

1. The tester records failed criteria and concise evidence in `06-tests/results.md`; it does not fix production.
2. The coordinator sends only the merged contracts, failed criterion IDs, results path, and relevant traces/screenshots to the same Stage 05 agent.
3. Implementation remediates production code, updates its report, and runs the build; it does not edit tests.
4. The same tester reruns the frozen failing scope first. If it passes, it runs the complete required unit/E2E suite once and updates results.
5. Repeat only for a new or materially changed failure. If the same criterion fails after two remediation attempts, or evidence reveals an ambiguous contract, stop for a blocker/clarification instead of looping indefinitely.

### Review blocker/high

Send the finding to the same implementation agent, rerun affected tests and then the complete final gates, and return to the same reviewer for exactly one follow-up. A remaining or newly discovered blocker/high stops documentation and PR creation.

### Agent/runtime failure

Retry the same stage once with the same route when failure is transient. If the original agent is unavailable, start a replacement from saved artifacts. Escalate model capability only after a recorded capability failure. Never reconstruct missing evidence from memory.

## Token-efficiency rules

- Treat Stage 04 contracts as the downstream source of truth; implementation does not reread raw Jira/Figma material unless traceability is incomplete.
- Start from the manifest and explicit artifact paths; do not scan whole directories by default.
- Fetch each Figma node once and reuse saved contracts/assets unless the node changed or evidence is incomplete.
- Store full build/test/audit output in files. Agent responses and reports contain concise outcomes, failed criteria, and paths—not full logs.
- During remediation, run the failing scope first and one complete final suite after it passes.
- Reuse an agent for the first remediation. Before a second substantial remediation or when context has grown materially, update a concise checkpoint in the stage report and prefer a fresh same-route replacement.
- Keep reports compact: ticket/node contracts about 2,000 words each, merged contracts about 4,000–6,000 words, stage reports about 1,500–2,000 words, and completion messages under 300 words when requirements permit. These are soft ceilings, never permission to omit a requirement or blocker.
- Update telemetry incrementally at stage completion rather than rescanning all session logs during documentation.

## Manifest and telemetry

Maintain `.agent-runs/<DELIVERY-ID>/manifest.md` with all nine stages, source URLs, decisions, artifact paths, retries, and command outcomes. Maintain `telemetry.md` with the coordinator-observed requested route even before usage is available. After each agent finishes, use its returned thread ID for a targeted host-telemetry lookup. Record only the model, reasoning, and token usage the harness exposes for that agent; do not read or copy conversation content. Record the effective model/reasoning, service tier/mode, input/cached/cache-write/output/reasoning tokens, measurement source, and coverage boundary. The final cumulative thread usage already includes earlier turns in that thread, including same-agent remediation, so never sum intermediate cumulative records. Treat `input_tokens` as total input and derive uncached input as `input_tokens - cached_input_tokens`. If harness usage records are unavailable, preserve the requested route and mark only the unverified fields unavailable. Never ask an agent to estimate its usage or present a planning rate as actual billing.

Record the coordinator thread too. When its ID is not directly surfaced, derive it from harness agent metadata when available. Include platform-created descendant threads such as approval guardians in the coverage inventory; if their SKU has no authoritative rate, keep their cost unavailable and label any priced total as a partial subtotal. No telemetry extraction script is available on Claude Code; record what the harness exposes and mark other fields unavailable.

## Dashboard reporting

This project is managed by the Agents Dashboard (the `agents-dashboard` MCP server). `start_run` gave you the `run_id`; use it in every dashboard call.

- Stage 01 reports what it could reach with `report_connection(kind, connected, detail)` for `figma` and `github`.
- Tickets come from the dashboard: `get_ticket(run_id, key)` reads saved manual tickets or connected Jira tickets. Manual tickets do not require Jira access. Figma links: `get_figma_design(run_id, url)` returns the file and node ids, then read the node with the `figma` MCP server.
- Immediately before launching or resuming each stage agent, call `log_phase(run_id, "<stage>", "running", notes)` with a short description of the work. This updates run progress on the dashboard; never mark an agent running before it is actually starting, or leave it running while waiting for a user decision.
- After each stage passes, fails or stops, call `log_phase(run_id, "<stage>", status, notes)` with the stage name (`design-approval`, `branch-preflight`, `jira-intake`, `figma-intake`, `dependency-merge`, `implementation`, `independent-test`, `code-review-security`, `documentation`, `pr-creation`), status `done` or `failed`, a one-line note such as the artifact path or the blocker, and the stage agent's measured `model`, `tokens` and `duration_ms` from the totals the harness prints with its result (cumulative for that agent, so a remediation report repeats the new running total; omit any value that was not measured). Every remediation pass and test/review rerun needs its own `running` report followed by a completion report. Do not infer completion merely because another stage starts.
- After Stage 08, call `finish_run(run_id, summary)` before asking for Stage 09 authorization. `summary` is JSON with: `what_changed` (list), `decisions`, `questions`, `remaining`, `files`, `tests` ({command, result}), `branch`, `stages` (one row per stage agent: `phase`, `agent`, `model`, `tokens`, `tool_calls`, `duration_ms`, `est_cost_usd`, `outcome`; for `tokens`, `tool_calls` and `duration_ms` use the totals the harness prints with each subagent's result, which are measured; leave `est_cost_usd` as `"not reported"`, the dashboard computes a clearly labelled estimate from the tokens; write `"not reported"` for anything else that was not measured), `usage` ({cost_usd, model} when measured), and `cost_note` repeating the provenance label (measured, calculated estimate, or unavailable). The telemetry rules above apply: never estimate what was not measured.
- Stage 09 opens the pull request with `open_pull_request(run_id, branch, title, body)` when the dashboard has GitHub connected; if it answers that GitHub is not connected, use `gh pr create`. Either way, ask the user first.

## Stop conditions

Stop for a dirty preflight tree, branch collision, a design document sent back three times or not decided within the waiting time, missing Jira/Figma access, ambiguous criteria, incomplete dependency membership, competing authoritative nodes, unresolved synthesis conflicts, repeated failed criteria, failed final gates, blocker/high review findings, missing documentation, or missing external-write authorization. Never transition/comment on Jira, push, open/merge a PR, or enable auto-merge without explicit authorization.

Finish with Jira/Figma links, Stage 04 and Stage 08 artifacts, branch/commit/PR state, and a pass/fail table for all nine stages.
