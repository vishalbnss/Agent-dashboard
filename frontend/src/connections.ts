import type { Integration } from "./api";

export type ConnectionReport = {
  connected: boolean;
  client: string;
  checked_at: string;
  detail: string;
};

function readReport(value: unknown): ConnectionReport | null {
  if (!value || typeof value !== "object") return null;
  const report = value as Record<string, unknown>;
  if (typeof report.connected !== "boolean") return null;
  return {
    connected: report.connected,
    client: typeof report.client === "string" ? report.client : "unknown",
    checked_at: typeof report.checked_at === "string" ? report.checked_at : "",
    detail: typeof report.detail === "string" ? report.detail : "",
  };
}

/** Older projects have one report; new reports keep each coding client's result. */
export function figmaReports(integration?: Integration): ConnectionReport[] {
  if (integration?.config.auth !== "via-ai") return [];
  const clients = integration.config.clients;
  const reports = clients && typeof clients === "object"
    ? Object.values(clients).map(readReport).filter((report): report is ConnectionReport => report !== null)
    : [];
  if (reports.length) return reports;
  const legacy = readReport(integration.config);
  return legacy ? [legacy] : [];
}
