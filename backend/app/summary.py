"""Turn the structured finish_run payload into the Markdown summary."""
from datetime import datetime


# USD per 1M tokens (input, output). Estimates assume a 90/10 input/output split. ponytail: static table; refresh when prices change.
PRICING = {"fable": (10, 50), "opus": (5, 25), "sonnet": (2, 10), "haiku": (1, 5), "gpt-5": (1.25, 10), "codex": (1.5, 6)}
COST_NOTE = "Estimated from the token totals the agents reported, at list prices with a 90/10 input/output split. Not a bill."


def rate_for(model: str) -> tuple[float, float] | None:
    m = str(model or "").lower()
    return next((v for k, v in PRICING.items() if k in m), None)


def estimate_from_tokens(tokens, model: str) -> float | None:
    """A labelled estimate for one stage: total tokens + model name -> USD, or None when either is unknown."""
    rate = rate_for(model)
    if not rate or not isinstance(tokens, (int, float)) or tokens <= 0:
        return None
    inp, out = rate
    return round((tokens * 0.9 * inp + tokens * 0.1 * out) / 1_000_000, 4)


def fill_estimates(summary: dict) -> dict:
    """Give every stage row an est_cost_usd when the agent reported tokens but no cost; return the usage additions."""
    stages = summary.get("stages") or []
    total, any_est, complete = 0.0, False, True
    for st in stages:
        if not isinstance(st, dict):
            continue
        if not isinstance(st.get("est_cost_usd"), (int, float)):
            est = estimate_from_tokens(st.get("tokens"), st.get("model", ""))
            if est is not None:
                st["est_cost_usd"] = est
                any_est = True
        if isinstance(st.get("est_cost_usd"), (int, float)):
            total += st["est_cost_usd"]
        else:
            complete = False
    if not any_est and total == 0:
        return {}
    if any_est and not summary.get("cost_note"):
        summary["cost_note"] = COST_NOTE
    return {"cost_usd": round(total, 2), "cost_kind": "estimate" + ("" if complete else " (partial)")}


def build_summary(run_goal: str, summary: dict, usage: dict, started: datetime, finished: datetime, pr_url: str = "") -> str:
    mins = (finished - started).total_seconds() / 60
    lines = [f"# Run summary", "", f"**Goal:** {run_goal}", ""]
    if pr_url:
        lines += [f"**Pull request:** {pr_url}", ""]
    for key, title in [("what_changed", "What changed"), ("decisions", "Decisions and assumptions"),
                       ("questions", "Questions asked"), ("remaining", "Not done / follow-ups")]:
        val = summary.get(key)
        if val:
            lines += [f"## {title}", ""]
            lines += [f"- {v}" for v in val] if isinstance(val, list) else [str(val)]
            lines.append("")
    files = summary.get("changed_files") or []
    if files:
        lines += ["## Files changed", ""] + [f"- `{f}`" for f in files] + [""]
    tests = summary.get("tests")
    if tests:
        lines += ["## Tests", "", str(tests) if not isinstance(tests, dict) else
                  f"Ran: {tests.get('command', '?')}  ->  {tests.get('result', '?')}", ""]
    stages = summary.get("stages") or []
    if stages:
        lines += ["## Stages", "", "| Phase | Agent | Model | Tokens | Calls | Time | Est. cost |", "|---|---|---|---:|---:|---:|---:|"]
        tot_tokens = tot_calls = tot_ms = 0
        tot_cost = None
        partial = False
        for st in stages:
            tokens, calls, ms, cost = st.get("tokens"), st.get("tool_calls"), st.get("duration_ms"), st.get("est_cost_usd")
            for v in (tokens, calls, ms, cost):
                if not isinstance(v, (int, float)):
                    partial = True
            tot_tokens += tokens if isinstance(tokens, (int, float)) else 0
            tot_calls += calls if isinstance(calls, (int, float)) else 0
            tot_ms += ms if isinstance(ms, (int, float)) else 0
            if isinstance(cost, (int, float)):
                tot_cost = (tot_cost or 0) + cost
            lines.append(f"| {st.get('phase', '?')} | {st.get('agent', '?')} | {st.get('model', 'not reported')} | "
                         f"{_num(tokens)} | {_num(calls)} | {_dur(ms)} | {_money(cost)} |")
        suffix = " (partial)" if partial else ""
        lines.append(f"| **Total**{suffix} |  |  | {_num(tot_tokens)} | {_num(tot_calls)} | {_dur(tot_ms)} | {_money(tot_cost)} |")
        lines.append("")
        for st in stages:
            if st.get("outcome"):
                lines.append(f"- **{st.get('phase', '?')}**: {st['outcome']}")
        lines.append("")
    lines += ["## Cost and time", "", "| Metric | Value |", "|---|---|",
              f"| Duration | {mins:.1f} min |"]
    for k, label in [("input_tokens", "Input tokens"), ("output_tokens", "Output tokens"),
                     ("cache_read_tokens", "Cache read tokens"), ("cost_usd", "Estimated cost (USD)"),
                     ("model", "Model"), ("ai_credits", "GitHub AI credits"), ("fix_cycles", "Fix cycles")]:
        if usage.get(k) is not None:
            lines.append(f"| {label} | {usage[k]} |")
    if summary.get("cost_note"):
        lines += ["", f"_{summary['cost_note']}_"]
    return "\n".join(lines) + "\n"


def _num(v) -> str:
    return f"{int(v):,}" if isinstance(v, (int, float)) else "not reported"


def _dur(ms) -> str:
    if not isinstance(ms, (int, float)):
        return "not reported"
    s = int(ms // 1000)
    return f"{s // 60}m {s % 60:02d}s" if s >= 60 else f"{s}s"


def _money(v) -> str:
    return f"~${v:.2f}" if isinstance(v, (int, float)) else "not reported"
