# JobPilot — Repository Issues Assessment

**Document type:** Code & Architecture Review
**Scope:** `jobpilot/` application (Flask backend + static frontend)
**Total findings:** 72 (Critical: 3 · High: 4 · Medium: 40 · Low: 25)
**Open:** 71 · **Resolved:** 1
**Estimated remediation effort:** ~97 engineering hours (~1.0 hr completed)
**Last re-check:** 2026-05-04 — all 68 prior findings re-verified; 4 new findings logged from the editor history/logout feature.
**Source of truth:** This document supersedes the previous `repo_issues.csv` (now removed).

---

## Change Log

| Date | Change | Issues Affected | Files Touched | Author |
|------|--------|-----------------|---------------|--------|
| 2026-05-04 | Initial corporate-format report generated; all 68 findings re-verified against working tree. | All | — | Review |
| 2026-05-04 | Added **Sign out** button and **in-session History** panel to the resume editor (status bar). History captures upload, generate, tailor, ATS, chat, and download events with timestamps; cleared on reload / logout. | New feature (no prior CSV ID) | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L123), [jobpilot/static/css/style.css](jobpilot/static/css/style.css#L1483) | Implementation |
| 2026-05-04 | Removed legacy `repo_issues.csv`; this Markdown report is now the single source of truth. | Housekeeping | `repo_issues.csv` (deleted) | Implementation |
| 2026-05-04 | Re-checked entire report against working tree. Refreshed shifted line numbers in [jobpilot/static/js/app.js](jobpilot/static/js/app.js) (after the ~60-line history insertion). Logged 4 new findings (#69–#72) from the editor history/logout feature. | #43, #65 (line refs); #69–#72 (new) | [jobpilot/static/js/app.js](jobpilot/static/js/app.js), [jobpilot/static/css/style.css](jobpilot/static/css/style.css) | Review |

> **Convention:** When an issue below is resolved, prepend the Severity column with `~~Fixed~~` and add a row to the Change Log above linking the commit/PR.

---

## Executive Summary

The codebase is functional but carries notable **production readiness** and **security** debt. Three Critical items (hardcoded Flask/JWT secrets, a chat-parser bug) should be remediated before any production exposure. The frontend and PDF-generation modules show meaningful duplication and monolithic file sizes that will compound maintenance cost. There is **no automated test suite and no CI/CD**, which is the single largest structural risk.

**Top remediation priorities (recommended sequencing):**
1. Eliminate hardcoded secrets and tighten the JWT auth guard (Issues 1, 2, 4).
2. Fix the chat-parser bug and silent exception swallowing (Issues 9, 19).
3. Add minimum input validation and a non-root Docker user (Issues 51–54).
4. Establish a baseline test suite + CI pipeline (Issues 30, 31).
5. Refactor PDF generation duplication and modularize frontend assets (Issues 17, 44, 45).

---

## 1. Security

| # | Severity | File | Finding | Analyst Note |
|---|----------|------|---------|--------------|
| 1 | Critical | [jobpilot/app.py](jobpilot/app.py#L34) | Hardcoded fallback for `FLASK_SECRET` (`jobpilot-flask-secret`). | Session forgery is trivial if the env var is unset; fail-fast on missing secret. |
| 2 | Critical | [jobpilot/core/auth_db.py](jobpilot/core/auth_db.py#L15) | Hardcoded fallback for `JWT_SECRET`. | Same risk as #1 for token forgery; require the env var or abort startup. |
| 4 | High | [jobpilot/app.py](jobpilot/app.py#L70-L86) | Auth guard uses `path.startswith("/static")` (no trailing slash). | Allows `/staticXYZ` to bypass auth; change to `/static/`. |
| 3 | High | [jobpilot/core/auth_db.py](jobpilot/core/auth_db.py#L20) | `passlib` configured for `pbkdf2_sha256`, not bcrypt as commented. | Align code with intent and `requirements.txt`; bcrypt or argon2 is preferred. |
| 63 | Medium | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L1182-L1224) | `fetch_job_description` accepts arbitrary URLs (SSRF). | Restrict to public HTTP(S) and block private/loopback ranges. |
| 6 | Medium | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L197-L227) | Download endpoint relies on user-supplied `filename`. | Sanitization exists but is implicit; validate explicitly at the route boundary. |
| 5 | Medium | [jobpilot/app.py](jobpilot/app.py#L76) | JWT and decoder imports inside `before_request`. | Move to module scope for performance and readability. |
| 7 | Medium | [jobpilot/routes/auth.py](jobpilot/routes/auth.py#L63) | Google-OAuth users get random hex password. | Mark account as OAuth-only and block password login for those users. |
| 8 | Low | [jobpilot/templates/landing.html](jobpilot/templates/landing.html#L466-L467) | Terms / Privacy links resolve to `#`. | Replace with real legal URLs prior to launch. |

## 2. Data Validation & Input Hardening

| # | Severity | File | Finding | Analyst Note |
|---|----------|------|---------|--------------|
| 52 | Medium | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L35) | Resume upload reads file with no size check. | Enforce `MAX_CONTENT_LENGTH` and reject oversized payloads early. |
| 53 | Medium | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L72) | `generate-resume` description has no length cap. | Cap input to control Claude API cost and latency. |
| 51 | Medium | [jobpilot/routes/auth.py](jobpilot/routes/auth.py#L21) | Email validated only by presence of `@`. | Use `email-validator` or a strict regex. |
| 65 | Medium | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L745) | Job title interpolated into `innerHTML` unsanitized in `showSearching`. | Confirmed at line 745 (shifted from L688 after history feature). XSS surface; escape with `escHtml`. |
| 66 | Low | [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py#L200-L252) | Resume/JD silently truncated at 6000/3000 chars. | Surface a warning to the user when truncation occurs. |

## 3. Authentication & Authorization

(See also Section 1 — Security: #1, #2, #4, #7.)

| # | Severity | File | Finding | Analyst Note |
|---|----------|------|---------|--------------|
| 37 | Medium | [jobpilot/templates/index.html](jobpilot/templates/index.html#L5) | Auth check is a JS `localStorage` redirect. | Bypassable with JS disabled; enforce server-side rendering guard. |

## 4. Error Handling & Observability

| # | Severity | File | Finding | Analyst Note |
|---|----------|------|---------|--------------|
| 19 | Medium | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L52-L53) | `except Exception: pass` after `pypdf` read. | Log the original error before falling back to `pdfplumber`. |
| 20 | Medium | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py) | 39 broad `except Exception` blocks across the codebase. | Catch specific exceptions; preserve diagnosability. |
| 21 | Medium | [jobpilot/core/resume_templates.py](jobpilot/core/resume_templates.py#L678) | `render_to_pdf` returns silently on page-count failure. | Log and surface error rather than shipping a possibly oversized doc. |
| 12 | Medium | [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py#L243) | `print()` used for errors (7+ sites). | Errors bypass the configured `RotatingFileHandler`; switch to `logging`. |
| 13 | Medium | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L205) | ~30 `print()` calls used for diagnostics. | Same as #12; use a module-level logger. |
| 14 | Medium | [jobpilot/core/resume_reader.py](jobpilot/core/resume_reader.py#L69-L91) | `print()` used in 6 error paths. | Same as #12. |

## 5. Architecture & Scalability

| # | Severity | File | Finding | Analyst Note |
|---|----------|------|---------|--------------|
| 23 | Medium | [jobpilot/core/auth_db.py](jobpilot/core/auth_db.py#L19) | SQLite used as production user store. | Migrate to PostgreSQL/MySQL for concurrent, multi-process deployments. |
| 24 | Medium | [jobpilot/core/auth_db.py](jobpilot/core/auth_db.py#L24-L25) | New SQLite connection per call; no pooling. | Introduce a pooled accessor or singleton. |
| 22 | Medium | [jobpilot/app.py](jobpilot/app.py#L18-L26) | Usage counters held in module-level dict. | Lost on restart and incorrect under multi-worker WSGI; persist to DB. |
| 25 | Medium | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L188-L192) | Global `requests.Session` with mutable headers. | Race conditions under threads; use thread-local sessions or per-call clients. |
| 67 | Medium | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L27-L64) | PDF/DOCX/TXT parsing duplicated vs. `resume_reader.read_resume`. | Consolidate into a single parser to avoid divergent fixes. |
| 26 | Low | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L289) | `_get_apify_actor_ids()` HTTP call at import time. | Defer to first use; tolerate Apify outages on startup. |

## 6. Performance & Cost

| # | Severity | File | Finding | Analyst Note |
|---|----------|------|---------|--------------|
| 27 | Medium | [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py#L62-L69) | No caching for Claude calls. | Cache by hash of (resume, JD, prompt) to cut spend on repeats. |
| 11 | Medium | [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py#L55-L59) | New `Anthropic` client per call. | Instantiate once at module load to reuse the HTTP pool. |
| 29 | Medium | [jobpilot/core/resume_reader.py](jobpilot/core/resume_reader.py#L389-L396) | PDF auto-fit rebuilds the doc up to 6 times. | Replace linear scan with binary search on scale factor. |
| 28 | Low | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L1229-L1260) | `search_all_platforms` results not cached. | Add a short-TTL cache keyed on query+filters. |

## 7. Resilience & External Integration

| # | Severity | File | Finding | Analyst Note |
|---|----------|------|---------|--------------|
| 61 | Medium | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L195-L206) | `_get()` has no retry logic. | Add exponential backoff for transient HTTP errors. |
| 60 | Medium | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L197) | Per-request 0.2–0.6 s sleep insufficient under thread pool. | Move throttling to a per-host token bucket. |

## 8. Code Quality & Maintainability

| # | Severity | File | Finding | Analyst Note |
|---|----------|------|---------|--------------|
| 9 | Critical | [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py#L799) | `parts = after_later = after_label.split(...)` — `after_later` unused. | Latent bug; remove the chained assignment. |
| 17 | High | [jobpilot/core/resume_reader.py](jobpilot/core/resume_reader.py#L122-L403) | ~80-line PDF parsing block duplicated inside `_build_story_with_scale`. | Extract a single parser function; current state guarantees drift. |
| 18 | Medium | [jobpilot/core/resume_reader.py](jobpilot/core/resume_reader.py#L123-L124) | `re` re-imported inside `save_tailored_pdf`. | Remove the redundant in-function imports. |
| 10 | Medium | [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py#L22) | `load_dotenv` called both here and in `app.py`. | Centralize in `app.py` to avoid override surprises. |
| 64 | Low | [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py#L65) | Claude model name hardcoded (`claude-sonnet-4-6`). | Move to a constant or env var for easy upgrades. |
| 15 | Low | [jobpilot/core/resume_normalizer.py](jobpilot/core/resume_normalizer.py#L23-L30) | `"professional experience"` key duplicated in `SECTION_SYNONYMS`. | Remove the duplicate entry. |
| 16 | Low | [jobpilot/core/resume_reader.py](jobpilot/core/resume_reader.py#L331) | Local `sp(base)` defined but never called. | Dead code; remove. |
| 62 | Low | [jobpilot/core/resume_normalizer.py](jobpilot/core/resume_normalizer.py) | `normalize_company`, `normalize_job_title`, `normalize_degree` unreferenced. | Verified at lines 416/428/434; either wire in or delete. |
| 50 | Low | [jobpilot/core/auth_db.py](jobpilot/core/auth_db.py#L1-L3) | Module docstring says `auth.py`. | Correct to `auth_db.py`. |

## 9. API Design

| # | Severity | File | Finding | Analyst Note |
|---|----------|------|---------|--------------|
| 46 | Medium | [jobpilot/routes/jobs.py](jobpilot/routes/jobs.py#L24-L27) | `jsearch_requests` / `adzuna_requests` incremented unconditionally. | Inflates metrics regardless of API success or configuration. |
| 47 | Low | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L137-L142) | `improve_line` does not increment `claude_calls`. | Inconsistent telemetry; standardize counter usage. |
| 48 | Low | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L176-L184) | `suggest_certs` does not increment `claude_calls`. | Same as #47. |
| 49 | Low | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L187-L194) | `answer` endpoint does not increment `claude_calls`. | Same as #47. |

## 10. Frontend

| # | Severity | File | Finding | Analyst Note |
|---|----------|------|---------|--------------|
| 41 | Medium | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L17) | `_authTab` declared in both `app.js` and `landing.html`. | Risk of redeclaration / behavior conflict; pick one source of truth. |
| 42 | Medium | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L45-L55) | `switchAuthTab` references DOM IDs that no longer exist. | Dead branch; align with current landing-page IDs. |
| 43 | Medium | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L193-L194) | Theme keys (`light-pro`/`dark-pro`) mismatch HTML options (`light`/`dark`). | Confirmed at L193–194 (shifted). Causes incorrect select state on load. |
| 44 | Low | [jobpilot/static/css/style.css](jobpilot/static/css/style.css) | Single 80 KB CSS file. | Split by component to manage specificity and reviewability. |
| 45 | Low | [jobpilot/static/js/app.js](jobpilot/static/js/app.js) | Single 85 KB JS file. | Modularize into auth/search/resume/chat. |
| 36 | Low | [jobpilot/templates/base.html](jobpilot/templates/base.html#L8) | Only Inter web font preloaded. | Acceptable for PDFs (system fonts), but document the dependency. |
| 38 | Low | [jobpilot/templates/landing.html](jobpilot/templates/landing.html#L338) | Hardcoded copyright `© 2025`. | Render dynamically. |
| 39 | Low | [jobpilot/templates/landing.html](jobpilot/templates/landing.html#L85-L107) | Marketing stats (2.4M+/98%/12K+) appear unsubstantiated. | Remove or back with real metrics to avoid misleading claims. |
| 40 | Low | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L12) | `const API = "";` (same-origin only). | Make configurable for local dev pointing to a remote backend. |

## 11. Accessibility & SEO

| # | Severity | File | Finding | Analyst Note |
|---|----------|------|---------|--------------|
| 56 | Medium | [jobpilot/templates/index.html](jobpilot/templates/index.html) | Interactive elements lack ARIA roles/labels. | Required for screen-reader compliance. |
| 57 | Low | [jobpilot/templates/landing.html](jobpilot/templates/landing.html) | Decorative/feature SVGs lack accessible names. | Add `<title>` or `aria-label`; mark purely decorative ones `aria-hidden`. |
| 58 | Low | [jobpilot/templates/base.html](jobpilot/templates/base.html) | No `<meta name="description">`. | Add for SEO and link previews. |
| 59 | Low | [jobpilot/templates/landing.html](jobpilot/templates/landing.html) | No Open Graph / Twitter Card tags. | Add OG/Twitter metadata for social sharing. |

## 12. Configuration & Deployment

| # | Severity | File | Finding | Analyst Note |
|---|----------|------|---------|--------------|
| 54 | Medium | [jobpilot/Dockerfile](jobpilot/Dockerfile#L24) | Container runs as `root`. | Add a non-root user and `USER` directive. |
| 32 | Medium | [jobpilot/.env.example](jobpilot/.env.example) | `FLASK_SECRET` missing from `.env.example`. | Document all required secrets to prevent insecure defaults. |
| 33 | Medium | [jobpilot/.gitignore](jobpilot/.gitignore#L7) | `generated/` rule is commented out. | Re-enable to prevent accidental commits of generated artifacts. |
| 34 | Low | [jobpilot/Dockerfile](jobpilot/Dockerfile#L13) | `COPY jobpilot/requirements.txt` assumes repo-root build context. | Document the expected build context or normalize paths. |
| 35 | Low | [jobpilot/requirements.txt](jobpilot/requirements.txt#L3) | `python-multipart==0.0.9` not used by Flask. | Remove unused dependency. |
| 55 | Low | [railway.toml](railway.toml#L6) | `startCommand` overrides Dockerfile `CMD`. | Pick one source of truth to avoid drift. |
| 68 | Low | [jobpilot/.env.example](jobpilot/.env.example) | `APIFY_MODULAR_ACTOR_ID` not documented. | Add the variable to keep `.env.example` in sync with the code. |

## 13. Testing & CI/CD

| # | Severity | File | Finding | Analyst Note |
|---|----------|------|---------|--------------|
| 30 | High | repo-wide | No tests, no `tests/` directory, no `pytest.ini`. | Highest structural risk; start with smoke tests on auth + scoring. |
| 31 | Medium | repo-wide | No CI/CD configuration. | Add GitHub Actions for lint + tests + Docker build on PR. |

## 14. New — Editor History & Logout Feature (added 2026-05-04)

*Findings introduced by the in-session history panel and editor-bar Sign-out button.*

| # | Severity | File | Finding | Analyst Note |
|---|----------|------|---------|--------------|
| 69 | Medium | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L132) | `sessionHistory` is a top-level mutable global. | Same anti-pattern as #41 (`_authTab`). Wrap in a module/IIFE or attach to a single namespace; risks redeclaration if `app.js` is included twice (it is, by [landing.html](jobpilot/templates/landing.html) on app pages). |
| 70 | Low | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L124) | `logout()` uses blocking `confirm()` dialog. | Native `confirm` blocks the event loop and looks inconsistent with the in-app toast/modal styling; use a styled confirmation modal. |
| 71 | Low | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L1085) | Two visible **Sign out** buttons exist when the editor is open (topbar `#logout-btn` and editor `.status-logout-btn`). | Functionally equivalent but visually duplicative. Either hide the topbar one inside the editor view or drop the new editor button and surface the topbar button more prominently. |
| 72 | Low | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L135) | Session history is in-memory only; lost on reload, navigation, or logout. | Documented behavior, but consider `sessionStorage` so accidental reloads don't wipe context. Cap at ~200 entries already enforced. |

---

## Severity Roll-up

| Severity | Count | Estimated Hours |
|----------|------:|----------------:|
| Critical | 3 | 1.25 |
| High | 4 | 13.0 |
| Medium | 40 | ~53 |
| Low | 25 | ~30 |
| **Total** | **72** | **~97** |

*Delta vs. previous baseline: +4 findings (1 Medium + 3 Low) from the editor history/logout feature; no prior findings closed in this re-check.*

## Recommended Phasing

1. **Hardening sprint (≈1 week):** Sections 1, 2, 3, and #54 (Docker non-root). Fail-fast on missing secrets, fix the auth-prefix bug, sanitize inputs, drop root.
2. **Reliability sprint (≈1 week):** Sections 4, 7, plus #22/#23/#24 from Section 5. Replace `print()` with `logging`, add retries, persist usage and migrate user store.
3. **Quality & cost sprint (≈1 week):** Section 6, #17 (PDF dedup), #67 (parser dedup), Claude client reuse and caching.
4. **Foundations sprint (ongoing):** Section 13 (tests + CI), Section 10 frontend modularization, Section 11 accessibility/SEO.

---

*Report re-verified against working tree on 2026-05-04. Line numbers correspond to the current source after the editor history/logout feature was merged.*
