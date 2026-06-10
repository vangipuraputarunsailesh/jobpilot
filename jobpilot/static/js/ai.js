// jobpilot/static/js/ai.js
//
// Phase 4 — Client-side Claude (Anthropic) AI engine.
//
// Ports the prompts and parsing logic from `jobpilot/core/ai_engine.py` into
// the browser. All users hit `https://api.anthropic.com/v1/messages`
// directly with their BYOK key (the `anthropic-dangerous-direct-browser-access`
// header is required for CORS). Users without a BYOK key see a Settings nudge
// — the static deploy has no Flask backend to proxy requests through.
//
// Exposed on `window.*` so app.js (loaded after this) can call them:
//   aiScoreAts(resumeText, jobDescription, finalCheck=false)
//   aiTailorResume(resumeText, jobDescription, jobTitle, company)
//   aiImproveLine(line, jobDescription, jobTitle)
//   aiApplyChatInstruction(opts)
//   aiGenerateResume(description, jobTitle, jobDescription)
//
// Each function returns a Promise resolving to the same shape the legacy
// server routes returned (so the call sites in app.js need minimal change).
//
// NOTE: the prompts must stay byte-for-byte identical to the Python ones in
// `ai_engine.py` — that's the whole point of Phase 4 (Token-by-token output
// should match for a fixed prompt + temperature, per the plan).

