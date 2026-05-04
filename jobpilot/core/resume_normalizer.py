"""
resume_normalizer.py  —  Normalize and parse resume text into structured data.

Layers:
  1. Section name normalization (synonyms → canonical names)
  2. Field normalization (job titles, companies, dates, degrees, certifications)
  3. Semantic/bullet normalization (delegated to AI)

Main API:
  normalize_resume(text)       → structured dict with name, contact, sections
  get_canonical_section(line)  → canonical section name or None
"""

import re


# ─────────────────────────────────────────
# LAYER 1: SECTION NAME NORMALIZATION
# ─────────────────────────────────────────
SECTION_SYNONYMS = {
    # Experience
    "work experience"            : "experience",
    "professional experience"    : "experience",
    "employment history"         : "experience",
    "career history"             : "experience",
    "work history"               : "experience",
    "experience"                 : "experience",
    "relevant experience"        : "experience",
    "job history"                : "experience",

    # Skills
    "technical skills"           : "skills",
    "technologies and tools"     : "skills",
    "core competencies"          : "skills",
    "key skills"                 : "skills",
    "tools & technologies"       : "skills",
    "tech stack"                 : "skills",
    "competencies"               : "skills",
    "skills & expertise"         : "skills",
    "areas of expertise"         : "skills",
    "tools and technologies"     : "skills",
    "skills"                     : "skills",
    "technical expertise"        : "skills",

    # Summary
    "professional summary"       : "summary",
    "career summary"             : "summary",
    "summary of qualifications"  : "summary",
    "profile"                    : "summary",
    "about me"                   : "summary",
    "objective"                  : "summary",
    "career objective"           : "summary",
    "professional profile"       : "summary",
    "summary"                    : "summary",
    "executive summary"          : "summary",

    # Education
    "education"                  : "education",
    "educational background"     : "education",
    "academic background"        : "education",
    "qualifications"             : "education",
    "academic qualifications"    : "education",

    # Projects
    "projects"                   : "projects",
    "key projects"               : "projects",
    "personal projects"          : "projects",
    "notable projects"           : "projects",
    "selected projects"          : "projects",
    "project experience"         : "projects",
    "academic projects"          : "projects",

    # Certifications
    "certifications"             : "certifications",
    "certificates"               : "certifications",
    "licenses & certifications"  : "certifications",
    "professional certifications": "certifications",
    "credentials"                : "certifications",
    "licenses and certifications": "certifications",

    # Awards / Publications (pass-through)
    "awards"                     : "awards",
    "honors"                     : "awards",
    "publications"               : "publications",
    "volunteer"                  : "volunteer",
    "volunteer experience"       : "volunteer",
    "languages"                  : "languages",
}


# ─────────────────────────────────────────
# LAYER 2A: JOB TITLE NORMALIZATION
# ─────────────────────────────────────────
JOB_TITLE_SYNONYMS = {
    "swe"                           : "software engineer",
    "software developer"            : "software engineer",
    "software development engineer" : "software engineer",
    "dev engineer"                  : "software engineer",
    "application developer"         : "software engineer",
    "application engineer"          : "software engineer",
    "programmer"                    : "software engineer",
    "de"                            : "data engineer",
    "data pipeline engineer"        : "data engineer",
    "etl developer"                 : "data engineer",
    "etl engineer"                  : "data engineer",
    "big data engineer"             : "data engineer",
    "machine learning engineer"     : "ml engineer",
    "ai engineer"                   : "ml engineer",
    "ml/ai engineer"                : "ml engineer",
    "ai/ml engineer"                : "ml engineer",
    "mlops engineer"                : "ml engineer",
    "bi analyst"                    : "data analyst",
    "business intelligence analyst" : "data analyst",
    "analytics engineer"            : "data analyst",
    "reporting analyst"             : "data analyst",
    "ds"                            : "data scientist",
    "research scientist"            : "data scientist",
    "applied scientist"             : "data scientist",
    "sr."                           : "senior",
    "sr "                           : "senior",
    "jr."                           : "junior",
    "jr "                           : "junior",
}


