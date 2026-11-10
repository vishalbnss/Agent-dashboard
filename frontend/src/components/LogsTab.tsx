import { useCallback, useEffect, useState } from "react";
import { api, type LogEntry, type Run } from "../api";
import { usePolling } from "../hooks/usePolling";
import { EmptyState } from "./ui";

const LEVELS: [string, string][] = [["info", "Info and above"], ["warn", "Warnings and errors"], ["error", "Errors only"], ["debug", "Everything, with polling"]];
const CLIENT: Record<string, string> = { claude: "Claude Code", codex: "Codex", copilot: "Copilot" };
const PAGE = 100;
const MAX = 500;

/* The API stores UTC without a zone marker. */
const utc = (s: string) => new Date(/Z$|[+-]\d\d:\d\d$/.test(s) ? s : s + "Z");

function when(ts: string) {
  const d = utc(ts);
  const today = d.toDateString() === new Date().toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function who(e: LogEntry) {
  if (e.source === "dashboard") return "Dashboard";
  return CLIENT[e.client] ?? (e.source === "system" ? "System" : "AI");
}

export function LogsTab({ projectId, runs }: { projectId: number; runs: Run[] }) {
  const [level, setLevel] = useState("info");
  const [runId, setRunId] = useState("");
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  // A new filter starts again from the latest page.
  useEffect(() => { const t = setTimeout(() => { setQ(input.trim()); setLimit(PAGE); }, 300); return () => clearTimeout(t); }, [input]);
  const fetcher = useCallback(() => api.logs(projectId, { level, run_id: runId, q, limit }), [projectId, level, runId, q, limit]);
  const { data, error } = usePolling(fetcher, 4000);
  const filtered = level !== "info" || runId || q;

  return (
    <section className="logs" aria-label="Logs">
      <div className="logs-bar">
        <input type="search" placeholder="Search messages and events" aria-label="Search logs" value={input} onChange={(e) => setInput(e.target.value)} />
        <select aria-label="Level" value={level} onChange={(e) => { setLevel(e.target.value); setLimit(PAGE); }}>
          {LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select aria-label="Run" value={runId} onChange={(e) => { setRunId(e.target.value); setLimit(PAGE); }}>
          <option value="">All runs</option>
          {runs.map((r) => <option key={r.id} value={r.id}>Run #{r.number || r.id} · {r.title || r.goal.slice(0, 60)}</option>)}
        </select>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      {!data ? <p className="muted">Loading logs…</p>
        : !data.items.length ? <EmptyState icon="document" title={filtered ? "No logs match these filters" : "No logs yet"}
            description={filtered ? undefined : "Tool calls from your AI and actions on the dashboard appear here as they happen."} />
        : <ol className="log-list">
            {data.items.map((e) => (
              <li key={e.id} className={`log ${e.level}`}>
                <details>
                  <summary>
                    <time dateTime={e.ts} title={utc(e.ts).toLocaleString()}>{when(e.ts)}</time>
                    <span className={`log-level ${e.level}`}>{e.level}</span>
                    <span className="log-who">{who(e)}</span>
                    <span className="log-msg">{e.message}</span>
                    {e.run_number != null && <a className="log-run" href={`#/runs/${e.run_id}`} onClick={(ev) => ev.stopPropagation()}>Run #{e.run_number}</a>}
                    {e.duration_ms != null && <span className="log-ms">{e.duration_ms} ms</span>}
                  </summary>
                  <div className="log-detail">
                    <p><span>Event</span><code>{e.event}</code><span>Source</span><code>{e.source}</code></p>
                    <pre>{JSON.stringify(e.detail, null, 2)}</pre>
                  </div>
                </details>
              </li>
            ))}
          </ol>}
      {data?.more && (limit < MAX
        ? <button className="secondary logs-more" onClick={() => setLimit((n) => n + PAGE)}>Load older</button>
        : <p className="muted logs-more">Showing the latest {MAX}. Use search or filters to find older entries.</p>)}
    </section>
  );
}
