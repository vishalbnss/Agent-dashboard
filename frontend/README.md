# Agents Dashboard frontend

React, TypeScript, and Vite UI for the Agents Dashboard backend.

## Run locally

From this directory, run `npm install`, then `npm run dev`. The Vite server proxies `/api` to `http://127.0.0.1:8000`; start the backend using the root README. Set `API_URL` before starting Vite to use a different backend.

## Checks

- `npm run build`: TypeScript check and production bundle.
- `npm run lint`: Oxlint.
- `npm test`: Vitest interaction tests in jsdom. API responses are mocked; these tests do not call providers or modify the application database.

The interaction suite covers overview counts, project and run filtering, keyboard search, project creation, connection config and key rotation, approval confirmation, section comments, document history, navigation focus, and failed-request recovery. Browser layout and live provider connectivity need separate verification.

## UI structure

- `src/components/AppShell.tsx`: responsive sidebar, top bar, and workspace search.
- `src/components/ui.tsx`: icons, page headers, metric cards, state displays, and keyboard-accessible dialogs.
- `src/App.tsx`: overview, projects, runs, approval inbox, project connections, design review, and setup guide. Existing hash URLs remain supported.
- `src/hooks/usePolling.ts`: shared polling with stale-response protection and retry support.
- `src/api.ts`: existing typed REST API client.
- `src/index.css`: base controls and workflow styles.
- `src/workspace.css`: workspace layout, responsive rules, and the warm neutral/bronze visual system inspired by the supplied AIKeyGuard reference.

Overview metrics and search results come from the backend. No sample records are included in the application UI. The redesign adds no production dependencies and does not alter the backend or API contracts.
