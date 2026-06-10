# AGENTS.md — JobPilot Repository Rules for AI Agents & Contributors

> This file is the contract every AI coding agent (Copilot, Claude, Cursor, etc.) and human contributor MUST read before editing this repository.
> If a rule here conflicts with a default model behavior, **this file wins**.

---

## 1. Project at a glance

- **App:** A static single-page web app, source in [jobpilot/templates/](jobpilot/templates/) + [jobpilot/static/](jobpilot/static/), built into [docs/](docs/) by [scripts/build_pages.py](scripts/build_pages.py) (stdlib-only Jinja stripper) and served from GitHub Pages.
- **Live deployment:** <https://www.jobspilot.site>.
- **Custom domain:** `www.jobspilot.site` is the canonical URL (the [CNAME](CNAME) file pins it; DNS points at GitHub Pages).
- **Deploy automation:** [.github/workflows/deploy-pages.yml](.github/workflows/deploy-pages.yml) re-runs `scripts/build_pages.py` and publishes `docs/` on every push to `master`.
- **Job-search proxy:** [proxy/worker.js](proxy/worker.js) — a stateless Cloudflare Worker. Each user pastes their own Worker URL into the in-app BYOK vault (`cf_worker_url`).
- **Outstanding work:** GitHub Issues on this repo. There is no in-repo issues report.

---

## 2. Hard rules (must-follow)

### 2.1 Owner attribution

- Fixes committed through this assistant/account are authored as `Unigalactix <kodagantir295@gmail.com>` and that author identity stands in for `Rajesh` in any human-readable status note.
- When a commit message references an issue, prefer GitHub's auto-close syntax (`Closes #N`) on the first issue and an explicit `gh issue close` for the rest in the same batch.
- Do not credit `Implementation`, `Copilot`, `AI`, or any model name in commit messages or issue comments.

### 2.2 Issues live on GitHub, not in the repo

- Outstanding work lives in GitHub Issues. Agents file issues; contributors self-assign and close them.
- **Do not** recreate the retired `REPO_ISSUES_REPORT.md` / `REPO_ISSUES_REPORT.xlsx`, and do not introduce a parallel tracker (CSV, JSON, GitHub Project, etc.) without explicit instruction.
- When you ship a fix:
  1. Reference the issue in the commit message (`Closes #N` on the first; `gh issue close N --reason completed --comment "Fixed in <sha>."` for any additional issues in the same batch).
  2. After push, verify the affected issues moved to `Closed`.

### 2.3 Scope discipline

- Only change code that the request asks for, or that is strictly required to implement the request.
- **Do not** add docstrings, comments, type annotations, refactors, or "improvements" to code you did not modify for the task.
- **Do not** introduce new dependencies, frameworks, or build tools without an explicit request.
- **Do not** delete user files, runtime artifacts, or git history as a shortcut.

### 2.4 Risk classification before editing

Before touching code, classify the change:

| Class | Examples | Allowed without confirmation? |
|---|---|---|
| **Trivial** | Typo fix, dead-code removal, single-line guard, log message | ✅ Yes |
| **Low-risk** | Add input validation, escape HTML on a known surface, fix a broken link | ✅ Yes |
| **Medium-risk** | Change a public function signature, alter auth flow, change BYOK vault layout | ⚠️ Ask first |
| **Destructive** | Force-push, `--no-verify`, rewrite history, delete tracked user data | 🚫 Always ask first |

### 2.5 Security non-negotiables

- Do not commit secrets. `.env` and `*.env*` are git-ignored — keep it that way.
- Google Identity Services is the only auth path. The Google ID token is decoded client-side for display name + email; never trust an unsigned JWT as a backend-style authz claim (we have no backend).
- BYOK provider keys live in the browser only, AES-GCM-encrypted in `localStorage` under `jp_byok_v1`. The vault key is derived from the signed-in Google email + a user-supplied passphrase via PBKDF2-SHA-256 (200K iters). Never log, exfiltrate, or persist either input.
- All BYOK-credentialed HTTP calls go **direct browser → provider** (Anthropic, Google Drive) or **direct browser → user's own Cloudflare Worker** (job search). No JobPilot-owned server sits in the middle.
- Sanitize anything that gets interpolated into `innerHTML`. Use the existing `escHtml(...)` helper in [jobpilot/static/js/app.js](jobpilot/static/js/app.js).

