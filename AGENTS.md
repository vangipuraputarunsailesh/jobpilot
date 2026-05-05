# AGENTS.md — JobPilot Repository Rules for AI Agents & Contributors

> This file is the contract every AI coding agent (Copilot, Claude, Cursor, etc.) and human contributor MUST read before editing this repository.
> If a rule here conflicts with a default model behavior, **this file wins**.

---

## 1. Project at a glance

- **App:** [jobpilot/](jobpilot/) — Flask backend + Jinja templates + vanilla JS frontend.
- **Source of truth for outstanding work:** [REPO_ISSUES_REPORT.md](REPO_ISSUES_REPORT.md).
- **Live deployment:** <https://www.jobspilot.site>.
- **Custom domain:** `www.jobspilot.site` is the canonical URL (CNAME-mapped to the Railway service).
- **Container build context:** repo root, e.g. `docker build -f jobpilot/Dockerfile .`.
- **Production process manager:** Railway runs the container’s `CMD` (no `startCommand` override).

---

## 2. Hard rules (must-follow)

### 2.1 Owner attribution

- **Every fix made through this assistant/account is attributed to `Rajesh`** in [REPO_ISSUES_REPORT.md](REPO_ISSUES_REPORT.md).
- Do **not** use `Implementation`, `Copilot`, `AI`, model names, or generic placeholders in the `Owner` column or Change Log.
- The only allowed values in the `Owner` column today are: `Rajesh`, `Tarun`, `Review`, or `—` (unassigned).

### 2.2 The issues report is updated, never recreated

- [REPO_ISSUES_REPORT.md](REPO_ISSUES_REPORT.md) is the single source of truth for outstanding work.
- **Never delete, rename, or recreate** this file. Always edit it in place.
- When you close an issue:
  1. Flip its `Status` to `✅ Fixed` and set `Owner = Rajesh`.
  2. Refresh the Analyst Note with a one-line description of the fix and the new line refs.
  3. Add a row to the **Change Log** describing the change, listing affected issue numbers and touched files.
  4. Update the **Severity Roll-up**, **Status Roll-up**, and **Contribution Tracker** counts.
- Do not introduce a parallel tracker (CSV, JSON, GitHub Project, etc.) without explicit instruction.

### 2.3 Scope discipline

- Only change code that the request asks for, or that is strictly required to implement the request.
- **Do not** add docstrings, comments, type annotations, refactors, or "improvements" to code you did not modify for the task.
- **Do not** introduce new dependencies, frameworks, or build tools without an explicit request.
- **Do not** delete user files, markdown reports, runtime artifacts, or git history as a shortcut.

### 2.4 Risk classification before editing

Before touching code, classify the change:

| Class | Examples | Allowed without confirmation? |
|---|---|---|
| **Trivial** | Typo fix, dead-code removal, single-line guard, log message | ✅ Yes |
| **Low-risk** | Add input validation, swap `print` → `logger`, escape HTML on a known surface | ✅ Yes |
| **Medium-risk** | Change a public function signature, alter auth flow, modify DB schema | ⚠️ Ask first |
| **Destructive** | Delete files, drop tables, force-push, `--no-verify`, rewrite history | 🚫 Always ask first |

When fixing items from `REPO_ISSUES_REPORT.md`, **prefer Trivial / Low-risk Mediums first**.

### 2.5 Security non-negotiables

