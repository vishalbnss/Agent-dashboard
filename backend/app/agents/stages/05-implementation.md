# Implementation

Read `AGENTS.md`, `01-git/preflight.md`, the current working-tree status, and all three `04-merge/` artifacts. Verify the active branch matches the passed preflight and that no unrelated changes appeared after its recorded baseline. Stop on a missing/mismatched branch, unexplained changes, an incomplete traceability matrix, or unresolved synthesis conflict; branch creation and requirement merging do not belong in implementation.

Implement the smallest coherent change using the folder layout, shared components and styling conventions recorded in AGENTS.md, and Figma-provided assets. Cover only required loading, empty, error, disabled, hover/focus, keyboard, and responsive states. Preserve unrelated work and avoid new dependencies unless necessary.

The implementation agent must not write or modify acceptance tests: those belong to the context-isolated test agent. It may run the build command recorded in AGENTS.md as a compilation gate.

Write `.agent-runs/<DELIVERY-ID>/05-implementation/report.md` with changed files, requirement/design decisions, assumptions, build result, and known risks. Map implemented behavior to the merged criterion IDs, but do not include instructions for how tests should pass.

For remediation, read only the merged contracts, current report, failed criterion IDs, concise results, and referenced failure artifacts. Fix production code without weakening tests. Run the failing scope when available, then leave the complete acceptance rerun to Stage 06; always rerun the build. Reuse this agent for the first remediation. Before a second substantial remediation or when context has grown materially, update the report with a concise checkpoint suitable for a fresh same-route replacement. Keep the report near 1,500–2,000 words when evidence permits and link to full logs instead of embedding them.
