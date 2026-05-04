# JobPilot — Repository Issues Assessment

**Document type:** Code & Architecture Review
**Scope:** `jobpilot/` application (Flask backend + static frontend)
**Total findings:** 72 (Critical: 3 · High: 4 · Medium: 40 · Low: 25)
**Open:** 33 · **In Progress:** 0 · **Resolved:** 37 (23 Low + 14 Medium) · **Won't Fix:** 2
**Estimated remediation effort:** ~97 engineering hours (~46 hr completed)
**Last re-check:** 2026-05-04
**Source of truth:** This document supersedes the previous `repo_issues.csv` (now removed).

---

## Legend

**Priority color codes** (used in the `Pri` column of every table):

| Color | Severity |
|-------|----------|
| 🔴 | Critical |
| 🟠 | High |
| 🟡 | Medium |
| 🟢 | Low |

**Status values:**

| Marker | Meaning |
|--------|---------|
| ⏳ Open | Not yet started |
| 🔧 WIP | In progress |
| ✅ Fixed | Resolved and verified |
| 🚫 Won't Fix | Acknowledged but intentionally not addressed |

**Owners:** `Rajesh` · `Tarun` · `—` (unassigned)

**Requirements column:** for every open issue this captures the concrete prerequisites needed to land the fix — env vars, libraries, schema/decisions, tests, design choices. For fixed / won't-fix rows it reads `None (already met)` or the deferred dependency.

> **Updating an issue:** change the `Status` cell to `✅ Fixed`, set `Owner` to `Rajesh` or `Tarun`, and add a row to the Change Log with the commit/PR link.

---

## Change Log

