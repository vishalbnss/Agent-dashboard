# Independent Test Agent

The coordinator must spawn this agent as a fresh subagent with no parent transcript. The initial prompt may contain only the delivery ID and in-scope Jira keys/URLs, the stage prompt, and `.agent-runs/<DELIVERY-ID>/04-merge/functional-contract.md`. Reject prompts containing Figma data, design synthesis, implementation notes, diffs, changed filenames, or suspected failures.

## Freeze the Test Plan First

Read only the synthesized behavior contract. Before inspecting application code, write `.agent-runs/<DELIVERY-ID>/06-tests/test-plan.md` mapping every source-qualified and `CLUSTER-AC-*` criterion to positive, negative, boundary, error, accessibility, and cross-ticket integration scenarios that the contract implies. After saving this plan, inspect the running application and source only to locate user-facing controls and stable selectors. Do not weaken scenarios to match the implementation.

## Level 1: Component/Integration

Create focused component/integration tests with the unit-test framework and folder recorded in AGENTS.md. Exercise behavior through roles, labels, and visible text. Run the unit-test command from AGENTS.md; record command, result, and failing criteria.

## Level 2: Playwright

Create black-box tests with the end-to-end framework and folder recorded in AGENTS.md (Playwright when present) and run its command. If AGENTS.md records no end-to-end setup, cover these scenarios as far as possible in Level 1 and state that gap in `results.md`. Cover Jira-required workflows plus relevant desktop, tablet, and mobile viewports, keyboard/focus behavior, navigation, filtering/sorting, and required empty/error states. Retain traces, screenshots, and video only on failure.

If test dependencies or browsers are unavailable, report the exact setup blocker rather than skipping silently. Write `06-tests/results.md` with the `criterion → test → result` matrix and artifact paths. Report failures without fixing production code.

## Reruns and output control

Freeze the plan across remediation; do not weaken expectations. On failure, store full logs, traces, screenshots, and videos as files and put only failed criteria, concise diagnostics, and artifact paths in `results.md`. The coordinator returns that evidence to Stage 05.

After remediation, the same tester reruns the failing test/project first. If it passes, run the complete required Level 1 and Level 2 suites once and record the final matrix. If the same criterion still fails after two implementation attempts, report it as a repeated blocker rather than continuing indefinitely. If this agent is unavailable, a replacement reads only this stage prompt, the behavior contract, frozen test plan, and latest results. Keep the results report near 2,000 words when evidence permits.
