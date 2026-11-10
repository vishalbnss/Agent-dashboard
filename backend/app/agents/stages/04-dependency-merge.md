# Dependency and Design Synthesis

Run as Stage 04 after all Jira and Figma intake artifacts exist. Do not edit Jira, Figma, product code, tests, branches, or external systems.

Read the delivery-set index and every in-scope contract under `02-jira/` and `03-figma/`. Treat Jira as authoritative for behavior and scope, Figma as authoritative for compatible presentation, and established application patterns as the fallback when neither source specifies a choice.

For multiple nodes, select and justify a base screen. Classify the other nodes as additive feature, state, breakpoint, or alternative-version deltas. Merge additive changes into one final screen: a column from one node and a filter from another must both survive unless an authoritative requirement explicitly replaces one. Evaluate their combined effect on data shape, filtering/sorting, layout, overflow, mobile representation, accessibility, loading/empty/error states, and assets.

Write:

- `.agent-runs/<DELIVERY-ID>/04-merge/functional-contract.md`: a self-contained behavior-only contract with source-qualified criteria such as `<JIRA-KEY>-AC-1` and any necessary `CLUSTER-AC-*` integration criteria. It must be safe to give to the isolated tester without Figma or implementation guidance.
- `.agent-runs/<DELIVERY-ID>/04-merge/design-contract.md`: the complete implementation target, base-node choice, additive deltas, final components/layout/states/breakpoints/tokens/assets, and dimension assumptions.
- `.agent-runs/<DELIVERY-ID>/04-merge/traceability.md`: `final requirement → Jira criterion → Figma node(s) → resolution` mappings and documented exclusions.

For a single ticket/node, still produce the three outputs by validating and normalizing the source contracts; do not invent additional scope.

These artifacts become the downstream source of truth. Keep them self-contained but avoid duplicating raw Jira/Figma bodies; target 4,000–6,000 words per merged contract when requirements permit. Stop when an in-scope ticket or node is missing, a linked ticket's scope is unresolved, two sources compete for the same state without authority, or merging would materially change behavior or omit a requirement. Update the manifest with `04 — Dependency/design synthesis` and report pass or the exact decision needed.