- Do not commit secrets. `.env` is git-ignored — keep it that way.
- Treat any new external HTTP call as untrusted: validate the URL scheme and block private/loopback ranges (Issue #63 is still open — do not regress it).
- Sanitize anything that gets interpolated into `innerHTML`. Use the existing `escHtml(...)` helper in [jobpilot/static/js/app.js](jobpilot/static/js/app.js).
- Sanitize filenames at the route boundary before they hit `Path(...)` — pattern already established in [jobpilot/routes/resume.py](jobpilot/routes/resume.py).
- Never bypass the JWT auth guard. The guard is in [jobpilot/app.py](jobpilot/app.py) (`_auth_guard`).

### 2.6 Environment & config

- `app.py` is the **single** authoritative `load_dotenv` caller. Do not re-add `load_dotenv` in submodules (Issue #10).
- New env vars MUST be added to `jobpilot/.env.example` with a one-line comment explaining their purpose.
- Tunable limits should be env-overridable (see `RESUME_MAX_BYTES`, `RESUME_DESCRIPTION_MAX_CHARS`, `CLAUDE_MODEL` for the established pattern).

### 2.7 Logging

- Use `logging.getLogger("jobpilot")` everywhere. The configured `RotatingFileHandler` in [jobpilot/app.py](jobpilot/app.py) is the destination.
- **Do not add new `print()` calls** for diagnostics. Existing `print()` calls are tracked under issues #12 / #13 / #14 and will be migrated as part of the reliability sprint.

### 2.8 Frontend

- All new dynamic HTML insertions must escape user data via `escHtml(...)`.
- Do not split [jobpilot/static/css/style.css](jobpilot/static/css/style.css) or [jobpilot/static/js/app.js](jobpilot/static/js/app.js) without introducing a build tool first (#44 / #45 are intentionally `🚫 Won't Fix` until that lands).
- The favicon at [jobpilot/static/favicon.svg](jobpilot/static/favicon.svg) is the canonical brand mark — keep the teal gradient (`#14b8a6 → #0d9488`) and `JP` wordmark consistent if you replace it.

### 2.9 Documentation

- The user-facing entry point is [README.md](README.md). Keep the **Live Site** badge/link pointing at <https://www.jobspilot.site> in sync with reality.
- Do **not** create new ad-hoc Markdown reports to document changes. Status updates belong in [REPO_ISSUES_REPORT.md](REPO_ISSUES_REPORT.md). Architectural notes belong in [README.md](README.md).

---

## 3. Standard workflow for an agent

1. **Read** the user request and the relevant section of [REPO_ISSUES_REPORT.md](REPO_ISSUES_REPORT.md).
2. **Plan** the smallest change that satisfies the request. Classify per §2.4.
3. **Read the target files** before editing. Never edit blind.
4. **Make the change.** Keep diffs minimal; do not reformat untouched code.
5. **Run** `get_errors` (or the equivalent LSP check) on every file you touched.
6. **Update** [REPO_ISSUES_REPORT.md](REPO_ISSUES_REPORT.md):
   - Flip affected rows to `✅ Fixed`, owner `Rajesh`, refreshed Analyst Note.
   - Add a Change Log entry.
   - Recompute the Severity Roll-up / Status Roll-up / Contribution Tracker.
7. **Reply** with a short summary that links to the touched files (workspace-relative paths, no backticks around file links).

---

## 4. What's intentionally out of scope

- The chat-parser bug (#9) and broad `except Exception` audit (#20) require careful semantic review — **ask before touching**.
- Migrations away from SQLite (#23, #24), introducing Redis/postgres, or replacing the in-memory usage counter (#22) are explicitly multi-step infra changes — **ask before touching**.
- The 3 🔴 Critical and 4 🟠 High security findings (#1, #2, #3, #4, #17, #30) are the next planned sprint — they will be done deliberately, with fail-fast guards and tests, not as drive-by edits.
- Splitting `style.css` / `app.js` (#44, #45) is `🚫 Won't Fix` until a bundler is introduced.

---

## 5. Quick reference — owner attribution example

When you fix issue #N from this account, the resulting row should look like:

```markdown
| N | 🟡 | [path/to/file.py](path/to/file.py#L10-L20) | Original finding text. | ✅ Fixed | Rajesh | One-line description of what changed and why it's safe. |
```

…and the matching Change Log entry:

```markdown
| YYYY-MM-DD | Short imperative description of the change. | #N | [path/to/file.py](path/to/file.py) | Rajesh |
```

That's it. Keep diffs small, attribution honest, and the report current.
