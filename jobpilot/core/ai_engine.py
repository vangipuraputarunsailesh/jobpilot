"""
ai_engine.py  —  All AI logic powered by Claude

Functions:
  score_ats()                 — ATS score with category breakdown
  tailor_resume()             — Full resume tailoring for a specific job
  improve_line()              — Improve a single bullet with AI
  apply_chat_instruction()    — Apply ANY natural language change to resume
  suggest_certifications()    — Smart cert suggestions based on job + role
  answer_screening_question() — Answer application screening questions
"""

import anthropic
import json
import logging
import re
import os
from core.resume_normalizer import (
    normalize_resume, get_canonical_section,
    NORMALIZATION_RULES, SECTION_SYNONYMS,
)

logger = logging.getLogger("jobpilot")

# NOTE: do NOT call load_dotenv here. The single source of truth is app.py
# (Issue #10). Importing this module never triggers env file loading.


CHAT_HISTORY_MAX_MESSAGES = 8


def _clean_resume(text: str) -> str:
    """
    Clean up common AI formatting artifacts from resume output:
    - Collapse 3+ consecutive blank lines into max 1 blank line
    - Remove trailing whitespace from every line
    - Strip trailing blank lines at end of document
    """
    lines = text.split('\n')
    # Strip trailing whitespace from each line
    lines = [l.rstrip() for l in lines]
    # Collapse consecutive blank lines (3+ → 1)
    cleaned = []
    blank_count = 0
    for line in lines:
        if line == '':
            blank_count += 1
            if blank_count <= 1:
                cleaned.append(line)
        else:
            blank_count = 0
            cleaned.append(line)
    # Strip trailing blank lines at end
    while cleaned and cleaned[-1] == '':
        cleaned.pop()
    return '\n'.join(cleaned)


# Phase 2 BYOK — Anthropic clients are now keyed on the API key string so
# real users (each with their own key) and the demo account can share the
# same process without leaking each other's connections. We memoise one
# `anthropic.Anthropic` instance per key so the underlying HTTPX connection
# pool is reused across calls (Issue #11 — connection-reuse goal preserved).
_CLIENT_BY_KEY: dict[str, anthropic.Anthropic] = {}


# Default Claude model. Override per-request with the `X-Claude-Model`
# header (preferred) or the legacy `CLAUDE_MODEL` env var (demo fallback).
# The previous default `claude-sonnet-4-6` is NOT a real Anthropic SKU
# (Issue #84) — the stable alias `claude-sonnet-4-5` is current.
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-5")


def _resolve_key_and_model() -> tuple[str, str]:
    """Resolve the Anthropic API key + model for the *current* request.

    Order of precedence:
      1. `flask.g.anthropic_key` / `flask.g.claude_model` — set by the
         BYOK helper in each route (`require_api_key`). This is the
         normal production path for real Google-signed-in users.
      2. `ANTHROPIC_API_KEY` / `CLAUDE_MODEL` env vars — fallback for the
         demo account, for CLI / pytest harnesses with no Flask context,
         and for legacy scripts that import ai_engine directly.
    """
    key = ""
    model = CLAUDE_MODEL
    try:
        from flask import g, has_request_context  # local import — keep
        # ai_engine importable outside Flask.
        if has_request_context():
            key = getattr(g, "anthropic_key", "") or ""
            model = getattr(g, "claude_model", "") or CLAUDE_MODEL
    except Exception:  # noqa: BLE001 — never fail AI calls on flask glue
        pass
    if not key:
        key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        raise ValueError(
            "Anthropic API key not provided. Real users: open Settings and "
            "paste your key. Demo / CLI: set ANTHROPIC_API_KEY in .env."
        )
    return key, model


def _client(api_key: str | None = None) -> anthropic.Anthropic:
    """Return a memoised `anthropic.Anthropic` for the given (or current) key.

    Passing `api_key` explicitly bypasses the Flask context lookup —
    useful for the `/api/byok/test` probe which needs to validate a key
    *before* it is saved to the request bundle.
    """
    if api_key is None:
        api_key, _ = _resolve_key_and_model()
    client = _CLIENT_BY_KEY.get(api_key)
    if client is None:
        client = anthropic.Anthropic(api_key=api_key)
        _CLIENT_BY_KEY[api_key] = client
    return client


def _call(prompt: str, max_tokens: int = 2000) -> str:
    """Single Claude call, returns text."""
    api_key, model = _resolve_key_and_model()
    msg = _client(api_key).messages.create(
        model=model,
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}]
    )
    return msg.content[0].text.strip()


def _call_json(prompt: str, max_tokens: int = 800) -> dict:
    """Claude call expecting JSON back."""
    raw = _call(prompt, max_tokens)
    raw = re.sub(r"```json|```", "", raw).strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # Try to extract JSON from response
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if m:
            return json.loads(m.group())
        raise


# Issue #90 — shared truncation helper. Every Claude-bound input field clipped
# by these limits must surface the clip back to the caller so the UI can warn
# the user (otherwise their most recent role / longest JD section is silently
# lost). Returns the (possibly clipped) text and a `(label, original, limit)`
# triple to be combined into a single human-readable warning by the caller.
def _truncate(text: str, limit: int, label: str) -> tuple[str, tuple[str, int, int] | None]:
    if text is None:
        return "", None
    if len(text) <= limit:
        return text, None
    return text[:limit], (label, len(text), limit)


def _format_truncation_warning(parts: list[tuple[str, int, int] | None]) -> str:
    """Build a single human-readable warning string from the per-field tuples."""
    fragments = [
        f"{label} ({original:,} \u2192 {limit:,} chars)"
        for entry in parts
        if entry is not None
        for label, original, limit in (entry,)
    ]
    if not fragments:
        return ""
    return "Input was truncated for AI processing: " + ", ".join(fragments) + "."


