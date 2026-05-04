"""
resume_templates.py  —  Resume PDF renderer with two professional templates.

Template 1 (Black)  — compact, 1-page style  (Umesh design)
Template 2 (Teal)   — spacious, 2-page style (Tarun design)

Flow:
  1. AI outputs structured Markdown
  2. parse_resume_markdown()  → structured dict
  3. estimate_pages()         → pick template automatically
  4. render_to_pdf()          → bytes (PDF)
"""

import re
import io
from typing import Optional


# ── Constants ──────────────────────────────────────────────────────────────────
TEAL   = "#1A7A8A"
BLACK  = "#000000"
GRAY   = "#555555"
FONT   = "Arial, Helvetica, sans-serif"

# Lines-of-content threshold: above this → use 2-page template
PAGE2_THRESHOLD = 60


# ── Markdown parser ────────────────────────────────────────────────────────────

def _strip_md_bold(text: str) -> str:
    """Remove ** markers but keep text."""
    return re.sub(r'\*\*(.+?)\*\*', r'\1', text)


def _strip_md_italic(text: str) -> str:
    """Remove * markers but keep text."""
    return re.sub(r'(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)', r'\1', text)


def _strip_md(text: str) -> str:
    return _strip_md_italic(_strip_md_bold(text)).strip()