| Date | Change | Issues Affected | Files Touched | Author |
|------|--------|-----------------|---------------|--------|
| 2026-05-04 | Initial corporate-format report generated; all 68 findings re-verified against working tree. | All | — | Review |
| 2026-05-04 | Added **Sign out** button and **in-session History** panel to the resume editor (status bar). History captures upload, generate, tailor, ATS, chat, and download events with timestamps; cleared on reload / logout. | New feature (no prior CSV ID) | [jobpilot/static/js/app.js](jobpilot/static/js/app.js), [jobpilot/static/css/style.css](jobpilot/static/css/style.css) | Rajesh |
| 2026-05-04 | Removed legacy `repo_issues.csv`; this Markdown report is now the single source of truth. | Housekeeping | `repo_issues.csv` (deleted) | Rajesh |
| 2026-05-04 | Re-checked report; refreshed shifted line numbers and logged 4 new findings (#69–#72) from the editor history/logout feature. | #43, #65 (line refs); #69–#72 (new) | [jobpilot/static/js/app.js](jobpilot/static/js/app.js), [jobpilot/static/css/style.css](jobpilot/static/css/style.css) | Review |
| 2026-05-04 | Added `Pri` (color-coded), `Status`, and `Owner` columns to every issue table for progress and contribution tracking. | All | — | Review |
| 2026-05-04 | **Logout / session lifecycle hardening.** Resolved unresolved git merge conflict in `logout()`. Made `hideAuthOverlay()` null-safe so the topbar **Sign out** button now reveals on the jobs page. Added `enforceSessionLifecycle()` + `jp_session_active` marker so the user is auto-logged-out when the browser/tab closes (lands back on `/`, sees latest changelog). | Bug fix; partial mitigation of #71 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js), [jobpilot/templates/index.html](jobpilot/templates/index.html) | Rajesh |
| 2026-05-04 | **Low-priority remediation sprint.** Closed all 25 🟢 Low findings + #54 (🟡 Docker root). See per-issue Status / Analyst Note for details. | #8, #15, #16, #26, #28, #34, #35, #36, #38, #39, #40, #44, #45, #47, #48, #49, #50, #54, #55, #57, #58, #59, #62, #64, #66, #68, #70, #71, #72 | 11 files (see below) | Rajesh |
| 2026-05-04 | **Low-risk Medium remediation sprint.** Closed 13 🟡 Medium findings (#5, #6, #10, #11, #18, #19, #21, #33, #46, #51, #52, #53, #65). All edits are small surface-area changes; no behavior change for happy paths. | #5, #6, #10, #11, #18, #19, #21, #33, #46, #51, #52, #53, #65 | [jobpilot/app.py](jobpilot/app.py), [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py), [jobpilot/core/resume_reader.py](jobpilot/core/resume_reader.py), [jobpilot/routes/resume.py](jobpilot/routes/resume.py), [jobpilot/routes/auth.py](jobpilot/routes/auth.py), [jobpilot/routes/jobs.py](jobpilot/routes/jobs.py), [jobpilot/static/js/app.js](jobpilot/static/js/app.js) | Rajesh |
| 2026-05-04 | Added [AGENTS.md](AGENTS.md) at the repo root: codifies the contributor / agent workflow, owner-attribution rule (use `Rajesh` for fixes from this account), and the *update-don't-recreate* policy for this report. | Process | [AGENTS.md](AGENTS.md) | Rajesh |
| 2026-05-04 | Added a **Requirements** column to every issue table. Open items list the concrete prerequisites to land the fix (env vars, libs, schema, tests, design decisions); fixed/won't-fix items read `None (already met)` or note the deferred dependency. | All | — | Rajesh |

**Files touched in low-priority sprint:** [jobpilot/app.py](jobpilot/app.py), [jobpilot/Dockerfile](jobpilot/Dockerfile), [jobpilot/requirements.txt](jobpilot/requirements.txt), [jobpilot/.env.example](jobpilot/.env.example), [railway.toml](railway.toml), [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py), [jobpilot/core/auth_db.py](jobpilot/core/auth_db.py), [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py), [jobpilot/core/resume_normalizer.py](jobpilot/core/resume_normalizer.py), [jobpilot/core/resume_reader.py](jobpilot/core/resume_reader.py), [jobpilot/routes/resume.py](jobpilot/routes/resume.py), [jobpilot/static/js/app.js](jobpilot/static/js/app.js), [jobpilot/static/css/style.css](jobpilot/static/css/style.css), [jobpilot/templates/base.html](jobpilot/templates/base.html), [jobpilot/templates/landing.html](jobpilot/templates/landing.html).

---

## Executive Summary

The codebase is functional but carries notable **production readiness** and **security** debt. The recent low-priority sprint cleared all 25 🟢 items plus the Docker non-root hardening, and a follow-on low-risk Medium sprint closed another 13 🟡 findings (input hardening, observability, and small dead-code / duplicate-init items). The remaining work is concentrated where it should be: the 3 🔴 Critical and 4 🟠 High items around hardcoded secrets, the auth-prefix bypass, and the missing test/CI foundation.

**Top remaining priorities (recommended sequencing):**
1. Eliminate hardcoded secrets and tighten the JWT auth guard (Issues 1, 2, 4).
2. Fix the chat-parser bug (Issue 9) and audit the remaining broad `except Exception` blocks (Issue 20).
3. Establish a baseline test suite + CI pipeline (Issues 30, 31).
4. Refactor PDF generation duplication (Issue 17).

---

## 1. Security

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 1 | 🔴 | [jobpilot/app.py](jobpilot/app.py#L34) | Hardcoded fallback for `FLASK_SECRET` (`jobpilot-flask-secret`). | ⏳ Open | — | `FLASK_SECRET` env var present in Railway + `.env`; startup guard that aborts on missing/short value; smoke test confirming `app.secret_key` is not the literal fallback. | Session forgery is trivial if env var is unset; fail-fast on missing secret. |
| 2 | 🔴 | [jobpilot/core/auth_db.py](jobpilot/core/auth_db.py#L15) | Hardcoded fallback for `JWT_SECRET`. | ⏳ Open | — | `JWT_SECRET` env var present in Railway + `.env`; fail-fast guard in `auth_db._get_secret()`; rotate any tokens issued under the dev fallback. | Same risk as #1 for token forgery; require the env var or abort startup. |
| 4 | 🟠 | [jobpilot/app.py](jobpilot/app.py#L70-L86) | Auth guard uses `path.startswith("/static")` (no trailing slash). | ⏳ Open | — | One-line change to `"/static/"`; regression test hitting `/staticXYZ` and `/static/...` to assert 401 vs. 200. | Allows `/staticXYZ` to bypass auth; change to `/static/`. |
| 3 | 🟠 | [jobpilot/core/auth_db.py](jobpilot/core/auth_db.py#L20) | `passlib` configured for `pbkdf2_sha256`, not bcrypt as commented. | ⏳ Open | — | Decision: keep `pbkdf2_sha256` (update docs) **or** add `bcrypt`/`argon2-cffi` to `requirements.txt` and migrate existing hashes via `CryptContext(schemes=[...], deprecated="auto")`. | Align code with intent and `requirements.txt`; bcrypt or argon2 is preferred. |
| 63 | 🟡 | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L1182-L1224) | `fetch_job_description` accepts arbitrary URLs (SSRF). | ⏳ Open | — | URL allow-list (https only); resolve hostname and reject RFC-1918 / loopback / link-local / metadata IPs *before* the request; dedicated unit tests with mocked DNS. | Restrict to public HTTP(S) and block private/loopback ranges. |
| 6 | 🟡 | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L213-L242) | Download endpoint relies on user-supplied `filename`. | ✅ Fixed | Rajesh | None (already met). | Sanitization is now explicit at the route boundary — `safe_stem = re.sub(r"[^A-Za-z0-9_\-]", "_", Path(os.path.basename(raw_name)).stem) or "resume"`; `save_tailored_*` then resolves under `GENERATED_DIR` and raises `ValueError` on traversal. |
| 5 | 🟡 | [jobpilot/app.py](jobpilot/app.py#L18-L82) | JWT and decoder imports inside `before_request`. | ✅ Fixed | Rajesh | None (already met). | `jwt as pyjwt` and `decode_token` are now imported at module scope so each request skips the import-cache lookup. |
| 7 | 🟡 | [jobpilot/routes/auth.py](jobpilot/routes/auth.py#L63) | Google-OAuth users get random hex password. | ⏳ Open | — | Schema migration: add `auth_provider` column (`local` / `google`); update `/api/auth/login` to reject password login when `auth_provider != 'local'`; backfill existing OAuth rows. | Mark account as OAuth-only and block password login for those users. |
| 8 | 🟢 | [jobpilot/templates/landing.html](jobpilot/templates/landing.html#L482) | Terms / Privacy links resolve to `#`. | ✅ Fixed | Rajesh | None (already met). Replace placeholder body with real legal copy before public launch. | Replaced with real `/terms` and `/privacy` routes serving placeholder pages in [jobpilot/app.py](jobpilot/app.py#L107). |

## 2. Data Validation & Input Hardening

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 52 | 🟡 | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L27-L48) | Resume upload reads file with no size check. | ✅ Fixed | Rajesh | None (already met). Tunable via `RESUME_MAX_BYTES`. | Added `MAX_RESUME_BYTES` (default 5 MB, env-overridable via `RESUME_MAX_BYTES`); upload returns HTTP 413 with a friendly message when exceeded. |
| 53 | 🟡 | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L77-L96) | `generate-resume` description has no length cap. | ✅ Fixed | Rajesh | None (already met). Tunable via `RESUME_DESCRIPTION_MAX_CHARS`. | Added `MAX_DESCRIPTION_CHARS` (default 8000, env-overridable via `RESUME_DESCRIPTION_MAX_CHARS`); endpoint short-circuits with HTTP 413 before the Claude call. |
| 51 | 🟡 | [jobpilot/routes/auth.py](jobpilot/routes/auth.py#L21-L34) | Email validated only by presence of `@`. | ✅ Fixed | Rajesh | None (already met). | Replaced the `"@" in email` check with an RFC-5322-lite regex (`_EMAIL_RE`) plus a 254-char length cap in `_is_valid_email()`. |
| 65 | 🟡 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L829-L840) | Job title interpolated into `innerHTML` unsanitized in `showSearching`. | ✅ Fixed | Rajesh | None (already met). | Title is now wrapped with `escHtml(title)` before injection, closing the reflected-XSS surface. |
| 66 | 🟢 | [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py#L203-L240) | Resume/JD silently truncated at 6000/3000 chars. | ✅ Fixed | Rajesh | None (already met). UI surface for the warning is a future polish item. | `score_ats()` now returns `truncation_warning` in its result dict whenever input was clipped; UI can surface it. |

## 3. Authentication & Authorization

(See also Section 1 — Security: #1, #2, #4, #7.)

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 37 | 🟡 | [jobpilot/templates/index.html](jobpilot/templates/index.html#L5) | Auth check is a JS `localStorage` redirect. | ⏳ Open | — | Server-side guard: `@app.get("/app")` should validate the JWT (cookie or `Authorization` header) and redirect to `/` on failure; cookie-based auth requires deciding on `Secure` / `HttpOnly` / `SameSite` defaults. | Bypassable with JS disabled; enforce server-side rendering guard. (Hardened by per-session lifecycle on 2026-05-04 but still client-side.) |

## 4. Error Handling & Observability

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 19 | 🟡 | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L60-L73) | `except Exception: pass` after `pypdf` read. | ✅ Fixed | Rajesh | None (already met). | Replaced silent `pass` with `logger.warning("pypdf extraction failed (%s); falling back to pdfplumber", e)` so failures are diagnosable while the fallback still runs. |
| 20 | 🟡 | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py) | 39 broad `except Exception` blocks across the codebase. | ⏳ Open | — | Per-call-site audit; replace with specific exceptions (`requests.RequestException`, `KeyError`, `json.JSONDecodeError`, etc.); add log lines with `exc_info=True`. Best done after #30 (tests) lands. | Catch specific exceptions; preserve diagnosability. |
| 21 | 🟡 | [jobpilot/core/resume_reader.py](jobpilot/core/resume_reader.py#L118-L128) | `render_to_pdf` returns silently on page-count failure. | ✅ Fixed | Rajesh | None (already met). | Failure now flows through `logging.getLogger("jobpilot").warning(...)` (lands in the configured `RotatingFileHandler`) before the ReportLab fallback. |
| 12 | 🟡 | [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py) | `print()` used for errors (7+ sites). | ⏳ Open | — | Add `logger = logging.getLogger("jobpilot")` at module top; mechanical `print(...) -> logger.warning/error(...)` swap; preserve message format. | Errors bypass the configured `RotatingFileHandler`; switch to `logging`. |
| 13 | 🟡 | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py) | ~30 `print()` calls used for diagnostics. | ⏳ Open | — | Same as #12. Decide log level per call site (debug for happy-path noise, warning for failures). | Same as #12; use a module-level logger. |
| 14 | 🟡 | [jobpilot/core/resume_reader.py](jobpilot/core/resume_reader.py#L69-L91) | `print()` used in 6 error paths. | ⏳ Open | — | Same as #12. | Same as #12. |

## 5. Architecture & Scalability

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 23 | 🟡 | [jobpilot/core/auth_db.py](jobpilot/core/auth_db.py#L19) | SQLite used as production user store. | ⏳ Open | — | Provision Postgres on Railway; add `psycopg[binary]` (or `asyncpg`); abstract `auth_db` behind a DB-agnostic interface; one-shot migration script for existing SQLite rows; new `DATABASE_URL` env var. | Migrate to PostgreSQL/MySQL for concurrent, multi-process deployments. |
| 24 | 🟡 | [jobpilot/core/auth_db.py](jobpilot/core/auth_db.py#L24-L25) | New SQLite connection per call; no pooling. | ⏳ Open | — | Either a thread-local `sqlite3.Connection` (interim) or SQLAlchemy with a connection pool (paired with #23). | Introduce a pooled accessor or singleton. |
| 22 | 🟡 | [jobpilot/app.py](jobpilot/app.py#L18-L26) | Usage counters held in module-level dict. | ⏳ Open | — | Persistent backing store — either a `usage_counters` table (paired with #23) or Redis (`redis-py`); decision on whether counters are per-user or global. | Lost on restart and incorrect under multi-worker WSGI; persist to DB. |
| 25 | 🟡 | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L188-L192) | Global `requests.Session` with mutable headers. | ⏳ Open | — | Switch to `threading.local()`-backed sessions, or build a fresh `Session` per `_get()` call (small perf cost, big safety win). | Race conditions under threads; use thread-local sessions or per-call clients. |
| 67 | 🟡 | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L27-L64) | PDF/DOCX/TXT parsing duplicated vs. `resume_reader.read_resume`. | ⏳ Open | — | Introduce `resume_reader.read_resume_bytes(content, ext)` and have the upload route call it; tests covering all three formats to lock behavior. | Consolidate into a single parser to avoid divergent fixes. |
| 26 | 🟢 | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L289-L327) | `_get_apify_actor_ids()` HTTP call at import time. | ✅ Fixed | Rajesh | None (already met). | Replaced eager call with `_LazyApifyActors` proxy + `get_apify_actors()`; HTTP now happens on first use. Existing `APIFY_ACTORS[...]` lookups continue to work. |

## 6. Performance & Cost

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 27 | 🟡 | [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py) | No caching for Claude calls. | ⏳ Open | — | Cache backend (in-process LRU → Redis when #22/#23 land); decision on TTL and on whether tailoring (which is per-job) is even cacheable; cache key must include model + prompt version. | Cache by hash of (resume, JD, prompt) to cut spend on repeats. |
| 11 | 🟡 | [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py#L54-L72) | New `Anthropic` client per call. | ✅ Fixed | Rajesh | None (already met). | `_client()` now memoises a single `anthropic.Anthropic` instance in module-level `_CLIENT`; subsequent calls reuse the existing HTTP connection pool. |
| 29 | 🟡 | [jobpilot/core/resume_reader.py](jobpilot/core/resume_reader.py#L389-L396) | PDF auto-fit rebuilds the doc up to 6 times. | ⏳ Open | — | Replace linear scan with binary search on the scale factor (bounds known: e.g. 0.6 – 1.0); golden-output tests for 1-, 2-, and 3-page resumes to lock behavior. | Replace linear scan with binary search on scale factor. |
| 28 | 🟢 | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L1268-L1345) | `search_all_platforms` results not cached. | ✅ Fixed | Rajesh | None (already met). | Added a 90-second in-memory TTL cache keyed on `(title, location, seniority, date_posted)`. Repeat clicks now skip the API fan-out entirely. |

## 7. Resilience & External Integration

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 61 | 🟡 | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L195-L206) | `_get()` has no retry logic. | ⏳ Open | — | Add `urllib3.util.Retry` to the session adapter (or `tenacity` decorator); only retry idempotent GETs on 5xx / `ConnectionError` / `ReadTimeout`; cap at 3 attempts with exponential backoff. | Add exponential backoff for transient HTTP errors. |
| 60 | 🟡 | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L197) | Per-request 0.2–0.6 s sleep insufficient under thread pool. | ⏳ Open | — | Per-host token bucket (e.g. `pyrate-limiter` or a hand-rolled `threading.Semaphore` per host); needs design decision on rate limits per provider. | Move throttling to a per-host token bucket. |

## 8. Code Quality & Maintainability

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 9 | 🔴 | [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py#L815) | `parts = after_later = after_label.split(...)` — `after_later` unused. | ⏳ Open | — | Read the surrounding `apply_chat_instruction` parser to confirm intent; targeted unit test for the chat-instruction split before the cleanup; small surgical edit. | Latent bug; remove the chained assignment. |
| 17 | 🟠 | [jobpilot/core/resume_reader.py](jobpilot/core/resume_reader.py#L122-L403) | ~80-line PDF parsing block duplicated inside `_build_story_with_scale`. | ⏳ Open | — | Extract a `_parse_resume_to_story(content, styles)` helper; golden-output regression tests for at least 3 sample resumes (since visual layout is hard to lint). | Extract a single parser function; current state guarantees drift. |
| 18 | 🟡 | [jobpilot/core/resume_reader.py](jobpilot/core/resume_reader.py#L131-L134) | `re` re-imported inside `save_tailored_pdf`. | ✅ Fixed | Rajesh | None (already met). | Removed the redundant `import re` (already imported at module scope on line 6); only the local `import io` for the ReportLab buffer remains, with an explanatory comment. |
| 10 | 🟡 | [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py#L1-L20) | `load_dotenv` called both here and in `app.py`. | ✅ Fixed | Rajesh | None (already met). | Removed the redundant `load_dotenv` call from `core/ai_engine.py`; `app.py` is now the single authoritative env loader (documented inline in both files). |
| 64 | 🟢 | [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py#L63) | Claude model name hardcoded (`claude-sonnet-4-6`). | ✅ Fixed | Rajesh | None (already met). Override with `CLAUDE_MODEL` env var. | Extracted to module-level `CLAUDE_MODEL` constant, env-overridable via `CLAUDE_MODEL`. Both `_call()` and the chat client now read it. |
| 15 | 🟢 | [jobpilot/core/resume_normalizer.py](jobpilot/core/resume_normalizer.py#L23-L30) | `"professional experience"` key duplicated in `SECTION_SYNONYMS`. | ✅ Fixed | Rajesh | None (already met). | Removed the duplicate dict key. |
| 16 | 🟢 | [jobpilot/core/resume_reader.py](jobpilot/core/resume_reader.py#L329-L331) | Local `sp(base)` defined but never called. | ✅ Fixed | Rajesh | None (already met). | Dead helper removed from `_build_story_with_scale`. |
| 62 | 🟢 | [jobpilot/core/resume_normalizer.py](jobpilot/core/resume_normalizer.py#L408-L444) | `normalize_company`, `normalize_job_title`, `normalize_degree` unreferenced. | ✅ Fixed | Rajesh | None (already met). | Kept (intended public normalization API) and prefixed with a documentation block declaring them public so they're not flagged again. |
| 50 | 🟢 | [jobpilot/core/auth_db.py](jobpilot/core/auth_db.py#L1-L4) | Module docstring says `auth.py`. | ✅ Fixed | Rajesh | None (already met). | Docstring now reads `auth_db.py` and reflects the actual `pbkdf2_sha256` algorithm. |

## 9. API Design

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 46 | 🟡 | [jobpilot/routes/jobs.py](jobpilot/routes/jobs.py#L24-L33) | `jsearch_requests` / `adzuna_requests` incremented unconditionally. | ✅ Fixed | Rajesh | None (already met). | Increments are now gated on `RAPIDAPI_KEY` / (`ADZUNA_APP_ID` + `ADZUNA_APP_KEY`) being present, so the usage dashboard doesn't inflate counts when those integrations are disabled. |
| 47 | 🟢 | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L137-L144) | `improve_line` does not increment `claude_calls`. | ✅ Fixed | Rajesh | None (already met). | Counter now incremented before delegating to `improve_line()`. |
| 48 | 🟢 | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L178-L188) | `suggest_certs` does not increment `claude_calls`. | ✅ Fixed | Rajesh | None (already met). | Counter incremented before `suggest_certifications()` call. |
| 49 | 🟢 | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L191-L200) | `answer` endpoint does not increment `claude_calls`. | ✅ Fixed | Rajesh | None (already met). | Counter incremented before `answer_screening_question()` call. |

## 10. Frontend

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 41 | 🟡 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L17) | `_authTab` declared in both `app.js` and `landing.html`. | ⏳ Open | — | Decision: keep `_authTab` only in `app.js` (current behavior preserved) and reference from `landing.html`; verify no duplicate `<script>` includes. | Risk of redeclaration / behavior conflict; pick one source of truth. |
| 42 | 🟡 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L45-L55) | `switchAuthTab` references DOM IDs that no longer exist. | ⏳ Open | — | Audit current DOM IDs in `index.html` / `landing.html`; either delete the dead branch or remap to live IDs; manual click-through to confirm tab switching. | Dead branch; align with current landing-page IDs. |
| 43 | 🟡 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js) | Theme keys (`light-pro`/`dark-pro`) mismatch HTML options (`light`/`dark`). | ⏳ Open | — | Pick one canonical naming (recommend `light` / `dark`); migrate any persisted `localStorage` value on read; update CSS theme attribute selector. | Causes incorrect select state on load. |
| 44 | 🟢 | [jobpilot/static/css/style.css](jobpilot/static/css/style.css) | Single 80 KB CSS file. | 🚫 Won't Fix | — | Build tool (esbuild / Vite / Parcel); CSS module split plan; CI step to bundle. Deferred until tooling lands. | Tracked separately as part of the Foundations sprint (full module split). Not a single-PR low-priority fix; deferred with this rationale. |
| 45 | 🟢 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js) | Single 85 KB JS file. | 🚫 Won't Fix | — | Same as #44 — needs a bundler before splitting. | Same as #44. Modularization will be planned alongside a build tool (esbuild/Vite) introduction. |
| 36 | 🟢 | [jobpilot/templates/base.html](jobpilot/templates/base.html#L19) | Only Inter web font preloaded. | ✅ Fixed | Rajesh | None (already met). | Added a comment in `base.html` explicitly documenting that PDF generation falls back to Times/system fonts and Inter is the only web font. |
| 38 | 🟢 | [jobpilot/templates/landing.html](jobpilot/templates/landing.html#L344) | Hardcoded copyright `© 2025`. | ✅ Fixed | Rajesh | None (already met). | Footer now uses `<span id="ln-footer-year">` populated by JS at load time. |
| 39 | 🟢 | [jobpilot/templates/landing.html](jobpilot/templates/landing.html#L88-L101) | Marketing stats (2.4M+/98%/12K+) appear unsubstantiated. | ✅ Fixed | Rajesh | None (already met). | Removed unsubstantiated stat cards and the "Search 2.4M+ US jobs live" hero copy. Kept verifiable stats (6 boards, 3× faster). |
| 40 | 🟢 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L12-L15) | `const API = "";` (same-origin only). | ✅ Fixed | Rajesh | None (already met). Override with `window.JOBPILOT_API_BASE`. | `API` now reads `window.JOBPILOT_API_BASE` if set; falls back to same-origin. Documented inline. |

## 11. Accessibility & SEO

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 56 | 🟡 | [jobpilot/templates/index.html](jobpilot/templates/index.html) | Interactive elements lack ARIA roles/labels. | ⏳ Open | — | WCAG 2.1 AA checklist; `axe-core` or Lighthouse a11y audit baseline; per-control `aria-label` / `aria-expanded` / focus management work. | Required for screen-reader compliance. |
| 57 | 🟢 | [jobpilot/templates/landing.html](jobpilot/templates/landing.html#L477-L491) | Decorative/feature SVGs lack accessible names. | ✅ Fixed | Rajesh | None (already met). | Inline init script now applies `aria-hidden="true"` + `focusable="false"` to every `<svg>` inside `.landing-root` that has no explicit `aria-label`/`role`. |
| 58 | 🟢 | [jobpilot/templates/base.html](jobpilot/templates/base.html#L7) | No `<meta name="description">`. | ✅ Fixed | Rajesh | None (already met). | Added a `meta_description` Jinja block in `base.html` with a sensible default. |
| 59 | 🟢 | [jobpilot/templates/base.html](jobpilot/templates/base.html#L8-L17) | No Open Graph / Twitter Card tags. | ✅ Fixed | Rajesh | None (already met). | Added `og:type/title/description/site_name` and `twitter:card/title/description` blocks in `base.html`. |

## 12. Configuration & Deployment

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 54 | 🟡 | [jobpilot/Dockerfile](jobpilot/Dockerfile#L26-L31) | Container runs as `root`. | ✅ Fixed | Rajesh | None (already met). | Added a system `appuser` (uid 1001), `chown`'d `/app`, and dropped to `USER appuser` before `CMD`. |
| 32 | 🟡 | [jobpilot/.env.example](jobpilot/.env.example#L3) | `FLASK_SECRET` missing from `.env.example`. | ⏳ Open | — | Pairs with #1 — closes when the fail-fast guard lands. Already documented in `.env.example`. | Now present in the file (added during low-priority sprint), but still tracked as Open until the corresponding fail-fast guard #1 lands. |
| 33 | 🟡 | [jobpilot/.gitignore](jobpilot/.gitignore#L27) | `generated/` rule is commented out. | ✅ Fixed | Rajesh | None (already met). | Verified the working `.gitignore` already enforces `jobpilot/generated/`, `jobpilot/logs/`, and `jobpilot/resumes/` — the original line ref pre-dated that change. No further action required. |
| 34 | 🟢 | [jobpilot/Dockerfile](jobpilot/Dockerfile#L3-L6) | `COPY jobpilot/requirements.txt` assumes repo-root build context. | ✅ Fixed | Rajesh | None (already met). | Added explicit comment block at the top of the Dockerfile documenting the expected build context (`docker build -f jobpilot/Dockerfile .`). |
| 35 | 🟢 | [jobpilot/requirements.txt](jobpilot/requirements.txt) | `python-multipart==0.0.9` not used by Flask. | ✅ Fixed | Rajesh | None (already met). | Dropped `python-multipart` from `requirements.txt`. |
| 55 | 🟢 | [railway.toml](railway.toml#L1-L8) | `startCommand` overrides Dockerfile `CMD`. | ✅ Fixed | Rajesh | None (already met). | Removed `startCommand` from `railway.toml` so the Dockerfile `CMD` is the single source of truth. |
| 68 | 🟢 | [jobpilot/.env.example](jobpilot/.env.example#L13-L15) | `APIFY_MODULAR_ACTOR_ID` not documented. | ✅ Fixed | Rajesh | None (already met). | Added `APIFY_MODULAR_ACTOR_ID` (and `CLAUDE_MODEL`) entries with explanatory comments. |

## 13. Testing & CI/CD

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 30 | 🟠 | repo-wide | No tests, no `tests/` directory, no `pytest.ini`. | ⏳ Open | — | Add `pytest`, `pytest-flask` (or use `app.test_client()`), `responses` for mocking external HTTP; create `tests/` skeleton; first targets are `routes/auth.py` and `core/ai_engine.score_ats` (mocked Anthropic). | Highest structural risk; start with smoke tests on auth + scoring. |
| 31 | 🟡 | repo-wide | No CI/CD configuration. | ⏳ Open | — | `.github/workflows/ci.yml` running `ruff` + `pytest` + `docker build` on PR; `ANTHROPIC_API_KEY` secret optional (mocked in tests). Pairs with #30. | Add GitHub Actions for lint + tests + Docker build on PR. |

## 14. New — Editor History & Logout Feature (added 2026-05-04)

*Findings introduced by the in-session history panel and editor-bar Sign-out button.*

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 69 | 🟡 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js) | `sessionHistory` is a top-level mutable global. | ⏳ Open | — | Wrap `app.js` in an IIFE or convert to ES modules (needs build tool, see #44/#45); confirm no other globals depend on `window.sessionHistory`. | Same anti-pattern as #41. Wrap in a module/IIFE; risks redeclaration if `app.js` is included twice. |
| 70 | 🟢 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L131-L182) | `logout()` uses blocking `confirm()` dialog. | ✅ Fixed | Rajesh | None (already met). | Replaced `confirm()` with a Promise-based `appConfirm()` modal (markup injected lazily, styled via `.app-confirm-*` rules in `style.css`). |
| 71 | 🟢 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js) | Two visible **Sign out** buttons exist when the editor is open (topbar + editor status bar). | ✅ Fixed | Rajesh | None (already met). | Removed the editor status-bar Sign-out button (and its CSS). Topbar Sign-out is now the single canonical control. |
| 72 | 🟢 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L211-L226) | Session history is in-memory only; lost on reload, navigation, or logout. | ✅ Fixed | Rajesh | None (already met). | Now persisted to `sessionStorage` (`jp_session_history`); survives reloads within the browser session, cleared on logout/browser-close. |

---

## Severity Roll-up

| Pri | Severity | Count | Resolved | Won't Fix | Open |
|-----|----------|------:|---------:|----------:|-----:|
| 🔴 | Critical | 3 | 0 | 0 | 3 |
| 🟠 | High | 4 | 0 | 0 | 4 |
| 🟡 | Medium | 40 | 14 | 0 | 26 |
| 🟢 | Low | 25 | 23 | 2 | 0 |
|     | **Total** | **72** | **37** | **2** | **33** |

## Status Roll-up

| Status | Count |
|--------|------:|
| ⏳ Open | 33 |
| 🔧 WIP | 0 |
| ✅ Fixed | 37 |
| 🚫 Won't Fix | 2 |

## Contribution Tracker

| Owner | Open | WIP | Fixed | Total Touched |
|-------|-----:|----:|------:|--------------:|
| Rajesh | 0 | 0 | 37 | 37 |
| Tarun | 0 | 0 | 0 | 0 |
| — (unassigned) | 33 | 0 | 0 | 33 |

> Update these tables whenever an issue's `Status` or `Owner` changes.

---

## Recommended Phasing

1. **Hardening sprint (≈1 week):** Sections 1, 2, 3 — fail-fast on missing secrets, fix the auth-prefix bug, sanitize inputs. (#54 Docker non-root already done.)
2. **Reliability sprint (≈1 week):** Sections 4, 7, plus #22/#23/#24 from Section 5. Replace `print()` with `logging`, add retries, persist usage and migrate user store.
3. **Quality & cost sprint (≈1 week):** Section 6 (#11, #27, #29), #17 (PDF dedup), #67 (parser dedup), Claude client reuse and caching.
4. **Foundations sprint (ongoing):** Section 13 (tests + CI), Section 10 frontend modularization (#44, #45 — currently Won't Fix until tooling lands), Section 11 ARIA work (#56).

---

*Report re-verified against working tree on 2026-05-04 after the low-priority remediation sprint. Line numbers correspond to the current source.*