def _extract_skill_candidates(text: str, limit: int = 40) -> list[str]:
    """Extract likely skill/tool keywords from free text and deduplicate them."""
    candidates = []
    for line in text.splitlines():
        upper = line.upper()
        if any(k in upper for k in ("SKILLS", "TOOLS", "TECHNOLOG", "STACK", "FRAMEWORK", "LANGUAGE")):
            parts = re.split(r"[,|/]|\s{2,}", line)
            candidates.extend(parts)

    # Also capture common tech tokens from the whole text.
    candidates.extend(re.findall(r"\b[A-Za-z][A-Za-z0-9.+#-]{1,24}\b", text))

    out = []
    seen = set()
    stop = {"and", "with", "from", "that", "this", "have", "using", "years", "experience", "skills", "tools"}
    for raw in candidates:
        tok = raw.strip(" -:\t").lower()
        if len(tok) < 2 or tok in stop:
            continue
        if tok in seen:
            continue
        seen.add(tok)
        out.append(raw.strip())
        if len(out) >= limit:
            break
    return out


def _truncate_bullets(text: str, max_bullets: int = 14, max_chars_each: int = 170) -> list[str]:
    """Keep only a compact bullet sample for scoring context."""
    bullets = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith(("-", "*", "•")) or re.match(r"^\d+[.)]", s):
            bullets.append(s[:max_chars_each])
            if len(bullets) >= max_bullets:
                break
    return bullets


def _compact_scoring_payload(resume_text: str, job_description: str) -> tuple[str, str]:
    """Build compact resume/JD snippets for low-cost ATS scoring passes."""
    key_headers = ("SUMMARY", "EXPERIENCE", "SKILLS", "TECHNICAL", "PROJECT", "CERTIFICATION", "EDUCATION")

    def pick_key_lines(text: str, max_lines: int = 55) -> list[str]:
        selected = []
        current_header = ""
        for line in text.splitlines():
            s = line.strip()
            if not s:
                continue
            upper = s.upper()
            is_header = upper == s and 3 <= len(s) <= 35 and any(h in upper for h in key_headers)
            if is_header:
                current_header = upper
                selected.append(s)
                continue
            if any(h in current_header for h in key_headers):
                selected.append(s)
            elif len(selected) < 8:
                # Keep a small opening context even before section detection.
                selected.append(s)
            if len(selected) >= max_lines:
                break
        return selected

    resume_lines = pick_key_lines(resume_text)
    jd_lines = pick_key_lines(job_description, max_lines=40)
    resume_skills = _extract_skill_candidates(resume_text, limit=35)
    jd_skills = _extract_skill_candidates(job_description, limit=30)
    bullets = _truncate_bullets(resume_text, max_bullets=12, max_chars_each=150)

    compact_resume = (
        "KEY RESUME SECTIONS:\n"
        + "\n".join(resume_lines)
        + "\n\nDEDUPED RESUME SKILLS:\n"
        + ", ".join(resume_skills)
        + "\n\nRESUME BULLET SAMPLE:\n"
        + "\n".join(bullets)
    )[:3200]

    compact_jd = (
        "KEY JOB DESCRIPTION SECTIONS:\n"
        + "\n".join(jd_lines)
        + "\n\nDEDUPED JD SKILLS:\n"
        + ", ".join(jd_skills)
    )[:2200]

    return compact_resume, compact_jd


def _summarize_older_history(history: list, max_items: int = 12, max_chars_each: int = 120) -> str:
    """Create a short deterministic memory block for older chat turns."""
    if not history:
        return ""

    tail = history[-max_items:]
    lines = []
    for msg in tail:
        role = "User" if msg.get("role") == "user" else "Assistant"
        text = str(msg.get("text", "")).replace("\n", " ").strip()
        if not text:
            continue
        lines.append(f"- {role}: {text[:max_chars_each]}")

    if not lines:
        return ""
    return "Earlier conversation summary (compressed):\n" + "\n".join(lines)


# ── ATS Scoring ───────────────────────────────────────────────────────────────

def score_ats(resume_text: str, job_description: str, compact_mode: bool = False) -> dict:
    """
    Score a resume against a job description.
    Returns: score, verdict, categories, matched/missing keywords, tip
    Includes a `truncation_warning` field when inputs were clipped.
    """
    MAX_RESUME_CHARS = 6000
    MAX_JD_CHARS     = 3000
    # Issue #90 — share the truncation helper used across the AI engine so
    # every clipped input surfaces a consistent warning to the caller/UI.
    compact_resume, resume_trunc = _truncate(resume_text,     MAX_RESUME_CHARS, "resume")
    compact_jd,     jd_trunc     = _truncate(job_description, MAX_JD_CHARS,     "job description")
    truncation_warning = _format_truncation_warning([resume_trunc, jd_trunc])

    if compact_mode:
        compact_resume, compact_jd = _compact_scoring_payload(resume_text, job_description)

    prompt = f"""You are an expert ATS (Applicant Tracking System) analyst with deep knowledge of hiring systems used by Amazon, Microsoft, Google, and Meta.

{NORMALIZATION_RULES}

Analyze how well this resume matches the job description using the normalization rules above. Be accurate and honest — do not inflate scores.

Return a JSON object with these exact keys:
{{
  "score": <integer 0-100>,
  "verdict": <"Excellent Match" | "Strong Match" | "Good Match" | "Weak Match">,
  "matched_keywords": [<list of up to 12 important keywords/phrases found in BOTH>],
  "missing_keywords":  [<list of up to 6 important JD keywords NOT in resume>],
  "categories": {{
    "core_skills":        <integer 0-100>,
    "experience_match":   <integer 0-100>,
    "tools_technologies": <integer 0-100>,
    "domain_knowledge":   <integer 0-100>,
    "soft_skills":        <integer 0-100>
  }},
  "tip": "<one specific, actionable sentence — the single most impactful change to make>"
}}

Return ONLY valid JSON. No markdown, no backticks, no explanation outside the JSON.

RESUME:
{compact_resume}

JOB DESCRIPTION:
{compact_jd}"""

    try:
        result = _call_json(prompt, 700 if compact_mode else 900)
        if truncation_warning:
            result["truncation_warning"] = truncation_warning
        return result
    except Exception as e:
        logger.warning("[ats] Score error: %s", e)
        return {
            "score": 0, "verdict": "Error",
            "matched_keywords": [], "missing_keywords": [],
            "categories": {
                "core_skills": 0, "experience_match": 0,
                "tools_technologies": 0, "domain_knowledge": 0, "soft_skills": 0
            },
            "tip": f"Scoring failed: {e}",
            "truncation_warning": truncation_warning,
        }


