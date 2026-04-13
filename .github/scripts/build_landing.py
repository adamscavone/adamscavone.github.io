#!/usr/bin/env python3
"""Scan the adamscavone.github.io repo root for protected-page subdirectories
and regenerate index.html so the landing page always reflects current pages.

Discovery rules:
  - Any top-level directory containing `index.html` is a candidate.
  - Excluded: `.git`, `.github`, directories starting with `_` or `.`.
  - Metadata priority:
      1. `{dir}/_meta.json` if present, with keys: title, description, added.
      2. Hardcoded override in OVERRIDES below (for directories we can't add
         `_meta.json` to, e.g. legacy paths).
      3. Fallback: title derived from directory name (kebab-case → Title Case).

The regenerated `index.html` lives at repo root. Run this from inside the
`adamscavone.github.io` checkout:

    python3 build_landing.py

Intended to be invoked by a GitHub Action on every push to main; see
`.github/workflows/landing.yml`.
"""
import json
import pathlib
import sys
import html as html_lib

REPO_ROOT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path.cwd()
OUT = REPO_ROOT / "index.html"

# Overrides for directories we don't control or don't want to add _meta.json to.
OVERRIDES = {
    "security": {
        "title": "Kondo Wave 1 — Security Review",
        "description": "AES-256-GCM-encrypted security review for Project Kondo Wave 1. Password-protected.",
        "added": "2026-04-12",
    },
}

# Directories to skip entirely
EXCLUDES = {".git", ".github", "node_modules", "tmp-clone"}


def title_case_from_slug(slug: str) -> str:
    return " ".join(w.capitalize() for w in slug.replace("-", " ").replace("_", " ").split())


def discover_pages():
    pages = []
    for entry in sorted(REPO_ROOT.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name in EXCLUDES:
            continue
        if entry.name.startswith(".") or entry.name.startswith("_"):
            continue
        index = entry / "index.html"
        if not index.exists():
            continue

        meta_path = entry / "_meta.json"
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception as e:
                print(f"WARN: bad _meta.json in {entry.name}: {e}", file=sys.stderr)
                meta = {}
        elif entry.name in OVERRIDES:
            meta = OVERRIDES[entry.name]
        else:
            meta = {}

        title = meta.get("title") or title_case_from_slug(entry.name)
        description = meta.get("description", "")
        added = meta.get("added", "")

        pages.append({
            "path": entry.name,
            "title": title,
            "description": description,
            "added": added,
        })

    # Sort by "added" descending (newest first); items without "added" sort last
    pages.sort(key=lambda p: (p["added"] == "", p["added"]), reverse=True)
    return pages


def render_index(pages) -> str:
    cards_html = []
    for p in pages:
        title = html_lib.escape(p["title"])
        desc = html_lib.escape(p["description"])
        added = html_lib.escape(p["added"])
        href = f"/{p['path']}/"
        cards_html.append(f"""  <a class="card" href="{href}">
    <div class="card-body">
      <h2 class="card-title">{title}</h2>
      {f'<p class="card-desc">{desc}</p>' if desc else ''}
      {f'<div class="card-meta">Added {added}</div>' if added else ''}
    </div>
    <div class="card-arrow">→</div>
  </a>""")

    cards_block = "\n".join(cards_html) if cards_html else '<p class="empty">No pages yet.</p>'

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark">
<title>Adam Scavone — Protected Documents</title>
<style>
  :root {{
    --bg: #0b0d10;
    --bg-card: #1a1e24;
    --fg: #e6e8eb;
    --fg-dim: #9aa0a6;
    --fg-muted: #6b7075;
    --accent: #8ab4f8;
    --border: #2d3239;
  }}
  /* Night mode locked — no light-mode fallback */
  * {{ box-sizing: border-box; }}
  html, body {{ margin: 0; padding: 0; background: var(--bg); color: var(--fg); }}
  body {{
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }}
  .wrap {{
    max-width: 640px;
    margin: 0 auto;
    padding: 2.5rem 1rem 4rem;
  }}
  header {{ margin-bottom: 2rem; }}
  h1 {{
    font-size: 1.4rem;
    margin: 0 0 .35rem;
    font-weight: 700;
  }}
  .tagline {{
    color: var(--fg-dim);
    font-size: .85rem;
    margin: 0 0 .6rem;
  }}
  .lock-note {{
    display: inline-flex;
    align-items: center;
    gap: .35rem;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: .35rem .7rem;
    color: var(--fg-muted);
    font-size: .75rem;
  }}
  .cards {{
    display: flex;
    flex-direction: column;
    gap: .75rem;
  }}
  .card {{
    display: flex;
    align-items: center;
    gap: 1rem;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1rem 1.15rem;
    color: var(--fg);
    text-decoration: none;
    transition: border-color .15s, transform .1s;
  }}
  .card:hover, .card:focus {{
    border-color: var(--accent);
    outline: none;
  }}
  .card:active {{ transform: scale(0.995); }}
  .card-body {{ flex: 1; min-width: 0; }}
  .card-title {{
    margin: 0 0 .2rem;
    font-size: 1rem;
    font-weight: 700;
    line-height: 1.3;
  }}
  .card-desc {{
    margin: 0;
    color: var(--fg-dim);
    font-size: .82rem;
    line-height: 1.4;
  }}
  .card-meta {{
    margin-top: .35rem;
    color: var(--fg-muted);
    font-size: .72rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }}
  .card-arrow {{
    color: var(--accent);
    font-size: 1.25rem;
    flex-shrink: 0;
  }}
  footer {{
    margin-top: 2.5rem;
    color: var(--fg-muted);
    font-size: .7rem;
    line-height: 1.5;
  }}
  .empty {{
    color: var(--fg-dim);
    font-style: italic;
    text-align: center;
  }}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Private work space</h1>
    <p class="tagline">Direct links only. Each page is password-protected.</p>
    <span class="lock-note">🔒 Passwords not indexed or cached</span>
  </header>
  <main class="cards">
{cards_block}
  </main>
  <footer>
    noindex, nofollow. Feedback on hosted content lives inside each page and never leaves the device on which it was typed.
  </footer>
</div>
</body>
</html>
"""


def main():
    pages = discover_pages()
    html = render_index(pages)
    OUT.write_text(html, encoding="utf-8")
    print(f"Wrote {OUT} with {len(pages)} page(s):")
    for p in pages:
        print(f"  /{p['path']}/  — {p['title']}")


if __name__ == "__main__":
    main()
