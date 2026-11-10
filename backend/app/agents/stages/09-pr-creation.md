# Pull Request Creation

Verify Git/remotes/authentication and require all stage artifacts, including `01-git/preflight.md`, every `04-merge/` contract, `08-documentation/summary.md`, and `pipeline-report.md`. Confirm the current branch and ancestry match the preflight base. Refuse creation when required gates failed, blocker/high findings remain, the branch contains unrelated changes, or branch/source/synthesis/test/documentation evidence is missing.

Prepare the body from `.github/pull_request_template.md` (when it exists) with every in-scope Jira and exact Figma link, the Stage 04 traceability summary, documentation summary, `criterion → unit/E2E test → result` matrix, screenshots, commands and outcomes, security/review result, dependencies, and residual risks. Include model/token/cost fields only with the provenance recorded by the documentation agent. Sanitize secrets and sensitive data.

Use an imperative commit subject prefixed by the Jira key, such as `FIN-123 Add market share filters`. Push and open the PR only when the current invocation explicitly authorizes both actions; otherwise ask immediately before the external write. Open the PR with the dashboard's `open_pull_request(run_id, branch, title, body)`; if it answers that GitHub is not connected, use `gh pr create`. Never merge, enable auto-merge, transition/comment on Jira, or change reviewers/labels beyond the user's authorization.

Write `.agent-runs/<DELIVERY-ID>/09-pr/result.md` with branch, commit SHA, PR URL, included Jira keys, and final gate status.
