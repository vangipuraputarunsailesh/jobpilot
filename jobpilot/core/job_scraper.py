"""
job_scraper.py  —  Enterprise job search via real aggregator APIs

Sources (in order of coverage):
  1. JSearch (RapidAPI)   — aggregates LinkedIn, Indeed, Glassdoor, ZipRecruiter via Google Jobs
  2. Adzuna               — broad US market, excellent small-company coverage
  3. The Muse             — free, no key, tech & startup companies
  4. Remotive             — free, no key, remote-only positions
  5. USAJobs              — free, government / federal positions
  6. Arbeitnow            — free, no key, remote + international with US filter

All sources are filtered to US + Remote jobs only.
Results are deduplicated by title+company.

Required env vars (set in .env):
  ANTHROPIC_API_KEY   — already set
  RAPIDAPI_KEY        — sign up free at rapidapi.com, subscribe to JSearch (500 req/mo free)
  ADZUNA_APP_ID       — sign up free at developer.adzuna.com
  ADZUNA_APP_KEY      — same as above
  USAJOBS_API_KEY     — sign up free at developer.usajobs.gov
  USAJOBS_EMAIL       — the email you registered with at usajobs.gov

Fixes applied:
  [FIX 1] JSearch & Adzuna now send quoted exact-phrase queries to the API
          e.g. '"Data Engineer" United States' instead of 'Data Engineer jobs in United States'
          This reduces garbage results at the source before filtering even runs.

  [FIX 2] _title_matches() now has 4 layers:
          Layer A — strip filler words, build query_words (unchanged)
          Layer B — ALL query words must appear as WHOLE words in title (unchanged)
          Layer C — query words must appear within 4 words of each other (proximity)
          Layer D — NEW: query words must appear in the SAME ORDER as the search query
                    e.g. searching "Data Engineer" → "data" must come BEFORE "engineer"
                    blocks "AI/ML Engineer (Data Focus)" where engineer precedes data
                    keeps "Data Engineer", "Data Platform Engineer", "Senior Data Engineer"
                    ORDER_FLEXIBLE = True  ← set to True to allow any order (less strict)

  [FIX 3] Null/empty title guard tightened — empty or whitespace-only titles
          are rejected before _title_matches() is even called.
"""

import os
import re
import time
import random
import json
import logging
import urllib.parse
from pathlib import Path
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from itertools import product as itertools_product

logger = logging.getLogger("jobpilot")


# ── Role Alias Map ────────────────────────────────────────────────────────────
# When a user searches a broad role, expand it to all titles that fall under it.
# Apify receives ALL aliases as search queries → platform-level matching.
# _title_matches() then checks against ALL aliases, not just the original query.

ROLE_ALIASES: dict[str, list[str]] = {
    # ── Software / Engineering ─────────────────────────────────────────────────
    "software engineer": [
        "software engineer", "software developer", "software development engineer",
        "full stack engineer", "full stack developer", "fullstack engineer",
        "backend engineer", "backend developer", "back end engineer",
        "frontend engineer", "frontend developer", "front end engineer",
        "web developer", "web engineer", "application developer",
        "application engineer", "swe",
    ],
    "full stack engineer": [
        "full stack engineer", "full stack developer", "fullstack engineer",
        "fullstack developer", "software engineer", "web developer",
    ],
    "backend engineer": [
        "backend engineer", "backend developer", "back end engineer",
        "back end developer", "server side engineer", "api engineer",
        "software engineer", "software developer",
    ],
    "frontend engineer": [
        "frontend engineer", "frontend developer", "front end engineer",
        "front end developer", "ui engineer", "ui developer",
        "react developer", "react engineer", "angular developer", "vue developer",
        "javascript developer", "javascript engineer",
    ],

    # ── Data ───────────────────────────────────────────────────────────────────
    "data engineer": [
        "data engineer", "data pipeline engineer", "etl developer",
        "etl engineer", "data platform engineer", "big data engineer",
        "analytics engineer", "data infrastructure engineer",
    ],
    "data scientist": [
        "data scientist", "data science engineer", "machine learning scientist",
        "applied scientist", "research scientist", "quantitative analyst",
    ],
    "data analyst": [
        "data analyst", "business analyst", "business intelligence analyst",
        "bi analyst", "reporting analyst", "analytics analyst",
        "quantitative analyst", "insights analyst",
    ],
    "machine learning engineer": [
        "machine learning engineer", "ml engineer", "ai engineer",
        "ai/ml engineer", "deep learning engineer", "applied ml engineer",
        "mlops engineer", "research engineer",
    ],

    # ── Cloud / DevOps / Infrastructure ───────────────────────────────────────
    "devops engineer": [
        "devops engineer", "site reliability engineer", "sre",
        "platform engineer", "cloud engineer", "infrastructure engineer",
        "release engineer", "build engineer", "devsecops engineer",
    ],
    "cloud engineer": [
        "cloud engineer", "cloud architect", "aws engineer", "azure engineer",
        "gcp engineer", "cloud infrastructure engineer", "devops engineer",
        "platform engineer",
    ],

    # ── Product / Design ───────────────────────────────────────────────────────
    "product manager": [
        "product manager", "product owner", "technical product manager",
        "senior product manager", "associate product manager",
        "program manager", "digital product manager",
    ],
    "ux designer": [
        "ux designer", "ui designer", "ui/ux designer", "product designer",
        "interaction designer", "user experience designer",
        "user interface designer", "visual designer",
    ],

    # ── Cybersecurity ──────────────────────────────────────────────────────────
    "security engineer": [
        "security engineer", "cybersecurity engineer", "information security engineer",
        "application security engineer", "cloud security engineer",
        "security analyst", "penetration tester", "soc analyst",
    ],

    # ── Management / Leadership ────────────────────────────────────────────────
    "engineering manager": [
        "engineering manager", "software engineering manager",
        "director of engineering", "vp of engineering",
        "technical lead", "tech lead", "team lead",
    ],

    # ── QA ─────────────────────────────────────────────────────────────────────
    "qa engineer": [
        "qa engineer", "quality assurance engineer", "test engineer",
        "sdet", "automation engineer", "quality engineer",
        "software test engineer",
    ],
}


def _expand_aliases(title: str) -> list[str]:
    """
    Given a search query, return the list of alias titles to search for.
    Falls back to [title] if no alias map entry exists.
    Matching is case-insensitive.
    """
    key = title.strip().lower()
    # Exact match first
    if key in ROLE_ALIASES:
        return ROLE_ALIASES[key]
    # Partial match — if the query contains a known key as a substring
    for k, aliases in ROLE_ALIASES.items():
        if k in key or key in k:
            return aliases
    # No alias found — use the title as-is
    return [title]


# ── HTML stripper ─────────────────────────────────────────────────────────────

def _strip_html(text: str) -> str:
    """Strip HTML tags and decode entities from a string."""
    if not text or "<" not in text:
        return text
    try:
        from bs4 import BeautifulSoup
        return BeautifulSoup(text, "html.parser").get_text(separator="\n", strip=True)
    except Exception:
        import re
        return re.sub(r"<[^>]+>", " ", text).strip()


# ── Shared HTTP helper ────────────────────────────────────────────────────────
# Per-thread session so worker threads in `search_all_platforms`'s ThreadPool
# don't share a mutable `headers` dict (Issue #25). Also installs an HTTPAdapter
# with bounded retries on idempotent GETs (Issue #61).
import threading as _threading
from requests.adapters import HTTPAdapter as _HTTPAdapter
from urllib3.util.retry import Retry as _Retry