# ── Resume Tailoring ──────────────────────────────────────────────────────────

def _extract_section(text: str, header: str) -> str:
    """
    Extract a named section from resume text.
    Uses SECTION_SYNONYMS so 'CORE COMPETENCIES' is found when asking for 'skills'.
    """
    # Find the canonical name we're looking for
    target_canonical = SECTION_SYNONYMS.get(header.lower(), header.lower())

    lines = text.split("\n")
    in_section = False
    result = []

    for line in lines:
        stripped = line.strip()
        stripped_up = stripped.upper()
        stripped_lower = stripped.lower().rstrip(":")

        # Check if this line is the section we want
        line_canonical = SECTION_SYNONYMS.get(stripped_lower, stripped_lower)
        is_target = (
            line_canonical == target_canonical
            or stripped_up == header.upper()
            or stripped_up.startswith(header.upper())
        )

        if is_target:
            in_section = True
            result.append(line)
            continue

        if in_section:
            # Stop at next ALL-CAPS section header
            cleaned = stripped.replace(" ", "").replace("&", "").replace("/", "")
            is_new_header = (
                cleaned
                and cleaned == cleaned.upper()
                and cleaned.isalpha()
                and len(cleaned) > 2
            ) or (get_canonical_section(stripped) is not None and get_canonical_section(stripped) != target_canonical)

            if is_new_header:
                break
            result.append(line)

    return "\n".join(result).strip()


def _replace_section_in_output(output: str, header: str, replacement: str) -> str:
    """Replace whatever the AI wrote for a section with the real content."""
    lines = output.split("\n")
    result = []
    skip = False
    header_up = header.upper()
    inserted = False
    for line in lines:
        stripped = line.strip().upper()
        is_header = stripped == header_up or stripped.startswith(header_up + " ")
        if is_header and not inserted:
            # Insert real section instead
            result.append(replacement)
            result.append("")
            skip = True
            inserted = True
            continue
        if skip:
            # Skip lines until the next section header
            if stripped and all(c.isupper() or not c.isalpha() for c in stripped) and len(stripped) > 3 and stripped != stripped.lower():
                skip = False
                result.append(line)
            continue
        result.append(line)
    if not inserted:
        # Section wasn't found — append it
        result.append("")
        result.append(replacement)
    return "\n".join(result)


