# Pipeline Documentation

Run after `07-review/findings.md` exists and before the PR stage. Prefer an agent that did not implement production code. This stage is read-only except for its two artifacts, telemetry, and the central run manifest; never update Jira, Figma, GitHub, product code, tests, commits, or branches.

Read the manifest, Stage 04 traceability, Stage 05 report, Stage 06 results, Stage 07 findings, and existing `telemetry.md` first. Open raw Jira/Figma contracts or full logs only to verify a claim, resolve an inconsistency, or fill required provenance; do not rescan every detailed artifact by default. When telemetry is incomplete, record only what the harness exposes and mark the rest unavailable; never copy conversation content. Inspect current Git metadata with read-only commands: status, branch, remotes, recent commit, and delivery-relevant diff/stat. Preserve unrelated work and sanitize credentials, tokens, private URLs, customer data, and sensitive Jira content.

## Outputs

Create `.agent-runs/<DELIVERY-ID>/08-documentation/summary.md` as a brief handoff containing:

- what was implemented and the user-visible result;
- each pipeline stage/gate and its current pass, fail, blocked, or not-started status;
- branch/commit/PR state, residual risks, and important follow-ups;
- model name(s), token usage, and cost with the provenance rules below.

Create `.agent-runs/<DELIVERY-ID>/08-documentation/pipeline-report.md` with:

- sanitized Jira and exact Figma source links, delivery-set relationships, and the Stage 04 synthesis/traceability decision;
- an ordered stage narrative with artifact links, decisions, remediations, command outcomes, and the acceptance-criteria evidence matrix when available;
- changed-file/diff scope from current Git metadata, without claiming uncommitted work belongs to the ticket unless an artifact establishes that;
- test, build, accessibility, review, and security evidence;
- unresolved findings, accepted exceptions, assumptions, and residual risks;
- a telemetry table covering every known participating agent/model and the provenance of every value.

Link to existing evidence instead of duplicating large logs. Clearly distinguish artifact evidence, current observations, and unavailable information. Do not turn a failed or missing gate into a pass.

## Telemetry and Cost Provenance

Never infer telemetry from prose length, elapsed time, context size, rate limits, or model defaults.

- Label platform- or API-reported values `Measured`, and identify the report or artifact that supplied them.
- Treat a workflow `telemetry.md` entry as measured only when it names the host/platform source; an agent's self-reported estimate is not measured usage.
- Treat requested model/reasoning plus the returned thread ID as coordinator-observed routing provenance, distinct from the effective model/reasoning measured by the harness.
- When cumulative per-thread usage records are available, use the final value once per thread. Do not sum its intermediate cumulative values. Derive uncached input as total `input_tokens` minus `cached_input_tokens`; reasoning output is an output subset and is not billed twice.
- Price each invocation or aggregate row using its exact effective model or billed SKU. Group only rows that share the same model, service tier/mode, pricing schedule, and currency; never apply one model's rate to another model or to an unspecified model family.
- Label arithmetic derived from measured token counts `Calculated`; show the model ID, input/output/cached/cache-write token counts, per-token rates, service tier/mode and other pricing modifiers, currency, formula, pricing source URL, and the pricing effective or access date.
- Compute ordinary text cost from the applicable model rates: uncached input plus cached input plus cache writes when separately priced plus output. Treat reasoning tokens as an output-token breakdown when the usage schema includes them within output tokens; do not count them twice. Add separately billed tools or modalities as distinct model/tool line items.
- Apply model-specific modifiers such as long-context thresholds, Batch/Flex/Priority/Fast modes, regional pricing, or promotional dates only when the authoritative pricing source and measured request attributes establish that they apply.
- Use `Unavailable` for a model name or token category not exposed by the runtime or recorded in an artifact.
- Cost for a row must be exactly `Unavailable` unless its exact model/SKU, applicable token counts, pricing modifiers, and explicit pricing from a cited authoritative source are available. If any billable row is incomplete, label any calculable subtotal with its coverage and keep the whole-pipeline total `Unavailable`; do not substitute public API pricing for an unknown deployment or subscription rate.
- Label a provider-issued billed amount `Measured actual cost`; otherwise, a valid price calculation is `Calculated estimated cost`, never actual cost.
- Distinguish API list-price estimates from subscription-plan usage. A token-based API estimate is not the user's subscription charge unless provider billing evidence says so.
- Do not claim the report captures whole-pipeline usage when telemetry covers only the current agent or selected stages; state the coverage boundary.

## API-equivalent planning estimate

When exact effective model names and measured token categories exist, use current official Anthropic per-token rates for the effective models (record the rate source and date) and calculate the documented standard-pricing scenario per stage. Keep it separate from actual/subscription cost. If per-request long-context or service-tier attributes are unavailable, label the result `API-equivalent planning estimate`, state the excluded modifiers, and leave actual cost `Unavailable`. If unpriced platform-created threads are present, report both their measured usage and a clearly bounded subtotal covering only priced model rows; the whole-pipeline estimate remains unavailable. Do not use a rate after its review/expiry condition without verifying the cited official source.

## Manifest Update

Update `.agent-runs/<DELIVERY-ID>/manifest.md` in place without erasing prior evidence. Add or update `08 — Documentation` with both artifact paths and the truthful outcome. Preserve legacy numbering in completed older runs; new runs must retain all nine current stages. Add documentation command/observation outcomes only when useful, and revise the current outcome to include this stage. Do not change external systems.

Before finishing, verify both files exist, their links resolve where locally checkable, no secrets appear, telemetry labels obey these rules, and the manifest agrees with the reports. Keep the summary concise and the pipeline report near 2,000 words when the evidence permits; link detailed logs instead of duplicating them.