(function () {
  "use strict";

  // ---- Config ---------------------------------------------------------------

  const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
  const ANTHROPIC_VERSION = "2023-06-01";
  const DEFAULT_MODEL = "claude-sonnet-4-5";
  const CHAT_HISTORY_MAX_MESSAGES = 8;

  // BYOK key + model are read out of the in-memory cache populated by
  // `app.js` (Phase 2 BYOK module). We don't import — we just peek at
  // the `_byokHeaders()` output via `window.authHeaders()`.
  function _byokAnthropic() {
    try {
      const h = window.authHeaders ? window.authHeaders() : {};
      return {
        key: h["X-Anthropic-Key"] || "",
        model: h["X-Claude-Model"] || DEFAULT_MODEL,
      };
    } catch (_) {
      return { key: "", model: DEFAULT_MODEL };
    }
  }

  // Should this call go direct to Anthropic? True iff the user has a BYOK
  // key in their browser. Demo or no-key users fall through to the banner
  // shim below which nudges them to Settings.
  function _useDirect() {
    const { key } = _byokAnthropic();
    return !!key;
  }

  // ---- Core call ------------------------------------------------------------

  // POST direct to api.anthropic.com. Returns the text of the first content
  // block, trimmed. Throws on HTTP error or missing key.
  async function _callDirect(systemPrompt, messages, maxTokens) {
    const { key, model } = _byokAnthropic();
    if (!key) throw new Error("Missing Anthropic API key");
    const body = {
      model: model || DEFAULT_MODEL,
      max_tokens: maxTokens,
      messages: messages,
    };
    if (systemPrompt) body.system = systemPrompt;

    const headers = {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
      // Required for browser → Anthropic CORS (Anthropic explicitly opts
      // into it instead of refusing all browser traffic).
      "anthropic-dangerous-direct-browser-access": "true",
    };

    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let detail = "";
      try { const j = await r.json(); detail = j.error?.message || JSON.stringify(j); }
      catch (_) { detail = r.statusText; }
      throw new Error(`Anthropic ${r.status}: ${detail}`);
    }
    const j = await r.json();
    const block = (j.content && j.content[0]) || {};
    // Bump the local usage counter rendered by app.js#refreshUsage(). Wrap
    // in try/catch so any storage error never breaks the AI call itself.
    try { if (typeof window.bumpUsage === "function") window.bumpUsage("claude_calls"); } catch (_) {}
    return (block.text || "").trim();
  }

  // Single user-prompt call (no system, no history).
  async function _call(prompt, maxTokens) {
    return _callDirect("", [{ role: "user", content: prompt }], maxTokens);
  }

  // Single user-prompt call returning parsed JSON.
  async function _callJson(prompt, maxTokens) {
    let raw = await _call(prompt, maxTokens);
    raw = raw.replace(/```json|```/g, "").trim();
    try { return JSON.parse(raw); }
    catch (_) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw new Error("Could not parse Claude JSON output");
    }
  }

  // ---- Helpers (ported from ai_engine.py) -----------------------------------

  function _truncate(text, limit, label) {
    if (text == null) return { text: "", clip: null };
    if (text.length <= limit) return { text: text, clip: null };
    return { text: text.slice(0, limit), clip: [label, text.length, limit] };
  }

  function _formatTruncationWarning(parts) {
    const frags = [];
    for (const p of parts) {
      if (!p) continue;
      const [label, original, limit] = p;
      frags.push(`${label} (${original.toLocaleString()} \u2192 ${limit.toLocaleString()} chars)`);
    }
    if (!frags.length) return "";
    return "Input was truncated for AI processing: " + frags.join(", ") + ".";
  }

  function _cleanResume(text) {
    const lines = text.split("\n").map(l => l.replace(/\s+$/, ""));
    const cleaned = [];
    let blank = 0;
    for (const line of lines) {
      if (line === "") {
        blank++;
        if (blank <= 1) cleaned.push(line);
      } else {
        blank = 0;
        cleaned.push(line);
      }
    }
    while (cleaned.length && cleaned[cleaned.length - 1] === "") cleaned.pop();
    return cleaned.join("\n");
  }

  function _extractSkillCandidates(text, limit) {
    if (limit == null) limit = 40;
    const candidates = [];
    for (const line of text.split("\n")) {
      const up = line.toUpperCase();
      if (["SKILLS", "TOOLS", "TECHNOLOG", "STACK", "FRAMEWORK", "LANGUAGE"].some(k => up.includes(k))) {
        const parts = line.split(/[,|/]|\s{2,}/);
        for (const p of parts) candidates.push(p);
      }
    }
    const tokenRe = /\b[A-Za-z][A-Za-z0-9.+#-]{1,24}\b/g;
    let m;
    while ((m = tokenRe.exec(text)) !== null) candidates.push(m[0]);

    const out = [];
    const seen = new Set();
    const stop = new Set(["and", "with", "from", "that", "this", "have", "using", "years", "experience", "skills", "tools"]);
    for (const raw of candidates) {
      const tok = raw.replace(/^[\s\-:\t]+|[\s\-:\t]+$/g, "").toLowerCase();
      if (tok.length < 2 || stop.has(tok)) continue;
      if (seen.has(tok)) continue;
      seen.add(tok);
      out.push(raw.trim());
      if (out.length >= limit) break;
    }
    return out;
  }

  function _truncateBullets(text, maxBullets, maxCharsEach) {
    if (maxBullets == null) maxBullets = 14;
    if (maxCharsEach == null) maxCharsEach = 170;
    const bullets = [];
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      if (/^[-*•]/.test(s) || /^\d+[.)]/.test(s)) {
        bullets.push(s.slice(0, maxCharsEach));
        if (bullets.length >= maxBullets) break;
      }
    }
    return bullets;
  }

  function _compactScoringPayload(resumeText, jobDescription) {
    const keyHeaders = ["SUMMARY", "EXPERIENCE", "SKILLS", "TECHNICAL", "PROJECT", "CERTIFICATION", "EDUCATION"];

    function pickKeyLines(text, maxLines) {
      if (maxLines == null) maxLines = 55;
      const selected = [];
      let currentHeader = "";
      for (const line of text.split("\n")) {
        const s = line.trim();
        if (!s) continue;
        const up = s.toUpperCase();
        const isHeader = up === s && s.length >= 3 && s.length <= 35 && keyHeaders.some(h => up.includes(h));
        if (isHeader) { currentHeader = up; selected.push(s); continue; }
        if (keyHeaders.some(h => currentHeader.includes(h))) selected.push(s);
        else if (selected.length < 8) selected.push(s);
        if (selected.length >= maxLines) break;
      }
      return selected;
    }

    const resumeLines = pickKeyLines(resumeText);
    const jdLines = pickKeyLines(jobDescription, 40);
    const resumeSkills = _extractSkillCandidates(resumeText, 35);
    const jdSkills = _extractSkillCandidates(jobDescription, 30);
    const bullets = _truncateBullets(resumeText, 12, 150);

    const compactResume = (
      "KEY RESUME SECTIONS:\n" +
      resumeLines.join("\n") +
      "\n\nDEDUPED RESUME SKILLS:\n" +
      resumeSkills.join(", ") +
      "\n\nRESUME BULLET SAMPLE:\n" +
      bullets.join("\n")
    ).slice(0, 3200);

    const compactJd = (
      "KEY JOB DESCRIPTION SECTIONS:\n" +
      jdLines.join("\n") +
      "\n\nDEDUPED JD SKILLS:\n" +
      jdSkills.join(", ")
    ).slice(0, 2200);

    return [compactResume, compactJd];
  }

  function _summarizeOlderHistory(history, maxItems, maxCharsEach) {
    if (maxItems == null) maxItems = 12;
    if (maxCharsEach == null) maxCharsEach = 120;
    if (!history || !history.length) return "";
    const tail = history.slice(-maxItems);
    const lines = [];
    for (const msg of tail) {
      const role = msg && msg.role === "user" ? "User" : "Assistant";
      const text = String((msg && msg.text) || "").replace(/\n/g, " ").trim();
      if (!text) continue;
      lines.push(`- ${role}: ${text.slice(0, maxCharsEach)}`);
    }
    if (!lines.length) return "";
    return "Earlier conversation summary (compressed):\n" + lines.join("\n");
  }

  // ---- NORMALIZATION_RULES — must match resume_normalizer.py ---------------

  const NORMALIZATION_RULES = `
## RESUME NORMALIZATION RULES — apply before any analysis

### SECTION NAMES (treat all variants as the same section)
- Experience = Work Experience = Professional Experience = Employment History = Career History
- Skills = Technical Skills = Core Competencies = Key Skills = Tech Stack = Areas of Expertise
- Summary = Professional Summary = Profile = About = Objective = Career Objective
- Education = Educational Background = Academic Background = Qualifications
- Projects = Key Projects = Personal Projects = Notable Projects = Selected Projects
- Certifications = Certificates = Credentials = Licenses & Certifications

### JOB TITLES (normalize before comparing)
- SWE / Software Developer / Dev Engineer → Software Engineer
- ETL Developer / Data Pipeline Engineer / ETL Engineer → Data Engineer
- BI Analyst / Reporting Analyst / Business Intelligence Analyst → Data Analyst
- AI/ML Engineer / Machine Learning Engineer → ML Engineer
- Sr. / Sr → Senior | Jr. / Jr → Junior

### COMPANY NAMES (match loosely — ignore legal suffixes)
- "Wipro Pvt Ltd" = "Wipro" = "Wipro Technologies"
- Ignore: Ltd, LLC, Corp, Inc, Pvt, Technologies (as suffix)

### DATES (all formats mean the same thing)
- "Jan 2024" = "January 2024" = "01/2024" = "2024-01"
- "Present" = "Current" = "Now" = "Ongoing"

### DEGREES
- MS / M.S. / MSc / Master's → Master of Science
- BS / B.S. / BSc / Bachelor's → Bachelor of Science
- B.Tech / BTech → Bachelor of Technology
- PhD / Ph.D → Doctor of Philosophy

### CERTIFICATIONS (match by exam code OR full name)
- AI-102 = Azure AI Engineer Associate
- AZ-204 = Azure Developer Associate
- CLF-C02 = AWS Cloud Practitioner
- PL-300 = Power BI Data Analyst Associate

### BULLET SEMANTICS (match by concept, not exact words)
- "built ETL pipelines" matches "developed data workflows"
- "improved response time by X%" matches "optimized performance"
- "containerized with Docker" matches "container orchestration"
- "Databricks" implies "Apache Spark"
- "Azure" implies cloud computing experience

### THE GOLDEN MATCHING RULE
A keyword match is valid if ANY of these are true:
1. Exact word match (after lowercasing)
2. Synonym/acronym match (from rules above)
3. One is a subset of the other ("Spark" matches "Apache Spark")
4. One implies the other ("Databricks" implies "Apache Spark")
5. Same concept, different phrasing ("built pipelines" = "ETL workflows")
When in doubt → count as a match and flag it.
`;

  // ---- No-key shim ----------------------------------------------------------

  // The static deploy has no Flask backend, so when a user calls an AI
  // function without a BYOK Anthropic key we surface a toast + open
  // Settings and throw — each call site already has a try/catch that
  // degrades gracefully (returns the original text, score=0, etc).
  let _byokNudgeShownAt = 0;
  async function _demoFallback(_path, _payload) {
    const now = Date.now();
    // Throttle the toast+modal to once every 8 s so a screen full of
    // bullets being improved doesn't open Settings five times.
    if (now - _byokNudgeShownAt > 8000) {
      _byokNudgeShownAt = now;
      try {
        if (typeof window.showToast === "function") {
          window.showToast(
            "AI requires an Anthropic API key. Open Settings to add one.",
            "error",
          );
        }
        if (typeof window.openSettingsModal === "function") {
          setTimeout(() => { try { window.openSettingsModal(); } catch (_) {} }, 250);
        }
      } catch (_) {}
    }
    throw new Error("ai_unavailable_no_key");
  }

  // ---- Public: scoreAts -----------------------------------------------------

  async function aiScoreAts(resumeText, jobDescription, finalCheck) {
    if (!_useDirect()) {
      return _demoFallback("/api/score", {
        resume_text: resumeText,
        description: jobDescription,
        final_check: !!finalCheck,
      });
    }

    const MAX_RESUME_CHARS = 6000;
    const MAX_JD_CHARS = 3000;
    const compactMode = !finalCheck;

    const r1 = _truncate(resumeText, MAX_RESUME_CHARS, "resume");
    const j1 = _truncate(jobDescription, MAX_JD_CHARS, "job description");
    const truncationWarning = _formatTruncationWarning([r1.clip, j1.clip]);

    let resumeForPrompt = r1.text;
    let jdForPrompt = j1.text;
    if (compactMode) {
      const [cr, cj] = _compactScoringPayload(resumeText, jobDescription);
      resumeForPrompt = cr;
      jdForPrompt = cj;
    }

    const prompt =
`You are an expert ATS (Applicant Tracking System) analyst with deep knowledge of hiring systems used by Amazon, Microsoft, Google, and Meta.

${NORMALIZATION_RULES}

Analyze how well this resume matches the job description using the normalization rules above. Be accurate and honest — do not inflate scores.

Return a JSON object with these exact keys:
{
  "score": <integer 0-100>,
  "verdict": <"Excellent Match" | "Strong Match" | "Good Match" | "Weak Match">,
  "matched_keywords": [<list of up to 12 important keywords/phrases found in BOTH>],
  "missing_keywords":  [<list of up to 6 important JD keywords NOT in resume>],
  "categories": {
    "core_skills":        <integer 0-100>,
    "experience_match":   <integer 0-100>,
    "tools_technologies": <integer 0-100>,
    "domain_knowledge":   <integer 0-100>,
    "soft_skills":        <integer 0-100>
  },
  "tip": "<one specific, actionable sentence — the single most impactful change to make>"
}

Return ONLY valid JSON. No markdown, no backticks, no explanation outside the JSON.

RESUME:
${resumeForPrompt}

JOB DESCRIPTION:
${jdForPrompt}`;

    try {
      const result = await _callJson(prompt, compactMode ? 700 : 900);
      if (truncationWarning) result.truncation_warning = truncationWarning;
      return result;
    } catch (e) {
      console.warn("[ats] Score error:", e);
      return {
        score: 0, verdict: "Error",
        matched_keywords: [], missing_keywords: [],
        categories: {
          core_skills: 0, experience_match: 0,
          tools_technologies: 0, domain_knowledge: 0, soft_skills: 0,
        },
        tip: `Scoring failed: ${e.message || e}`,
        truncation_warning: truncationWarning,
      };
    }
  }

  // ---- Public: tailorResume -------------------------------------------------

  // Tiny port of get_canonical_section / SECTION_SYNONYMS minimal subset used
  // by tailor_resume's _extract_section / _replace_section_in_output.
  const _SECTION_ALIASES = {
    "education": ["education", "educational background", "academic background", "qualifications", "academic qualifications"],
    "certifications": ["certifications", "certificates", "licenses & certifications", "professional certifications", "credentials", "licenses and certifications"],
  };

  function _extractSection(text, header) {
    const aliasSet = _SECTION_ALIASES[header.toLowerCase()] || [header.toLowerCase()];
    const lines = text.split("\n");
    let inSection = false;
    const result = [];
    for (const line of lines) {
      const stripped = line.trim();
      const lower = stripped.toLowerCase().replace(/:+$/, "");
      const isTarget = aliasSet.indexOf(lower) !== -1 ||
                       stripped.toUpperCase() === header.toUpperCase() ||
                       stripped.toUpperCase().startsWith(header.toUpperCase());

      if (isTarget) { inSection = true; result.push(line); continue; }
      if (inSection) {
        const cleaned = stripped.replace(/[ \t&/]/g, "");
        const isNewHeader = (cleaned && cleaned === cleaned.toUpperCase() && /^[A-Za-z]+$/.test(cleaned) && cleaned.length > 2);
        if (isNewHeader) break;
        result.push(line);
      }
    }
    return result.join("\n").trim();
  }

  function _replaceSectionInOutput(output, header, replacement) {
    const lines = output.split("\n");
    const result = [];
    let skip = false;
    const headerUp = header.toUpperCase();
    let inserted = false;
    for (const line of lines) {
      const stripped = line.trim().toUpperCase();
      const isHeader = stripped === headerUp || stripped.startsWith(headerUp + " ");
      if (isHeader && !inserted) {
        result.push(replacement);
        result.push("");
        skip = true;
        inserted = true;
        continue;
      }
      if (skip) {
        // Skip until the next ALL-CAPS-ish header line.
        const isUpHeader = stripped && stripped.length > 3 && /[A-Z]/.test(stripped) &&
          [...stripped].every(c => c === c.toUpperCase());
        if (isUpHeader) {
          skip = false;
          result.push(line);
        }
        continue;
      }
      result.push(line);
    }
    if (!inserted) {
      result.push("");
      result.push(replacement);
    }
    return result.join("\n");
  }

  async function aiTailorResume(resumeText, jobDescription, jobTitle, company) {
    if (!_useDirect()) {
      const j = await _demoFallback("/api/tailor", {
        resume_text: resumeText,
        description: jobDescription,
        job_title: jobTitle || "",
        company: company || "",
      });
      // Server returns {tailored, report, jd_analysis, audit, truncation_warning?}
      return j;
    }

    const realEducation = _extractSection(resumeText, "EDUCATION");
    const realCerts = _extractSection(resumeText, "CERTIFICATIONS");

    const jdClip = _truncate(jobDescription, 3000, "job description");
    const resumeClip = _truncate(resumeText, 6000, "resume");
    const truncationWarning = _formatTruncationWarning([jdClip.clip, resumeClip.clip]);

    const prompt =
`# SYSTEM PROMPT: Elite Resume Tailoring Engine v2.0

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
JOB TITLE: ${jobTitle || ""}
COMPANY: ${company || ""}

JOB DESCRIPTION:
${jdClip.text}

ORIGINAL RESUME:
${resumeClip.text}

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
[One powerful sentence connecting candidate's strongest match to the role]`;

    try {
      const raw = await _call(prompt, 6000);

      let jdAnalysis = "";
      let audit = "";
      let resumeRaw = resumeText;
      let report = "";

      if (raw.indexOf("### SECTION 1:") !== -1) {
        const a = raw.split("### SECTION 1:")[1];
        jdAnalysis = (a.indexOf("### SECTION 2:") !== -1 ? a.split("### SECTION 2:")[0] : "").trim();
      }
      if (raw.indexOf("### SECTION 2:") !== -1) {
        const a = raw.split("### SECTION 2:")[1];
        audit = (a.indexOf("### SECTION 3:") !== -1 ? a.split("### SECTION 3:")[0] : "").trim();
      }
      if (raw.indexOf("### SECTION 3:") !== -1) {
        const a = raw.split("### SECTION 3:")[1];
        resumeRaw = (a.indexOf("### SECTION 4:") !== -1 ? a.split("### SECTION 4:")[0] : a).trim();
        if (resumeRaw.startsWith("TAILORED RESUME")) {
          resumeRaw = resumeRaw.slice("TAILORED RESUME".length).trim();
        }
      }
      if (raw.indexOf("### SECTION 4:") !== -1) {
        report = raw.split("### SECTION 4:")[1].trim();
      }

      if (realEducation) {
        if (resumeRaw.indexOf("EDUCATION_PLACEHOLDER") !== -1) {
          resumeRaw = resumeRaw.replace("EDUCATION_PLACEHOLDER", realEducation);
        } else {
          resumeRaw = _replaceSectionInOutput(resumeRaw, "EDUCATION", realEducation);
        }
      }
      if (realCerts) {
        if (resumeRaw.indexOf("CERTIFICATIONS_PLACEHOLDER") !== -1) {
          resumeRaw = resumeRaw.replace("CERTIFICATIONS_PLACEHOLDER", realCerts);
        } else {
          resumeRaw = _replaceSectionInOutput(resumeRaw, "CERTIFICATIONS", realCerts);
        }
      }

      return {
        tailored: _cleanResume(resumeRaw),
        report: report,
        jd_analysis: jdAnalysis,
        audit: audit,
        truncation_warning: truncationWarning,
      };
    } catch (e) {
      console.warn("[tailor] Error:", e);
      return {
        tailored: resumeText,
        report: `Error: ${e.message || e}`,
        jd_analysis: "",
        audit: "",
        truncation_warning: truncationWarning,
      };
    }
  }

  // ---- Public: applyChatInstruction ----------------------------------------

  async function aiApplyChatInstruction(opts) {
    opts = opts || {};
    const instruction = opts.instruction || "";
    const resumeText = opts.resume_text || "";
    const description = opts.description || "";
    const jobTitle = opts.job_title || "";
    const company = opts.company || "";
    const chatHistory = opts.chat_history || [];
    const version = opts.version || 1;
    const originalResume = opts.original_resume || "";

    if (!_useDirect()) {
      const j = await _demoFallback("/api/chat-instruction", {
        instruction, resume_text: resumeText, description,
        job_title: jobTitle, company, chat_history: chatHistory,
        version, original_resume: originalResume,
      });
      return j;
    }

    const recent = chatHistory.slice(-CHAT_HISTORY_MAX_MESSAGES);
    const older = chatHistory.slice(0, -CHAT_HISTORY_MAX_MESSAGES);

    const messages = [];
    const olderSummary = _summarizeOlderHistory(older);
    if (olderSummary) messages.push({ role: "assistant", content: olderSummary });

    const desc = _truncate(description, 2000, "job description");
    const orig = _truncate(originalResume || resumeText || "", 4000, "original resume");
    const curr = _truncate(resumeText || "", 4000, "current resume");
    const truncationWarning = _formatTruncationWarning([desc.clip, orig.clip, curr.clip]);

    const sessionContext =
`SESSION CONTEXT (do not respond to this, just load it):

JOB DESCRIPTION:
${desc.text ? desc.text : "Not provided"}

ORIGINAL RESUME (v1 — never modify this reference):
${orig.text}

CURRENT RESUME (v${version}):
${curr.text}`;

    messages.push({ role: "user", content: sessionContext });
    messages.push({ role: "assistant", content: "Context loaded. Ready to help refine your resume." });

    for (const msg of recent) {
      messages.push({
        role: msg.role === "user" ? "user" : "assistant",
        content: msg.text || "",
      });
    }
    messages.push({ role: "user", content: instruction });

    const systemPrompt =
`# SYSTEM PROMPT: JobPilot Conversational Resume Editor v3.0

## IDENTITY
You are JobPilot's AI Resume Coach — a conversational career expert who helps
candidates refine their tailored resume through natural dialogue. You combine
the precision of a professional resume writer with the warmth of a career mentor.

You always have access to:
- ORIGINAL JOB DESCRIPTION (JD) — the target role
- ORIGINAL RESUME — candidate's unmodified base resume
- CURRENT RESUME — the latest edited version (v${version})
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

Resume v${version + 1}:
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
- Never use: passionate, team player, results-driven, go-getter, synergy, dynamic`;

    try {
      const raw = await _callDirect(systemPrompt, messages, 4000);

      // ANSWER: — conversation only.
      if (raw.startsWith("ANSWER:")) {
        const answer = raw.slice("ANSWER:".length).trim();
        return {
          updated_resume: resumeText,
          explanation: answer,
          resume_changed: false,
          version: version,
          truncation_warning: truncationWarning,
        };
      }

      // Resume v[N]: — edit applied.
      const versionMatch = raw.match(/Resume v(\d+):/);
      if (versionMatch) {
        const newVersion = parseInt(versionMatch[1], 10);
        const afterLabel = raw.slice(versionMatch.index + versionMatch[0].length).trim();

        let explanation = "";
        let resumeRaw = afterLabel;
        if (afterLabel.indexOf("✅ Change Log:") !== -1) {
          const parts = afterLabel.split("✅ Change Log:");
          resumeRaw = parts[0].trim();
          explanation = "✅ Change Log:" + parts.slice(1).join("✅ Change Log:").trim();
        } else if (afterLabel.indexOf("✅") !== -1) {
          const parts = afterLabel.split("✅");
          resumeRaw = parts[0].trim();
          explanation = "✅" + parts.slice(1).join("✅").trim();
        }

        return {
          updated_resume: _cleanResume(resumeRaw),
          explanation: explanation || "Applied your change.",
          resume_changed: true,
          version: newVersion,
          truncation_warning: truncationWarning,
        };
      }

      // Legacy UPDATED RESUME: format.
      if (raw.indexOf("UPDATED RESUME:") !== -1) {
        const parts = raw.split("UPDATED RESUME:");
        let resumeRaw = parts.slice(1).join("UPDATED RESUME:");
        let explanation = "";
        if (resumeRaw.indexOf("EXPLANATION:") !== -1) {
          const [r, e] = resumeRaw.split("EXPLANATION:");
          resumeRaw = r.trim();
          explanation = e.trim();
        }
        return {
          updated_resume: _cleanResume(resumeRaw.trim()),
          explanation: explanation || "Applied your change.",
          resume_changed: true,
          version: version + 1,
          truncation_warning: truncationWarning,
        };
      }

      // Fallback — treat as conversational.
      return {
        updated_resume: resumeText,
        explanation: raw,
        resume_changed: false,
        version: version,
        truncation_warning: truncationWarning,
      };
    } catch (e) {
      console.warn("[chat_instruction] Error:", e);
      return {
        updated_resume: resumeText,
        explanation: `Error: ${e.message || e}`,
        resume_changed: false,
        version: version,
        truncation_warning: truncationWarning,
      };
    }
  }

  // ---- Public: improveLine --------------------------------------------------

  async function aiImproveLine(line, jobDescription, jobTitle) {
    if (!_useDirect()) {
      const j = await _demoFallback("/api/improve-line", {
        line, description: jobDescription || "", job_title: jobTitle || "",
      });
      return j;
    }
    const context = jobTitle ? ` for a ${jobTitle} role` : "";
    const jdHint = jobDescription ? `\n\nJob description context:\n${jobDescription.slice(0, 800)}` : "";
    const prompt =
`You are an expert resume writer.

Improve this resume bullet point${context}. Make it:
- Start with a stronger, more specific action verb
- More quantified and impactful (add metrics if possible)
- Include relevant keywords naturally
- Concise and punchy — max 2 sentences
- Sound human and genuine, not robotic

ORIGINAL BULLET: ${line}
${jdHint}

Return ONLY the improved bullet text. Nothing else.`;
    try {
      const improved = await _call(prompt, 200);
      return { improved };
    } catch (e) {
      console.warn("[improve_line] Error:", e);
      return { improved: line };
    }
  }

  // ---- Public: generateResume ----------------------------------------------

  async function aiGenerateResume(userDescription, jobTitle, jobDescription) {
    if (!_useDirect()) {
      const j = await _demoFallback("/api/generate-resume", {
        description: userDescription,
        job_title: jobTitle || "",
        job_description: jobDescription || "",
      });
      return j;
    }

    const jdClip = _truncate(jobDescription || "", 2500, "job description");
    const truncationWarning = _formatTruncationWarning([jdClip.clip]);

    let jdSection = "";
    if (jobTitle || jobDescription) {
      jdSection =
`TARGET ROLE: ${jobTitle || ""}

JOB DESCRIPTION (tailor resume to this from the start):
${jdClip.text}`;
    }

    const prompt =
`# SYSTEM PROMPT: JobPilot Resume Generation Engine v2.0

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

${jdSection}

USER INPUT:
${userDescription}`;

    try {
      const resume = await _call(prompt, 7000);
      return { resume, truncation_warning: truncationWarning };
    } catch (e) {
      console.warn("[generate_resume] Error:", e);
      return { resume: "", truncation_warning: truncationWarning, error: e.message || String(e) };
    }
  }

  // ---- Expose --------------------------------------------------------------

  window.aiScoreAts = aiScoreAts;
  window.aiTailorResume = aiTailorResume;
  window.aiApplyChatInstruction = aiApplyChatInstruction;
  window.aiImproveLine = aiImproveLine;
  window.aiGenerateResume = aiGenerateResume;
})();
