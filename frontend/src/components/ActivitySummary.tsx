import { useId, type ReactNode } from "react";
import type { Project, Run } from "../api";

const STATUSES = [
  { key: "running", label: "In progress", color: "var(--running)" },
  { key: "awaiting_approval", label: "Awaiting approval", color: "#d4a556" },
  { key: "done", label: "Completed", color: "var(--done)" },
  { key: "failed", label: "Failed", color: "var(--bad)" },
  { key: "stopped", label: "Stopped", color: "var(--muted)" },
];

export function RunSummary({ runs, children }: { runs: Pick<Run, "status">[]; children: ReactNode }) {
  const total = runs.length;
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  const rows = STATUSES.map((status) => ({ ...status, count: counts.get(status.key) ?? 0 }));
  const other = total - rows.reduce((sum, row) => sum + row.count, 0);
  if (other) rows.push({ key: "other", label: "Other", color: "var(--faint)", count: other });
  return <DistributionSummary title="Run status" totalLabel="Total runs" rows={rows}>{children}</DistributionSummary>;
}

export function ProjectSummary({ projects, children }: { projects: Pick<Project, "claude_connected_at" | "codex_connected_at" | "copilot_connected_at">[]; children: ReactNode }) {
  const connected = projects.filter((project) => project.claude_connected_at || project.codex_connected_at || project.copilot_connected_at).length;
  const rows = [
    { key: "connected", label: "Connected", color: "var(--done)", count: connected },
    { key: "unconnected", label: "Needs connection", color: "var(--accent)", count: projects.length - connected },
  ];
  return <DistributionSummary title="Project connections" totalLabel="Total projects" rows={rows}>{children}</DistributionSummary>;
}

type DistributionRow = { key: string; label: string; color: string; count: number };

function DistributionSummary({ title, totalLabel, rows, children }: { title: string; totalLabel: string; rows: DistributionRow[]; children: ReactNode }) {
  const headingId = useId();
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const breakdown = rows.filter((row) => row.count).map((row) => `${row.label}: ${row.count}`).join(". ");
  const description = `${total} ${totalLabel.toLowerCase()}.${breakdown ? ` ${breakdown}.` : ""}`;

  return <div className="run-summary-grid">
    <section className="run-distribution" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      <div className="run-distribution-body">
        <div className="run-donut">
          <svg viewBox="0 0 144 144" role="img" aria-label={description}>
            <circle cx="72" cy="72" r="58" fill="none" stroke="var(--line)" strokeWidth="17" />
            {rows.map((row, i) => {
              if (!row.count) return null;
              const share = row.count / total * 100;
              const offset = rows.slice(0, i).reduce((sum, item) => sum + item.count, 0) / total * 100;
              return <circle key={row.key} cx="72" cy="72" r="58" fill="none" stroke={row.color} strokeWidth="17" pathLength="100" strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={-offset} transform="rotate(-90 72 72)">
                <title>{row.label}: {row.count} ({Math.round(share)}%)</title>
              </circle>;
            })}
          </svg>
          <div className="run-donut-total" aria-hidden="true"><strong>{total.toLocaleString()}</strong><span>{totalLabel}</span></div>
        </div>
        <ul className="run-distribution-legend" aria-label={`${title} breakdown`}>
          {rows.map((row) => <li key={row.key}><span className="run-distribution-dot" style={{ backgroundColor: row.color }} aria-hidden="true" /><span>{row.label}</span><strong>{row.count.toLocaleString()}</strong></li>)}
        </ul>
      </div>
    </section>
    <div className="metrics-grid">{children}</div>
  </div>;
}