_SESSION_TLS = _threading.local()
_DEFAULT_HEADERS = {
    "User-Agent": "JobPilot/2.0 (Enterprise Job Aggregator)",
    "Accept":     "application/json",
}


def _build_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(_DEFAULT_HEADERS)
    retry = _Retry(
        total=3,
        backoff_factor=0.4,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset(("GET", "HEAD")),
        raise_on_status=False,
    )
    adapter = _HTTPAdapter(max_retries=retry, pool_connections=4, pool_maxsize=8)
    s.mount("http://",  adapter)
    s.mount("https://", adapter)
    return s


def _session() -> requests.Session:
    s = getattr(_SESSION_TLS, "session", None)
    if s is None:
        s = _build_session()
        _SESSION_TLS.session = s
    return s


# Backwards-compat alias retained for external callers; per-thread sessions
# are accessed via `_session()` inside `_get`.
_SESSION = _build_session()


# Issue #96 — only the slow rate-limited providers (Adzuna, JSearch) get a
# small randomised pre-request sleep. Free providers (Muse / Remotive /
# USAJobs / Arbeitnow) used to pay an unconditional 0.2–0.6s tax × N
# concurrent requests; that's pure wall-clock for no rate-limit benefit.
_SLOW_HOSTS = ("adzuna.com", "jsearch.p.rapidapi.com")


def _get(url: str, headers: dict = None, params: dict = None, timeout: int = 15) -> requests.Response | None:
    try:
        if any(h in url for h in _SLOW_HOSTS):
            time.sleep(random.uniform(0.05, 0.2))
        sess = _session()
        h = dict(sess.headers)
        if headers:
            h.update(headers)
        r = sess.get(url, headers=h, params=params, timeout=timeout)
        r.raise_for_status()
        return r
    except Exception as e:
        logger.warning("  [scraper] GET failed: %s  —  %s", url[:70], e)
        return None


APIFY_ACTOR_CONFIG_FILE = Path(__file__).with_name("apify_actors.json")
DEFAULT_APIFY_ACTORS = {
    "linkedin":    "bebity/linkedin-jobs-scraper",
    "indeed":     "misceres/indeed-scraper",
    "glassdoor":  "bebity/glassdoor-jobs-scraper",
    "ziprecruiter":"radekmie/ziprecruiter-scraper",
    "modular":    "",
}


