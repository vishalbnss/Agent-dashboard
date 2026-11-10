// Claude Code Stop hook: sum token usage from the session transcript and POST it to the dashboard
// for the run this session started (last "run_id" seen in a tool result). Silent on any failure.
import { readFileSync } from "node:fs";

const DASHBOARD = process.env.AGENTS_DASHBOARD_URL || "http://localhost:8000";

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  try {
    const { transcript_path } = JSON.parse(input);
    const lines = readFileSync(transcript_path, "utf8").split("\n").filter(Boolean);
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };
    let model = null;
    let runId = null;
    const seen = new Set(); // one assistant message can be streamed as several lines with the same id
    for (const line of lines) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const m = msg.message;
      if (msg.type === "assistant" && m?.usage && !seen.has(m.id)) {
        seen.add(m.id);
        usage.input_tokens += (m.usage.input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
        usage.output_tokens += m.usage.output_tokens || 0;
        usage.cache_read_tokens += m.usage.cache_read_input_tokens || 0;
        model = m.model || model;
      }
      const hit = /"run_id":\s*(\d+)/.exec(line);
      if (hit && line.includes("tool_result")) runId = Number(hit[1]);
    }
    if (!runId) return;
    await fetch(`${DASHBOARD}/api/runs/${runId}/usage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...usage, model }),
    });
  } catch {
    /* never block the user's session over telemetry */
  }
});