# ─────────────────────────────────────────
# LAYER 2B: COMPANY NAME NORMALIZATION
# ─────────────────────────────────────────
COMPANY_SYNONYMS = {
    "wipro pvt ltd"             : "wipro",
    "wipro technologies"        : "wipro",
    "wipro ltd"                 : "wipro",
    "quadrant technologies llc" : "quadrant technologies",
    "quadrant tech"             : "quadrant technologies",
    "microsoft corporation"     : "microsoft",
    "microsoft corp"            : "microsoft",
    "amazon web services"       : "aws",
    "google llc"                : "google",
    "alphabet"                  : "google",
    "meta platforms"            : "meta",
    "facebook"                  : "meta",
}


# ─────────────────────────────────────────
# LAYER 2C: DATE FORMAT NORMALIZATION
# ─────────────────────────────────────────
MONTH_MAP = {
    "jan": "01", "feb": "02", "mar": "03", "apr": "04",
    "may": "05", "jun": "06", "jul": "07", "aug": "08",
    "sep": "09", "oct": "10", "nov": "11", "dec": "12",
    "january": "01", "february": "02", "march": "03",
    "april": "04", "june": "06", "july": "07",
    "august": "08", "september": "09", "october": "10",
    "november": "11", "december": "12",
}


def normalize_date(date_str: str) -> str:
    """Normalize any date format to MM/YYYY."""
    s = date_str.strip().lower()
    if s in ["present", "current", "now", "ongoing", "till date"]:
        return "Present"
    if re.match(r'\d{2}/\d{4}', s):
        return s
    match = re.match(r'([a-z]+)\.?\s+(\d{4})', s)
    if match:
        month = MONTH_MAP.get(match.group(1), "01")
        return f"{month}/{match.group(2)}"
    match = re.match(r'(\d{4})-(\d{2})', s)
    if match:
        return f"{match.group(2)}/{match.group(1)}"
    match = re.match(r'(\d{4})', s)
    if match:
        return f"01/{match.group(1)}"
    return date_str


# ─────────────────────────────────────────
# LAYER 2D: DEGREE NORMALIZATION
# ─────────────────────────────────────────
DEGREE_SYNONYMS = {
    "ms"                        : "master of science",
    "m.s."                      : "master of science",
    "msc"                       : "master of science",
    "m.sc"                      : "master of science",
    "master's"                  : "master of science",
    "masters"                   : "master of science",
    "master of science"         : "master of science",
    "m.eng"                     : "master of engineering",
    "master of engineering"     : "master of engineering",
    "mba"                       : "master of business administration",
    "bs"                        : "bachelor of science",
    "b.s."                      : "bachelor of science",
    "bsc"                       : "bachelor of science",
    "bachelor's"                : "bachelor of science",
    "bachelors"                 : "bachelor of science",
    "b.tech"                    : "bachelor of technology",
    "btech"                     : "bachelor of technology",
    "be"                        : "bachelor of engineering",
    "b.e."                      : "bachelor of engineering",
    "bachelor of science"       : "bachelor of science",
    "bachelor of technology"    : "bachelor of technology",
    "as"                        : "associate of science",
    "aa"                        : "associate of arts",
    "phd"                       : "doctor of philosophy",
    "ph.d"                      : "doctor of philosophy",
    "doctorate"                 : "doctor of philosophy",
}


# ─────────────────────────────────────────
# LAYER 2E: CERTIFICATION NORMALIZATION
# ─────────────────────────────────────────
CERT_SYNONYMS = {
    "az-204"           : "azure developer associate",
    "az-104"           : "azure administrator associate",
    "az-900"           : "azure fundamentals",
    "ai-102"           : "azure ai engineer associate",
    "dp-203"           : "azure data engineer associate",
    "dp-900"           : "azure data fundamentals",
    "pl-300"           : "power bi data analyst associate",
    "clf-c02"          : "aws cloud practitioner",
    "clf-c01"          : "aws cloud practitioner",
    "saa-c03"          : "aws solutions architect associate",
    "dva-c02"          : "aws developer associate",
    "mls-c01"          : "aws machine learning specialty",
    "gcp ace"          : "google cloud associate cloud engineer",
    "gcp pca"          : "google cloud professional cloud architect",
    "databricks certified": "databricks certified",
    "dea"              : "databricks certified data engineer associate",
    "pmp"              : "project management professional",
    "csm"              : "certified scrum master",
}


# ─────────────────────────────────────────
# LAYER 3: SEMANTIC / BULLET NORMALIZATION
# (handled by AI — not a dictionary)
# ─────────────────────────────────────────
#
# CONCEPT: "built data pipelines"
#   = "developed ETL workflows" = "created data ingestion pipelines"
#   = "architected ELT processes" = "engineered data flows"
#
# CONCEPT: "improved performance"
#   = "optimized latency" = "reduced response time"
#   = "enhanced throughput" = "cut processing time"
#
# The AI handles this layer — it understands meaning, not just words.