def _load_apify_actor_config() -> dict[str, str]:
    actors = DEFAULT_APIFY_ACTORS.copy()
    if not APIFY_ACTOR_CONFIG_FILE.exists():
        return actors
    try:
        data = json.loads(APIFY_ACTOR_CONFIG_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            for key, value in data.items():
                if isinstance(value, str) and key in actors:
                    actors[key] = value.strip()
    except Exception as e:
        logger.warning("  [apify] Failed to load %s: %s", APIFY_ACTOR_CONFIG_FILE.name, e)
    return actors


def _discover_apify_actors(token: str) -> dict[str, str]:
    discovered: dict[str, str] = {}
    if not token:
        return discovered
    try:
        r = _SESSION.get(
            "https://api.apify.com/v2/acts",
            params={"token": token, "search": "job", "limit": 200},
            timeout=30,
        )
        r.raise_for_status()
        payload = r.json()
        items = payload.get("data", {}).get("items", []) if isinstance(payload, dict) else []
        for item in items:
            actor_name = str(item.get("name", "")).strip()
            username = str(item.get("username", "")).strip()
            if not actor_name or not username:
                continue
            full_id = f"{username}~{actor_name}"
            lower = actor_name.lower()
            if "linkedin" in lower and "linkedin" not in discovered:
                discovered["linkedin"] = full_id
            elif "glassdoor" in lower and "glassdoor" not in discovered:
                discovered["glassdoor"] = full_id
            elif "ziprecruiter" in lower and "ziprecruiter" not in discovered:
                discovered["ziprecruiter"] = full_id
            elif "indeed" in lower and "indeed" not in discovered:
                discovered["indeed"] = full_id
            elif "monster" in lower and "modular" not in discovered:
                discovered["modular"] = full_id
            elif "job" in lower and ("scraper" in lower or "search" in lower):
                discovered.setdefault("modular", full_id)
    except Exception as e:
        logger.warning("  [apify] Actor discovery failed: %s", e)
    return discovered


def _get_apify_actor_ids() -> dict[str, str]:
    actors = DEFAULT_APIFY_ACTORS.copy()
    token = os.environ.get("APIFY_API_TOKEN", "").strip()
    if token:
        discovered = _discover_apify_actors(token)
        for key, actor_id in discovered.items():
            if actor_id:
                actors[key] = actor_id
    config_actors = _load_apify_actor_config()
    for key, actor_id in config_actors.items():
        if actor_id:
            actors[key] = actor_id
    env_modular = os.environ.get("APIFY_MODULAR_ACTOR_ID", "").strip()
    if env_modular:
        actors["modular"] = env_modular
    return actors


# Lazy-resolved on first use to avoid an HTTP call to Apify at import time
# (which would slow startup and fail noisily during Apify outages).
# Issue #93 — also negatively cache so an Apify outage doesn't trigger a
# 30-second discovery call on every subsequent search. Both success and
# failure outcomes are TTL'd; on failure we serve the static defaults until
# the TTL elapses.
_APIFY_ACTORS_CACHE: dict[str, str] | None = None
_APIFY_ACTORS_CACHE_AT: float = 0.0
_APIFY_ACTORS_CACHE_TTL_SEC = 300  # 5 minutes

def get_apify_actors() -> dict[str, str]:
    global _APIFY_ACTORS_CACHE, _APIFY_ACTORS_CACHE_AT
    now = time.time()
    if (
        _APIFY_ACTORS_CACHE is not None
        and (now - _APIFY_ACTORS_CACHE_AT) < _APIFY_ACTORS_CACHE_TTL_SEC
    ):
        return _APIFY_ACTORS_CACHE
    try:
        _APIFY_ACTORS_CACHE = _get_apify_actor_ids()
    except Exception as e:
        # Fail-open: keep serving the static defaults until the TTL elapses.
        logger.warning("  [apify] actor-id resolution failed (%s); using defaults", e)
        _APIFY_ACTORS_CACHE = DEFAULT_APIFY_ACTORS.copy()
    _APIFY_ACTORS_CACHE_AT = now
    return _APIFY_ACTORS_CACHE

# Backwards-compatible accessor: code that reads APIFY_ACTORS[...] keeps working.
class _LazyApifyActors:
    def __getitem__(self, key):       return get_apify_actors()[key]
    def get(self, key, default=None): return get_apify_actors().get(key, default)
    def __contains__(self, key):      return key in get_apify_actors()
    def __iter__(self):               return iter(get_apify_actors())
    def items(self):                  return get_apify_actors().items()
    def keys(self):                   return get_apify_actors().keys()
    def values(self):                 return get_apify_actors().values()

APIFY_ACTORS = _LazyApifyActors()


# ── Date normalizer ───────────────────────────────────────────────────────────

def _normalize_date(raw) -> str:
    if not raw:
        return "Today"
    s = str(raw).strip()
    s_low = s.lower()
    if any(k in s_low for k in ("just", "moment", "now", "second")):
        return "Just now"
    if "hour" in s_low:
        n = re.search(r"(\d+)", s)
        return f"{n.group()} hr ago" if n else "Today"
    if "today" in s_low or s_low in ("0", "0 days"):
        return "Today"
    if "day" in s_low:
        n = re.search(r"(\d+)", s)
        return f"{n.group()} day{'s' if n and n.group() != '1' else ''} ago" if n else "Today"
    # Numeric epoch (seconds or milliseconds) — Arbeitnow returns this in `created_at`
    if s.isdigit() and len(s) in (10, 13):
        try:
            ts = int(s) / (1000 if len(s) == 13 else 1)
            dt = datetime.fromtimestamp(ts, tz=timezone.utc)
            delta = datetime.now(timezone.utc) - dt
            d = delta.days
            hrs = delta.seconds // 3600
            if d == 0:
                return f"{hrs} hr ago" if hrs > 0 else "Just now"
            if d == 1:
                return "1 day ago"
            if d < 7:
                return f"{d} days ago"
            return dt.date().isoformat()
        except Exception:
            return "Today"
    # ISO datetime
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        delta = datetime.now(timezone.utc) - dt.astimezone(timezone.utc)
        d = delta.days
        hrs = delta.seconds // 3600
        if d == 0:
            return f"{hrs} hr ago" if hrs > 0 else "Just now"
        if d == 1:
            return "1 day ago"
        if d < 7:
            return f"{d} days ago"
        return s[:10]
    except Exception:
        return s[:10] if len(s) >= 10 else (s or "Today")


# ── Salary builder ────────────────────────────────────────────────────────────

def _salary(min_s, max_s, period=None) -> str:
    suffix = {"year": "/yr", "month": "/mo", "week": "/wk", "hour": "/hr"}.get(
        str(period or "").lower(), ""
    )
    try:
        lo = int(float(min_s)) if min_s else None
        hi = int(float(max_s)) if max_s else None
    except (ValueError, TypeError):
        return "Not listed"
    if lo and hi:
        return f"${lo:,} – ${hi:,}{suffix}"
    if lo:
        return f"${lo:,}+{suffix}"
    return "Not listed"


# ── Location builder ──────────────────────────────────────────────────────────

def _location(city=None, state=None, country=None, is_remote=False) -> str:
    if is_remote:
        return "Remote"
    parts = [p for p in (city, state) if p]
    if parts:
        return ", ".join(parts)
    return country or "United States"


# ── US / Remote filter ────────────────────────────────────────────────────────

_US_STATES = {
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN",
    "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV",
    "NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN",
    "TX","UT","VT","VA","WA","WV","WI","WY","DC"
}
_REMOTE_KEYWORDS = {"remote", "united states", "usa", "u.s.", "us,", "worldwide", "anywhere", "work from home"}
_NON_US_COUNTRIES = {
    "united kingdom", "india", "canada", "australia", "germany", "france",
    "netherlands", "singapore", "brazil", "mexico", "spain", "italy",
    "poland", "uk", "gb", "eu", "europe"
}


def _is_us_or_remote(loc: str) -> bool:
    if not loc:
        return True
    u = loc.lower()
    if any(k in u for k in _REMOTE_KEYWORDS):
        return True
    # Reject known non-US countries
    if any(k in u for k in _NON_US_COUNTRIES):
        return False
    u_up = loc.upper()
    for state in _US_STATES:
        if f", {state}" in u_up or f" {state}," in u_up or u_up.endswith(f" {state}") or u_up.endswith(f",{state}"):
            return True
    # Short ambiguous string → keep
    if len(loc.split()) <= 3:
        return True
    return False


# ── Seniority filter ─────────────────────────────────────────────────────────

_SENIORITY_ENTRY  = {"junior", "jr", "entry", "associate", "intern", "graduate", "new grad", "apprentice"}
_SENIORITY_SENIOR = {"senior", "sr"}
_SENIORITY_LEAD   = {"staff", "principal", "lead", "director", "head", "vp", "vice president",
                      "architect", "distinguished", "fellow", "chief", "manager"}

def _seniority_matches(title: str, seniority: str) -> bool:
    """
    Return True if the job title matches the requested seniority level.

    Levels:
      any    — always passes (default)
      entry  — Junior, Jr, Entry, Associate, Intern, Graduate, Level I
      mid    — no seniority prefix, or Level II
      senior — Senior, Sr, Level III
      lead   — Staff, Principal, Lead, Director, Head, VP, Architect

    Roman numerals I / II / III / IV in titles are used as level indicators.
    """
    if not seniority or seniority == "any":
        return True

    t     = title.lower()
    words = set(re.findall(r'\b\w+\b', t))

    has_entry  = bool(words & _SENIORITY_ENTRY)
    has_senior = bool(words & _SENIORITY_SENIOR)
    has_lead   = bool(words & _SENIORITY_LEAD)

    # Detect trailing roman numeral level (I, II, III, IV)
    roman_match = re.search(r'\b(iv|iii|ii|i)\b', t)
    roman_level = {"i": 1, "ii": 2, "iii": 3, "iv": 4}.get(roman_match.group() if roman_match else "", 0)

    if seniority == "entry":
        return has_entry or roman_level == 1

    if seniority == "mid":
        # Mid = no strong seniority marker, or explicitly level II
        return (not has_entry and not has_senior and not has_lead) or roman_level == 2

    if seniority == "senior":
        return has_senior or roman_level == 3

    if seniority == "lead":
        return has_lead or roman_level == 4

    return True


# ── Title relevance filter ────────────────────────────────────────────────────

def _title_matches(job_title: str, search_query: str) -> bool:
    """
    Return True only if the job title is genuinely relevant to the search query.

    4-layer check:

    Layer A — Build meaningful query words
        Strip filler/noise words (senior, remote, jr, etc.)
        Split remaining words from the search query
        e.g. "Senior Data Engineer" → ["data", "engineer"]

    Layer B — All query words must appear as WHOLE WORDS in the title
        Uses \\b word boundaries so:
          "data"     does NOT match inside "database"
          "engineer" does NOT match inside "engineering"

    Layer C — Proximity check
        Query words must appear within PROXIMITY_WINDOW words of each other.
        Blocks titles where words are spread far apart.
        Keeps: "Data Engineer", "Senior Data Engineer", "Data Platform Engineer"
        Blocks: "Director of AI — Data Solutions Engineer Support" (span > 4)

    Layer D — Word order check
        Query words must appear in the SAME ORDER as your search query.
        Searching "Data Engineer" → "data" must come BEFORE "engineer" in the title.

        Why this matters:
          "AI/ML Engineer (Data Focus)"
           title_words = [ai, ml, engineer, data, focus]
           "engineer" is at index 2, "data" is at index 3
           → engineer comes BEFORE data  →  wrong order  →  BLOCKED

          "Data Platform Engineer"
           "data" is at index 0, "engineer" is at index 2
           → data comes BEFORE engineer  →  correct order  →  PASSES

        ORDER_FLEXIBLE = False  ← set to True to allow any order (less strict)
            False = strict, recommended for most job title searches
            True  = flexible, use if you search things like "Engineer Data" style queries

    Tuning constants:
        PROXIMITY_WINDOW = 4   (3=very strict, 4=recommended, 6=loose)
        ORDER_FLEXIBLE   = False
    """

    FILLER_WORDS = {
        "senior", "sr", "jr", "junior", "lead", "staff", "principal",
        "associate", "head", "i", "ii", "iii", "iv",
        "the", "and", "or", "of", "in", "at", "a",
        "remote", "us", "usa", "jobs", "job"
    }

    PROXIMITY_WINDOW = 4    # max word-distance allowed between query words in title
    ORDER_FLEXIBLE   = False # if True, skip Layer D (word order check)

    # ── Layer A: build query words (preserving search order) ─────────────────
    raw_tokens = [
        w.strip().lower() for w in re.split(r"[\s,/\-]+", search_query)
        if w.strip() and len(w.strip()) > 1
    ]
    query_words = [w for w in raw_tokens if w not in FILLER_WORDS]

    # Nothing meaningful to filter on. Previously this returned True, which
    # meant any alias that filler-stripped down to nothing (e.g. "team lead",
    # "the lead") acted as a wildcard and let every job in the source pass —
    # because callers OR aliases together with `any()`. Reject instead so the
    # filter is fail-closed for empty-meaning aliases.
    if not query_words:
        return False

    # Over-stripped alias guard: if the original alias had 2+ meaningful tokens
    # but only one survived filler-stripping, the surviving token is almost
    # always too generic to gate a match (e.g. "tech lead" → ["tech"], which
    # would otherwise let "Marketing Tech Specialist" pass when the user
    # searched "Engineering Manager"). Require at least 2 surviving tokens
    # whenever the alias started with 2+.
    if len(raw_tokens) >= 2 and len(query_words) < 2:
        return False

    title_lower = job_title.lower()

    # ── Layer B: all query words must be present as whole words ───────────────
    for qw in query_words:
        if not re.search(r'\b' + re.escape(qw) + r'\b', title_lower):
            return False  # missing word → reject immediately

    # ── Layers C & D only apply when there are 2+ query words ─────────────────
    if len(query_words) >= 2:

        # Tokenize the title into an ordered list of words
        title_words = re.findall(r'\b\w+\b', title_lower)

        # Find every position each query word appears at in the title
        positions: dict[str, list[int]] = {}
        for qw in query_words:
            for i, tw in enumerate(title_words):
                if tw == qw:
                    positions.setdefault(qw, []).append(i)

        # Safety net (should never trigger after Layer B)
        if len(positions) < len(query_words):
            return False

        pos_lists = [positions[qw] for qw in query_words]

        # ── Layer C: proximity check ──────────────────────────────────────────
        # Find the minimum span (max_pos - min_pos) across all position combos.
        # If even the closest combo is too spread out, reject.
        min_span = min(
            max(combo) - min(combo)
            for combo in itertools_product(*pos_lists)
        )
        if min_span > PROXIMITY_WINDOW:
            return False  # words too far apart → likely not the right role

        # ── Layer D: word order check ─────────────────────────────────────────
        # Check that there exists at least ONE combination of positions where
        # each query word appears in strictly increasing order in the title.
        # e.g. query = ["data", "engineer"]
        #      we need pos(data) < pos(engineer) in the title
        #
        # "Data Platform Engineer" → pos(data)=0, pos(engineer)=2  → 0 < 2 ✓
        # "AI/ML Engineer (Data Focus)" → pos(engineer)=2, pos(data)=3
        #      only combo is (2, 3) → engineer(2) before data(3) → WRONG ORDER
        if not ORDER_FLEXIBLE:
            order_ok = any(
                all(combo[i] < combo[i + 1] for i in range(len(combo) - 1))
                for combo in itertools_product(*pos_lists)
            )
            if not order_ok:
                return False  # no combo preserves query word order → reject

    return True


# ── 1. Apify — LinkedIn Jobs ──────────────────────────────────────────────────

def search_apify_linkedin(title: str, location: str, max_results: int = 100, date_posted: str = "pastWeek") -> list[dict]:
    """
    LinkedIn Jobs scraped via Apify (bebity/linkedin-jobs-scraper).
    Fetches exact-title matches for the past 24 hours from LinkedIn directly.

    Sign up free at: https://apify.com/
    Free tier: $5 credit/month (~1000–2000 results depending on actor cost)
    Set APIFY_API_TOKEN in .env

    Fields returned by this actor (key ones):
      title, companyName, location, publishedAt, salary,
      jobUrl, description, employmentType, seniorityLevel
    """
    token = os.environ.get("APIFY_API_TOKEN", "")
    actor_id = APIFY_ACTORS.get("linkedin", "").strip()
    if not token:
        logger.info("  [apify] APIFY_API_TOKEN not set — skipping (sign up at apify.com)")
        return []
    if not actor_id:
        logger.info("  [apify] LinkedIn actor id not configured — skipping")
        return []

    aliases = _expand_aliases(title)
    jobs = []
    try:
        r = _session().post(
            f"https://api.apify.com/v2/acts/{actor_id}/run-sync-get-dataset-items",
            params={"token": token, "timeout": 120, "memory": 256},
            json={
                "searchQueries": aliases,
                "location":      location,
                "datePosted":    date_posted,
                "maxResults":    max_results,
            },
            timeout=130,
        )
        r.raise_for_status()
        for j in r.json():
            jobs.append({
                "id":          f"apify_li_{j.get('id', len(jobs))}",
                "title":       (j.get("title") or "").strip(),
                "company":     j.get("companyName") or j.get("company") or "Unknown",
                "location":    j.get("location") or location,
                "posted":      _normalize_date(j.get("publishedAt") or j.get("postedAt")),
                "salary":      j.get("salary") or "Not listed",
                "url":         j.get("jobUrl") or j.get("url") or "",
                "source":      "LinkedIn",
                "description": _strip_html(j.get("description") or "")[:8000],
                "type":        (j.get("employmentType") or "").replace("_", " ").title(),
            })
    except Exception as e:
        logger.warning("  [apify] Error: %s", e)

    logger.info("  [apify] %d raw jobs fetched for '%s'", len(jobs), title)
    return jobs


# ── 1b. Apify — Indeed ───────────────────────────────────────────────────────

def search_apify_indeed(title: str, location: str, max_results: int = 100, date_posted: str = "pastWeek") -> list[dict]:
    """
    Indeed Jobs scraped via Apify (misceres/indeed-scraper).
    Largest job board globally — covers all industries and company sizes.
    Same APIFY_API_TOKEN used across all Apify actors.
    """
    token = os.environ.get("APIFY_API_TOKEN", "")
    actor_id = APIFY_ACTORS.get("indeed", "").strip()
    if not token:
        return []
    if not actor_id:
        logger.info("  [apify] Indeed actor id not configured — skipping")
        return []

    aliases = _expand_aliases(title)
    jobs = []
    try:
        r = _session().post(
            f"https://api.apify.com/v2/acts/{actor_id}/run-sync-get-dataset-items",
            params={"token": token, "timeout": 120, "memory": 256},
            json={
                "searchTerms":  aliases,
                "location":     location,
                "maxItems":     max_results,
                "datePosted":   "last3days" if date_posted == "past24Hours" else ("lastweek" if date_posted == "pastWeek" else "lastmonth"),
                "countryCode":  "us",
            },
            timeout=130,
        )
        r.raise_for_status()
        for j in r.json():
            jobs.append({
                "id":          f"apify_in_{j.get('id', len(jobs))}",
                "title":       (j.get("positionName") or j.get("title") or "").strip(),
                "company":     j.get("company") or j.get("companyName") or "Unknown",
                "location":    j.get("location") or location,
                "posted":      _normalize_date(j.get("datePosted") or j.get("postedAt")),
                "salary":      j.get("salary") or j.get("salaryText") or "Not listed",
                "url":         j.get("url") or j.get("jobUrl") or "",
                "source":      "Indeed",
                "description": _strip_html(j.get("description") or j.get("jobDescription") or "")[:8000],
                "type":        (j.get("jobType") or j.get("employmentType") or "").replace("_", " ").title(),
            })
    except Exception as e:
        logger.warning("  [apify-indeed] Error: %s", e)

    logger.info("  [apify-indeed] %d raw jobs fetched for '%s'", len(jobs), title)
    return jobs


# ── 1c. Apify — Glassdoor ─────────────────────────────────────────────────────

def search_apify_glassdoor(title: str, location: str, max_results: int = 100, date_posted: str = "pastWeek") -> list[dict]:
    """
    Glassdoor Jobs scraped via Apify (bebity/glassdoor-jobs-scraper).
    Great for salary data + company ratings alongside job listings.
    Same APIFY_API_TOKEN used across all Apify actors.
    """
    token = os.environ.get("APIFY_API_TOKEN", "")
    actor_id = APIFY_ACTORS.get("glassdoor", "").strip()
    if not token:
        return []
    if not actor_id:
        logger.info("  [apify] Glassdoor actor id not configured — skipping")
        return []

    aliases = _expand_aliases(title)
    jobs = []
    try:
        r = _session().post(
            f"https://api.apify.com/v2/acts/{actor_id}/run-sync-get-dataset-items",
            params={"token": token, "timeout": 120, "memory": 256},
            json={
                "searchQuery":  " OR ".join(aliases),   # Glassdoor supports OR queries
                "location":     location,
                "maxResults":   max_results,
                "datePosted":   "1" if date_posted == "past24Hours" else ("7" if date_posted == "pastWeek" else "30"),
            },
            timeout=130,
        )
        r.raise_for_status()
        for j in r.json():
            sal_min = j.get("payPeriodAdjustedPay", {}).get("p10") if isinstance(j.get("payPeriodAdjustedPay"), dict) else None
            sal_max = j.get("payPeriodAdjustedPay", {}).get("p90") if isinstance(j.get("payPeriodAdjustedPay"), dict) else None
            sal_str = _salary(sal_min, sal_max, "year") if (sal_min or sal_max) else j.get("salary") or "Not listed"
            jobs.append({
                "id":          f"apify_gd_{j.get('jobListingId', len(jobs))}",
                "title":       (j.get("jobTitle") or j.get("title") or "").strip(),
                "company":     j.get("companyName") or j.get("employer", {}).get("name") or "Unknown",
                "location":    j.get("location") or j.get("locationName") or location,
                "posted":      _normalize_date(j.get("datePosted") or j.get("postedAt")),
                "salary":      sal_str,
                "url":         j.get("applyUrl") or j.get("jobUrl") or j.get("url") or "",
                "source":      "Glassdoor",
                "description": _strip_html(j.get("description") or j.get("jobDescription") or "")[:8000],
                "type":        (j.get("jobType") or j.get("employmentType") or "").replace("_", " ").title(),
            })
    except Exception as e:
        logger.warning("  [apify-glassdoor] Error: %s", e)

    logger.info("  [apify-glassdoor] %d raw jobs fetched for '%s'", len(jobs), title)
    return jobs


# ── 1d. Apify — ZipRecruiter ──────────────────────────────────────────────────

def search_apify_ziprecruiter(title: str, location: str, max_results: int = 100, date_posted: str = "pastWeek") -> list[dict]:
    """
    ZipRecruiter Jobs scraped via Apify (radekmie/ziprecruiter-scraper).
    Strong US coverage — especially mid-size companies and SMBs.
    Same APIFY_API_TOKEN used across all Apify actors.
    """
    token = os.environ.get("APIFY_API_TOKEN", "")
    actor_id = APIFY_ACTORS.get("ziprecruiter", "").strip()
    if not token:
        return []
    if not actor_id:
        logger.info("  [apify] ZipRecruiter actor id not configured — skipping")
        return []

    aliases = _expand_aliases(title)
    jobs = []
    try:
        r = _session().post(
            f"https://api.apify.com/v2/acts/{actor_id}/run-sync-get-dataset-items",
            params={"token": token, "timeout": 120, "memory": 256},
            json={
                "search":     " OR ".join(aliases),   # ZipRecruiter supports OR queries
                "location":   location,
                "maxResults": max_results,
                "days":       1 if date_posted == "past24Hours" else (7 if date_posted == "pastWeek" else 30),
            },
            timeout=130,
        )
        r.raise_for_status()
        for j in r.json():
            jobs.append({
                "id":          f"apify_zr_{j.get('id', len(jobs))}",
                "title":       (j.get("title") or j.get("name") or "").strip(),
                "company":     j.get("hiring_company", {}).get("name") or j.get("company") or "Unknown",
                "location":    j.get("location") or location,
                "posted":      _normalize_date(j.get("posted_time") or j.get("datePosted")),
                "salary":      j.get("salary_interval") or j.get("salary") or "Not listed",
                "url":         j.get("job_url") or j.get("url") or "",
                "source":      "ZipRecruiter",
                "description": _strip_html(j.get("job_description") or j.get("description") or "")[:8000],
                "type":        (j.get("job_type") or j.get("employmentType") or "").replace("_", " ").title(),
            })
    except Exception as e:
        logger.warning("  [apify-ziprecruiter] Error: %s", e)

    logger.info("  [apify-ziprecruiter] %d raw jobs fetched for '%s'", len(jobs), title)
    return jobs


# ── 1e. Apify — Modular Job Scraper ────────────────────────────────────────────

def search_apify_modular(title: str, location: str, max_results: int = 100, date_posted: str = "pastWeek") -> list[dict]:
    """
    Use a single modular Apify actor that scrapes multiple job platforms.
    Set APIFY_MODULAR_ACTOR_ID in .env if you have an actor that normalizes job data.
    """
    token = os.environ.get("APIFY_API_TOKEN", "")
    actor_id = APIFY_ACTORS.get("modular", "").strip()
    if not token:
        return []
    if not actor_id:
        return []

    aliases = _expand_aliases(title)
    jobs = []
    try:
        r = _session().post(
            f"https://api.apify.com/v2/acts/{actor_id}/run-sync-get-dataset-items",
            params={"token": token, "timeout": 180, "memory": 512},
            json={
                "searchQueries": aliases,
                "location":      location,
                "datePosted":    date_posted,
                "maxResults":    max_results,
            },
            timeout=190,
        )
        r.raise_for_status()
        for j in r.json():
            jobs.append({
                "id":          f"apify_mod_{j.get('id', len(jobs))}",
                "title":       (j.get("title") or j.get("jobTitle") or j.get("positionName") or "").strip(),
                "company":     j.get("company") or j.get("companyName") or j.get("employer") or j.get("organization") or "Unknown",
                "location":    j.get("location") or j.get("locationName") or location,
                "posted":      _normalize_date(j.get("publishedAt") or j.get("datePosted") or j.get("postedAt")),
                "salary":      j.get("salary") or j.get("salaryText") or j.get("pay") or "Not listed",
                "url":         j.get("jobUrl") or j.get("url") or j.get("applyUrl") or "",
                "source":      j.get("source") or "Apify",
                "description": _strip_html(j.get("description") or j.get("jobDescription") or "")[:8000],
                "type":        (j.get("employmentType") or j.get("jobType") or "").replace("_", " ").title(),
            })
    except Exception as e:
        logger.warning("  [apify-modular] Error: %s", e)

    logger.info("  [apify-modular] %d raw jobs fetched for '%s'", len(jobs), title)
    return jobs


# ── 2. JSearch (RapidAPI) ────────────────────────────────────────────────────

def search_jsearch(title: str, location: str, max_results: int = 100, date_posted: str = "pastWeek") -> list[dict]:
    """
    JSearch via RapidAPI — aggregates LinkedIn, Indeed, Glassdoor, ZipRecruiter
    and more via Google Jobs under the hood.
    Sign up free at: https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch
    Free tier: 500 requests/month. Set RAPIDAPI_KEY in .env.
    """
    api_key = os.environ.get("RAPIDAPI_KEY", "")
    if not api_key:
        logger.info("  [jsearch] RAPIDAPI_KEY not set — skipping")
        return []

    date_map = {"past24Hours": "today", "pastWeek": "week", "pastMonth": "month"}
    date_param = date_map.get(date_posted, "week")

    query = f"{title} in {location}"
    pages_needed = min((max_results // 10) + 1, 5)  # 10 results/page, cap at 5 pages

    jobs = []
    for page in range(1, pages_needed + 1):
        r = _get(
            "https://jsearch.p.rapidapi.com/search",
            headers={
                "X-RapidAPI-Key":  api_key,
                "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
            },
            params={
                "query":       query,
                "page":        page,
                "num_pages":   1,
                "date_posted": date_param,
            },
        )
        if not r:
            break
        try:
            batch = r.json().get("data", [])
            if not batch:
                break
            for j in batch:
                is_remote = bool(j.get("job_is_remote"))
                loc_str   = _location(
                    j.get("job_city"), j.get("job_state"), j.get("job_country"), is_remote
                )
                jobs.append({
                    "id":          f"jsearch_{j.get('job_id', len(jobs))}",
                    "title":       (j.get("job_title") or "").strip(),
                    "company":     j.get("employer_name") or "Unknown",
                    "location":    loc_str,
                    "posted":      _normalize_date(j.get("job_posted_at_datetime_utc")),
                    "salary":      _salary(
                                       j.get("job_min_salary"),
                                       j.get("job_max_salary"),
                                       j.get("job_salary_period"),
                                   ),
                    "url":         j.get("job_apply_link") or j.get("job_google_link") or "",
                    "source":      j.get("job_publisher") or "JSearch",
                    "description": (j.get("job_description") or "")[:8000],
                    "type":        (j.get("job_employment_type") or "").replace("_", " ").title(),
                })
        except Exception as e:
            logger.warning("  [jsearch] Parse error page %d: %s", page, e)
            break

        if len(jobs) >= max_results:
            break

    logger.info("  [jsearch] %d raw jobs fetched for '%s'", len(jobs), title)
    return jobs


# ── 3. Adzuna ─────────────────────────────────────────────────────────────────

def search_adzuna(title: str, location: str, pages: int = 4, date_posted: str = "pastWeek") -> list[dict]:
    """
    Adzuna has excellent US coverage including solo founders, SMBs, and enterprises.
    Sign up free at: https://developer.adzuna.com/
    Free tier: 250 calls/day.

    FIX: 'what_phrase' param used for exact phrase match in Adzuna API.
    """
    app_id  = os.environ.get("ADZUNA_APP_ID", "")
    app_key = os.environ.get("ADZUNA_APP_KEY", "")
    if not app_id or not app_key:
        logger.info("  [adzuna] ADZUNA_APP_ID/KEY not set — skipping (sign up free at developer.adzuna.com)")
        return []

    jobs = []
    for page in range(1, pages + 1):
        r = _get(
            f"https://api.adzuna.com/v1/api/jobs/us/search/{page}",
            params={
                "app_id":           app_id,
                "app_key":          app_key,
                "results_per_page": 20,
                "what_phrase":      title,
                "where":            location,
                "max_days_old":     1 if date_posted == "past24Hours" else (7 if date_posted == "pastWeek" else 30),
                "sort_by":          "date",
                "content-type":     "application/json",
            },
        )
        if not r:
            break
        try:
            data = r.json()
            batch = data.get("results", [])
            if not batch:
                break
            for j in batch:
                company  = j.get("company", {}).get("display_name", "Unknown")
                loc_area = j.get("location", {}).get("area", [])
                loc_str  = ", ".join(loc_area[-2:]) if loc_area else location
                jobs.append({
                    "id":          f"adzuna_{j.get('id', len(jobs))}",
                    "title":       j.get("title", "").strip(),
                    "company":     company,
                    "location":    loc_str,
                    "posted":      _normalize_date(j.get("created")),
                    "salary":      _salary(j.get("salary_min"), j.get("salary_max"), "year"),
                    "url":         j.get("redirect_url", ""),
                    "source":      "Adzuna",
                    "description": _strip_html(j.get("description", ""))[:8000],
                    "type":        j.get("contract_time", "").replace("_", " ").title(),
                })
        except Exception as e:
            logger.warning("  [adzuna] Parse error page %d: %s", page, e)
            break

    logger.info("  [adzuna] %d raw jobs fetched for '%s'", len(jobs), title)
    return jobs


# ── 3. The Muse (free, no key) ────────────────────────────────────────────────

def search_themuse(title: str, location: str, pages: int = 4) -> list[dict]:
    """
    The Muse covers 100+ companies with transparent culture info.
    Completely free — no API key needed.
    """
    jobs = []
    loc_map = {
        "seattle":       "Seattle, WA",
        "new york":      "New York City, NY",
        "san francisco": "San Francisco, CA",
        "los angeles":   "Los Angeles, CA",
        "austin":        "Austin, TX",
        "chicago":       "Chicago, IL",
        "boston":        "Boston, MA",
        "denver":        "Denver, CO",
        "atlanta":       "Atlanta, GA",
        "dallas":        "Dallas, TX",
        "houston":       "Houston, TX",
        "miami":         "Miami, FL",
        "washington":    "Washington, DC",
        "remote":        "Flexible / Remote",
    }
    loc_lower = location.lower()
    muse_loc  = next((v for k, v in loc_map.items() if k in loc_lower), None)

    params: dict = {"descending": "true"}
    if muse_loc:
        params["location"] = muse_loc
    params["category"] = title

    for page in range(1, pages + 1):
        params["page"] = page
        r = _get("https://www.themuse.com/api/public/jobs", params=params)
        if not r:
            break
        try:
            data  = r.json()
            batch = data.get("results", [])
            if not batch:
                break
            for j in batch:
                locs    = j.get("locations", [])
                loc_str = locs[0].get("name", location) if locs else location
                company = j.get("company", {}).get("name", "Unknown")
                jobs.append({
                    "id":          f"muse_{j.get('id', len(jobs))}",
                    "title":       j.get("name", "").strip(),
                    "company":     company,
                    "location":    loc_str,
                    "posted":      _normalize_date(j.get("publication_date")),
                    "salary":      "See listing",
                    "url":         j.get("refs", {}).get("landing_page", ""),
                    "source":      "The Muse",
                    "description": "",
                    "type":        j.get("type", "").replace("_", " ").title(),
                })
        except Exception as e:
            logger.warning("  [themuse] Parse error: %s", e)
            break

    logger.info("  [themuse] %d raw jobs fetched for '%s'", len(jobs), title)
    return jobs


# ── 4. Remotive (free, remote jobs) ──────────────────────────────────────────

def search_remotive(title: str) -> list[dict]:
    """
    Remotive is the leading remote-jobs platform. Free API, no key required.
    Covers companies from Shopify to solo startups, all remote positions.

    NOTE: Remotive matches on full description text, not just title.
    Our _title_matches() filter in search_all_platforms() handles this —
    any job whose *title* doesn't match your search is discarded afterward.
    """
    jobs = []
    r = _get(
        "https://remotive.com/api/remote-jobs",
        params={"search": title, "limit": 100},
    )
    if not r:
        return jobs
    try:
        for j in r.json().get("jobs", []):
            region = j.get("candidate_required_location") or "Worldwide"
            jobs.append({
                "id":          f"remotive_{j.get('id', len(jobs))}",
                "title":       j.get("title", "").strip(),
                "company":     j.get("company_name", "Unknown"),
                "location":    f"Remote — {region}",
                "posted":      _normalize_date(j.get("publication_date")),
                "salary":      j.get("salary") or "See listing",
                "url":         j.get("url", ""),
                "source":      "Remotive",
                "description": _strip_html(j.get("description") or "")[:8000],
                "type":        "Remote",
            })
    except Exception as e:
        logger.warning("  [remotive] Parse error: %s", e)

    logger.info("  [remotive] %d raw jobs fetched for '%s'", len(jobs), title)
    return jobs


# ── 5. USAJobs (free, government) ────────────────────────────────────────────

def search_usajobs(title: str, location: str) -> list[dict]:
    """
    Official US federal government job portal.
    Sign up free at: https://developer.usajobs.gov/
    Or works without a key with reduced rate limits.
    """
    email   = os.environ.get("USAJOBS_EMAIL", "jobpilot@example.com")
    api_key = os.environ.get("USAJOBS_API_KEY", "")

    hdrs = {"Host": "data.usajobs.gov", "User-Agent": email}
    if api_key:
        hdrs["Authorization-Key"] = api_key

    r = _get(
        "https://data.usajobs.gov/api/search",
        headers=hdrs,
        params={
            "Keyword":        title,
            "LocationName":   location,
            "DatePosted":     1,
            "ResultsPerPage": 25,
            "SortField":      "OpenDate",
            "SortDirection":  "Desc",
        },
    )
    jobs = []
    if not r:
        return jobs
    try:
        items = r.json().get("SearchResult", {}).get("SearchResultItems", [])
        for item in items:
            d   = item.get("MatchedObjectDescriptor", {})
            sal = (d.get("PositionRemuneration") or [{}])[0]
            sal_str = _salary(sal.get("MinimumRange"), sal.get("MaximumRange"), "year")
            url = ""
            uris = d.get("ApplyURI") or d.get("PositionURI") or []
            if isinstance(uris, list) and uris:
                url = uris[0]
            elif isinstance(uris, str):
                url = uris
            jobs.append({
                "id":          f"usajobs_{d.get('PositionID', len(jobs))}",
                "title":       d.get("PositionTitle", "").strip(),
                "company":     d.get("OrganizationName", "US Federal Government"),
                "location":    d.get("PositionLocationDisplay", location),
                "posted":      _normalize_date(d.get("PublicationStartDate")),
                "salary":      sal_str,
                "url":         url,
                "source":      "USAJobs",
                "description": _strip_html(d.get("UserArea", {}).get("Details", {}).get("JobSummary", ""))[:8000],
                "type":        (d.get("PositionSchedule") or [{}])[0].get("Name", ""),
            })
    except Exception as e:
        logger.warning("  [usajobs] Parse error: %s", e)

    logger.info("  [usajobs] %d raw jobs fetched for '%s'", len(jobs), title)
    return jobs


# ── 6. Arbeitnow (free, global with US/remote filter) ────────────────────────

def search_arbeitnow(title: str) -> list[dict]:
    """
    Arbeitnow is a free job board aggregator with remote and US positions.
    No API key required. Filter applied: remote=true or US location only.

    NOTE: Like Remotive, Arbeitnow searches full descriptions.
    _title_matches() in search_all_platforms() cleans up the noise afterward.
    """
    jobs = []
    for page in range(1, 4):
        r = _get(
            "https://www.arbeitnow.com/api/job-board-api",
            params={"search": title, "page": page},
        )
        if not r:
            break
        try:
            data  = r.json()
            batch = data.get("data", [])
            if not batch:
                break
            for j in batch:
                loc = j.get("location") or ""
                is_remote = bool(j.get("remote"))
                if not is_remote and not _is_us_or_remote(loc):
                    continue
                jobs.append({
                    "id":          f"arbeitnow_{j.get('slug', len(jobs))}",
                    "title":       j.get("title", "").strip(),
                    "company":     j.get("company_name", "Unknown"),
                    "location":    "Remote" if is_remote else loc,
                    "posted":      _normalize_date(str(j.get("created_at", ""))),
                    "salary":      "See listing",
                    "url":         j.get("url", ""),
                    "source":      "Arbeitnow",
                    "description": _strip_html(j.get("description") or "")[:8000],
                    "type":        "Remote" if is_remote else "",
                })
        except Exception as e:
            logger.warning("  [arbeitnow] Parse error page %d: %s", page, e)
            break

    logger.info("  [arbeitnow] %d raw jobs fetched for '%s'", len(jobs), title)
    return jobs


# ── Fetch full job description from URL ───────────────────────────────────────

def _is_safe_external_url(url: str) -> bool:
    """SSRF guard (Issue #63): only allow http(s) URLs that resolve to public
    routable IPs. Rejects loopback, private (RFC1918), link-local, multicast,
    CGNAT (100.64/10), and unspecified addresses. We resolve once with
    `getaddrinfo` and inspect every returned address."""
    import ipaddress
    import socket
    from urllib.parse import urlparse

    try:
        u = urlparse(url)
    except Exception:
        return False
    if u.scheme not in ("http", "https"):
        return False
    host = (u.hostname or "").strip()
    if not host:
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return False
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr.split("%", 1)[0])
        except ValueError:
            return False
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_multicast or ip.is_reserved or ip.is_unspecified):
            return False
        # CGNAT 100.64.0.0/10
        if isinstance(ip, ipaddress.IPv4Address) and ip in ipaddress.ip_network("100.64.0.0/10"):
            return False
    return True


def fetch_job_description(url: str) -> str:
    """Fetch and extract job description text from any job posting URL."""
    from bs4 import BeautifulSoup
    if not _is_safe_external_url(url):
        logger.warning("  [jd] Refusing unsafe URL: %s", url[:80])
        return ""
    try:
        time.sleep(random.uniform(0.4, 1.0))
        r = requests.get(url, headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }, timeout=14, allow_redirects=False)
        # Reject any redirect — a 30x to an internal host would otherwise
        # bypass the pre-flight allow-list check above.
        if r.is_redirect or r.is_permanent_redirect:
            logger.warning("  [jd] Refusing redirect from %s", url[:80])
            return ""
        r.raise_for_status()
    except Exception as e:
        logger.warning("  [jd] Fetch failed: %s", e)
        return ""

    soup = BeautifulSoup(r.text, "html.parser")
    for sel in [
        "#jobDescriptionText",
        "div[data-testid='jobDescriptionText']",
        ".jobsearch-jobDescriptionText",
        "div.job-description",
        "div.jobDescription",
        "section.description",
        "div[class*='description']",
        "div[class*='job-detail']",
        "div[class*='jobDetail']",
        ".job-desc",
        "article.job__description",
        "[data-automation='jobDescription']",
        ".job-view-layout",
        "div[class*='job_description']",
    ]:
        el = soup.select_one(sel)
        if el and len(el.get_text(strip=True)) > 100:
            return el.get_text(separator="\n", strip=True)[:5000]

    divs = [d for d in soup.find_all("div") if len(d.get_text(strip=True)) > 300]
    if divs:
        return max(divs, key=lambda d: len(d.get_text())).get_text(separator="\n", strip=True)[:5000]
    return ""


