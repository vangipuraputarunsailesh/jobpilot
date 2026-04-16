"""
app.py  —  JobPilot FastAPI backend (Enterprise Edition)
Run:  uvicorn app:app --reload --port 5000
Docs: http://localhost:5000/docs
"""

import os
import io
from pathlib import Path
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

from job_scraper   import search_all_platforms, fetch_job_description, _source_count

# ── API usage counters (in-memory, resets on server restart) ──────────────────
_usage = {
    "jsearch_requests":   0,   # 5 per search, free tier = 200/month
    "adzuna_requests":    0,   # 4 per search, free tier = 250/day
    "claude_calls":       0,   # each tailor/score/chat/generate = 1 call
    "total_searches":     0,
    "total_tailors":      0,
    "total_ats_scores":   0,
    "total_ai_chats":     0,
}
from ai_engine     import (
    score_ats, tailor_resume, improve_line,
    answer_screening_question, apply_chat_instruction,
    suggest_certifications, generate_resume,
)
from resume_reader import (
    get_resume_list, read_resume,
    save_tailored_docx, save_tailored_resume, save_tailored_pdf,
)

app = FastAPI(
    title="JobPilot API",
    description="Enterprise AI job applicator — search across all US companies, tailor, score, apply",
    version="3.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


# ── Pydantic models ────────────────────────────────────────────────────────────

class JobSearchRequest(BaseModel):
    title:     str
    location:  str = "United States"
    seniority: str = "any"   # any | entry | mid | senior | lead

class JDRequest(BaseModel):
    url:         str = ""
    description: str = ""

class ScoreRequest(BaseModel):
    resume_text: str
    description: str

class TailorRequest(BaseModel):
    resume_text: str
    description: str
    job_title:   str = ""
    company:     str = ""

class ImproveLineRequest(BaseModel):
    line:        str
    description: str = ""
    job_title:   str = ""

class ChatInstructionRequest(BaseModel):
    instruction:   str
    resume_text:   str
    description:   str = ""
    job_title:     str = ""
    company:       str = ""
    chat_history:  list = []

class AnswerRequest(BaseModel):
    question:    str
    resume_text: str
    description: str = ""

class DownloadRequest(BaseModel):
    content:   str
    filename:  str = "resume"
    format:    str = "pdf"
    fit_pages: int = 0

class CertRequest(BaseModel):
    resume_text: str
    description: str
    job_title:   str = ""
    company:     str = ""

class GenerateResumeRequest(BaseModel):
    description:     str          # free-text user description of themselves
    job_title:       str = ""
    job_description: str = ""


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(str(Path(__file__).parent / "static" / "index.html"))


@app.get("/api/health")
async def health():
    key_set  = bool(os.environ.get("ANTHROPIC_API_KEY"))
    jsearch  = bool(os.environ.get("RAPIDAPI_KEY"))
    adzuna   = bool(os.environ.get("ADZUNA_APP_ID")) and bool(os.environ.get("ADZUNA_APP_KEY"))
    usajobs  = bool(os.environ.get("USAJOBS_API_KEY"))
    resumes  = get_resume_list()
    return {
        "status":       "ok",
        "api_key_set":  key_set,
        "resume_count": len(resumes),
        "resumes":      [r["name"] for r in resumes],
        "sources": {
            "jsearch":  jsearch,
            "adzuna":   adzuna,
            "themuse":  True,
            "remotive": True,
            "usajobs":  usajobs,
            "arbeitnow":True,
        },
    }


@app.get("/api/usage")
async def get_usage():
    """Current API usage counters since last server start."""
    jsearch_key = bool(os.environ.get("RAPIDAPI_KEY"))
    adzuna_key  = bool(os.environ.get("ADZUNA_APP_ID"))
    js_used     = _usage["jsearch_requests"]
    az_used     = _usage["adzuna_requests"]
    return {
        "usage":  _usage,
        "limits": {
            "jsearch": {
                "used":          js_used,
                "monthly_limit": 200 if jsearch_key else 0,
                "remaining":     max(0, 200 - js_used) if jsearch_key else 0,
                "searches_left": max(0, (200 - js_used) // 5) if jsearch_key else 0,
            },
            "adzuna": {
                "used":          az_used,
                "daily_limit":   250 if adzuna_key else 0,
                "remaining":     max(0, 250 - az_used) if adzuna_key else 0,
                "searches_left": max(0, (250 - az_used) // 4) if adzuna_key else 0,
            },
        },
        "note": "Counters reset on server restart. JSearch: 200 req/month free. Adzuna: 250 req/day free.",
    }


@app.post("/api/jobs")
async def search_jobs(req: JobSearchRequest):
    if not req.title.strip():
        raise HTTPException(400, "Job title is required")
    _usage["total_searches"]   += 1
    _usage["jsearch_requests"] += 5   # 5 pages per search
    _usage["adzuna_requests"]  += 4   # 4 pages per search
    jobs = search_all_platforms(req.title.strip(), req.location.strip() or "United States", req.seniority or "any")
    sources = list({j["source"] for j in jobs})
    return {
        "jobs":     jobs,
        "count":    len(jobs),
        "sources":  sources,
        "title":    req.title,
        "location": req.location,
    }


@app.post("/api/jd")
async def get_jd(req: JDRequest):
    jd = req.description
    if not jd and req.url:
        jd = fetch_job_description(req.url)
    return {"description": jd}


@app.post("/api/upload-resume")
async def upload_resume(file: UploadFile = File(...)):
    """
    Upload a resume file (.pdf, .docx, .txt) and extract its text.
    Returns the raw text — no file is saved to disk.
    The frontend uses this text directly for tailoring.
    """
    if not file.filename:
        raise HTTPException(400, "No file provided")

    ext = Path(file.filename).suffix.lower()
    if ext not in (".pdf", ".docx", ".txt"):
        raise HTTPException(400, "Supported formats: .pdf, .docx, .txt")

    content = await file.read()
    text = ""

    if ext == ".txt":
        text = content.decode("utf-8", errors="ignore")

    elif ext == ".docx":
        try:
            from docx import Document
            doc = Document(io.BytesIO(content))
            text = "\n".join(p.text.strip() for p in doc.paragraphs if p.text.strip())
        except Exception as e:
            raise HTTPException(500, f"Could not read .docx: {e}")

    elif ext == ".pdf":
        # Try pypdf first, then pdfplumber as fallback
        try:
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(content))
            text = "\n".join(p.extract_text() or "" for p in reader.pages)
        except Exception:
            pass
        if not text.strip():
            try:
                import pdfplumber
                with pdfplumber.open(io.BytesIO(content)) as pdf:
                    text = "\n".join(p.extract_text() or "" for p in pdf.pages)
            except Exception as e:
                raise HTTPException(500, f"Could not read .pdf: {e}")

    if not text.strip():
        raise HTTPException(422, "Could not extract text from the uploaded file. Try a .txt or .docx version.")

    return {"text": text.strip(), "filename": file.filename}


@app.post("/api/generate-resume")
async def generate_resume_endpoint(req: GenerateResumeRequest):
    _usage["claude_calls"] += 1
    """
    Generate a complete professional resume from a free-text description.
    The user describes their background conversationally — Claude builds the resume.
    """
    if not req.description.strip():
        raise HTTPException(400, "Description is required")
    result = generate_resume(
        user_description=req.description,
        job_title=req.job_title,
        job_description=req.job_description,
    )
    if not result:
        raise HTTPException(500, "Resume generation failed — check ANTHROPIC_API_KEY")
    return {"resume": result}


@app.post("/api/score")
async def score(req: ScoreRequest):
    if not req.resume_text.strip():
        raise HTTPException(400, "Resume text is required")
    if not req.description.strip():
        raise HTTPException(400, "Job description is required")
    _usage["total_ats_scores"] += 1
    _usage["claude_calls"]     += 1
    return score_ats(req.resume_text, req.description)


@app.post("/api/tailor")
async def tailor(req: TailorRequest):
    if not req.resume_text.strip():
        raise HTTPException(400, "Resume text is required")
    if not req.description.strip():
        raise HTTPException(400, "Job description is required")
    _usage["total_tailors"] += 1
    _usage["claude_calls"]  += 1
    tailored = tailor_resume(req.resume_text, req.description, req.job_title, req.company)
    return {"tailored": tailored}


@app.post("/api/improve-line")
async def improve(req: ImproveLineRequest):
    if not req.line:
        raise HTTPException(400, "No line provided")
    return {"improved": improve_line(req.line, req.description, req.job_title)}


@app.post("/api/chat-instruction")
async def chat_instruction(req: ChatInstructionRequest):
    _usage["total_ai_chats"] += 1
    _usage["claude_calls"]   += 1
    """
    Apply ANY natural language instruction to the resume.
    Works like chatting with Claude — completely open-ended.
    """
    if not req.instruction.strip():
        raise HTTPException(400, "Instruction required")
    if not req.resume_text.strip():
        raise HTTPException(400, "Resume text required")
    result = apply_chat_instruction(
        instruction=req.instruction,
        resume_text=req.resume_text,
        description=req.description,
        job_title=req.job_title,
        company=req.company,
        chat_history=req.chat_history,
    )
    return {
        "updated_resume":  result["resume"],
        "explanation":     result["explanation"],
        "resume_changed":  result.get("resume_changed", True),
    }


@app.post("/api/suggest-certs")
async def suggest_certs(req: CertRequest):
    return suggest_certifications(
        resume_text=req.resume_text,
        description=req.description,
        job_title=req.job_title,
        company=req.company,
    )


@app.post("/api/answer")
async def answer(req: AnswerRequest):
    return {"answer": answer_screening_question(req.question, req.resume_text, req.description)}


@app.post("/api/download")
async def download(req: DownloadRequest):
    if not req.content:
        raise HTTPException(400, "No content to download")
    if req.format == "docx":
        path = save_tailored_docx(req.filename, req.content)
        return FileResponse(
            path,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            filename=Path(path).name,
        )
    if req.format == "pdf":
        path = save_tailored_pdf(req.filename, req.content, max_pages=req.fit_pages)
        return FileResponse(path, media_type="application/pdf", filename=Path(path).name)
    path = save_tailored_resume(req.filename, req.content)
    return FileResponse(path, media_type="text/plain", filename=Path(path).name)


# ── Entry point ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    print("\n" + "=" * 60)
    print("  JobPilot — Enterprise AI Job Applicator  v3.0")
    print("=" * 60)
    print(f"  Claude API key : {'✓ set' if os.environ.get('ANTHROPIC_API_KEY') else '✗ MISSING'}")
    print(f"  JSearch key    : {'✓ set' if os.environ.get('RAPIDAPI_KEY') else '✗ not set (add to .env)'}")
    print(f"  Adzuna keys    : {'✓ set' if os.environ.get('ADZUNA_APP_ID') else '✗ not set (add to .env)'}")
    print(f"  Free sources   : The Muse, Remotive, Arbeitnow  ✓ always on")
    print(f"  USAJobs key    : {'✓ set' if os.environ.get('USAJOBS_API_KEY') else '○ optional'}")
    print(f"  Resumes        : {len(get_resume_list())} file(s) in resumes/ folder")
    print(f"  App URL        : http://localhost:5000")
    print(f"  API docs       : http://localhost:5000/docs")
    print("=" * 60 + "\n")
    uvicorn.run("app:app", host="0.0.0.0", port=5000, reload=True)
