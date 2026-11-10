# Ticket Intake

Read every supplied ticket with the dashboard's `get_ticket(run_id, key)` tool. It reads saved manual tickets first and uses Jira only when a ticket is not saved; it also lists the Figma URLs in the ticket. A `source="pasted"` ticket is valid input and requires no Jira connection. If the user supplied the full ticket directly in the request and lookup is unavailable, use that supplied text as the source. Use the summary, description and acceptance criteria, plus comments, attachments, subtasks, parent, linked issues and remote links only when the tool or the user supplies them. Classify links as in-scope dependency, blocker, duplicate, related context, backend dependency, or design reference. Do not silently pull a linked ticket into scope and do not modify Jira.

Always write `.agent-runs/<DELIVERY-ID>/02-jira/delivery-set.md`. For a single ticket, also write `02-jira/functional-contract.md`. For an atomic ticket set, write one `02-jira/tickets/<JIRA-KEY>.md` per ticket. Each ticket contract contains:

- ticket key, source (manual or Jira), source URL when provided, summary, and in/out of scope; never invent a Jira URL for a manual ticket;
- acceptance criteria copied faithfully and numbered `AC-1`, `AC-2`, ...;
- user roles, business rules, inputs/outputs, errors, permissions, and responsive/accessibility behavior stated by the ticket;
- candidate Figma URLs and unresolved questions;
- a sanitized functional test seed containing only behavior, never design or implementation guidance.

The delivery-set index records the fixed delivery ID, primary/parent/lead keys, every in-scope ticket, relationship and dependency order, why one implementation is required, candidate Figma URLs by ticket, out-of-scope links, and unresolved authority questions. A discovered link does not enter scope or rename the delivery without user/Jira authority. Preserve source-qualified criterion IDs such as `<JIRA-KEY>-AC-1` when more than one ticket is in scope.

Normalize rather than repeatedly copying large source bodies. Preserve exact criterion meaning and source links while keeping each ticket contract near 2,000 words when requirements permit. Do not infer missing requirements. Stop when criteria are contradictory or not testable. Remove credentials, private comments unrelated to delivery, and sensitive customer/financial data from the artifact.