# ── Master search ─────────────────────────────────────────────────────────────

# Short-TTL in-memory cache for search results. Keyed on the full query tuple.
# 90 seconds is short enough to surface fresh postings but long enough to absorb
# repeat clicks from the same user (back/forward, accidental re-search, etc.).
#
# Issue #87 — bound the cache so it can't grow unbounded over the worker's
# lifetime (each entry holds hundreds of multi-KB job dicts). When the cache
# would exceed _SEARCH_CACHE_MAX entries we sweep expired keys first and
# then drop the oldest remaining entries until we're back under the cap.
_SEARCH_CACHE_TTL_SEC = 90
_SEARCH_CACHE_MAX = 128
_SEARCH_CACHE: dict[tuple, tuple[float, list[dict]]] = {}


def _search_cache_evict(now: float) -> None:
    """Drop expired entries; if still over cap, drop oldest."""
    expired = [k for k, (ts, _) in _SEARCH_CACHE.items() if (now - ts) >= _SEARCH_CACHE_TTL_SEC]
    for k in expired:
        _SEARCH_CACHE.pop(k, None)
    if len(_SEARCH_CACHE) >= _SEARCH_CACHE_MAX:
        # Drop the oldest entries (smallest timestamp) until under cap.
        ordered = sorted(_SEARCH_CACHE.items(), key=lambda kv: kv[1][0])
        for k, _ in ordered[: len(_SEARCH_CACHE) - _SEARCH_CACHE_MAX + 1]:
            _SEARCH_CACHE.pop(k, None)