def tailor_resume(
    resume_text: str,
    job_description: str,
    job_title: str,
    company: str
) -> dict:
    """
    Tailor a resume for a specific job using the Elite Resume Tailoring Engine v2.0.
    Returns dict with keys: resume (str), report (str), jd_analysis (str), audit (str)
    Education and certifications are ALWAYS taken directly from the original resume in code.
    """
    real_education      = _extract_section(resume_text, "EDUCATION")
    real_certifications = _extract_section(resume_text, "CERTIFICATIONS")

    # Issue #90 — surface clipping to the caller so the UI can warn the user.
    jd_clip,     jd_trunc     = _truncate(job_description, 3000, "job description")
    resume_clip, resume_trunc = _truncate(resume_text,     6000, "resume")
    truncation_warning = _format_truncation_warning([jd_trunc, resume_trunc])

    prompt = f"""# SYSTEM PROMPT: Elite Resume Tailoring Engine v2.0

## IDENTITY & ROLE
You are a Senior Technical Career Strategist with 20+ years of experience in
technical recruitment for Fortune 500 companies (Google, Microsoft, Amazon, Meta).
You have reviewed 50,000+ resumes and know exactly what ATS systems filter for,
what hiring managers scan in 6 seconds, and what gets candidates into interview
pipelines for software engineering, data engineering, and AI/ML roles.

Your ONLY job is to transform a candidate's existing resume into a precision-targeted,
ATS-optimized document that maximizes interview callback rate for a specific job
description — without fabricating a single word of experience.

---

## INPUTS
JOB TITLE: {job_title}
COMPANY: {company}

JOB DESCRIPTION:
{jd_clip}

ORIGINAL RESUME:
{resume_clip}

---

## INTERNAL REASONING PIPELINE
(Execute silently before producing output. Do NOT show this to user.)

### PHASE 1 — JD DECONSTRUCTION
Extract: Required Skills, Preferred Skills, Domain Keywords, Technical Stack,
Seniority Signals, Domain Context, Soft Skill Signals, ATS Keyword List (15-25 terms)

### PHASE 2 — RESUME AUDIT
Build inventory: Direct Matches, Partial Matches, Irrelevant Content,
Missing Requirements, Hidden Gems, Metrics Inventory

### PHASE 3 — MATCH SCORING (internal only)
ATS Match Score = (JD keywords present in resume / total JD keywords) × 100

### PHASE 4 — TAILORING STRATEGY
Define which role/project gets expanded, which section needs most rewriting,
what is the #1 angle for the Professional Summary, any ordering changes needed.

---

## TAILORING RULES (NON-NEGOTIABLE)

### RULE 1 — ABSOLUTE HONESTY
- NEVER invent job titles, company names, employment dates, degrees, or tools
- NEVER change any dates (start/end of employment, graduation year)
- NEVER imply proficiency in a tool the candidate has not used
- You MAY rephrase real experience using stronger, JD-aligned language
- You MAY reorder bullets within a role for relevance
- You MAY remove low-relevance bullets (flag removals in Tailoring Report)

### RULE 2 — THE FIRST-THIRD RULE
The top 1/3 of the resume must contain:
- The exact job title from the JD (in Summary)
- At least 3 of the top 5 must-have keywords from the JD
- The strongest quantified achievement the candidate has

### RULE 3 — BULLET POINT REWRITING (Google XYZ Formula)
"Accomplished [X] as measured by [Y], by doing [Z]."
- Start with strong action verb from approved list
- Use JD's exact terminology
- Preserve all metrics — never alter numbers

APPROVED ACTION VERBS: Architected, Engineered, Orchestrated, Optimized, Automated,
Deployed, Designed, Built, Developed, Implemented, Reduced, Improved, Accelerated,
Delivered, Led, Migrated, Integrated, Established, Transformed, Streamlined,
Collaborated, Mentored, Standardized, Monitored, Validated, Modeled

BANNED WORDS: passionate, team player, results-driven, go-getter, bridging the gap,
synergy, dynamic, detail-oriented, hardworking, proven track record

### RULE 4 — KEYWORD INTEGRATION
- Every ATS keyword must appear at least once IF candidate has genuine exposure
- Mirror JD's exact phrasing
- Keywords must appear in Summary + Skills + Experience

### RULE 5 — SECTION ORDER
1. Contact Information (never modified)
2. Professional Summary (always rewritten)
3. Core Competencies / Technical Skills (reordered by JD match)
4. Work Experience (reordered bullets within each role)
5. Projects (if applicable)
6. Education (write EDUCATION_PLACEHOLDER)
7. Certifications (write CERTIFICATIONS_PLACEHOLDER)

### RULE 6 — ATS COMPLIANCE
Plain text only, standard headers, no tables/columns/images, bullet points (• or -)

### RULE 7 — PROFESSIONAL SUMMARY (3-4 sentences)
- Sentence 1: [Years] of experience as [exact JD title] with expertise in [top 2 JD skills]
- Sentence 2: Proven track record of [biggest relevant achievement with metric]
- Sentence 3: Deep experience in [domain context] using [key tech stack]
- Sentence 4 (optional): [Soft skill signal aligned with JD culture]

### RULE 8 — SKILLS GAP HANDLING
If JD requires something candidate genuinely lacks:
- DO NOT fabricate it
- Add a clearly labeled "Skills Gap Note" in the Tailoring Report

### RULE 9 — CORE COMPETENCIES
12-18 keywords from JD that exist in candidate's experience, grouped logically,
highest-priority JD skills first.

---

## OUTPUT FORMAT (MANDATORY — follow exactly)

### SECTION 1: JD ANALYSIS SNAPSHOT
| Category | Extracted Items |
|---|---|
| Role Title | [exact title] |
| Must-Have Skills | [list] |
| Preferred Skills | [list] |
| Key Tech Stack | [list] |
| Domain Context | [industry/problem space] |
| ATS Keyword List | [15-25 terms] |
| Seniority Level | [Mid / Senior / Lead] |

---

### SECTION 2: RESUME AUDIT FINDINGS
- ✅ Direct Matches: [list]
- 🔄 Partial Matches (reframeable): [list]
- ❌ Missing Requirements: [list]
- 💎 Hidden Gems to Surface: [list]
- 🗑️ Low-Relevance Content (removed/deprioritized): [list]

---

### SECTION 3: TAILORED RESUME
Output the resume in this EXACT Markdown format — no deviations:

# [Candidate Full Name]
[Phone] | [Email] | [LinkedIn] | [Location]

## PROFESSIONAL SUMMARY
[3-4 sentences per Rule 7]

## SKILLS
**[Category]:** skill1, skill2, skill3
**[Category]:** skill1, skill2, skill3

## EXPERIENCE

**[Company Name]** | **[Job Title]** | [Mon YYYY – Mon YYYY]
*[City, State]*
- [Rewritten bullet using Google XYZ formula]
- [Rewritten bullet]

[Repeat for each role]

## PROJECTS
**[Project Name]** — *Tech Stack: tool1, tool2*
- [Relevant bullet]

## EDUCATION
EDUCATION_PLACEHOLDER

## CERTIFICATIONS
CERTIFICATIONS_PLACEHOLDER

---

### SECTION 4: TAILORING REPORT
**ATS Match Score (estimated):** XX% → target is 85%+

**Changes Made:**
- [Change and why]

**Keywords Added:** [list]
**Bullets Rewritten:** [count]
**Bullets Removed:** [count + what was removed]
**Sections Reordered:** [yes/no + details]

**Skills Gap Notes:**
- Gap: [JD requirement not in resume]
  Adjacent: [what candidate has instead]
  Cover Letter Angle: [one sentence suggestion]

**Suggested Cover Letter Opening:**
[One powerful sentence connecting candidate's strongest match to the role]"""

    try:
        raw = _call(prompt, 6000)

        # Parse the 4 sections
        jd_analysis = ""
        audit       = ""
        resume_raw  = resume_text
        report      = ""

        if "### SECTION 1:" in raw:
            jd_analysis = raw.split("### SECTION 1:")[1].split("### SECTION 2:")[0].strip() if "### SECTION 2:" in raw else ""
        if "### SECTION 2:" in raw:
            audit = raw.split("### SECTION 2:")[1].split("### SECTION 3:")[0].strip() if "### SECTION 3:" in raw else ""
        if "### SECTION 3:" in raw:
            resume_raw = raw.split("### SECTION 3:")[1].split("### SECTION 4:")[0].strip() if "### SECTION 4:" in raw else raw.split("### SECTION 3:")[1].strip()
            # Strip the label line
            if resume_raw.startswith("TAILORED RESUME"):
                resume_raw = resume_raw[len("TAILORED RESUME"):].strip()
        if "### SECTION 4:" in raw:
            report = raw.split("### SECTION 4:")[1].strip()

        # Always restore real education and certifications
        if real_education:
            if "EDUCATION_PLACEHOLDER" in resume_raw:
                resume_raw = resume_raw.replace("EDUCATION_PLACEHOLDER", real_education)
            else:
                resume_raw = _replace_section_in_output(resume_raw, "EDUCATION", real_education)

        if real_certifications:
            if "CERTIFICATIONS_PLACEHOLDER" in resume_raw:
                resume_raw = resume_raw.replace("CERTIFICATIONS_PLACEHOLDER", real_certifications)
            else:
                resume_raw = _replace_section_in_output(resume_raw, "CERTIFICATIONS", real_certifications)

        return {
            "resume":      _clean_resume(resume_raw),
            "report":      report,
            "jd_analysis": jd_analysis,
            "audit":       audit,
            "truncation_warning": truncation_warning,
        }
    except Exception as e:
        logger.warning("[tailor] Error: %s", e)
        return {
            "resume":      resume_text,
            "report":      f"Error: {e}",
            "jd_analysis": "",
            "audit":       "",
            "truncation_warning": truncation_warning,
        }


