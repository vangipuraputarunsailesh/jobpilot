# JobPilot — AI-Powered Job Application Co-Pilot

> Search real jobs posted across every major US company, tailor your resume with AI, check your ATS score, and apply — all in one place.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/)

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Application Interface](#application-interface)
  - [Landing Page](#landing-page)
  - [Job Search Dashboard](#job-search-dashboard)
  - [Job Detail Panel](#job-detail-panel)
  - [Resume Tailoring & ATS Scoring](#resume-tailoring--ats-scoring)
- [Workflow — Step by Step](#workflow--step-by-step)
- [Setup (Local Development)](#setup-local-development)
- [Deploying on Railway](#deploying-on-railway)
- [Environment Variables](#environment-variables)
- [Project Structure](#project-structure)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)

---

## Overview

JobPilot is a full-stack AI job application assistant built on **FastAPI** (Python) with a clean single-page frontend. It aggregates job listings from multiple platforms in real time, uses **Claude AI (Anthropic)** to tailor your resume to any job description, scores your resume against ATS (Applicant Tracking System) criteria, and lets you apply directly from within the app.

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
| **Auth system** | Email/password and Google OAuth sign-in; JWT-protected API |
| **Usage monitor** | Live API quota tracker for all paid integrations |

---

## Application Interface

### Landing Page

The app opens on a dark-themed marketing landing page (`/`) with a teal/green color palette.

```
┌──────────────────────────────────────────────────────────────────┐
│  🧭 JobPilot       Features  How It Works  Pricing      Sign In │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│        Your AI Co-Pilot for                                      │
│        Career Success                                            │
│                                                                  │
│   ┌─────────────────────────────────┐                           │
│   │  Job title, skills, or company  │   [Find Jobs Now →]       │
│   └─────────────────────────────────┘                           │
│                                                                  │
│   Popular: Software Engineer  Data Engineer  Product Manager    │
│                                                                  │
│   Trusted sources: LinkedIn · Indeed · Glassdoor · ZipRecruiter │
│                    Adzuna · The Muse · Remotive · Arbeitnow      │
└──────────────────────────────────────────────────────────────────┘
```

Clicking **Find Jobs Now** or any role chip passes the search query to the main app (`/app`) via `sessionStorage` so the search auto-triggers after sign-in.

---

### Job Search Dashboard

After authentication, users land on the main application dashboard (`/app`).

```
┌─ Top Bar ─────────────────────────────────────────────────────────────────────┐
│  🧭 JobPilot  Enterprise AI · Real jobs from every US company                 │
│                               Theme ▼   ● Live · Last 24h   ● user@email.com │
└───────────────────────────────────────────────────────────────────────────────┘

┌─ Left Sidebar (Search Controls) ──┐  ┌─ Job Cards List ──────────────────────┐
│                                   │  │                                        │
│  Job Title                        │  │  ┌─ Job Card ─────────────────────┐   │
│  ┌─────────────────────────────┐  │  │  │ Software Engineer              │   │
│  │ Software Engineer         ▼ │  │  │  │ Google · Mountain View, CA     │   │
│  └─────────────────────────────┘  │  │  │ ● JSearch  · $150k–$200k      │   │
│                                   │  │  │ Posted: 3 hours ago            │   │
│  Location                         │  │  └────────────────────────────────┘   │
│  ┌─────────────────────────────┐  │  │                                        │
│  │ United States             ▼ │  │  │  ┌─ Job Card ─────────────────────┐   │
│  └─────────────────────────────┘  │  │  │ Senior Data Engineer            │   │
│                                   │  │  │ Amazon · Seattle, WA            │   │
│  Seniority:  [Any ▼]              │  │  │ ● Adzuna  · $130k–$170k        │   │
│  Posted:     [Past Week ▼]        │  │  │ Posted: 1 day ago               │   │
│                                   │  │  └────────────────────────────────┘   │
│  Platforms                        │  │                                        │
│  ☑ JSearch    ☑ Adzuna            │  │  ... more cards ...                   │
│  ☑ The Muse   ☑ Remotive          │  │                                        │
│  ☑ Arbeitnow  ☑ USAJobs           │  └────────────────────────────────────────┘
│                                   │
│  [ Find Jobs Now ]                │  ┌─ Right Detail Panel ──────────────────┐
│                                   │  │  (opens when a job card is clicked)   │
│  ── Resume ──────────────────     │  │  [ Job Description ] [ Tailor ] [ATS] │
│  Upload or select a resume file   │  └────────────────────────────────────────┘
└───────────────────────────────────┘
```

---

### Job Detail Panel

Clicking any job card opens the right-side detail panel with three tabs:

**Tab 1 — Job Description**
```
┌─ Right Panel ──────────────────────────────────────────────────────────────┐
│  Senior Software Engineer @ Google                                          │
│  Mountain View, CA · Full-time · $150,000 – $200,000                       │
│  ─────────────────────────────────────────────────────────────────────     │
│  [Job Description]  [Tailor & Edit]  [ATS Score]                           │
│  ─────────────────────────────────────────────────────────────────────     │
│  About the role:                                                            │
│  We are looking for a Senior Software Engineer to join our team...          │
│                                                                             │
│  Requirements:                                                              │
│  • 5+ years of experience with Python, Go, or Java                         │
│  • Experience with distributed systems...                                   │
│                                                                             │
│                              [Apply Now →]   (opens job page in new tab)   │
└────────────────────────────────────────────────────────────────────────────┘
```

**Tab 2 — Tailor & Edit**
```
┌─ Right Panel ──────────────────────────────────────────────────────────────┐
│  [Job Description]  [Tailor & Edit ●]  [ATS Score]                         │
│  ─────────────────────────────────────────────────────────────────────     │
│  Resume:  [ my_resume.pdf ▼ ]   or  [ Upload Resume ]                      │
│                                                                             │
│  [ ✨ Tailor with AI ]                                                      │
│                                                                             │
│  ── Tailored Resume (editable) ─────────────────────────────────────────   │
│  JOHN DOE                                                                   │
│  Senior Software Engineer | john@email.com | github.com/johndoe             │
│                                                                             │
│  SUMMARY                                                                    │
│  Results-driven engineer with 6 years of Python and distributed systems... │
│  [✏ improve this line]                                                     │
│                                                                             │
│  ── AI Chat ────────────────────────────────────────────────────────────   │
│  💬  "make the summary shorter"                        [ Send ]            │
│                                                                             │
│  [ Download PDF ]   [ Download DOCX ]                                      │
└────────────────────────────────────────────────────────────────────────────┘
```

**Tab 3 — ATS Score**
```
┌─ Right Panel ──────────────────────────────────────────────────────────────┐
│  [Job Description]  [Tailor & Edit]  [ATS Score ●]                         │
│  ─────────────────────────────────────────────────────────────────────     │
│                  ATS Score: 87 / 100  ✅ Strong Match                       │
│                                                                             │
│  ✅ Matched Keywords:                                                        │
│     Python, distributed systems, microservices, CI/CD, AWS, Kubernetes     │
│                                                                             │
│  ⚠️  Missing Keywords:                                                       │
│     Go, gRPC, Spanner                                                       │
│                                                                             │
│  📋 Recommendations:                                                         │
│     • Mention your experience with gRPC-style APIs                         │
│     • Add a line about database experience (Spanner or similar)            │
│                                                                             │
│  [ Apply Now → ]                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

### Resume Tailoring & ATS Scoring

The AI pipeline (powered by Claude Sonnet) performs:

1. **JD Analysis** — Extracts required skills, experience, seniority signals, and company culture keywords from the job description
2. **Resume Rewrite** — Rewrites each section of your resume to use exact keywords from the JD while keeping your real experience intact
3. **ATS Audit** — Scores the tailored resume against the JD, listing matched/missing keywords and a numeric fit score
4. **Certification Suggestions** — Recommends certifications that would strengthen your profile for this specific role

---

## Workflow — Step by Step

### 1. Sign Up or Log In

- Visit the app URL and click **Sign In** or **Get Started**
- Register with email/password, or use **Continue with Google**
- On successful auth, you're redirected to the job search dashboard

### 2. Search for Jobs

1. Type a job title in the **Job Title** field (e.g., `Data Engineer`, `Product Manager`)
2. Optionally set your **Location** (defaults to `United States`)
3. Select **Seniority** (Any / Entry / Mid / Senior / Lead)
4. Select **Date Posted** (Past 24 Hours / Past Week / Past Month)
5. Toggle individual **Platforms** on/off to narrow results
6. Click **Find Jobs Now**
7. Results appear as cards in the center panel, showing title, company, location, salary, source, and posting date

### 3. Review a Job

- Click any **job card** to open the right panel
- The **Job Description** tab shows the full JD fetched live from the source
- Click **Apply Now** to open the original job page in a new tab (no tailoring needed)

### 4. Tailor Your Resume

1. Switch to the **Tailor & Edit** tab
2. Select or upload your resume from the sidebar
3. Click **✨ Tailor with AI**
4. Wait ~10–15 seconds while Claude analyzes the JD and rewrites your resume
5. The tailored resume appears in an inline editor
6. Hover over any bullet point and click **✏ improve this line** for AI-assisted micro-edits
7. Use the **AI Chat** box for natural language instructions: `"add a bullet about Docker to my experience"`, `"make the summary more concise"`, `"revert to original"`

### 5. Check ATS Score

1. Switch to the **ATS Score** tab
2. The score is calculated automatically after tailoring
3. Review **Matched Keywords**, **Missing Keywords**, and **Recommendations**
4. Return to Tailor & Edit to address missing keywords if needed
5. Re-score to see improvement

### 6. Download & Apply

1. Click **Download PDF** or **Download DOCX** to save your tailored resume
2. Click **Apply Now** to open the job application page
3. Upload your downloaded resume and submit your application

### 7. Generate a Resume from Scratch (Optional)

- No resume on hand? Click **Generate Resume** in the sidebar
- Describe your background in plain language: `"I'm a data engineer with 4 years of experience at a fintech startup, skilled in Spark, Kafka, Python, and AWS"`
- Claude builds a complete, formatted professional resume in seconds

---

## Setup (Local Development)

### Prerequisites

- Python 3.11+
- Git

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/vangipuraputarunsailesh/jobpilot.git
cd jobpilot/jobpilot

# 2. Create and activate a virtual environment
python -m venv venv
source venv/bin/activate       # Mac/Linux
# venv\Scripts\activate        # Windows

# 3. Install Python dependencies
pip install -r requirements.txt

# 4. Configure environment variables
#    Copy .env and fill in your API keys (see Environment Variables section)
#    The file already has placeholders — replace them with your real keys.

# 5. Run the app
python app.py

# 6. Open in browser
#    Landing page: http://localhost:5000
#    App:          http://localhost:5000/app
#    API docs:     http://localhost:5000/docs
```

### Docker (local)

```bash
# From the repo root:
docker compose up --build
# App available at http://localhost:5000
```

---

## Deploying on Railway

Railway is the recommended cloud platform for JobPilot. The `railway.toml` at the repo root is pre-configured.

### Steps

1. **Fork / push** this repository to your GitHub account
2. Go to [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo**
3. Select this repository
4. Railway auto-detects `railway.toml` and uses `jobpilot/Dockerfile` for builds
5. In the **Variables** tab, add the environment variables listed below
6. Click **Deploy** — Railway builds the Docker image and starts the service
7. Railway provides a public HTTPS URL automatically (e.g., `https://jobpilot-production.up.railway.app`)

### Known Railway Issues (Already Fixed)

| Issue | Fix Applied |
|---|---|
| `VOLUME` directive banned by Railway | Removed from `jobpilot/Dockerfile` in PR #6 |
| Port binding — app must listen on `$PORT` | `app.py` reads `PORT` from env (fallback: 5000) |
| Runtime directories missing on first start | `app.py` and `resume_reader.py` create directories on demand |

---

## Environment Variables

Configure these in your `.env` file (local) or Railway **Variables** panel (production).

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ Required | Claude AI key — get one at [console.anthropic.com](https://console.anthropic.com) |
| `JWT_SECRET` | ✅ Required | Secret string for signing JWTs — use a long random value in production |
| `RAPIDAPI_KEY` | Recommended | JSearch key (aggregates LinkedIn, Indeed, Glassdoor) — [rapidapi.com](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch) |
| `ADZUNA_APP_ID` | Recommended | Adzuna App ID — [developer.adzuna.com](https://developer.adzuna.com) |
| `ADZUNA_APP_KEY` | Recommended | Adzuna App Key |
| `GOOGLE_CLIENT_ID` | Optional | Google OAuth client ID for "Sign in with Google" |
| `GOOGLE_CLIENT_SECRET` | Optional | Google OAuth client secret |
| `APIFY_API_TOKEN` | Optional | Apify token for LinkedIn scraper |
| `USAJOBS_API_KEY` | Optional | US Federal jobs API key — [developer.usajobs.gov](https://developer.usajobs.gov) |
| `USAJOBS_EMAIL` | Optional | Email associated with USAJobs API key |
| `PORT` | Auto-set | Railway injects this automatically — do not set manually |

**Free sources that require no API keys:** The Muse, Remotive, Arbeitnow — these are always active.

---

## Project Structure

```
jobpilot/                        ← Application root (build context for Docker)
├── app.py                       ← FastAPI backend — all routes and startup logic
├── ai_engine.py                 ← Claude AI: ATS scoring, resume tailoring, chat, generation
├── job_scraper.py               ← Multi-platform job search aggregator
├── resume_reader.py             ← Resume file reader and export (.docx, .pdf, .txt)
├── resume_normalizer.py         ← Normalises resume section headings
├── resume_templates.py          ← DOCX and PDF resume template builder
├── auth.py                      ← JWT auth, bcrypt password hashing, SQLite user store
├── requirements.txt             ← Python dependencies
├── Dockerfile                   ← Docker build definition
├── .dockerignore                ← Files excluded from Docker build context
├── .env                         ← Local secrets (never commit with real values)
├── resumes/                     ← Place resume files here for local development
├── generated/                   ← Tailored resumes saved here after download
├── logs/                        ← Rotating application logs
└── static/
    ├── landing.html             ← Marketing landing page (served at /)
    ├── index.html               ← Main application UI (served at /app)
    ├── css/
    │   └── style.css            ← All application styles + theme tokens
    └── js/
        └── app.js               ← All frontend logic (vanilla JS)

src/
└── README.md                    ← This file

railway.toml                     ← Railway deployment configuration
docker-compose.yml               ← Local Docker Compose setup
```

---

## API Reference

The full interactive API documentation is available at `/docs` (Swagger UI) when the app is running.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth/register` | Register with email/password |
| `POST` | `/api/auth/login` | Log in with email/password |
| `POST` | `/api/auth/google` | Sign in with Google OAuth credential |
| `GET` | `/api/health` | Health check — shows API key status and resume count |
| `GET` | `/api/usage` | API quota usage counters |
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

All `/api/*` endpoints (except `/api/auth/*` and `/api/health`) require a `Authorization: Bearer <token>` header.

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
| Railway deploy fails | Check the Railway build logs in the Railway dashboard; ensure all required env vars are set in the Variables tab |
| Jobs show datacenter block | Some platforms (LinkedIn) block datacenter IPs — use Apify (`APIFY_API_TOKEN`) for better LinkedIn coverage |
