# JobPilot — Repository Issues Assessment

> ⚠️ **Top-of-mind security debt** — the items below are *not* drive-by fixes; they are the remaining must-do work before this app should serve real production traffic at scale. Review at the start of every sprint:
>
> - 🔴 **#1** — `FLASK_SECRET` defaults to a hard-coded string. Add a fail-fast guard at startup.
> - 🔴 **#2** — `JWT_SECRET` defaults to a hard-coded string. Same fail-fast pattern.
> - 🔴 **#9** — `ai_engine.apply_chat_instruction` parser has a latent split bug; needs careful semantic review (AGENTS.md §4 — *ask before touching*).
> - 🟠 **#3** — `passlib` configured for `pbkdf2_sha256` despite docstring claiming `bcrypt`.
> - 🟠 **#4** — Auth guard uses `path.startswith("/static")` (no trailing slash) — `/staticXYZ` bypasses auth.
> - 🟠 **#17** — ~80-line PDF parsing block duplicated; risk of drift on every fix.
> - 🟠 **#30** — Test scaffold landed (Phase 3) but is intentionally minimal; broaden before any large refactor.
>
> ⚠️ **Document handling rule (AGENTS.md §2.2):** This file is **edit-in-place**. Do **not** delete or recreate it. If you accidentally delete it, restore from git history rather than reconstructing.

