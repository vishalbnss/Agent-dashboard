# Branch Preflight

Ticket access may come from a saved manual ticket or Jira. `get_ticket` reads the project's saved tickets first; when it returns `source="pasted"`, use that ticket and do not require a Jira connection or a Jira access probe. If a ticket is missing, the user can add it in the project's Tickets tab. If its full text was supplied directly in the request, carry that text into ticket intake rather than blocking on Jira authentication.

Run before Jira intake or any ticket artifact/source edit. First confirm access with one cheap read each: call the dashboard's `get_ticket(run_id, <primary key>)` (Jira is connected on the dashboard's project page), and fetch metadata for the first supplied Figma node through the `figma` MCP server (or its current user when no node URL is supplied yet). Run `gh auth status` when `gh` is installed; it is optional if GitHub is connected on the dashboard. If a call fails with an authentication or connection error, stop and report the exact fix: Connect with Jira on the project page for Jira, `/mcp` → figma → Authenticate for Figma, `gh auth login --web` for GitHub. Record the probe results in the preflight artifact, and report them to the dashboard with `report_connection("figma", true|false, detail)` and `report_connection("github", true|false, detail)` so the project page shows the real status.

Read `AGENTS.md`, then inspect Git with read-only commands: repository root, current branch and `HEAD`, status including untracked files, local branches, and remotes. Do not fetch or pull unless separately authorized. If the folder is not a Git repository yet, run `git init -b main` and commit the current files once; that is the only commit preflight may make.

Derive the branch from the supplied delivery ID as `feature/<DELIVERY-ID>`; use the primary Jira key or the parent/lead key explicitly supplied before preflight. The delivery ID remains stable if later Jira intake discovers related tickets. Append a short lowercase slug only when the user supplied one before preflight. Sanitize the slug to letters, digits, and hyphens. Do not read Jira merely to improve the branch name.

Require a clean working tree before creating or switching branches. Ignored runtime artifacts do not count as dirt. If tracked or untracked work exists, stop and list the paths; never carry it onto the ticket branch, stash it, commit it, delete it, or create a workaround worktree without explicit user direction.

- If already on the intended branch, verify it and continue without recreating it.
- If the intended branch exists, do not reset or overwrite it. Stop unless the working tree is clean and its reuse is clearly the user's intent.
- Otherwise create it from the current verified `HEAD` with a non-destructive branch command.

After creation, verify the active branch and base `HEAD`. Write `.agent-runs/<DELIVERY-ID>/01-git/preflight.md` with the branch, base branch/ref when known, base commit SHA, creation/reuse result, initial status, and remote availability. Initialize or update the central manifest with all nine stages and mark `01 — Branch preflight`. Never include credentials or remote URLs containing secrets.

No later stage may edit ticket artifacts or product code unless this preflight passed. Branch creation does not authorize commits, pushes, PRs, Jira updates, or other external writes.
