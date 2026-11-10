"""Open a pull request via GitHub REST."""
import re

import httpx


def owner_repo(repo_url: str) -> tuple[str, str]:
    m = re.search(r"github\.com/([^/]+)/([^/]+)", repo_url)
    if not m:
        raise ValueError(f"Not a GitHub URL: {repo_url}")
    return m.group(1), m.group(2)


async def open_pr(token: str, repo_url: str, head: str, title: str, body: str, base: str | None = None) -> str:
    owner, repo = owner_repo(repo_url)
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    async with httpx.AsyncClient(timeout=30, headers=headers) as c:
        if not base:
            r = await c.get(f"https://api.github.com/repos/{owner}/{repo}")
            r.raise_for_status()
            base = r.json()["default_branch"]
        r = await c.post(f"https://api.github.com/repos/{owner}/{repo}/pulls",
                         json={"title": title, "body": body, "head": head, "base": base})
        if r.status_code >= 400:
            raise RuntimeError(f"GitHub {r.status_code}: {r.text[:400]}")
        return r.json()["html_url"]
