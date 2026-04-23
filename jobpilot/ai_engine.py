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
import re
import os
from dotenv import load_dotenv
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"), override=True)


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


def _client() -> anthropic.Anthropic:
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        raise ValueError("ANTHROPIC_API_KEY not set in .env file")
    return anthropic.Anthropic(api_key=key)


def _call(prompt: str, max_tokens: int = 2000) -> str:
    """Single Claude call, returns text."""
    msg = _client().messages.create(
        model="claude-sonnet-4-6",
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
    """
    compact_resume = resume_text[:6000]
    compact_jd = job_description[:3000]
    if compact_mode:
        compact_resume, compact_jd = _compact_scoring_payload(resume_text, job_description)

    prompt = f"""You are an expert ATS (Applicant Tracking System) analyst with deep knowledge of hiring systems used by Amazon, Microsoft, Google, and Meta.

Analyze how well this resume matches the job description. Be accurate and honest — do not inflate scores.

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
        return _call_json(prompt, 700 if compact_mode else 900)
    except Exception as e:
        print(f"[ats] Score error: {e}")
        return {
            "score": 0, "verdict": "Error",
            "matched_keywords": [], "missing_keywords": [],
            "categories": {
                "core_skills": 0, "experience_match": 0,
                "tools_technologies": 0, "domain_knowledge": 0, "soft_skills": 0
            },
            "tip": f"Scoring failed: {e}"
        }


# ── Resume Tailoring ──────────────────────────────────────────────────────────

def _extract_section(text: str, header: str) -> str:
    """Extract a named section from resume text (e.g. EDUCATION, CERTIFICATIONS)."""
    lines = text.split("\n")
    in_section = False
    result = []
    header_up = header.upper()
    for line in lines:
        stripped = line.strip().upper()
        if stripped == header_up or stripped.startswith(header_up):
            in_section = True
            result.append(line)
            continue
        if in_section:
            # Stop at next ALL-CAPS section header
            if stripped and stripped == stripped.replace(" ", "").upper().replace("&","").replace("/","") and len(stripped) > 3 and stripped != stripped.lower() and all(c.isupper() or not c.isalpha() for c in stripped):
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
{job_description[:3000]}

ORIGINAL RESUME:
{resume_text[:6000]}

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
[Full resume in plain text — ready to copy-paste]

[Candidate Full Name]
[Phone] | [Email] | [LinkedIn] | [Location]

PROFESSIONAL SUMMARY
[3-4 sentences per Rule 7]

CORE COMPETENCIES
[Grouped keywords per Rule 9]

WORK EXPERIENCE

[Company Name] | [Job Title] | [MM/YYYY – MM/YYYY]
- [Rewritten bullet]
- [Rewritten bullet]

[Repeat for each role]

PROJECTS (if applicable)
[Project Name]
- [Relevant bullet]

EDUCATION
EDUCATION_PLACEHOLDER

CERTIFICATIONS
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
        }
    except Exception as e:
        print(f"[tailor] Error: {e}")
        return {
            "resume":      resume_text,
            "report":      f"Error: {e}",
            "jd_analysis": "",
            "audit":       "",
        }


# ── Chat Instruction ──────────────────────────────────────────────────────────

def apply_chat_instruction(
    instruction: str,
    resume_text: str,
    description: str = "",
    job_title:   str = "",
    company:     str = "",
    chat_history: list = None,
) -> dict:
    """
    Smart resume assistant — detects intent first:
    - If the message is a question or general conversation → reply naturally, no resume edit
    - If it's an edit instruction → apply it, return updated resume + explanation
    - If it's both (e.g. "what certs should I add? also add AWS one") → do both

    Full chat history is sent to Claude so it remembers the conversation.
    Returns {"resume": str, "explanation": str, "resume_changed": bool}
    """
    jd_context = f"Job: {job_title} at {company}\n\nJob Description:\n{description[:1500]}" if description else ""
    history = chat_history or []
    recent_history = history[-CHAT_HISTORY_MAX_MESSAGES:]
    older_history = history[:-CHAT_HISTORY_MAX_MESSAGES]

    # Build conversation history as Claude messages
    messages = []
    older_summary = _summarize_older_history(older_history)
    if older_summary:
        messages.append({"role": "assistant", "content": older_summary})

    for msg in recent_history:
        role = "user" if msg["role"] == "user" else "assistant"
        messages.append({"role": role, "content": msg["text"]})

    # System prompt — makes Claude behave like a smart resume assistant
    system_prompt = f"""You are an expert resume assistant and career coach helping a job applicant.

You have access to their current resume and the job description they are targeting.

Your job is to:
1. DETECT INTENT — figure out what the user actually wants:
   - Is this a QUESTION? (e.g. "what should I improve?", "what certs should I add?", "is my summary good?") → Answer conversationally, do NOT edit the resume
   - Is this an EDIT INSTRUCTION? (e.g. "remove the gap", "add a bullet about Python", "make it shorter") → Edit the resume and explain what you changed
   - Is this BOTH? → Answer the question AND apply the edit
   - Is this FEEDBACK or CONVERSATION? (e.g. "looks good", "thanks", "ok") → Respond naturally

2. WHEN EDITING, follow these rules:
   - "remove X" → remove it completely
   - "add X" → add it in the right place
   - "make shorter" / "fit 1 page" → trim bullets, remove less important points
   - "expand" / "fill 2 pages" / "add more content" → add strong detail, more bullets, quantified achievements
   - "remove the gap" / "fix spacing" → remove extra blank lines in that section
    - Always aim to improve ATS alignment toward 90+ for the target role when possible
    - Prefer truthful optimization: stronger wording, better ordering, and relevant keyword coverage
    - If user explicitly provides skills/certs/details, prioritize those additions and mention them clearly in your explanation
    - If adding generic content, keep it realistic and clearly explain that it was generalized guidance
   - Keep all real data (companies, dates, education) unchanged unless told otherwise

3. RESPONSE FORMAT:
   - If NO resume edit needed: just reply conversationally. Start your response with "ANSWER:"
   - If resume WAS edited: respond in this format:
     UPDATED RESUME:
     [full updated resume as plain text]
     EXPLANATION:
    [1-2 natural sentences explaining what you changed, and whether additions came from user input or generic assumptions]

{jd_context}

CURRENT RESUME:
{resume_text}"""

    # Add current user message
    messages.append({"role": "user", "content": instruction})

    try:
        client = _client()
        msg = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=3200,
            system=system_prompt,
            messages=messages,
        )
        raw = msg.content[0].text.strip()

        # Parse response
        if raw.startswith("ANSWER:"):
            # Pure conversational reply — no resume change
            answer = raw[len("ANSWER:"):].strip()
            return {"resume": resume_text, "explanation": answer, "resume_changed": False}

        if "UPDATED RESUME:" in raw and "EXPLANATION:" in raw:
            parts_exp = raw.split("EXPLANATION:", 1)
            explanation = parts_exp[1].strip()
            resume_raw  = parts_exp[0].strip()
            if resume_raw.startswith("UPDATED RESUME:"):
                resume_raw = resume_raw[len("UPDATED RESUME:"):].strip()
            return {"resume": _clean_resume(resume_raw), "explanation": explanation, "resume_changed": True}

        if "UPDATED RESUME:" in raw:
            resume_raw = raw.split("UPDATED RESUME:", 1)[1].strip()
            return {"resume": _clean_resume(resume_raw), "explanation": "Applied your change.", "resume_changed": True}

        # Fallback — treat whole response as explanation (no edit)
        return {"resume": resume_text, "explanation": raw, "resume_changed": False}

    except Exception as e:
        print(f"[chat_instruction] Error: {e}")
        return {"resume": resume_text, "explanation": f"Error: {e}", "resume_changed": False}


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
{description[:2000]}

