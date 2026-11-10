# Figma Intake

After a successful Figma read, call `report_connection(kind="figma", connected=true, client="claude", detail="Design read succeeded")` (use `client="codex"` in Codex). If the tools are unavailable or a read fails, report `connected=false` with a short reason and no credentials. Report the result before stopping for a connection problem so the project page reflects the latest check.

For every exact file/node URL found by Jira intake, first call the dashboard's `get_figma_design(run_id, url)` to get the file key and node id, then read the node with the `figma` MCP server (`get_design_context` first). Fetch design context once for each node, then screenshot, variables, reusable components, states, breakpoints, and downloadable assets. Reuse saved evidence; refetch only when the node changed, an asset expired before download, or required context is missing. Do not assume the newest-looking node supersedes another.

Write `.agent-runs/<DELIVERY-ID>/03-figma/nodes/<FILE-KEY>-<NODE-ID>.md` for every node, sanitizing separators to hyphens so nodes from different files cannot collide. Each contract contains its URL, source ticket, purpose, dimensions, layout, tokens, typography, content, components, states, responsive behavior, accessibility implications, and asset paths. Store downloaded assets under a matching per-node directory and write an asset manifest. Write `03-figma/design-index.md` classifying each node as a base-screen candidate, additive feature, state, breakpoint, or alternative version.

Jira governs behavior; Figma governs compatible presentation. Record conflicts and possible base/delta relationships without merging them in this stage. Stop when nodes compete for the same state and authority cannot be established. Never substitute placeholders for supplied assets or modify Figma during intake.

Keep each node contract near 2,000 words when the design permits. Reference screenshots/assets by path instead of embedding or restating large generated code blocks.