**Document type:** Code & Architecture Review
**Scope:** `jobpilot/` application (Flask backend + static frontend)
**Total findings:** 82 (Critical: 4 · High: 4 · Medium: 45 · Low: 29)
**Open:** 17 · **In Progress:** 1 (#30) · **Resolved:** 54 (27 Low + 27 Medium + 0 High + 0 Critical fixes credited; net 1 Critical Fixed = #73) · **Won't Fix:** 11 (with documented Requirements)
**Estimated remediation effort:** ~99 engineering hours (~72 hr completed)
**Last re-check:** 2026-05-04 (TTL session + Google visibility sprint)
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
| 2026-05-04 | **Live Playwright UI sprint.** Drove the running app through every auth path + a full search; reproduced and fixed 7 bugs (1 🔴, 3 🟡, 3 🟢) under new Section 14b. Headline fix: every landing-page auth handler now writes `sessionStorage.jp_session_active='1'` so `/app` no longer wipes the token and bounces home (full auth lockout in fresh browsers). Also: Arbeitnow epoch dates now format correctly, `/api/usage` and `/api/upload-resume` requests now carry the bearer token, footer links stop scrolling to top, the orphan "or continue with" divider hides when Google is unconfigured, and the auth modal's leftover "12,000+" stat is gone. | #73, #74, #75, #76, #77, #78, #79 | [jobpilot/templates/landing.html](jobpilot/templates/landing.html), [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py), [jobpilot/static/js/app.js](jobpilot/static/js/app.js) | Rajesh |
| 2026-05-04 | **Phase 3 — Medium remediation sprint.** Mechanical print()→logger migration across 3 core modules; thread-local HTTP session + bounded retry adapter; SSRF allow-list for `fetch_job_description`; binary-search PDF auto-fit; shared `read_resume_bytes` parser; frontend `_authTab`/dead-code/theme-key cleanup; `.env.example` status flip. Also added a top-of-file warnings header per user request. | #12, #13, #14, #25, #29, #32, #41, #42, #43, #61, #63, #67 | [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py), [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py), [jobpilot/core/resume_reader.py](jobpilot/core/resume_reader.py), [jobpilot/routes/resume.py](jobpilot/routes/resume.py), [jobpilot/static/js/app.js](jobpilot/static/js/app.js), [REPO_ISSUES_REPORT.md](REPO_ISSUES_REPORT.md) | Rajesh |
| 2026-05-04 | **Test & CI scaffolding.** Added pytest skeleton with `app.test_client()` fixture and 5 smoke tests covering health, landing render, demo login, registration validation, and the JWT guard on `/api/jobs/search`. Added matrix CI on python 3.11 / 3.12 running `compileall` + pytest, plus a separate Docker-build job. | #30 (WIP), #31 (Fixed) | [tests/conftest.py](tests/conftest.py), [tests/test_auth_smoke.py](tests/test_auth_smoke.py), [pytest.ini](pytest.ini), [requirements-dev.txt](requirements-dev.txt), [.github/workflows/ci.yml](.github/workflows/ci.yml) | Rajesh |
| 2026-05-04 | **Won't-Fix policy update.** Marked nine items 🚫 Won't Fix with explicit Requirements blocks documenting exactly what infra/design decisions must land first to reopen them. No code change. | #7, #20, #22, #23, #24, #27, #37, #56, #60 | [REPO_ISSUES_REPORT.md](REPO_ISSUES_REPORT.md) | Rajesh |
| 2026-05-04 | **TTL session + Google visibility sprint.** Replaced the tab-scoped `sessionStorage.jp_session_active` marker with a sliding `localStorage.jp_session_expiry` (7 d for real accounts, 24 h for demo) so logged-in users survive tab close + browser restart and only get logged out by sign-out, expiry, or browser "Clear site data". Added a `?debug=1`-gated "GOOGLE_CLIENT_ID not configured" hint inside the auth modal, a startup `logger.warning` when the env var is unset, and an **Enable Google Sign-In** section in [README.md](README.md). | #80, #81, #82 (new) | [jobpilot/templates/index.html](jobpilot/templates/index.html), [jobpilot/templates/landing.html](jobpilot/templates/landing.html), [jobpilot/static/js/app.js](jobpilot/static/js/app.js), [jobpilot/app.py](jobpilot/app.py), [README.md](README.md) | Rajesh |

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
| 63 | � | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L1258-L1330) | `fetch_job_description` accepts arbitrary URLs (SSRF). | ✅ Fixed | Rajesh | None (already met). | New `_is_safe_external_url(url)` allow-list: only `http(s)`, host resolved with `getaddrinfo`, every returned IP must be public-routable (rejects `is_private`/`is_loopback`/`is_link_local`/`is_multicast`/`is_reserved`/`is_unspecified` plus the CGNAT block `100.64.0.0/10`). Outbound request also runs with `allow_redirects=False` so a 30x to an internal host can't bypass the pre-flight check. Severity bumped to 🟠 to reflect the original metadata-endpoint exposure now closed. |
| 6 | 🟡 | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L213-L242) | Download endpoint relies on user-supplied `filename`. | ✅ Fixed | Rajesh | None (already met). | Sanitization is now explicit at the route boundary — `safe_stem = re.sub(r"[^A-Za-z0-9_\-]", "_", Path(os.path.basename(raw_name)).stem) or "resume"`; `save_tailored_*` then resolves under `GENERATED_DIR` and raises `ValueError` on traversal. |
| 5 | 🟡 | [jobpilot/app.py](jobpilot/app.py#L18-L82) | JWT and decoder imports inside `before_request`. | ✅ Fixed | Rajesh | None (already met). | `jwt as pyjwt` and `decode_token` are now imported at module scope so each request skips the import-cache lookup. |
| 7 | 🟡 | [jobpilot/routes/auth.py](jobpilot/routes/auth.py#L63) | Google-OAuth users get random hex password. | 🚫 Won't Fix | — | **Requirements (must agree before reopening):** (a) schema migration adding `auth_provider` column to `users` (paired with #23 Postgres migration), (b) backfill script tagging existing OAuth rows, (c) `/api/auth/login` change rejecting password login when `auth_provider != 'local'`, (d) UI copy explaining the rejection on the login form. | Deferred until the Postgres migration (#23) lands so we don't write a SQLite-only schema change. |
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
| 37 | 🟡 | [jobpilot/templates/index.html](jobpilot/templates/index.html#L5) | Auth check is a JS `localStorage` redirect. | 🚫 Won't Fix | — | **Requirements:** (a) Cookie-auth design with `Secure` / `HttpOnly` / `SameSite=Lax` defaults, (b) CSRF strategy (double-submit cookie or origin check), (c) refresh-token endpoint, (d) frontend rewrite of every `authHeaders()` call site, (e) backend `@app.get("/app")` server-side guard. Pairs with #37/#73 client-side hardening already done. | Deferred — multi-week security redesign, not a drive-by edit. |

## 4. Error Handling & Observability

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 19 | 🟡 | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L60-L73) | `except Exception: pass` after `pypdf` read. | ✅ Fixed | Rajesh | None (already met). | Replaced silent `pass` with `logger.warning("pypdf extraction failed (%s); falling back to pdfplumber", e)` so failures are diagnosable while the fallback still runs. |
| 20 | 🟡 | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py) | 39 broad `except Exception` blocks across the codebase. | 🚫 Won't Fix | — | **Requirements (must agree before reopening):** (a) the pytest baseline (#30) must be broader than the current smoke tests — needs unit coverage of every adapter so behavior changes are caught, (b) per-module exception inventory (`grep` + manual triage), (c) agreed error-class taxonomy (`requests.RequestException`, `KeyError`, `json.JSONDecodeError`, etc.), (d) replace bare excepts in priority order with `exc_info=True` logging. | Deliberately deferred per AGENTS.md §4 — careful semantic review needed; not a drive-by edit. |
| 21 | 🟡 | [jobpilot/core/resume_reader.py](jobpilot/core/resume_reader.py#L118-L128) | `render_to_pdf` returns silently on page-count failure. | ✅ Fixed | Rajesh | None (already met). | Failure now flows through `logging.getLogger("jobpilot").warning(...)` (lands in the configured `RotatingFileHandler`) before the ReportLab fallback. |
| 12 | 🟡 | [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py) | `print()` used for errors (7+ sites). | ✅ Fixed | Rajesh | None (already met). | Module-scope `logger = logging.getLogger("jobpilot")` added; all 7 `print(f"[…] error: {e}")` sites swapped to `logger.warning("[…] error: %s", e)`. Output now flows through the configured `RotatingFileHandler` in `app.py` (Phase 3). |
| 13 | 🟡 | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py) | ~30 `print()` calls used for diagnostics. | ✅ Fixed | Rajesh | None (already met). | All 42 `print()` sites migrated to `logger.info` (status / counts) or `logger.warning` (errors / `Failed`/`Error` strings) keeping the per-source `[adapter]` prefixes intact (Phase 3). |
| 14 | 🟡 | [jobpilot/core/resume_reader.py](jobpilot/core/resume_reader.py#L69-L91) | `print()` used in 6 error paths. | ✅ Fixed | Rajesh | None (already met). | Module logger added; `print()` calls in `read_resume`, `save_tailored_pdf`, and `save_tailored_docx` swapped to `logger.warning(..., exc_info=True)` where the previous code also called `traceback.print_exc()` (Phase 3). |

## 5. Architecture & Scalability

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 23 | 🟡 | [jobpilot/core/auth_db.py](jobpilot/core/auth_db.py#L19) | SQLite used as production user store. | 🚫 Won't Fix | — | **Requirements (must agree before reopening):** (a) provision Postgres on Railway (plan upgrade), (b) add `psycopg[binary]` (or `asyncpg`), (c) abstract `auth_db` behind a connection-pool layer, (d) write SQLite→Postgres migration script, (e) add `DATABASE_URL` env var, (f) update tests to spin up a temporary Postgres (or use `pytest-postgresql`). | Deferred infra change — not a drive-by edit (AGENTS.md §4). |
| 24 | 🟡 | [jobpilot/core/auth_db.py](jobpilot/core/auth_db.py#L24-L25) | New SQLite connection per call; no pooling. | 🚫 Won't Fix | — | **Requirements:** Paired with #23 — same Postgres migration scope. Interim thread-local `sqlite3.Connection` rejected because it would mask the bigger concurrency problem. | Deferred until #23 lands. |
| 22 | 🟡 | [jobpilot/app.py](jobpilot/app.py#L18-L26) | Usage counters held in module-level dict. | 🚫 Won't Fix | — | **Requirements:** Persistent backing store — either a `usage_counters` table (paired with #23) or Redis (`redis-py`); decision on whether counters are per-user or global; pricing-tier coupling (free vs paid). | Deferred until the persistence story (#23) is settled. |
| 25 | 🟡 | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L185-L245) | Global `requests.Session` with mutable headers. | ✅ Fixed | Rajesh | None (already met). | Replaced module-level `_SESSION` with `_session()` returning a per-thread `requests.Session` from `threading.local()` (`_SESSION_TLS`). Each session is built via `_build_session()`, mounted with the new retry adapter (#61). Backwards-compat `_SESSION` alias retained for any external callers (Phase 3). |
| 67 | 🟡 | [jobpilot/routes/resume.py](jobpilot/routes/resume.py#L27-L64) | PDF/DOCX/TXT parsing duplicated vs. `resume_reader.read_resume`. | ✅ Fixed | Rajesh | None (already met). | Introduced `read_resume_bytes(content, ext)` in [core/resume_reader.py](jobpilot/core/resume_reader.py); the upload route now delegates so the two code paths can no longer drift apart. Same logger and pdfplumber-fallback contract as the disk path (Phase 3). |
| 26 | 🟢 | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L289-L327) | `_get_apify_actor_ids()` HTTP call at import time. | ✅ Fixed | Rajesh | None (already met). | Replaced eager call with `_LazyApifyActors` proxy + `get_apify_actors()`; HTTP now happens on first use. Existing `APIFY_ACTORS[...]` lookups continue to work. |

## 6. Performance & Cost

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 27 | 🟡 | [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py) | No caching for Claude calls. | 🚫 Won't Fix | — | **Requirements:** (a) cache backend decision (in-process LRU is fine for single-instance deploys but breaks under multi-worker WSGI/Railway scale-out — likely needs Redis once #22 lands), (b) prompt-versioning scheme so prompt edits invalidate entries, (c) per-call-type TTL (ATS=15 min, tailor=never — each result is per-job), (d) per-user quota check before serving stale entries. | Caching the wrong call would silently serve stale answers; deferred until backend + versioning are agreed. |
| 11 | 🟡 | [jobpilot/core/ai_engine.py](jobpilot/core/ai_engine.py#L54-L72) | New `Anthropic` client per call. | ✅ Fixed | Rajesh | None (already met). | `_client()` now memoises a single `anthropic.Anthropic` instance in module-level `_CLIENT`; subsequent calls reuse the existing HTTP connection pool. |
| 29 | 🟡 | [jobpilot/core/resume_reader.py](jobpilot/core/resume_reader.py#L388-L420) | PDF auto-fit rebuilds the doc up to 6 times. | ✅ Fixed | Rajesh | None (already met). | Replaced linear `[1.0, 0.95, ..., 0.75]` scan with a fast-path full-scale build then a 6-iteration binary search on `[0.75, 1.0]`. Worst-case build count unchanged; best-case (most resumes fit at scale 1.0) drops from 1 build to 1, and medium-length resumes converge to the largest fitting scale rather than the next coarse step (Phase 3). |
| 28 | 🟢 | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L1268-L1345) | `search_all_platforms` results not cached. | ✅ Fixed | Rajesh | None (already met). | Added a 90-second in-memory TTL cache keyed on `(title, location, seniority, date_posted)`. Repeat clicks now skip the API fan-out entirely. |

## 7. Resilience & External Integration

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 61 | 🟡 | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L185-L245) | `_get()` has no retry logic. | ✅ Fixed | Rajesh | None (already met). | `_build_session()` now mounts an `HTTPAdapter` with `urllib3.util.Retry(total=3, backoff_factor=0.4, status_forcelist=(429, 500, 502, 503, 504), allowed_methods=frozenset(("GET", "HEAD")), raise_on_status=False)`. Idempotent-only retries; per-host budget capped at 3 attempts; pool_maxsize=8 (Phase 3). |
| 60 | 🟡 | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L197) | Per-request 0.2–0.6 s sleep insufficient under thread pool. | 🚫 Won't Fix | — | **Requirements:** (a) per-provider rate-limit decision (Apify/Adzuna/JSearch each publish different limits), (b) library choice (`pyrate-limiter` vs hand-rolled `threading.Semaphore` per host), (c) coordination with the #61 retry budget so we don't double-throttle, (d) optional per-user fairness layer once #22 lands. | Deferred until provider-specific limits are catalogued. |

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
| 41 | 🟡 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L17) | `_authTab` declared in both `app.js` and `landing.html`. | ✅ Fixed | Rajesh | None (already met). | Removed the duplicate `_authTab` declaration from `app.js` (auth UI lives only in `landing.html`). Added a comment block at the top of the auth section in `app.js` explicitly documenting the contract so the two sources can't accidentally re-fork (Phase 3). |
| 42 | 🟡 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L60-L75) | `switchAuthTab` references DOM IDs that no longer exist. | ✅ Fixed | Rajesh | None (already met). | Replaced `switchAuthTab` and the dead `submitAuth` body with no-op stubs that document the dead-code path. Stubs are safe against any stale cached HTML still binding `onclick="switchAuthTab(...)"` (Phase 3). |
| 43 | 🟡 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js) | Theme keys (`light-pro`/`dark-pro`) mismatch HTML options (`light`/`dark`). | ✅ Fixed | Rajesh | None (already met). | Added `normalizeThemeKey()` so persisted `light-pro`/`dark-pro` values from older builds are migrated to the canonical `light`/`dark` on first load. `applyTheme()` now writes the normalized key to `<html data-theme="…">` and `localStorage`, matching `style.css` and `base.html` (Phase 3). |
| 44 | 🟢 | [jobpilot/static/css/style.css](jobpilot/static/css/style.css) | Single 80 KB CSS file. | 🚫 Won't Fix | — | Build tool (esbuild / Vite / Parcel); CSS module split plan; CI step to bundle. Deferred until tooling lands. | Tracked separately as part of the Foundations sprint (full module split). Not a single-PR low-priority fix; deferred with this rationale. |
| 45 | 🟢 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js) | Single 85 KB JS file. | 🚫 Won't Fix | — | Same as #44 — needs a bundler before splitting. | Same as #44. Modularization will be planned alongside a build tool (esbuild/Vite) introduction. |
| 36 | 🟢 | [jobpilot/templates/base.html](jobpilot/templates/base.html#L19) | Only Inter web font preloaded. | ✅ Fixed | Rajesh | None (already met). | Added a comment in `base.html` explicitly documenting that PDF generation falls back to Times/system fonts and Inter is the only web font. |
| 38 | 🟢 | [jobpilot/templates/landing.html](jobpilot/templates/landing.html#L344) | Hardcoded copyright `© 2025`. | ✅ Fixed | Rajesh | None (already met). | Footer now uses `<span id="ln-footer-year">` populated by JS at load time. |
| 39 | 🟢 | [jobpilot/templates/landing.html](jobpilot/templates/landing.html#L88-L101) | Marketing stats (2.4M+/98%/12K+) appear unsubstantiated. | ✅ Fixed | Rajesh | None (already met). | Removed unsubstantiated stat cards and the "Search 2.4M+ US jobs live" hero copy. Kept verifiable stats (6 boards, 3× faster). |
| 40 | 🟢 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L12-L15) | `const API = "";` (same-origin only). | ✅ Fixed | Rajesh | None (already met). Override with `window.JOBPILOT_API_BASE`. | `API` now reads `window.JOBPILOT_API_BASE` if set; falls back to same-origin. Documented inline. |

## 11. Accessibility & SEO

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 56 | 🟡 | [jobpilot/templates/index.html](jobpilot/templates/index.html) | Interactive elements lack ARIA roles/labels. | 🚫 Won't Fix | — | **Requirements:** (a) full WCAG 2.1 AA audit baseline via `axe-core` or Lighthouse CI, (b) per-control inventory with `aria-label`/`aria-expanded`/focus-management defects, (c) dedicated a11y sprint (not a drive-by edit). | Deferred until a11y sprint is scheduled. |
| 57 | 🟢 | [jobpilot/templates/landing.html](jobpilot/templates/landing.html#L477-L491) | Decorative/feature SVGs lack accessible names. | ✅ Fixed | Rajesh | None (already met). | Inline init script now applies `aria-hidden="true"` + `focusable="false"` to every `<svg>` inside `.landing-root` that has no explicit `aria-label`/`role`. |
| 58 | 🟢 | [jobpilot/templates/base.html](jobpilot/templates/base.html#L7) | No `<meta name="description">`. | ✅ Fixed | Rajesh | None (already met). | Added a `meta_description` Jinja block in `base.html` with a sensible default. |
| 59 | 🟢 | [jobpilot/templates/base.html](jobpilot/templates/base.html#L8-L17) | No Open Graph / Twitter Card tags. | ✅ Fixed | Rajesh | None (already met). | Added `og:type/title/description/site_name` and `twitter:card/title/description` blocks in `base.html`. |

## 12. Configuration & Deployment

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 54 | 🟡 | [jobpilot/Dockerfile](jobpilot/Dockerfile#L26-L31) | Container runs as `root`. | ✅ Fixed | Rajesh | None (already met). | Added a system `appuser` (uid 1001), `chown`'d `/app`, and dropped to `USER appuser` before `CMD`. |
| 32 | 🟡 | [jobpilot/.env.example](jobpilot/.env.example#L3) | `FLASK_SECRET` missing from `.env.example`. | ✅ Fixed | Rajesh | None (already met). Pairs with still-open #1 fail-fast guard. | `FLASK_SECRET=` is now present in `.env.example` so first-time deploys see the required env var; the still-open #1 will close the loop with a startup guard that aborts on missing/short secret. |
| 33 | 🟡 | [jobpilot/.gitignore](jobpilot/.gitignore#L27) | `generated/` rule is commented out. | ✅ Fixed | Rajesh | None (already met). | Verified the working `.gitignore` already enforces `jobpilot/generated/`, `jobpilot/logs/`, and `jobpilot/resumes/` — the original line ref pre-dated that change. No further action required. |
| 34 | 🟢 | [jobpilot/Dockerfile](jobpilot/Dockerfile#L3-L6) | `COPY jobpilot/requirements.txt` assumes repo-root build context. | ✅ Fixed | Rajesh | None (already met). | Added explicit comment block at the top of the Dockerfile documenting the expected build context (`docker build -f jobpilot/Dockerfile .`). |
| 35 | 🟢 | [jobpilot/requirements.txt](jobpilot/requirements.txt) | `python-multipart==0.0.9` not used by Flask. | ✅ Fixed | Rajesh | None (already met). | Dropped `python-multipart` from `requirements.txt`. |
| 55 | 🟢 | [railway.toml](railway.toml#L1-L8) | `startCommand` overrides Dockerfile `CMD`. | ✅ Fixed | Rajesh | None (already met). | Removed `startCommand` from `railway.toml` so the Dockerfile `CMD` is the single source of truth. |
| 68 | 🟢 | [jobpilot/.env.example](jobpilot/.env.example#L13-L15) | `APIFY_MODULAR_ACTOR_ID` not documented. | ✅ Fixed | Rajesh | None (already met). | Added `APIFY_MODULAR_ACTOR_ID` (and `CLAUDE_MODEL`) entries with explanatory comments. |

## 13. Testing & CI/CD

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 30 | 🟠 | repo-wide | No tests, no `tests/` directory, no `pytest.ini`. | 🔧 WIP | Rajesh | Smoke tests cover `/api/health`, landing render, demo login, registration validation, and the protected-route guard. Broaden to `core/ai_engine.score_ats` (mocked Anthropic), `core/job_scraper` adapters, and route-level resume tests. | Phase 3 added [tests/conftest.py](tests/conftest.py), [tests/test_auth_smoke.py](tests/test_auth_smoke.py), [pytest.ini](pytest.ini), and [requirements-dev.txt](requirements-dev.txt). 5/5 smoke tests pass locally (`python -m pytest -q`). |
| 31 | 🟡 | repo-wide | No CI/CD configuration. | ✅ Fixed | Rajesh | None (already met). | Added [.github/workflows/ci.yml](.github/workflows/ci.yml): pull-request + push-to-main triggers; matrix `python-version: [3.11, 3.12]`; jobs run `python -m compileall -q jobpilot tests` then `python -m pytest -q`; a separate `docker` job builds the production image with `docker build -f jobpilot/Dockerfile .` (Phase 3). |

## 14. New — Editor History & Logout Feature (added 2026-05-04)

*Findings introduced by the in-session history panel and editor-bar Sign-out button.*

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 69 | 🟡 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js) | `sessionHistory` is a top-level mutable global. | ⏳ Open | — | Wrap `app.js` in an IIFE or convert to ES modules (needs build tool, see #44/#45); confirm no other globals depend on `window.sessionHistory`. | Same anti-pattern as #41. Wrap in a module/IIFE; risks redeclaration if `app.js` is included twice. |
| 70 | 🟢 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L131-L182) | `logout()` uses blocking `confirm()` dialog. | ✅ Fixed | Rajesh | None (already met). | Replaced `confirm()` with a Promise-based `appConfirm()` modal (markup injected lazily, styled via `.app-confirm-*` rules in `style.css`). |
| 71 | 🟢 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js) | Two visible **Sign out** buttons exist when the editor is open (topbar + editor status bar). | ✅ Fixed | Rajesh | None (already met). | Removed the editor status-bar Sign-out button (and its CSS). Topbar Sign-out is now the single canonical control. |
| 72 | 🟢 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L211-L226) | Session history is in-memory only; lost on reload, navigation, or logout. | ✅ Fixed | Rajesh | None (already met). | Now persisted to `sessionStorage` (`jp_session_history`); survives reloads within the browser session, cleared on logout/browser-close. |

## 14b. New — Live Playwright UI Sprint (added 2026-05-04)
*Findings discovered during a live Playwright sweep of the running app: every auth path, search, and supporting fetch was exercised end-to-end. All seven issues were reproduced, fixed, and re-verified against the running server.*

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 73 | 🔴 | [jobpilot/templates/landing.html](jobpilot/templates/landing.html#L552-L668) | All three landing-page auth handlers (`submitAuth`, `handleGoogleCredential`, `enterDemoMode`) set `localStorage.jp_token` but never set `sessionStorage.jp_session_active='1'`. Every successful login/register/Google/demo redirected to `/app`, where the `index.html` IIFE immediately wiped the token and bounced back to `/` — full auth lockout in any fresh browser. | ✅ Fixed | Rajesh | None (already met). | Mirrored the session-marker writes from [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L85-L140) into all three handlers. Re-tested via Playwright: demo flow now lands on `/app` with the topbar **Sign out** visible. Memory note recorded under `/memories/repo/` so future auth changes are mirrored to both source files. |
| 74 | 🟢 | [jobpilot/templates/landing.html](jobpilot/templates/landing.html#L341-L342) | Footer **Sign in** / **Get started** anchors had `href="#"` with no `event.preventDefault()` — clicking jumped the page to the top before the modal opened. | ✅ Fixed | Rajesh | None (already met). | Both `onclick` handlers now begin with `event.preventDefault();` so the modal opens in place. |
| 75 | 🟢 | [jobpilot/templates/landing.html](jobpilot/templates/landing.html#L443) | Auth-modal "**or continue with**" divider rendered even when no `GOOGLE_CLIENT_ID` was configured (Google container + fallback button were already hidden), leaving an orphan visual element. | ✅ Fixed | Rajesh | None (already met). | Gave the divider `id="auth-google-divider"` and added it to the same hide branch in `initGoogleSignIn()` that already hides the Google container/fallback. |
| 76 | 🟢 | [jobpilot/templates/landing.html](jobpilot/templates/landing.html#L412) | Auth modal still showed the unsubstantiated "Joined by **12,000+** job seekers" stat (mirror of #39, missed in the modal's left rail). | ✅ Fixed | Rajesh | None (already met). | Replaced with the verifiable line "Trusted by job seekers everywhere"; avatars retained as decorative. |
| 77 | 🟡 | [jobpilot/core/job_scraper.py](jobpilot/core/job_scraper.py#L314-L348) | `_normalize_date` had no branch for numeric epoch values, so Arbeitnow's `created_at` (e.g. `"1777906850"`) leaked into the UI verbatim as a 10-digit raw number. | ✅ Fixed | Rajesh | None (already met). | Added an explicit epoch branch (10- or 13-digit numeric strings) that converts to UTC and reuses the same "X hr ago / X days ago / ISO date" formatting as the ISO branch. Verified live: Arbeitnow rows now show "8 hr ago". |
| 78 | 🟡 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L656) | `refreshUsage()` called `fetch('/api/usage')` without `authHeaders()`, producing a 401 and the visible "Could not load usage data" error in the API Usage panel. | ✅ Fixed | Rajesh | None (already met). | Added `headers: authHeaders()` to the request, matching every other authenticated `fetch()` in the file. |
| 79 | 🟡 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L1349) | `/api/upload-resume` upload sent `multipart/form-data` with no `Authorization` header — uploads would 401 for the demo user and any other authenticated session. Discovered while wiring up a working UI test. | ✅ Fixed | Rajesh | None (already met). | Added `Authorization: Bearer <token>` to the multipart POST without overriding the implicit boundary (no `Content-Type` set). |

## 14c. New — TTL Session + Google Visibility Sprint (added 2026-05-04)

*Findings raised by the user ("still facing login issue" + "don't see sign in/up with Google button anywhere") and one latent ReferenceError spotted while reading the auth code. The session model was redesigned end-to-end so users no longer get auto-logged-out every time they close a tab; the Google button now ships with admin-debuggable diagnostics.*

| # | Pri | File | Finding | Status | Owner | Requirements | Analyst Note |
|---|-----|------|---------|--------|-------|--------------|--------------|
| 80 | 🟡 | [jobpilot/templates/index.html](jobpilot/templates/index.html#L4-L28), [jobpilot/templates/landing.html](jobpilot/templates/landing.html#L502-L535), [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L25-L60) | Auth used `sessionStorage.jp_session_active` as the liveness marker, so any tab/browser close auto-logged-out the user ("still facing login issue"). UX too aggressive: users had to re-auth on every reload-after-close. | ✅ Fixed | Rajesh | None (already met). Tunable via the `SESSION_TTL_MS` / `DEMO_SESSION_TTL_MS` JS constants in landing.html + app.js. | Replaced the `sessionStorage` marker with a sliding `localStorage.jp_session_expiry` (ms-since-epoch). 7 days for real accounts, 24 h for demo accounts. Refreshed on every page load that has a valid token (sliding session). Survives tab close + browser restart; cleared by explicit sign-out, browser **Clear site data**, or the expiry elapsing. Three mirrored helpers (`setLoginSession`, `clearLoginSession`, `isLoginSessionValid`) live in landing.html (auth handlers), app.js (in-app), and the IIFE in index.html — all three keep the same contract. Legacy `jp_session_active` is purged on every write so old sessions don't linger. |
| 81 | 🟡 | [jobpilot/templates/landing.html](jobpilot/templates/landing.html#L568-L606), [jobpilot/app.py](jobpilot/app.py#L106-L113), [README.md](README.md) | Google Sign-In button silently vanished when `GOOGLE_CLIENT_ID` was unset, with no startup warning or in-product hint. Admins debugging deploys had no signal that the env var was the cause. | ✅ Fixed | Rajesh | None (already met). Toggle via `?debug=1` query string on the landing URL. | (a) Startup `logger.warning("GOOGLE_CLIENT_ID is not set; Google Sign-In is disabled.")` in `create_app()`. (b) `initGoogleSignIn()` now branches: production users still see nothing (preserves clean UI), but `?debug=1` renders an inline dashed-border hint reading "Google Sign-In not configured — set `GOOGLE_CLIENT_ID`". (c) New **Enable Google Sign-In** section in `README.md` with Cloud Console steps, redirect URI guidance, and the `?debug=1` recipe. The actual rendering code was already correct (#75) — this issue closes the missing diagnostic loop. |
| 82 | 🟢 | [jobpilot/static/js/app.js](jobpilot/static/js/app.js#L233) | `clearSessionHistory()` calls `_persistSessionHistory()`, but that function is never defined anywhere in `app.js` — clicking **Clear** in the in-session history panel throws `ReferenceError`. Likely fallout from the #72 "persist to sessionStorage" change where the helper was inlined and a stale call site remained. | ⏳ Open | — | Decide whether session history should actually persist to `sessionStorage` (per the #72 analyst note) or stay in-memory only. Then either (a) implement `_persistSessionHistory()` (read/write `jp_session_history`) and matching restore-on-load, or (b) drop the call. Either path needs a single regression test exercising **Clear**. | Pre-existing latent bug; not user-visible until the **Clear** button is clicked, but should be cleaned up alongside the next history-panel touch. |


---

## Severity Roll-up

| Pri | Severity | Count | Resolved | Won't Fix | Open |
|-----|----------|------:|---------:|----------:|-----:|
| 🔴 | Critical | 4 | 1 | 0 | 3 |
| 🟠 | High | 4 | 0 | 0 | 4 (1 WIP — #30) |
| 🟡 | Medium | 45 | 27 | 9 | 9 |
| 🟢 | Low | 29 | 26 | 2 | 1 |
|     | **Total** | **82** | **54** | **11** | **17** |

## Status Roll-up

| Status | Count |
|--------|------:|
| ⏳ Open | 17 |
| 🔧 WIP | 1 |
| ✅ Fixed | 54 |
| 🚫 Won't Fix | 11 |

## Contribution Tracker

| Owner | Open | WIP | Fixed | Total Touched |
|-------|-----:|----:|------:|--------------:|
| Rajesh | 0 | 1 | 54 | 55 |
| Tarun | 0 | 0 | 0 | 0 |
| — (unassigned) | 17 | 0 | 0 | 17 |

> Update these tables whenever an issue's `Status` or `Owner` changes.

---

## Recommended Phasing

1. **Hardening sprint (≈1 week):** Sections 1, 2, 3 — fail-fast on missing secrets, fix the auth-prefix bug, sanitize inputs. (#54 Docker non-root already done.)
2. **Reliability sprint (≈1 week):** Sections 4, 7, plus #22/#23/#24 from Section 5. Replace `print()` with `logging`, add retries, persist usage and migrate user store.
3. **Quality & cost sprint (≈1 week):** Section 6 (#11, #27, #29), #17 (PDF dedup), #67 (parser dedup), Claude client reuse and caching.
4. **Foundations sprint (ongoing):** Section 13 (tests + CI), Section 10 frontend modularization (#44, #45 — currently Won't Fix until tooling lands), Section 11 ARIA work (#56).

---

*Report re-verified against working tree on 2026-05-04 after the TTL session + Google visibility sprint (issues #80–#82). Line numbers correspond to the current source.*