CURRENT RESUME (for existing certs and background):
{resume_text[:2500]}

Return ONLY valid JSON. No markdown, no explanation outside the JSON."""

    try:
        return _call_json(prompt, 1000)
    except Exception as e:
        print(f"[certs] Error: {e}")
        return {
            "keep": [], "remove": [], "add": [],
            "updated_cert_section": "",
            "error": str(e)
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
        print(f"[improve_line] Error: {e}")
        return line


# ── Generate Resume from Scratch ─────────────────────────────────────────────

def generate_resume(user_description: str, job_title: str = "", job_description: str = "") -> str:
    """
    Generate a complete, professional resume from a free-text description of the user.
    The user can describe themselves conversationally — Claude builds the full resume.

    Example user_description:
      "I'm a software engineer with 5 years of experience at Google and Amazon.
       I worked on distributed systems, Python, Go, Kubernetes. I have a BS in CS
       from UT Austin. I want to apply for senior backend roles."
    """
    job_context = ""
    if job_title or job_description:
        job_context = f"""
Target job: {job_title}

Job Description (tailor the resume towards this):
{job_description[:2000]}
"""

    prompt = f"""You are a world-class resume writer. Create a complete, professional, ATS-optimized resume based on the user's description below.

{job_context}

USER DESCRIPTION:
{user_description}

RESUME REQUIREMENTS:
- Start with the person's full name (centered, largest text)
- Contact line: Phone | Email | LinkedIn | Location (use realistic placeholders if not provided — mark them with [FILL IN])
- Professional Summary: 3-4 impactful sentences tailored to their experience and the target job
- EXPERIENCE section: each role formatted as "Company | Job Title  Month Year – Month Year", followed by 3-5 strong bullet points with action verbs and quantified impact
- TECHNICAL SKILLS section: organized by category (Languages, Frameworks, Tools, Cloud, etc.)
- EDUCATION section: degree, university, graduation year
- CERTIFICATIONS section: only if mentioned or highly relevant
- Use strong action verbs: Architected, Engineered, Led, Reduced, Increased, Deployed, etc.
- Quantify achievements wherever possible (even estimated: "reduced latency by ~30%")
- Format bullets as: [Action verb] [what you did] [measurable impact]
- Write in plain text — no markdown symbols, no asterisks
- Section headers in ALL CAPS

Return ONLY the complete resume as plain text. No preamble, no explanation, no commentary."""

    try:
        return _clean_resume(_call(prompt, max_tokens=4000))
    except Exception as e:
        print(f"[generate_resume] Error: {e}")
        return ""


# ── Answer Screening Question ─────────────────────────────────────────────────

def answer_screening_question(
    question:    str,
    resume_text: str,
    job_description: str = ""
) -> str:
    """Generate a strong answer to a job application screening question."""
    prompt = f"""You are helping a job applicant answer a screening question honestly and compellingly.

Write a strong, genuine, first-person answer (3-5 sentences) based on their actual experience.
Be specific — reference real projects and technologies from their resume.
Sound confident and natural, not rehearsed or robotic.
Match the answer to what the job description is looking for.

QUESTION: {question}

RESUME:
{resume_text[:2000]}

JOB DESCRIPTION:
{job_description[:800]}

Return ONLY the answer text. No preamble, no "Here is your answer:", just the answer itself."""

    try:
        return _call(prompt, 400)
    except Exception as e:
        print(f"[answer] Error: {e}")
        return f"Error generating answer: {e}"