def search_all_platforms(title: str, location: str = "United States", seniority: str = "any", date_posted: str = "pastWeek") -> list[dict]:
    """
    Search all real job APIs and return deduplicated US + remote results.
    Covers FAANG, Fortune 500, mid-market, startups, and solo companies.

    Filtering pipeline (in order):
      1. US/Remote location filter      — drop non-US jobs
      2. Non-empty title guard          — drop blank titles
      3. _title_matches() filter        — drop irrelevant titles (4-layer check)
      4. Deduplication                  — drop exact (title, company) duplicates
    """
    cache_key = (title.strip().lower(), location.strip().lower(), seniority, date_posted)
    now = time.time()
    cached = _SEARCH_CACHE.get(cache_key)
    if cached and (now - cached[0]) < _SEARCH_CACHE_TTL_SEC:
        logger.info("[scraper] Cache hit for '%s' in '%s' (age %ds)", title, location, int(now - cached[0]))
        return cached[1]

    logger.info("[scraper] Searching: '%s' in '%s'", title, location)
    all_jobs: list[dict] = []

    scrapers = [
        lambda: search_jsearch(title, location, max_results=100, date_posted=date_posted),
        lambda: search_adzuna(title, location, pages=4, date_posted=date_posted),
        lambda: search_themuse(title, location, pages=4),
        lambda: search_remotive(title),
        lambda: search_usajobs(title, location),
        lambda: search_arbeitnow(title),
    ]

    # Run all scrapers in parallel — total time = slowest single source, not sum of all.
    # Issue #89 — bound the overall wait. A single slow Apify actor used to
    # stall /api/jobs/search for up to 130s; we now cap the fan-out at 60s
    # and treat unfinished sources as failed (they're optional inputs).
    _SEARCH_DEADLINE_SEC = 60
    with ThreadPoolExecutor(max_workers=len(scrapers)) as pool:
        futures = {pool.submit(fn): fn for fn in scrapers}
        try:
            for future in as_completed(futures, timeout=_SEARCH_DEADLINE_SEC):
                try:
                    all_jobs.extend(future.result())
                except Exception as e:
                    logger.warning("  [scraper] Source error: %s", e)
        except TimeoutError:
            pending = sum(1 for f in futures if not f.done())
            logger.warning(
                "  [scraper] Search budget %ds exceeded; %d source(s) abandoned",
                _SEARCH_DEADLINE_SEC, pending,
            )
            for f in list(futures):
                if not f.done():
                    f.cancel()

    total_raw = len(all_jobs)

    # ── Filter 1: US or Remote only ───────────────────────────────────────────
    all_jobs = [j for j in all_jobs if _is_us_or_remote(j.get("location", ""))]
    logger.info("[filter] After location filter : %4d / %d", len(all_jobs), total_raw)

    # ── Filter 2: Must have a non-empty title ─────────────────────────────────
    all_jobs = [j for j in all_jobs if j.get("title", "").strip()]
    logger.info("[filter] After empty-title drop: %4d", len(all_jobs))

    # ── Filter 3: Title must match the search query OR any of its aliases ────
    #    _title_matches() runs 4 layers per alias — job passes if ANY alias matches.
    #    This means searching "Software Engineer" also passes "Full Stack Developer",
    #    "Backend Engineer", "Frontend Developer" etc. without over-filtering.
    aliases = _expand_aliases(title)
    before_title_filter = len(all_jobs)
    all_jobs = [
        j for j in all_jobs
        if any(_title_matches(j.get("title", ""), alias) for alias in aliases)
    ]
    print_count = len(all_jobs)
    logger.info("[filter] After title filter    : %4d  (removed %d irrelevant titles)",
                print_count, before_title_filter - print_count)

    # ── Filter 4: Seniority filter ────────────────────────────────────────────
    if seniority and seniority != "any":
        before_seniority = len(all_jobs)
        all_jobs = [j for j in all_jobs if _seniority_matches(j.get("title", ""), seniority)]
        logger.info("[filter] After seniority filter  : %4d  (removed %d wrong-level titles)",
                    len(all_jobs), before_seniority - len(all_jobs))

    # ── Filter 5: Deduplicate by (title_lower, company_lower) ─────────────────
    seen:   set  = set()
    unique: list = []
    for j in all_jobs:
        key = (j["title"].lower().strip()[:60], j["company"].lower().strip()[:50])
        if key not in seen:
            seen.add(key)
            unique.append(j)

    logger.info("[filter] After deduplication   : %4d  (removed %d duplicates)",
                len(unique), len(all_jobs) - len(unique))

    # Re-index
    for i, j in enumerate(unique):
        j["idx"] = i

    logger.info("[scraper] Final results: %d unique jobs from %d sources",
                len(unique), _source_count(unique))
    _search_cache_evict(now)
    _SEARCH_CACHE[cache_key] = (now, unique)
    return unique


def _source_count(jobs: list[dict]) -> int:
    return len({j.get("source", "") for j in jobs})