def _html_esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _render_inline(text: str) -> str:
    """Convert **bold** and *italic* in a line to HTML spans."""
    text = _html_esc(text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
    text = re.sub(r'(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)', r'<em>\1</em>', text)
    return text


def _is_company_line(line: str) -> bool:
    """Detect lines like: **Company** | **Title** | Jan 2024 – Present"""
    if "**" not in line:
        return False
    date_pat = re.compile(
        r'(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*'
        r'\s*\d{4}\s*[–—-]+\s*(Present|\w+\s*\d{0,4})',
        re.IGNORECASE,
    )
    return bool(date_pat.search(line))


def _parse_company_line(line: str) -> dict:
    """Parse **Company** | **Title** | Date → {company, title, date}"""
    date_pat = re.compile(
        r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*'
        r'\s*\d{4}\s*[–—-]+\s*(?:Present|\w+\s*\d{0,4}))',
        re.IGNORECASE,
    )
    m = date_pat.search(line)
    date = m.group(1).strip() if m else ""
    left = line[:m.start()].strip() if m else line.strip()
    parts = [p.strip() for p in left.split("|")]
    company = _strip_md(parts[0]) if parts else ""
    title   = _strip_md(parts[1]) if len(parts) > 1 else ""
    return {"company": company, "title": title, "date": date}


def _is_project_line(line: str) -> bool:
    """Detect project header: **Name** — *Tech: ...*  or  **Name** — Tech Stack: ..."""
    return bool(re.match(r'\*\*.+\*\*\s*[—–-]', line.strip()))


def _parse_project_line(line: str) -> dict:
    """Parse **Project Name** — *Tech Stack: x, y* → {name, tech}"""
    parts = re.split(r'\s*[—–-]\s*', line.strip(), maxsplit=1)
    name = _strip_md(parts[0]) if parts else ""
    tech = _strip_md(parts[1]) if len(parts) > 1 else ""
    tech = re.sub(r'^(tech stack|tech|stack)\s*:\s*', '', tech, flags=re.IGNORECASE).strip()
    return {"name": name, "tech": tech}


def _is_skills_line(line: str) -> bool:
    """Detect  **Category:** items  or  Category: items"""
    return bool(re.match(r'\*?\*?[A-Za-z &/]+\*?\*?:', line.strip()))


def _parse_skills_line(line: str) -> dict:
    """Parse **Languages & OOP:** Python, SQL → {label, items}"""
    m = re.match(r'\*?\*?(.+?)\*?\*?:\s*(.*)', line.strip())
    if m:
        return {"label": m.group(1).strip(), "items": m.group(2).strip()}
    return {"label": "", "items": line.strip()}


def parse_resume_markdown(text: str) -> dict:
    """
    Parse AI-generated Markdown resume into a structured dict.

    Returns:
    {
        "name": str,
        "contact": str,
        "sections": [
            {"type": "summary",  "title": str, "text": str},
            {"type": "experience","title": str, "entries": [...]},
            {"type": "skills",   "title": str, "categories": [...]},
            {"type": "education","title": str, "entries": [...]},
            {"type": "certifications","title": str,"items": [str]},
            {"type": "projects", "title": str, "entries": [...]},
            {"type": "generic",  "title": str, "lines": [str]},
        ]
    }
    """
    from core.resume_normalizer import get_canonical_section

    lines  = text.split("\n")
    result = {"name": "", "contact": "", "sections": []}

    name_done    = False
    contact_done = False
    current_sec  = None   # dict being built
    current_ent  = None   # current experience/project/education entry

    def flush_entry():
        nonlocal current_ent
        if current_ent and current_sec:
            current_sec.setdefault("entries", []).append(current_ent)
        current_ent = None

    def flush_section():
        nonlocal current_sec, current_ent
        flush_entry()
        if current_sec:
            result["sections"].append(current_sec)
        current_sec = None

    for raw in lines:
        line = raw.strip()

        # ── Name ────────────────────────────────────────────────────────────
        if not name_done:
            if line.startswith("# "):
                result["name"] = line[2:].strip()
                name_done = True
                continue
            if line and "@" not in line and "|" not in line:
                result["name"] = _strip_md(line)
                name_done = True
                continue

        # ── Contact ──────────────────────────────────────────────────────────
        if name_done and not contact_done:
            if line and ("|" in line or "@" in line):
                result["contact"] = _strip_md(line)
                contact_done = True
                continue
            if line and not line.startswith("#"):
                # might be city/name continuation — skip
                continue

        # ── Section header ────────────────────────────────────────────────────
        if line.startswith("## "):
            flush_section()
            title     = line[3:].strip()
            canonical = get_canonical_section(title) or title.lower()
            current_sec = {"type": canonical, "title": title}
            continue

        # Fallback: ALL-CAPS line as section header (plain text output)
        if (line and not line.startswith("-") and not line.startswith("•")
                and not line.startswith("*") and not line.startswith("#")
                and line == line.upper() and len(line) > 3
                and get_canonical_section(line)):
            flush_section()
            canonical = get_canonical_section(line)
            current_sec = {"type": canonical, "title": line}
            continue

        if not current_sec or not line:
            continue

        sec_type = current_sec.get("type", "generic")

        # ── SUMMARY ──────────────────────────────────────────────────────────
        if sec_type == "summary":
            current_sec["text"] = current_sec.get("text", "") + (" " if current_sec.get("text") else "") + _strip_md(line)
            continue

        # ── EXPERIENCE ───────────────────────────────────────────────────────
        if sec_type == "experience":
            if _is_company_line(line):
                flush_entry()
                current_ent = _parse_company_line(line)
                current_ent["location"] = ""
                current_ent["bullets"]  = []
                continue
            if current_ent is not None:
                if line.startswith("*") and not line.startswith("**"):
                    current_ent["location"] = _strip_md(line)
                elif line.startswith(("-", "•", "●")):
                    current_ent["bullets"].append(_strip_md(line.lstrip("-•● ").strip()))
                else:
                    # sub-role label (e.g. italicized project name in Umesh template)
                    current_ent.setdefault("sub_roles", [])
                    if _strip_md(line):
                        current_ent["sub_roles"].append(_strip_md(line))
            continue

        # ── PROJECTS ─────────────────────────────────────────────────────────
        if sec_type == "projects":
            if _is_project_line(line):
                flush_entry()
                current_ent = _parse_project_line(line)
                current_ent["bullets"] = []
                continue
            if line.startswith("**") and not _is_project_line(line):
                # Plain bold project name
                flush_entry()
                current_ent = {"name": _strip_md(line), "tech": "", "bullets": []}
                continue
            if current_ent is not None and line.startswith(("-", "•", "●")):
                current_ent["bullets"].append(_strip_md(line.lstrip("-•● ").strip()))
            continue

        # ── SKILLS ───────────────────────────────────────────────────────────
        if sec_type == "skills":
            if _is_skills_line(line):
                current_sec.setdefault("categories", []).append(_parse_skills_line(line))
            else:
                current_sec.setdefault("categories", []).append({"label": "", "items": _strip_md(line)})
            continue

        # ── EDUCATION ────────────────────────────────────────────────────────
        if sec_type == "education":
            if line.startswith("**") or (line and not line.startswith(("-", "•", "*"))):
                clean = _strip_md(line)
                if clean:
                    # New education entry if the line looks like a degree title
                    if re.search(r'(master|bachelor|doctor|phd|mba|associate|b\.tech|m\.s|b\.s)', clean, re.I) or (current_ent is None):
                        if current_ent:
                            flush_entry()
                        current_ent = {"degree": clean, "school": "", "date": "", "details": []}
                    elif current_ent and not current_ent.get("school"):
                        current_ent["school"] = clean
                    else:
                        current_ent.setdefault("details", []).append(clean)
            elif line.startswith(("-", "•", "●")):
                if current_ent:
                    current_ent.setdefault("details", []).append(_strip_md(line.lstrip("-•● ").strip()))
            continue

        # ── CERTIFICATIONS ────────────────────────────────────────────────────
        if sec_type == "certifications":
            clean = _strip_md(line.lstrip("-•● ").strip())
            if clean:
                current_sec.setdefault("items", []).append(clean)
            continue

        # ── GENERIC (awards, languages, etc.) ────────────────────────────────
        current_sec.setdefault("lines", []).append(_strip_md(line))

    flush_section()
    return result


def estimate_pages(text: str) -> int:
    """Estimate how many pages this resume will need (1 or 2)."""
    content_lines = 0
    for line in text.split("\n"):
        s = line.strip()
        if not s:
            continue
        # Long lines wrap — count extra
        content_lines += max(1, len(s) // 90 + (1 if len(s) % 90 > 20 else 0))
    return 1 if content_lines < PAGE2_THRESHOLD else 2


# ── HTML/CSS Templates ─────────────────────────────────────────────────────────

def _build_html_template1(parsed: dict, font_scale: float = 1.0) -> str:
    """Template 1: Black, compact — Umesh style (1-page)."""

    def fs(pt): return f"{pt * font_scale:.1f}pt"

    sections_html = ""
    for sec in parsed.get("sections", []):
        t = sec.get("type", "generic")
        title = _html_esc(sec.get("title", t.upper()))

        sections_html += f"""
        <div class="section">
          <div class="section-header">{title}</div>
          <hr class="section-hr">
        """

        if t == "summary":
            sections_html += f'<p class="summary-text">{_html_esc(sec.get("text",""))}</p>'

        elif t == "experience":
            for ent in sec.get("entries", []):
                sections_html += f"""
                <div class="exp-entry">
                  <div class="exp-header">
                    <span class="exp-left"><strong>{_html_esc(ent.get("company",""))}</strong> | <em>{_html_esc(ent.get("title",""))}</em></span>
                    <span class="exp-date">{_html_esc(ent.get("date",""))}</span>
                  </div>"""
                if ent.get("location"):
                    sections_html += f'<div class="exp-location"><em>{_html_esc(ent["location"])}</em></div>'
                for sub in ent.get("sub_roles", []):
                    sections_html += f'<div class="sub-role"><em>{_html_esc(sub)}</em></div>'
                for b in ent.get("bullets", []):
                    sections_html += f'<div class="bullet">• {_html_esc(b)}</div>'
                sections_html += "</div>"

        elif t == "projects":
            for ent in sec.get("entries", []):
                name = _html_esc(ent.get("name", ""))
                tech = _html_esc(ent.get("tech", ""))
                sections_html += f'<div class="proj-header"><strong>{name}</strong>'
                if tech:
                    sections_html += f' — <em>Tech Stack: {tech}</em>'
                sections_html += "</div>"
                for b in ent.get("bullets", []):
                    sections_html += f'<div class="bullet">• {_html_esc(b)}</div>'

        elif t == "skills":
            for cat in sec.get("categories", []):
                label = _html_esc(cat.get("label", ""))
                items = _html_esc(cat.get("items", ""))
                if label:
                    sections_html += f'<div class="skills-line"><strong>{label}:</strong> {items}</div>'
                else:
                    sections_html += f'<div class="skills-line">{items}</div>'

        elif t == "education":
            for ent in sec.get("entries", []):
                sections_html += f'<div class="edu-entry">'
                sections_html += f'<div class="edu-degree"><strong>{_html_esc(ent.get("degree",""))}</strong></div>'
                if ent.get("school"):
                    sections_html += f'<div class="edu-school"><em>{_html_esc(ent["school"])}</em></div>'
                for d in ent.get("details", []):
                    sections_html += f'<div class="edu-detail">{_html_esc(d)}</div>'
                sections_html += "</div>"

        elif t == "certifications":
            for item in sec.get("items", []):
                sections_html += f'<div class="bullet">• {_html_esc(item)}</div>'

        else:
            for ln in sec.get("lines", []):
                sections_html += f'<div class="generic-line">{_html_esc(ln)}</div>'

        sections_html += "</div>"  # close section

    name    = _html_esc(parsed.get("name", ""))
    contact = _html_esc(parsed.get("contact", ""))

    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page {{
    size: letter;
    margin: 0.47in 0.4in 0.47in 0.4in;
  }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    font-family: {FONT};
    font-size: {fs(9)};
    color: {BLACK};
    line-height: 1.35;
  }}
  .name {{
    font-size: {fs(20)};
    font-weight: bold;
    text-align: center;
    margin-bottom: 2pt;
  }}
  .contact {{
    font-size: {fs(10)};
    text-align: center;
    margin-bottom: 3pt;
  }}
  .contact-hr {{
    border: none;
    border-top: 1pt solid {BLACK};
    margin: 3pt 0 6pt 0;
  }}
  .section {{
    margin-top: 5pt;
  }}
  .section-header {{
    font-size: {fs(11)};
    font-weight: bold;
    text-transform: uppercase;
    margin-bottom: 1pt;
  }}
  .section-hr {{
    border: none;
    border-top: 0.5pt solid #999;
    margin: 1pt 0 3pt 0;
  }}
  .summary-text {{
    font-size: {fs(9)};
    text-align: justify;
    margin-bottom: 2pt;
  }}
  .exp-entry {{ margin-bottom: 4pt; }}
  .exp-header {{
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: {fs(10)};
  }}
  .exp-left {{ font-size: {fs(10)}; }}
  .exp-date  {{ font-size: {fs(9)}; white-space: nowrap; }}
  .exp-location {{ font-size: {fs(9)}; font-style: italic; margin-bottom: 1pt; }}
  .sub-role  {{ font-size: {fs(9)}; font-style: italic; margin: 2pt 0 1pt 0; }}
  .bullet {{
    font-size: {fs(9)};
    padding-left: 12pt;
    text-indent: -8pt;
    margin-bottom: 1pt;
  }}
  .proj-header {{
    font-size: {fs(9.5)};
    margin-bottom: 1pt;
    margin-top: 2pt;
  }}
  .skills-line {{
    font-size: {fs(9)};
    margin-bottom: 1pt;
  }}
  .edu-entry {{ margin-bottom: 3pt; }}
  .edu-degree {{ font-size: {fs(10)}; }}
  .edu-school {{ font-size: {fs(9)}; }}
  .edu-detail {{ font-size: {fs(9)}; }}
  .generic-line {{ font-size: {fs(9)}; margin-bottom: 1pt; }}
</style>
</head>
<body>
  <div class="name">{name}</div>
  <div class="contact">{contact}</div>
  <hr class="contact-hr">
  {sections_html}
</body>
</html>"""


def _build_html_template2(parsed: dict, font_scale: float = 1.0) -> str:
    """Template 2: Teal accent, spacious — Tarun style (2-page)."""

    def fs(pt): return f"{pt * font_scale:.1f}pt"

    sections_html = ""
    for sec in parsed.get("sections", []):
        t     = sec.get("type", "generic")
        title = _html_esc(sec.get("title", t.upper()))

        sections_html += f"""
        <div class="section">
          <div class="section-header">{title}</div>
        """

        if t == "summary":
            sections_html += f'<p class="summary-text">{_html_esc(sec.get("text",""))}</p>'

        elif t == "experience":
            for ent in sec.get("entries", []):
                company = _html_esc(ent.get("company", ""))
                jobtitle = _html_esc(ent.get("title", ""))
                date    = _html_esc(ent.get("date", ""))
                sections_html += f"""
                <div class="exp-entry">
                  <div class="exp-header">
                    <span class="exp-left"><strong>{company}</strong> | <strong class="teal">{jobtitle}</strong></span>
                    <span class="exp-date"><em>{date}</em></span>
                  </div>"""
                if ent.get("location"):
                    sections_html += f'<div class="exp-location"><em>{_html_esc(ent["location"])}</em></div>'
                for sub in ent.get("sub_roles", []):
                    sections_html += f'<div class="sub-role"><em>{_html_esc(sub)}</em></div>'
                for b in ent.get("bullets", []):
                    sections_html += f'<div class="bullet">• {_html_esc(b)}</div>'
                sections_html += "</div>"

        elif t == "projects":
            for ent in sec.get("entries", []):
                name = _html_esc(ent.get("name", ""))
                tech = _html_esc(ent.get("tech", ""))
                sections_html += f'<div class="proj-header"><strong>{name}</strong>'
                if tech:
                    sections_html += f' — <em>Tech Stack: {tech}</em>'
                sections_html += "</div>"
                for b in ent.get("bullets", []):
                    sections_html += f'<div class="bullet">• {_html_esc(b)}</div>'

        elif t == "skills":
            for cat in sec.get("categories", []):
                label = _html_esc(cat.get("label", ""))
                items = _html_esc(cat.get("items", ""))
                if label:
                    sections_html += f'<div class="skills-line"><strong class="teal">{label}:</strong> {items}</div>'
                else:
                    sections_html += f'<div class="skills-line">{items}</div>'

        elif t == "education":
            for ent in sec.get("entries", []):
                sections_html += f'<div class="edu-entry">'
                sections_html += f'<div class="edu-degree"><strong>{_html_esc(ent.get("degree",""))}</strong></div>'
                if ent.get("school"):
                    sections_html += f'<div class="edu-school">{_html_esc(ent["school"])}</div>'
                for d in ent.get("details", []):
                    sections_html += f'<div class="edu-detail"><strong>Relevant Coursework:</strong> {_html_esc(d.replace("Relevant Coursework:","").strip()) if "Coursework" in d else _html_esc(d)}</div>'
                sections_html += "</div>"

        elif t == "certifications":
            for item in sec.get("items", []):
                sections_html += f'<div class="bullet">• {_html_esc(item)}</div>'

        else:
            for ln in sec.get("lines", []):
                sections_html += f'<div class="generic-line">{_html_esc(ln)}</div>'

        sections_html += "</div>"  # close section

    name    = _html_esc(parsed.get("name", ""))
    contact = _html_esc(parsed.get("contact", ""))

    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page {{
    size: letter;
    margin: 0.5in 0.45in 0.5in 0.45in;
  }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    font-family: {FONT};
    font-size: {fs(9.5)};
    color: {BLACK};
    line-height: 1.4;
  }}
  .teal {{ color: {TEAL}; }}
  .name {{
    font-size: {fs(22)};
    font-weight: bold;
    text-align: center;
    margin-bottom: 3pt;
  }}
  .contact {{
    font-size: {fs(10)};
    text-align: center;
    margin-bottom: 6pt;
  }}
  .section {{
    margin-top: 8pt;
  }}
  .section-header {{
    font-size: {fs(11)};
    font-weight: bold;
    color: {TEAL};
    border-bottom: 1.5pt solid {TEAL};
    padding-bottom: 1pt;
    margin-bottom: 4pt;
    text-transform: uppercase;
  }}
  .summary-text {{
    font-size: {fs(9.5)};
    text-align: justify;
    margin-bottom: 3pt;
  }}
  .exp-entry {{ margin-bottom: 6pt; }}
  .exp-header {{
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }}
  .exp-left  {{ font-size: {fs(10)}; }}
  .exp-date  {{ font-size: {fs(9.5)}; white-space: nowrap; }}
  .exp-location {{ font-size: {fs(9.5)}; font-style: italic; margin-bottom: 2pt; }}
  .sub-role  {{ font-size: {fs(9.5)}; font-style: italic; margin: 3pt 0 1pt 0; }}
  .bullet {{
    font-size: {fs(9.5)};
    padding-left: 13pt;
    text-indent: -8pt;
    margin-bottom: 2pt;
    text-align: justify;
  }}
  .proj-header {{
    font-size: {fs(10)};
    font-weight: bold;
    margin-top: 3pt;
    margin-bottom: 2pt;
  }}
  .skills-line {{
    font-size: {fs(9.5)};
    margin-bottom: 2pt;
  }}
  .edu-entry {{ margin-bottom: 4pt; }}
  .edu-degree {{ font-size: {fs(10.5)}; }}
  .edu-school {{ font-size: {fs(9.5)}; margin-bottom: 1pt; }}
  .edu-detail {{ font-size: {fs(9.5)}; }}
  .generic-line {{ font-size: {fs(9.5)}; margin-bottom: 2pt; }}
</style>
</head>
<body>
  <div class="name">{name}</div>
  <div class="contact">{contact}</div>
  {sections_html}
</body>
</html>"""


# ── Renderer ───────────────────────────────────────────────────────────────────

def render_to_pdf(
    markdown_text: str,
    max_pages: int = 0,
    template: Optional[int] = None,
) -> bytes:
    """
    Convert Markdown resume text → PDF bytes.

    Args:
        markdown_text: AI-generated Markdown resume
        max_pages:     0 = auto-detect, 1 = force 1-page, 2 = force 2-page
        template:      None = auto-select, 1 = black, 2 = teal

    Returns:
        PDF as bytes
    """
    from weasyprint import HTML as WeasyprintHTML

    parsed = parse_resume_markdown(markdown_text)

    # Auto-select template based on content volume
    if template is None:
        auto_pages = estimate_pages(markdown_text)
        template = 1 if (max_pages == 1 or (max_pages == 0 and auto_pages == 1)) else 2

    build_fn = _build_html_template1 if template == 1 else _build_html_template2

    # Try at full scale first
    for scale in [1.0, 0.95, 0.90, 0.85, 0.80, 0.75]:
        html_str = build_fn(parsed, font_scale=scale)
        pdf_bytes = WeasyprintHTML(string=html_str).write_pdf()

        if max_pages == 0:
            return pdf_bytes  # No page limit — return immediately

        # Count pages in output
        try:
            from pypdf import PdfReader
            page_count = len(PdfReader(io.BytesIO(pdf_bytes)).pages)
            if page_count <= max_pages:
                return pdf_bytes
        except Exception:
            return pdf_bytes  # Can't count — return as-is

    # Last resort: smallest scale
    return WeasyprintHTML(string=build_fn(parsed, font_scale=0.75)).write_pdf()
