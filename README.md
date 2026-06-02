# JobPilot — AI-Powered Job Application Co-Pilot

> Search real jobs across every major US company, tailor your resume with AI, check your ATS score, and apply — all in one place.

<p align="center">
  <a href="https://www.jobspilot.site">
    <img alt="Live Site" src="https://img.shields.io/badge/Live%20Site-www.jobspilot.site-14b8a6?style=for-the-badge&logo=googlechrome&logoColor=white"/>
  </a>
</p>

<p align="center">
  <strong>🌐 Visit the app:</strong>
  <a href="https://www.jobspilot.site">www.jobspilot.site</a>
</p>

---

## Table of Contents

- [Overview](#overview)
- [Live Links](#live-links)
- [Key Features](#key-features)
- [Application Interface](#application-interface)
- [Workflow — Step by Step](#workflow--step-by-step)
- [Setup (Local Development)](#setup-local-development)
- [Deploying on Railway](#deploying-on-railway)
- [Environment Variables](#environment-variables)
- [Project Structure](#project-structure)
- [API Reference](#api-reference)
- [Branding & Favicon](#branding--favicon)
- [Troubleshooting](#troubleshooting)

---

## Overview

JobPilot is a full-stack AI job application assistant built on **Flask** (Python) with a clean server-rendered single-page frontend (Jinja templates + vanilla JS). It aggregates job listings from multiple platforms in real time, uses **Claude AI (Anthropic)** to tailor your resume to any job description, scores your resume against ATS (Applicant Tracking System) criteria, and lets you apply directly from within the app.

---

## Live Links

| Environment | URL | Status |
|---|---|---|
| **Production** | <https://www.jobspilot.site> | ✅ Live |
| **Landing page** | <https://www.jobspilot.site/> | ✅ Live |
| **Application** | <https://www.jobspilot.site/app> | ✅ Live |
| **API docs** | <https://www.jobspilot.site/docs> | ✅ Live |

---

## Key Features

| Feature | Description |
|---|---|
| **Multi-platform job search** | Searches JSearch (LinkedIn/Indeed/Glassdoor/ZipRecruiter), Adzuna, The Muse, Remotive, Arbeitnow, and USAJobs simultaneously |
| **AI resume tailoring** | Claude AI rewrites your resume to match a specific job description while preserving your authentic voice |
| **ATS scoring** | Instant keyword analysis — see matched/missing skills and an overall fit score |
| **Resume generation** | Generate a complete professional resume from a free-text description of your background |
| **Inline editing** | Edit tailored resumes directly in the browser; AI assists line-by-line on demand |
| **Chat-style instructions** | Natural language commands to refine your resume ("make the summary more concise", "add Python to skills") |
| **PDF & DOCX download** | Export tailored resumes in multiple formats |
| **Auth system** | **Google Sign-In only** (Phase 1 of the BYOK refactor) — JWT-protected API; resumes will move to your own Google Drive `appDataFolder` in Phase 3 |
| **Demo mode** | One-click "Try Demo" button — no sign-up required to explore the app |
| **Usage monitor** | Live API quota tracker for all paid integrations |

---

## Application Interface

### Landing Page

The app opens on a dark-themed marketing landing page (`/`) with a teal/green color palette. The hero section now includes two primary CTAs plus a direct link to the live site:

- **Start for free** — opens the Google Sign-In modal
- **Sign in →** — opens the same Google Sign-In modal
- **Try Demo** — enter the app instantly with a demo account
- **Visit www.jobspilot.site** — the canonical production URL

```
┌──────────────────────────────────────────────────────────────────────────┐
│  🟦 JP  JobPilot                                  Log in   Get started   │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│        Find your next job                                                │
│        faster with AI                                                    │
│                                                                          │
│   [ Start for free → ]   Sign in →   [ ▶ Try Demo ]                      │
│   [ 🌐 Visit www.jobspilot.site ]                                         │
│                                                                          │
│   ✓ Free forever  ·  ✓ No credit card required  ·  ✓ 2-minute setup     │
└──────────────────────────────────────────────────────────────────────────┘
```

### Job Search Dashboard

After authentication, users land on the main application dashboard at `/app` — a 3-column layout with search controls on the left, the live job results in the center, and a contextual detail panel on the right (Job Description / Tailor & Edit / ATS Score tabs).

### Resume Tailoring & ATS Scoring

The AI pipeline (powered by Claude Sonnet) performs:

1. **JD Analysis** — Extracts required skills, experience, seniority signals, and culture keywords
2. **Resume Rewrite** — Rewrites each section using exact keywords from the JD while keeping your real experience intact
3. **ATS Audit** — Scores the tailored resume, listing matched/missing keywords and a numeric fit score
4. **Certification Suggestions** — Recommends certifications that would strengthen your profile

---

## Workflow — Step by Step

1. **Sign in with Google** (or click **Try Demo** for an instant tour).
2. **Search jobs** — pick a title, location, seniority and date range, then toggle which job boards to query.
3. **Review a job** — click any card to open the right panel with the full description.
4. **Tailor your resume** — upload a resume, then click **✨ Tailor with AI**. Refine inline or via the AI chat box.
5. **Check ATS score** — see matched/missing keywords and recommendations.
6. **Download & apply** — export as PDF or DOCX, then click **Apply Now**.
7. **Generate from scratch** *(optional)* — describe your background and let Claude build a fresh resume.

---

## Setup (Local Development)

### Prerequisites

- Python 3.11+
- Git

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/<your-fork>/jobpilot.git
cd jobpilot/jobpilot

# 2. Create and activate a virtual environment
python -m venv venv
source venv/bin/activate       # macOS/Linux
# venv\Scripts\activate        # Windows

# 3. Install Python dependencies
pip install -r requirements.txt

# 4. Configure environment variables
#    Create a .env in the jobpilot/ folder (see Environment Variables below).

# 5. Run the app
python app.py

# 6. Open in browser
#    Landing page: http://localhost:5000/
#    App:          http://localhost:5000/app
```

### Docker (local)

```bash
# From the jobpilot/ folder:
docker build -t jobpilot .
docker run --rm -p 5000:5000 --env-file .env jobpilot
# App available at http://localhost:5000
```

---

## Deploying on Railway

Railway is the recommended cloud platform for JobPilot. The `railway.toml` at the repo root is pre-configured.

### Steps

1. **Fork / push** this repository to your GitHub account.
2. Go to [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo**.
3. Select this repository — Railway auto-detects `railway.toml` and uses `jobpilot/Dockerfile`.
4. In the **Variables** tab add the environment variables listed below.
5. Click **Deploy** — Railway builds the image and starts the service.
6. Railway provides a public HTTPS URL automatically. The production deployment for this project is served at <https://www.jobspilot.site> (the canonical custom domain; CNAME-mapped to the Railway service).

### Known Railway Issues (Already Fixed)

| Issue | Fix Applied |
|---|---|
| `VOLUME` directive banned by Railway | Removed from `jobpilot/Dockerfile` |
| Port binding — app must listen on `$PORT` | `app.py` reads `PORT` from env (fallback 5000) |
| Runtime directories missing on first start | App creates `logs/`, `resumes/`, and `generated/` on demand |

---

## Environment Variables

Configure these in your `.env` file (local) or Railway **Variables** panel (production).

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | ✅ | Google OAuth client ID — the only identity provider after the Phase 1 BYOK refactor. The client-side flow requests `openid email profile` plus `drive.appdata` and `drive.file` scopes (Phase 3 will use those scopes to persist resumes in the user's own Drive). |
| `JWT_SECRET` | ✅ | Secret string for signing JWTs — use a long random value in production |
| `FLASK_SECRET` | ✅ | Flask session secret |
| `ANTHROPIC_API_KEY` | Demo-only | Claude AI key used **only** for requests from the demo account. Real users supply their own via the in-app Settings panel (BYOK, Phase 2). |
| `RAPIDAPI_KEY` | Demo-only | JSearch key used only for demo requests. Real users supply their own (BYOK, Phase 2). |
| `ADZUNA_APP_ID` | Demo-only | Adzuna App ID — demo fallback (BYOK in Phase 2). |
| `ADZUNA_APP_KEY` | Demo-only | Adzuna App Key — demo fallback (BYOK in Phase 2). |
| `GOOGLE_CLIENT_SECRET` | Optional | Kept for tooling/back-compat; not used at runtime (the client-side GIS flow is sufficient). |
| `APIFY_API_TOKEN` | Optional | Apify token for the LinkedIn scraper |
| `USAJOBS_API_KEY` | Optional | US Federal jobs API key — [developer.usajobs.gov](https://developer.usajobs.gov) |
| `USAJOBS_EMAIL` | Optional | Email associated with the USAJobs API key |
| `PORT` | Auto-set | Railway injects this automatically — do not set manually in production |

**Free sources that require no API keys:** The Muse, Remotive, Arbeitnow.

### Enable Google Sign-In

Google is the only identity provider — the app will refuse to render the
sign-in modal without `GOOGLE_CLIENT_ID`. To enable it:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Create an **OAuth 2.0 Client ID** of type *Web application*.
3. Add **Authorized JavaScript origins** for every domain you serve from, e.g.
   `https://www.jobspilot.site` and `http://localhost:5000`.
4. Configure the **OAuth consent screen** with the following scopes:
   - `openid`, `email`, `profile`
   - `https://www.googleapis.com/auth/drive.appdata` (hidden per-app folder)
   - `https://www.googleapis.com/auth/drive.file` (files the user picks or that JobPilot creates)
5. Copy the generated **Client ID** into your environment:
   - Local: `GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com` in `jobpilot/.env`.
   - Railway: add `GOOGLE_CLIENT_ID` under the service's **Variables** tab.
6. Restart the app. The Google button renders on the landing page's auth modal
   and the Drive-scoped `access_token` is fetched immediately after sign-in
   so the resume Drive sync (Phase 3) can store data without a second consent
   prompt.

Append `?debug=1` to the landing URL to render an admin-visible "not configured"
hint when `GOOGLE_CLIENT_ID` is missing — useful when triaging a deploy.

> **Note on removed providers.** Email/password registration and GitHub OAuth
> were removed in Phase 1 of the BYOK refactor. The legacy routes
> (`/api/auth/register`, `/api/auth/login`, `/api/auth/github/*`) no longer
> exist; the `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_REDIRECT_URI`
> environment variables are now ignored and safe to delete from your deploy.

---

## Project Structure

```
<repo root>/
├── jobpilot/                        ← Application root (build context for Docker)
│   ├── app.py                       ← Flask app factory, logging, JWT guard, server bootstrap
│   ├── Dockerfile                   ← Production container image
│   ├── requirements.txt             ← Python dependencies
│   ├── core/                        ← Business logic
│   │   ├── ai_engine.py             ← Claude AI: ATS scoring, tailoring, chat, generation
│   │   ├── auth_db.py               ← JWT, bcrypt, SQLite user store
│   │   ├── job_scraper.py           ← Multi-platform job search aggregator
│   │   ├── resume_reader.py         ← Resume file reader and export (.docx/.pdf/.txt)
│   │   ├── resume_normalizer.py     ← Normalises resume section headings
│   │   └── resume_templates.py      ← DOCX and PDF resume template builder
│   ├── routes/                      ← Flask blueprints
│   │   ├── auth.py                  ← /api/auth/* (register, login, Google OAuth, demo)
│   │   ├── jobs.py                  ← /api/jobs, /api/jd, /api/score, /api/usage, ...
│   │   └── resume.py                ← /api/upload-resume, /api/tailor, /api/download, ...
│   ├── templates/                   ← Jinja2 templates
│   │   ├── base.html                ← Shared <head>, fonts, favicon, scripts
│   │   ├── landing.html             ← Marketing landing page  (route: /)
│   │   └── index.html               ← Main application UI     (route: /app)
│   └── static/
│       ├── favicon.svg              ← JP-monogram favicon (teal gradient)
│       ├── css/style.css            ← All application styles + theme tokens
│       └── js/app.js                ← All frontend logic (vanilla JS)
├── railway.toml                     ← Railway deployment configuration
└── README.md                        ← This file
```

---

## API Reference

The full interactive API documentation is available at `/docs` when the app is running.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth/register` | Register with email/password |
| `POST` | `/api/auth/login` | Log in with email/password |
| `POST` | `/api/auth/google` | Sign in with Google OAuth credential |
| `GET`  | `/api/auth/github/start` | Redirect to GitHub OAuth authorize URL |
| `GET`  | `/api/auth/github/callback` | Handle GitHub OAuth callback and mint a JWT |
| `POST` | `/api/auth/demo` | Issue a demo-mode JWT (no sign-up) |
| `GET`  | `/api/health` | Health check — shows API key status and resume count |
| `GET`  | `/api/usage` | API quota usage counters |
| `POST` | `/api/jobs` | Search jobs across all platforms |
| `POST` | `/api/jd` | Fetch job description from URL or pass raw text |
| `POST` | `/api/upload-resume` | Upload a resume file (.pdf, .docx, .txt) and extract text |
| `POST` | `/api/generate-resume` | Generate a full resume from a free-text description |
| `POST` | `/api/score` | Score a resume against a job description (ATS check) |
| `POST` | `/api/tailor` | AI-tailor a resume for a specific job |
| `POST` | `/api/improve-line` | AI-improve a single resume bullet point |
| `POST` | `/api/chat-instruction` | Apply a natural language instruction to the resume |
| `POST` | `/api/suggest-certs` | Suggest certifications for a given role |
| `POST` | `/api/answer` | Answer a screening question using resume + JD context |
| `POST` | `/api/download` | Download the resume as PDF, DOCX, or plain text |

All `/api/*` endpoints (except `/api/auth/*` and `/api/health`) require an `Authorization: Bearer <token>` header.

---

## Branding & Favicon

JobPilot ships with a built-in **JP monogram favicon** rendered as scalable SVG so it stays crisp at any DPI.

- File: [jobpilot/static/favicon.svg](jobpilot/static/favicon.svg)
- Style: white **JP** wordmark on a teal gradient (`#14b8a6 → #0d9488`) with a 14px rounded square
- Wired up in [jobpilot/templates/base.html](jobpilot/templates/base.html) via:

```html
<link rel="icon" type="image/svg+xml" href="/static/favicon.svg"/>
<link rel="apple-touch-icon" href="/static/favicon.svg"/>
<meta name="theme-color" content="#0d9488"/>
```

To customise the brand mark, edit the `<text>` element inside `favicon.svg` (or swap the gradient `<stop>` colors to match a new theme).

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `ANTHROPIC_API_KEY not set` | Add your Anthropic key to `.env` or Railway Variables |
| No jobs returned | Some platforms occasionally time out — try again, or check that `RAPIDAPI_KEY` and `ADZUNA_APP_ID`/`ADZUNA_APP_KEY` are set |
| `401 Not authenticated` | Your JWT has expired — log out and log in again |
| PDF download fails | Ensure `weasyprint` and its system dependencies are installed (handled automatically in Docker) |
| DOCX download fails | Ensure `python-docx` is installed: `pip install python-docx` |
| Port 5000 in use locally | Set `PORT=5001` in your `.env` before running `python app.py` |
| Google Sign-In not working | Verify `GOOGLE_CLIENT_ID` is set and the OAuth consent screen is configured at [console.cloud.google.com](https://console.cloud.google.com) |
| GitHub Sign-In not working | Verify both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set and the OAuth App's **Authorization callback URL** matches `<your-host>/api/auth/github/callback` exactly |
| Railway deploy fails | Check the Railway build logs; ensure all required env vars are set in the Variables tab |
| Jobs show datacenter block | Some platforms (LinkedIn) block datacenter IPs — use Apify (`APIFY_API_TOKEN`) for better LinkedIn coverage |
| Favicon not updating | Hard-refresh the browser (`Ctrl+Shift+R` / `Cmd+Shift+R`) — browsers cache favicons aggressively |