### 2.6 Environment & config

- The only build-time env var is `GOOGLE_CLIENT_ID`, baked into the static build by [scripts/build_pages.py](scripts/build_pages.py). It is exposed in the rendered HTML; do not put anything secret there.
- The Cloudflare Worker URL and all provider API keys are **runtime** values supplied by the user through the in-app Settings panel and stored in the BYOK vault. Never hard-code them.

### 2.7 Logging

- Use `console.warn` / `console.error` in browser code. There are no server logs.
- Do not add `console.log` calls that include BYOK keys, the Google ID token, raw resume text, or job-description bodies.

### 2.8 Frontend

- All new dynamic HTML insertions must escape user data via `escHtml(...)`.
- Do not split [jobpilot/static/css/style.css](jobpilot/static/css/style.css) or [jobpilot/static/js/app.js](jobpilot/static/js/app.js) without introducing a build tool first.
- The favicon at [jobpilot/static/favicon.svg](jobpilot/static/favicon.svg) is the canonical brand mark — keep the teal gradient (`#14b8a6 → #0d9488`) and `JP` wordmark consistent if you replace it.
- After editing anything under [jobpilot/templates/](jobpilot/templates/) or [jobpilot/static/](jobpilot/static/), rebuild [docs/](docs/) by running `python scripts/build_pages.py` so the static deploy stays in sync.

### 2.9 Documentation

- The user-facing entry point is [README.md](README.md). Keep the **Live Site** link pointing at <https://www.jobspilot.site> in sync with reality.
- Do **not** create new ad-hoc Markdown status reports. Status updates belong on the relevant GitHub issue or PR.

---

## 3. Standard workflow for an agent

1. **Read** the user request and the linked GitHub issue(s).
2. **Plan** the smallest change that satisfies the request. Classify per §2.4.
3. **Read the target files** before editing. Never edit blind.
4. **Make the change.** Keep diffs minimal; do not reformat untouched code.
5. **Run** `get_errors` (or the equivalent LSP check) on every file you touched.
6. **Rebuild** [docs/](docs/) if any template or static asset changed.
7. **Commit + push.** Use `Closes #N` for the first issue in the batch; close the rest with `gh issue close` and reference the commit SHA.
8. **Reply** with a short summary that links to the touched files (workspace-relative paths, no backticks around file links).

---

## 4. What's intentionally out of scope

- Reintroducing a server (Flask, FastAPI, Express, etc.) — the static-site cutover is deliberate. Anything that needs a real backend should go into the user's own Cloudflare Worker via [proxy/](proxy/).
- Adding a build tool (webpack, Vite, esbuild, etc.) — the stdlib-only [scripts/build_pages.py](scripts/build_pages.py) is intentional.
- Replacing Google Identity Services with email/password or GitHub OAuth (both removed in Phase 1).
- Splitting [jobpilot/static/css/style.css](jobpilot/static/css/style.css) or [jobpilot/static/js/app.js](jobpilot/static/js/app.js) until a bundler is introduced.

---

## 5. Quick reference — commit + close pattern

When you fix issues `#A`, `#B`, `#C` in a single batch:

```pwsh
git add -A
git commit -m "Fix A, B, C: short summary" -m "Closes #A #B #C"
git push origin master
$sha = git rev-parse HEAD
foreach ($n in B, C) {
  gh issue close $n --repo vangipuraputarunsailesh/jobpilot --reason completed --comment "Fixed in $sha."
}
```

(Only the first issue (`#A`) auto-closes from the commit message; the rest need an explicit `gh issue close`.)

That's it. Keep diffs small, attribution honest, and the issues current.