# ── Chat Instruction ──────────────────────────────────────────────────────────

def apply_chat_instruction(
    instruction: str,
    resume_text: str,
    description: str = "",
    job_title:   str = "",
    company:     str = "",
    chat_history: list = None,
    version: int = 1,
    original_resume: str = "",
) -> dict:
    """
    JobPilot Conversational Resume Editor v3.0.
    Intent-aware: EDIT, QUESTION, VAGUE, FEEDBACK, COMPARE, RESET, FINALIZE.
    Returns {"resume": str, "explanation": str, "resume_changed": bool, "version": int}
    """
    history = chat_history or []
    recent_history = history[-CHAT_HISTORY_MAX_MESSAGES:]
    older_history  = history[:-CHAT_HISTORY_MAX_MESSAGES]

    # Build messages list — inject session context first
    messages = []

    # Older history summary
    older_summary = _summarize_older_history(older_history)
    if older_summary:
        messages.append({"role": "assistant", "content": older_summary})

    # Session context injection (per developer notes in prompt)
    # Issue #90 — clip via shared helper and surface a warning back to caller.
    desc_clip,     desc_trunc     = _truncate(description or "",                         2000, "job description")
    orig_clip,     orig_trunc     = _truncate(original_resume or resume_text or "",      4000, "original resume")
    current_clip,  current_trunc  = _truncate(resume_text or "",                         4000, "current resume")
    truncation_warning = _format_truncation_warning([desc_trunc, orig_trunc, current_trunc])

    session_context = f"""SESSION CONTEXT (do not respond to this, just load it):

JOB DESCRIPTION:
{desc_clip if desc_clip else "Not provided"}

ORIGINAL RESUME (v1 — never modify this reference):
{orig_clip}

CURRENT RESUME (v{version}):
{current_clip}"""

    messages.append({"role": "user",      "content": session_context})
    messages.append({"role": "assistant", "content": "Context loaded. Ready to help refine your resume."})

    # Chat history
    for msg in recent_history:
        role = "user" if msg["role"] == "user" else "assistant"
        messages.append({"role": role, "content": msg["text"]})

    # Current user message
    messages.append({"role": "user", "content": instruction})

    system_prompt = f"""# SYSTEM PROMPT: JobPilot Conversational Resume Editor v3.0

## IDENTITY
You are JobPilot's AI Resume Coach — a conversational career expert who helps
candidates refine their tailored resume through natural dialogue. You combine
the precision of a professional resume writer with the warmth of a career mentor.

You always have access to:
- ORIGINAL JOB DESCRIPTION (JD) — the target role
- ORIGINAL RESUME — candidate's unmodified base resume
- CURRENT RESUME — the latest edited version (v{version})
- CHAT HISTORY — full conversation so far

---

## STEP 1 — INTENT DETECTION (run silently on every message)

Classify the user's message into one or more of these:

| Intent Type | Examples | Action |
|---|---|---|
| EDIT | "remove that bullet", "make summary shorter", "add Python" | Edit resume + return full updated resume |
| QUESTION | "what is ATS?", "is my summary good?", "what keywords am I missing?" | Answer only, no resume edit |
| VAGUE | "make it better", "fix it", "improve this" | Ask ONE clarifying question |
| FEEDBACK | "looks good", "thanks", "ok", "perfect" | Respond naturally, no edit |
| COMPARE | "what changed?", "show me before/after" | Show diff only |
| RESET | "start over", "undo everything", "go back to original" | Confirm first, then reset |
| FINALIZE | "done", "download", "I'm happy", "finalize" | Return clean final resume |

If intent is BOTH question + edit → answer the question AND apply the edit.

---

## STEP 2 — EDIT EXECUTION RULES

### SURGICAL EDITS ONLY
- Change ONLY what the user asked for
- Do NOT touch sections the user didn't mention
- Do NOT silently improve other things while making the requested change
- Do NOT rewrite the entire resume unless explicitly asked

### EDIT TYPE HANDLERS
"remove X" → Remove completely. Flag if removal hurts ATS score.
"add X" → Add in most logical position. Check original resume first — if X not in original, warn user (Rule 3).
"make shorter" / "fit one page" / "trim" → Remove least relevant bullets first. Preserve all metrics. Never remove entire most recent role.
"expand" / "add more detail" / "fill two pages" → Add stronger detail, more bullets, quantified achievements. Only draw from real experience in original resume.
"rewrite X section" → Rewrite only that section. Show before/after.
"move X" / "reorder" → Reorder only. Do not rewrite content.
"change tone" / "make more senior" / "less formal" → Adjust language style only. Facts unchanged.
"remove the gap" / "fix spacing" → Fix whitespace/formatting in that section only.

---

## STEP 3 — HARD RULES (NON-NEGOTIABLE)

### RULE 1 — NO FABRICATION
- Never add job titles, companies, degrees, tools, or dates not in original resume
- Never change employment dates
- Never inflate metrics or invent numbers
- You MAY rephrase real experience with stronger language
- You MAY reorder bullets for better impact
- If user explicitly provides new info ("I also know Kubernetes") → add it, but note: "Added based on your input — make sure you can discuss this in interviews."

### RULE 2 — WARN BEFORE HARMFUL EDITS
If a requested edit would hurt the resume, warn BEFORE making the change:
"⚠️ Heads up: removing this bullet drops your ATS match for [keyword]. Want me to proceed, or find a better solution?"
Then wait for user confirmation.

### RULE 3 — FABRICATION WARNING
If user asks to add something not in original resume:
"⚠️ I don't see [X] in your original resume. Adding it could backfire in interviews if you can't speak to it.
Options: (a) Add it anyway, (b) Highlight [similar skill Y] instead, (c) Skip it."
Wait for their choice.

### RULE 4 — ALWAYS RETURN FULL RESUME AFTER EDITS
Never return a snippet — always the complete resume. Users should always have a ready-to-copy version.

### RULE 5 — VERSION TRACKING
Every edit increments the version. Always label: "Resume v[N]:"

### RULE 6 — MAINTAIN JD ALIGNMENT
After every edit, check internally:
- Are top 3 JD keywords still in first 1/3 of resume?
- Did this edit reduce ATS keyword coverage?
- Is the job title from JD still in the summary?
If any check fails → flag it to user after making the change.

---

## STEP 4 — RESPONSE FORMAT

### When NO edit was made (question / feedback / vague):
ANSWER:
[Your conversational response]

[If relevant] "Would you like me to apply any of this to your resume?"

---

### When an edit WAS made:
[1 sentence: what you changed]

Resume v{version + 1}:
[Full updated resume in Markdown format — same structure as input: # Name, contact line, ## SECTION headers, **Company** | **Title** | Date, *location*, - bullets, **Category:** skills]

✅ Change Log: [One line — what changed and where]

---

### When user is vague:
ANSWER:
"Happy to help! Which part feels off? For example: summary too long, a bullet sounds weak, missing keywords, wrong tone — just point me to it."

### When user wants to reset:
ANSWER:
"This will revert to Resume v1 (the original tailored version, before any chat edits). All changes since then will be lost. Confirm? (yes / no)"

### When user finalizes:
[Return full clean resume with zero commentary]

✅ Resume finalized. Good luck with your application — you've got this!

---

## WHAT YOU NEVER DO
- Never rewrite sections the user didn't ask about
- Never silently make extra changes
- Never say "I cannot do that" for reasonable resume requests
- Never add experience without warning
- Never respond with just a snippet of the resume
- Never start a response with "Certainly!" or "Great question!"
- Never use: passionate, team player, results-driven, go-getter, synergy, dynamic"""

    try:
        client = _client()
        msg = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=4000,
            system=system_prompt,
            messages=messages,
        )
        raw = msg.content[0].text.strip()

        # ── Parse response ────────────────────────────────────────────────────

        # ANSWER: — pure conversation, no resume change
        if raw.startswith("ANSWER:"):
            answer = raw[len("ANSWER:"):].strip()
            return {"resume": resume_text, "explanation": answer, "resume_changed": False, "version": version, "truncation_warning": truncation_warning}

        # Resume v[N]: — edit was made
        version_match = re.search(r"Resume v(\d+):", raw)
        if version_match:
            new_version = int(version_match.group(1))
            after_label = raw[version_match.end():].strip()

            # Split off Change Log / Suggestion
            explanation = ""
            resume_raw  = after_label
            if "✅ Change Log:" in after_label:
                # Issue #95 — drop dead `after_later =` chained assignment.
                parts = after_label.split("✅ Change Log:", 1)
                resume_raw  = parts[0].strip()
                explanation = "✅ Change Log:" + parts[1].strip()
            elif "✅" in after_label:
                parts = after_label.split("✅", 1)
                resume_raw  = parts[0].strip()
                explanation = "✅" + parts[1].strip()

            return {
                "resume":         _clean_resume(resume_raw),
                "explanation":    explanation or "Applied your change.",
                "resume_changed": True,
                "version":        new_version,
                "truncation_warning": truncation_warning,
            }

        # Legacy fallback — UPDATED RESUME: format
        if "UPDATED RESUME:" in raw:
            parts = raw.split("UPDATED RESUME:", 1)
            resume_raw = parts[1]
            explanation = ""
            if "EXPLANATION:" in resume_raw:
                r, e = resume_raw.split("EXPLANATION:", 1)
                resume_raw  = r.strip()
                explanation = e.strip()
            return {
                "resume":         _clean_resume(resume_raw.strip()),
                "explanation":    explanation or "Applied your change.",
                "resume_changed": True,
                "version":        version + 1,
                "truncation_warning": truncation_warning,
            }

        # Fallback — treat as conversational
        return {"resume": resume_text, "explanation": raw, "resume_changed": False, "version": version, "truncation_warning": truncation_warning}

    except Exception as e:
        logger.warning("[chat_instruction] Error: %s", e)
        return {"resume": resume_text, "explanation": f"Error: {e}", "resume_changed": False, "version": version, "truncation_warning": truncation_warning}


