"""Jira issues arrive through Atlassian's MCP server (see mcp_oauth). This module turns its answer into ticket text."""
import json


def _adf_text(node) -> str:
    """Flatten Atlassian Document Format to plain text. ponytail: drops tables/marks; enough for prompts."""
    if isinstance(node, dict):
        if node.get("type") == "text":
            return node.get("text", "")
        inner = "".join(_adf_text(c) for c in node.get("content", []))
        return inner + ("\n" if node.get("type") in ("paragraph", "heading", "listItem", "codeBlock") else "")
    if isinstance(node, list):
        return "".join(_adf_text(n) for n in node)
    return ""


def parse_issue(text: str, key: str) -> dict:
    """The MCP tool returns the issue as JSON text (Jira REST shape). Fall back to the raw text."""
    try:
        d = json.loads(text)
    except json.JSONDecodeError:
        return {"key": key, "title": "", "body_md": text}
    f = d.get("fields") or d
    desc = f.get("description")
    body = _adf_text(desc) if isinstance(desc, (dict, list)) else str(desc or "")
    return {"key": d.get("key") or key, "title": f.get("summary", "") or d.get("summary", ""), "body_md": body,
            "type": (f.get("issuetype") or {}).get("name") if isinstance(f.get("issuetype"), dict) else f.get("issuetype"),
            "status": (f.get("status") or {}).get("name") if isinstance(f.get("status"), dict) else f.get("status")}


def cloud_id(text: str) -> str:
    """First site id from getAccessibleAtlassianResources."""
    try:
        d = json.loads(text)
    except json.JSONDecodeError:
        return ""
    sites = d if isinstance(d, list) else d.get("resources") or d.get("sites") or []
    return (sites[0].get("id") or sites[0].get("cloudId") or "") if sites else ""
