"""
scripts/build_pages.py — Build a static GitHub-Pages-deployable copy of the
JobPilot frontend under ./docs/.

What it does:
  1. Reads jobpilot/templates/base.html and inlines its blocks with the child
     templates (landing.html → docs/index.html, index.html → docs/app.html).
  2. Strips all Jinja syntax (`{% extends %}`, `{% block %}...{% endblock %}`,
     `{{ var }}`) and substitutes known template variables from env vars.
  3. Rewrites absolute `/static/*` and `/app`, `/`, `/terms`, `/privacy`
     references so they work from a static directory hosted at
     `<user>.github.io/<repo>/`.
  4. Copies jobpilot/static/ → docs/static/.

Usage:
    python scripts/build_pages.py

Env vars (optional):
    GOOGLE_CLIENT_ID    — substituted into the `{{ google_client_id }}` slot
                          on the landing page. If empty, the GSI button stays
                          hidden and only "Try Demo" is reachable.

This script is intentionally pure-Python stdlib (no Jinja2 dep) so it runs
on a clean GitHub Actions runner without any pip install.
"""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TPL_DIR = ROOT / "jobpilot" / "templates"
STATIC_SRC = ROOT / "jobpilot" / "static"
DOCS = ROOT / "docs"
STATIC_DST = DOCS / "static"

# Regex for Jinja block tags. Non-greedy + DOTALL so a block can span many
# lines but cannot accidentally swallow the next block's endblock.
_BLOCK_RE = re.compile(
    r"{%\s*block\s+(\w+)\s*%}(.*?){%\s*endblock(?:\s+\w+)?\s*%}",
    re.DOTALL,
)
_EXTENDS_RE = re.compile(r"{%\s*extends[^%]+%}\s*")


def _extract_blocks(child_html: str) -> dict[str, str]:
    """Return {block_name: inner_html} for every top-level block in child."""
    return {m.group(1): m.group(2) for m in _BLOCK_RE.finditer(child_html)}


def _apply_blocks(base_html: str, blocks: dict[str, str]) -> str:
    """Replace each block in base with the matching child block, falling
    back to the base's own default content when the child doesn't override
    that block (mirrors Jinja's behavior)."""
    def sub(match: re.Match[str]) -> str:
        name = match.group(1)
        default = match.group(2)
        return blocks.get(name, default)

    return _BLOCK_RE.sub(sub, base_html)


def _substitute_vars(html: str) -> str:
    """Replace `{{ var }}` placeholders with values from env vars."""
    google_client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    html = html.replace("{{ google_client_id }}", google_client_id)
    # Strip any remaining `{{ ... }}` so dangling expressions don't render.
    html = re.sub(r"{{\s*[^}]+\s*}}", "", html)
    return html


# Pairs of (search, replace) applied as plain text. Order matters — replace
# more specific patterns first.
_TEXT_REWRITES: list[tuple[str, str]] = [
    # Static asset paths: /static/X → static/X
    ('"/static/', '"static/'),
    ("'/static/", "'static/"),
    # Internal navigation
    ('href="/app"', 'href="app.html"'),
    ("href='/app'", "href='app.html'"),
    ('href="/"', 'href="index.html"'),
    ("href='/'", "href='index.html'"),
    # /terms and /privacy don't exist statically — point at the landing
    # anchor to avoid 404s.
    ('href="/terms"', 'href="index.html#terms"'),
    ('href="/privacy"', 'href="index.html#privacy"'),
    # Inline-script navigation
    ("window.location.href = '/app'", "window.location.href = 'app.html'"),
    ('window.location.href = "/app"', 'window.location.href = "app.html"'),
    ("window.location.replace('/app')", "window.location.replace('app.html')"),
    ('window.location.replace("/app")', 'window.location.replace("app.html")'),
    ("window.location.replace('/')", "window.location.replace('index.html')"),
    ('window.location.replace("/")', 'window.location.replace("index.html")'),
]


def _apply_text_rewrites(html: str) -> str:
    for old, new in _TEXT_REWRITES:
        html = html.replace(old, new)
    return html


def render(child_template: str, out_name: str) -> None:
    base = (TPL_DIR / "base.html").read_text(encoding="utf-8")
    child = (TPL_DIR / child_template).read_text(encoding="utf-8")

    # 1. Strip `{% extends %}` from child (already implicit by merging)
    child_stripped = _EXTENDS_RE.sub("", child)

    # 2. Pull each block out of the child
    blocks = _extract_blocks(child_stripped)

    # 3. Inline them into the base template
    merged = _apply_blocks(base, blocks)

    # 4. Strip any leftover Jinja constructs in the merged output
    merged = _substitute_vars(merged)

    # 5. Rewrite absolute paths for static hosting
    merged = _apply_text_rewrites(merged)

    out = DOCS / out_name
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(merged, encoding="utf-8")
    print(f"  wrote {out.relative_to(ROOT)} ({len(merged):,} bytes)")


def main() -> int:
    if DOCS.exists():
        shutil.rmtree(DOCS)
    DOCS.mkdir()

    print(f"Copying static assets from {STATIC_SRC.relative_to(ROOT)}/...")
    shutil.copytree(STATIC_SRC, STATIC_DST)
    print(f"  copied -> {STATIC_DST.relative_to(ROOT)}/")

    # Also copy the SVG favicon if it lives at the static root (it does).
    print("Rendering HTML pages...")
    render("landing.html", "index.html")
    render("index.html", "app.html")

    # 404.html: serve the landing page so deep-linked typos still load
    # something useful instead of GitHub's default 404.
    shutil.copy(DOCS / "index.html", DOCS / "404.html")
    print(f"  wrote {(DOCS / '404.html').relative_to(ROOT)} (copy of index.html)")

    # .nojekyll: prevent GitHub Pages from running Jekyll over the artifact
    # (we ship `_`-prefixed paths via cdnjs URLs that Jekyll would otherwise
    # try to interpret).
    (DOCS / ".nojekyll").write_text("", encoding="utf-8")
    print(f"  wrote {(DOCS / '.nojekyll').relative_to(ROOT)}")

    print(f"\nDone. {DOCS.relative_to(ROOT)}/ is ready to deploy.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