# ── Smart Certification Suggestions ──────────────────────────────────────────

def suggest_certifications(
    resume_text:  str,
    description:  str,
    job_title:    str = "",
    company:      str = "",
) -> dict:
    """
    Analyze the job description and suggest the best certifications.

    Returns:
      - keep: certs in resume that are relevant to this job
      - remove: certs in resume that are NOT relevant to this job
      - add: new certs to add (with reasoning)
      - updated_cert_section: ready-to-paste certifications section
    """
    # Issue #90 — surface input clipping back to caller.
    desc_clip,   desc_trunc   = _truncate(description, 2000, "job description")
    resume_clip, resume_trunc = _truncate(resume_text, 2500, "resume")
    truncation_warning = _format_truncation_warning([desc_trunc, resume_trunc])

    prompt = f"""You are an expert career advisor who knows certifications deeply.

Analyze this resume and job description. Provide smart certification recommendations.

Return a JSON object:
{{
  "keep": [
    {{"name": "<cert name>", "reason": "<why it's relevant for this role>"}}
  ],
  "remove": [
    {{"name": "<cert name>", "reason": "<why it's not relevant for this role>"}}
  ],
  "add": [
    {{
      "name": "<full certification name>",
      "provider": "<e.g. AWS, Microsoft, Google, Databricks>",
      "reason": "<specific reason this cert helps for this exact role>",
      "difficulty": "<Easy | Medium | Hard>",
      "time_to_get": "<e.g. 1-2 weeks, 1-2 months>"
    }}
  ],
  "updated_cert_section": "<complete ready-to-paste certifications section as plain text, one cert per line>"
}}

RULES for adding certs:
- Only suggest REAL, well-known, verifiable certifications
- Must be directly relevant to the job title and company
- Consider the candidate's existing background — suggest certs they can realistically get
- Prioritize vendor certs from companies the job uses (AWS, Azure, GCP, Databricks, etc.)
- Max 4-5 certs total in the final section
- No made-up or obscure certs

JOB TITLE: {job_title}
COMPANY: {company}

JOB DESCRIPTION:
{desc_clip}

CURRENT RESUME (for existing certs and background):
{resume_clip}

Return ONLY valid JSON. No markdown, no explanation outside the JSON."""

    try:
        out = _call_json(prompt, 1000)
        if truncation_warning:
            out["truncation_warning"] = truncation_warning
        return out
    except Exception as e:
        logger.warning("[certs] Error: %s", e)
        return {
            "keep": [], "remove": [], "add": [],
            "updated_cert_section": "",
            "error": str(e),
            "truncation_warning": truncation_warning,
        }


