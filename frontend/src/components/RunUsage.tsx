import type { Run } from "../api";

const count = (value: number | string | undefined) => {
  if (value == null || value === "" || !Number.isFinite(Number(value)) || Number(value) < 0) return null;
  return Number(value);
};
const format = (value: number) => value.toLocaleString("en-US");

export function Cost({ usage }: { usage: Run["usage"] }) {
  const amount = count(usage.cost_usd);
  if (amount == null) return <span title="Cost not reported">—</span>;
  const estimated = Boolean(usage.cost_kind);
  return <span title={String(usage.cost_note || (estimated ? "Estimated from reported usage. Not a bill." : "Reported cost"))}>
    {estimated ? "~" : ""}${amount.toFixed(amount > 0 && amount < 0.01 ? 4 : 2)}
  </span>;
}

/* one agent's line in the breakdown, already formatted by the run page */
export type AgentCost = { name: string; model: string; time: string; tokens: number | null; cost: number | null };

const money = (v: number) => `~$${v.toFixed(v > 0 && v < 0.01 ? 4 : 2)}`;

export function RunUsage({ usage, duration, agents = [] }: { usage: Run["usage"]; duration: string; agents?: AgentCost[] }) {
  const input = count(usage.input_tokens), output = count(usage.output_tokens);
  const total = count(usage.total_tokens) ?? (input != null && output != null ? input + output : null);
  const cost = count(usage.cost_usd);
  const partial = String(usage.cost_kind ?? "").includes("partial");
  const metrics = [
    ["Input tokens", input],
    ["Cached input (included above)", count(usage.cached_input_tokens ?? usage.cache_read_tokens)],
    ["Cache write tokens", count(usage.cache_write_input_tokens ?? usage.cache_write_tokens)],
    ["Output tokens", output],
    ["Reasoning tokens (included in output)", count(usage.reasoning_output_tokens)],
    ["Model requests", count(usage.model_requests)],
    ["GitHub AI credits", count(usage.ai_credits)],
    ["Tokens included in estimate", count(usage.priced_tokens)],
    ["Tokens without a price", count(usage.unpriced_tokens)],
    ["Fix cycles", count(usage.fix_cycles)],
  ] as const;
  const hasDetails = metrics.some(([, value]) => value != null) || usage.model || usage.usage_note || usage.cost_note || cost != null || agents.length > 0;
  const priced = agents.filter((a) => a.cost != null);
  const agentTokens = agents.reduce((sum, a) => sum + (a.tokens ?? 0), 0);
  return <div className="panel run-usage" aria-label="Cost and time">
    <h2>Cost and time</h2>
    <dl className="usage-highlights">
      <div><dt>{usage.cost_kind ? "Estimated cost" : "Cost"}</dt><dd>{cost == null ? "Unavailable" : <Cost usage={usage} />}</dd>{partial && <span className="usage-coverage">Partial estimate</span>}</div>
      <div><dt>Duration</dt><dd>{duration}</dd></div>
      <div><dt>Total tokens</dt><dd>{total == null ? "Not reported" : format(total)}</dd></div>
    </dl>
    {hasDetails && <details className="usage-details">
      <summary>Usage breakdown</summary>
      <dl>
        {cost != null && <div><dt>{usage.cost_kind ? "Estimated cost" : "Cost"}{partial ? " (partial)" : ""}</dt><dd><Cost usage={usage} /></dd></div>}
        {usage.model && <div><dt>Model</dt><dd>{usage.model}</dd></div>}
        {metrics.filter(([, value]) => value != null).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{format(value!)}</dd></div>)}
      </dl>
      {agents.length > 0 && <div className="usage-agents-scroll"><table className="usage-agents">
        <caption>Cost by agent</caption>
        <thead><tr><th scope="col">Agent</th><th scope="col">Model</th><th scope="col">Time</th><th scope="col">Tokens</th><th scope="col">Est. cost</th></tr></thead>
        <tbody>{agents.map((a) => <tr key={a.name}>
          <th scope="row">{a.name}</th><td>{a.model}</td><td>{a.time}</td>
          <td>{a.tokens == null ? "—" : format(a.tokens)}</td><td>{a.cost == null ? "—" : money(a.cost)}</td>
        </tr>)}</tbody>
        <tfoot><tr><th scope="row">Total{priced.length < agents.length ? " (partial)" : ""}</th><td /><td /><td>{agentTokens ? format(agentTokens) : "—"}</td>
          <td>{priced.length ? money(priced.reduce((sum, a) => sum + a.cost!, 0)) : "—"}</td></tr></tfoot>
      </table></div>}
      {usage.usage_note && <p>{usage.usage_note}</p>}
      {usage.cost_note && <p>{usage.cost_note}</p>}
      {usage.cost_kind && !usage.cost_note && <p>Estimated from reported token usage at list prices. Not a bill.</p>}
    </details>}
  </div>;
}