# ─────────────────────────────────────────
# NORMALIZATION RULES (for AI prompt injection)
# ─────────────────────────────────────────
NORMALIZATION_RULES = """
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
"""


# ─────────────────────────────────────────
# MAIN PARSER
# ─────────────────────────────────────────

def get_canonical_section(line: str) -> str | None:
    """
    Map any section header line to its canonical name.
    Returns canonical name (e.g. "experience") or None if not recognized.
    """
    stripped = line.strip().lower()
    stripped = stripped.rstrip(":").strip()
    return SECTION_SYNONYMS.get(stripped)


def _is_section_header(line: str) -> bool:
    """True if line looks like a resume section header (ALL CAPS or known section name)."""
    stripped = line.strip()
    if len(stripped) < 3:
        return False
    # Known section synonym
    if get_canonical_section(stripped):
        return True
    # ALL CAPS line (e.g. "WORK EXPERIENCE", "KEY PROJECTS")
    cleaned = stripped.replace(" ", "").replace("&", "").replace("/", "").replace("-", "")
    return cleaned == cleaned.upper() and cleaned.isalpha() and len(cleaned) > 2


def normalize_resume(text: str) -> dict:
    """
    Parse raw resume text into a structured dict with normalized section names.

    Returns:
    {
        "name": str,
        "contact": str,
        "sections": {
            "summary": str,
            "experience": str,
            "skills": str,
            "education": str,
            "projects": str,
            "certifications": str,
            ...  (other sections as found)
        }
    }
    """
    lines = text.split("\n")

    name = ""
    contact = ""
    sections: dict[str, list[str]] = {}
    current_section: str | None = None
    current_lines: list[str] = []
    header_done = False
    name_done = False

    def flush():
        if current_section is not None and current_lines:
            body = "\n".join(current_lines).strip()
            if body:
                if current_section in sections:
                    sections[current_section] += "\n" + body
                else:
                    sections[current_section] = body

    for line in lines:
        stripped = line.strip()

        # ── Name: first non-empty line with no @ or | ────────────────────────
        if not name_done and stripped and "@" not in stripped and "|" not in stripped:
            if not _is_section_header(stripped):
                name = stripped
                name_done = True
                continue

        # ── Contact: line with @ or | after name ─────────────────────────────
        if name_done and not header_done and stripped and ("@" in stripped or "|" in stripped):
            contact = stripped
            header_done = True
            continue

        # ── Section header ────────────────────────────────────────────────────
        if stripped and _is_section_header(stripped):
            flush()
            current_lines = []
            canonical = get_canonical_section(stripped)
            current_section = canonical if canonical else stripped.lower()
            continue

        # ── Body lines ────────────────────────────────────────────────────────
        if current_section is not None:
            current_lines.append(line)
        # Lines before first section (after contact) are ignored

    flush()

    return {
        "name": name,
        "contact": contact,
        "sections": sections,
    }


# ─────────────────────────────────────────
# PUBLIC NORMALIZATION HELPERS
#
# These helpers are exposed for callers (frontend integrations, future
# matchers, ATS analytics) that need to reduce surface variants to a
# canonical form. They intentionally remain in the module surface even if
# the current Flask routes don't yet consume them.
# ─────────────────────────────────────────

def normalize_company(name: str) -> str:
    """Normalize company name by stripping legal suffixes and applying synonyms."""
    lower = name.strip().lower()
    if lower in COMPANY_SYNONYMS:
        return COMPANY_SYNONYMS[lower]
    # Strip trailing legal suffixes
    for suffix in [" pvt ltd", " ltd", " llc", " corp", " inc", " technologies", " solutions"]:
        if lower.endswith(suffix):
            lower = lower[: -len(suffix)].strip()
    return lower.title()


def normalize_job_title(title: str) -> str:
    """Normalize job title using synonym map."""
    lower = title.strip().lower()
    return JOB_TITLE_SYNONYMS.get(lower, title.strip())


def normalize_degree(degree: str) -> str:
    """Normalize degree abbreviation to full name."""
    lower = degree.strip().lower().rstrip(".")
    return DEGREE_SYNONYMS.get(lower, degree.strip())