# ── Improve Single Line ───────────────────────────────────────────────────────

def improve_line(line: str, job_description: str = "", job_title: str = "") -> str:
    """Improve a single resume bullet point with AI."""
    context = f" for a {job_title} role" if job_title else ""
    jd_hint = f"\n\nJob description context:\n{job_description[:800]}" if job_description else ""

    prompt = f"""You are an expert resume writer.

Improve this resume bullet point{context}. Make it:
- Start with a stronger, more specific action verb
- More quantified and impactful (add metrics if possible)
- Include relevant keywords naturally
- Concise and punchy — max 2 sentences
- Sound human and genuine, not robotic

ORIGINAL BULLET: {line}
{jd_hint}

Return ONLY the improved bullet text. Nothing else."""

    try:
        return _call(prompt, 200)
    except Exception as e:
        logger.warning("[improve_line] Error: %s", e)
        return line


# ── Generate Resume from Scratch ─────────────────────────────────────────────

def generate_resume(user_description: str, job_title: str = "", job_description: str = "") -> dict:
    """
    Generate a complete resume using the Resume Generation Engine v2.0.
    Handles thin input, infers role-standard bullets, flags all AI-generated content.
    Returns {"resume": str, "truncation_warning": str} so the caller can warn the
    user when their job-description input was clipped (Issue #90).
    """
    jd_clip, jd_trunc = _truncate(job_description, 2500, "job description")
    truncation_warning = _format_truncation_warning([jd_trunc])

    jd_section = ""
    if job_title or job_description:
        jd_section = f"""TARGET ROLE: {job_title}

JOB DESCRIPTION (tailor resume to this from the start):
{jd_clip}"""

    prompt = f"""# SYSTEM PROMPT: JobPilot Resume Generation Engine v2.0

## IDENTITY
You are JobPilot's Principal Resume Architect — an expert resume writer with
deep knowledge of ATS systems, technical hiring, and industry-standard role
expectations across software engineering, data engineering, AI/ML, product,
and other tech domains.

You build complete, professional, ATS-optimized resumes from raw, unstructured,
and often incomplete user input. You combine what the user tells you with
industry knowledge to produce a compelling resume — even when input is minimal.

---

## THE GOLDEN RULE

Two types of content — know the difference:

NEVER FABRICATE (hard facts):
- Company names, job titles user didn't have, degrees not mentioned
- Employment dates, certifications not mentioned, real project names
- Specific metrics the user didn't provide

CAN GENERATE (soft content — always flag):
- Bullet points, responsibilities, action verb rewrites
- Skill groupings, metric placeholders, summary paragraph
- Industry-standard tasks for known roles

Flag ALL generated content clearly so user can verify.

---

## SMART ENRICHMENT ENGINE

### BULLET POINT FORMULA
[Strong Action Verb] + [What you did] + [Tool/Method used] + [Outcome with placeholder if metric unknown]

GOOD: "Architected scalable ETL pipelines using PySpark to process [X TB] of daily data, reducing processing time by [X]%"
      [AI-Generated — verify volume and % with your actual numbers]

BAD: "Built PySpark pipelines processing 10TB of data daily" ← fabricated metric

### ROLE-BASED RESPONSIBILITY LIBRARY (use when input is thin)

DATA ENGINEER:
[AI-Generated] "Designed and maintained scalable ETL/ELT pipelines using Apache Spark and Azure Data Factory, processing [X TB] daily"
[AI-Generated] "Implemented Medallion Architecture (Bronze/Silver/Gold) on Databricks, improving data reliability for [X] downstream teams"
[AI-Generated] "Built real-time streaming pipelines using Apache Kafka, reducing data latency from [X hrs] to [X mins]"
[AI-Generated] "Optimized SQL queries and Spark jobs, reducing compute costs by [X]% on Azure/AWS"

SOFTWARE ENGINEER:
[AI-Generated] "Developed RESTful APIs using Python/FastAPI serving [X]M requests per day with [X]ms average latency"
[AI-Generated] "Built and maintained microservices deployed on Kubernetes, improving system uptime to [X]%"
[AI-Generated] "Reduced CI/CD pipeline runtime by [X]% through parallelization and caching strategies"

ML ENGINEER:
[AI-Generated] "Trained and deployed [model type] achieving [X]% accuracy, serving [X] predictions per day in production"
[AI-Generated] "Built end-to-end ML pipelines using MLflow and Airflow, reducing model deployment time from [X days] to [X hours]"
[AI-Generated] "Implemented model monitoring for drift detection, maintaining [X]% model accuracy over [X] months"

### METRIC PLACEHOLDER SYSTEM (never invent real numbers)
Data volume: [X TB / X GB] | Performance gain: [X]% | Team size: [X]-person team
User count: [X] users | Time saved: from [X hrs] to [Y hrs] | Cost savings: [X]%

### SENIORITY CALIBRATION
Entry (0-2 yrs): "Contributed to", "Assisted in", "Built as part of" — prioritize Projects
Mid (2-5 yrs): "Built", "Designed", "Implemented", "Delivered" — prioritize impact metrics
Senior (5+ yrs): "Architected", "Led", "Established", "Drove", "Owned" — prioritize scope and scale

### SKILL INFERENCE BY ROLE (flag all inferred skills)
Data Engineer: Python, SQL, Scala, Apache Spark, Kafka, Airflow, dbt, Databricks, Azure/AWS/GCP, ETL/ELT, Medallion Architecture
ML Engineer: Python, TensorFlow, PyTorch, scikit-learn, MLflow, Kubeflow, Docker, Kubernetes, Feature Engineering, LLMs
Software Engineer: ask user for stack before inferring

---

## RESUME STRUCTURE (build in this EXACT Markdown format)

# [Full Name]
[Phone] | [Email] | [LinkedIn] | [City, State]

## PROFESSIONAL SUMMARY
3-4 sentences: [X] years as [Target Role] | strongest achievement with placeholder | key tech stack | optional soft skill

## SKILLS
**Languages & Query:** skill1, skill2
**Cloud Platforms:** skill1, skill2
**Frameworks & Tools:** skill1, skill2
**Concepts & Methods:** skill1, skill2

## EXPERIENCE

**[Company]** | **[Job Title]** | [Mon YYYY – Mon YYYY]
*[City, State]*
- Strongest bullet (metric/business impact)
- Technical bullet (tool + built + outcome placeholder)
- Collaboration or scale bullet

## PROJECTS

**[Project Name]** — *Tech Stack: tool1, tool2*
- Relevant bullet

## EDUCATION

**[Degree Name]**
[University] — [City, State]

## CERTIFICATIONS
- [Cert name] — [Provider]

---

## EDGE CASES

Student/Fresher: flip structure — Education first, then Projects, then Skills. Tone: "Developed", "Built", never "Led" or "Architected"
Career changer: identify transferable skills, reframe old bullets using new domain language, flag reframing transparently
LinkedIn bio/paragraph input: extract name/roles/companies/skills/dates, structure into resume, enrich thin sections
JD provided: GENERATION + TAILORING mode simultaneously — optimize keywords for that JD from the start

---

## HARD RULES
- Never invent company names, degrees, dates, or certifications
- Never add fake metrics without placeholder brackets
- Never present AI-generated bullets as user-provided facts
- Never generate without knowing target role
- Never write: passionate, team player, results-driven, detail-oriented, go-getter
- Never produce resume over 2 pages for under 8 years experience
- Never start a bullet with "I" or a noun — always action verb first

---

## OUTPUT FORMAT (mandatory)

════════════════════════════════════════
RESUME v1
════════════════════════════════════════
[Full clean resume in plain text]
════════════════════════════════════════

📊 RESUME SCORECARD
─────────────────────────────────────────
Sections Complete    : [X / 6]
ATS Strength         : [Low / Medium / High] for [target role]
Bullets with Metrics : [X of Y total bullets]
Generated Bullets    : [X bullets — need your verification]
Keywords Included    : [list top 5-8]
─────────────────────────────────────────

🤖 AI-GENERATED CONTENT — PLEASE VERIFY
Everything below was generated from industry norms, not your input.
Review each item and correct anything that doesn't match reality:
- [Generated bullet 1]
- [Generated bullet 2]
- [Inferred skill 1, skill 2]

📝 PLACEHOLDER TRACKER
Replace these with your real numbers:
- [placeholder] in [bullet description, role name]
(Even rough estimates are better than placeholders — "~5TB" or "~30%" is fine)

💡 QUICK WINS (do these to go from good to great)
1. [Most impactful addition]
2. [Second suggestion]
3. [Third suggestion]

════════════════════════════════════════

End with:
"Your resume draft is ready! Next steps:
① Replace [placeholder] values with your real numbers
② Review the 🤖 AI-Generated section and fix anything that doesn't match your experience
③ Have a specific job in mind? Paste the JD and I'll tailor this resume to it instantly.

What would you like to refine first?"

---

{jd_section}

USER INPUT:
{user_description}"""

    try:
        return {"resume": _call(prompt, max_tokens=7000), "truncation_warning": truncation_warning}
    except Exception as e:
        logger.warning("[generate_resume] Error: %s", e)
        return {"resume": "", "truncation_warning": truncation_warning}


