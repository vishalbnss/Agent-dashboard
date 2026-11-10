"""Figma REST: fetch nodes for a design URL and flatten to what a coder needs. Plus OAuth (Sign in with Figma)."""
import re
from urllib.parse import parse_qs, urlparse

import httpx

FIGMA_URL_RE = re.compile(r"https://(?:www\.)?figma\.com/(?:file|design|proto|board)/[^\s)\]>\"\x27]+")


def extract_figma_urls(text: str) -> list[str]:
    return list(dict.fromkeys(FIGMA_URL_RE.findall(text or "")))


def parse_figma_url(url: str) -> tuple[str, str | None]:
    p = urlparse(url)
    parts = p.path.strip("/").split("/")
    file_key = parts[1] if len(parts) > 1 else ""
    node = parse_qs(p.query).get("node-id", [None])[0]
    return file_key, node.replace("-", ":") if node else None


def _rgba(fill: dict) -> str | None:
    c = fill.get("color")
    if fill.get("type") != "SOLID" or not c:
        return None
    a = fill.get("opacity", c.get("a", 1))
    r, g, b = (round(c[k] * 255) for k in "rgb")
    return f"#{r:02x}{g:02x}{b:02x}" if a >= 0.999 else f"rgba({r},{g},{b},{a:.2f})"


def flatten(node: dict, depth: int = 0, max_depth: int = 12) -> dict:
    """Keep only design-relevant fields. ponytail: depth cap keeps payload small; raise if designs are deeper."""
    out = {"name": node.get("name"), "type": node.get("type")}
    box = node.get("absoluteBoundingBox")
    if box:
        out["box"] = {k: round(box[k]) for k in ("x", "y", "width", "height") if k in box}
    fills = [c for c in (_rgba(f) for f in node.get("fills", []) if f.get("visible", True)) if c]
    if fills:
        out["fills"] = fills
    strokes = [c for c in (_rgba(f) for f in node.get("strokes", [])) if c]
    if strokes:
        out["strokes"] = strokes
    for k in ("characters", "cornerRadius", "layoutMode", "itemSpacing", "paddingLeft", "paddingRight",
              "paddingTop", "paddingBottom", "primaryAxisAlignItems", "counterAxisAlignItems", "opacity"):
        if node.get(k) not in (None, 0, "NONE"):
            out[k] = node[k]
    st = node.get("style")
    if st:
        out["text"] = {k: st[k] for k in ("fontFamily", "fontWeight", "fontSize", "lineHeightPx", "letterSpacing", "textAlignHorizontal") if k in st}
    if depth < max_depth and node.get("children"):
        out["children"] = [flatten(c, depth + 1, max_depth) for c in node["children"] if c.get("visible", True)]
    return out


async def get_design(token: str, url: str) -> dict:
    file_key, node_id = parse_figma_url(url)
    if not file_key:
        return {"error": f"Could not parse Figma file key from {url}"}
    headers = {"X-Figma-Token": token}
    async with httpx.AsyncClient(timeout=60, headers=headers) as c:
        if node_id:
            r = await c.get(f"https://api.figma.com/v1/files/{file_key}/nodes", params={"ids": node_id, "depth": 20})
            r.raise_for_status()
            doc = r.json()["nodes"][node_id]["document"]
        else:
            r = await c.get(f"https://api.figma.com/v1/files/{file_key}", params={"depth": 3})
            r.raise_for_status()
            doc = r.json()["document"]
        image_url = None
        if node_id:
            img = await c.get(f"https://api.figma.com/v1/images/{file_key}", params={"ids": node_id, "format": "png", "scale": 2})
            if img.status_code == 200:
                image_url = img.json().get("images", {}).get(node_id)
    return {"file_key": file_key, "node_id": node_id, "image_png_url": image_url, "tree": flatten(doc)}