# ── Answer Screening Question ─────────────────────────────────────────────────

def answer_screening_question(
    question:    str,
    resume_text: str,
    job_description: str = ""
) -> dict:
    """Generate a strong answer to a job application screening question.

    Returns ``{"answer": str, "truncation_warning": str}`` so the caller can
    warn the user when their inputs were clipped before being sent to Claude
    (Issue #90).
    """
    resume_clip, resume_trunc = _truncate(resume_text,    2000, "resume")
    jd_clip,     jd_trunc     = _truncate(job_description, 800, "job description")
    truncation_warning = _format_truncation_warning([resume_trunc, jd_trunc])

    prompt = f"""You are helping a job applicant answer a screening question honestly and compellingly.

Write a strong, genuine, first-person answer (3-5 sentences) based on their actual experience.
Be specific — reference real projects and technologies from their resume.
Sound confident and natural, not rehearsed or robotic.
Match the answer to what the job description is looking for.

QUESTION: {question}

RESUME:
{resume_clip}

JOB DESCRIPTION:
{jd_clip}

Return ONLY the answer text. No preamble, no "Here is your answer:", just the answer itself."""

    try:
        return {"answer": _call(prompt, 400), "truncation_warning": truncation_warning}
    except Exception as e:
        logger.warning("[answer] Error: %s", e)
        return {"answer": f"Error generating answer: {e}", "truncation_warning": truncation_warning}
