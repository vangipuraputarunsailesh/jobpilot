"""
routes/resume.py — Resume & AI Blueprint for JobPilot Flask app.
Handles upload, generate, score, tailor, improve, chat, certs, answer, download.
"""
import io
import os
import re
import logging
from pathlib import Path

from flask import Blueprint, request, jsonify, send_file, current_app

from core.ai_engine import (
    score_ats, tailor_resume, improve_line,
    answer_screening_question, apply_chat_instruction,
    suggest_certifications, generate_resume,
)
from core.resume_reader import (
    get_resume_list, save_tailored_docx,
    save_tailored_resume, save_tailored_pdf,
)

resume_bp = Blueprint("resume", __name__)
logger = logging.getLogger("jobpilot")


# Issue #52 — hard cap on uploaded resume size to prevent memory exhaustion
# from oversized PDFs/DOCX. Tunable via env var RESUME_MAX_BYTES.
MAX_RESUME_BYTES = int(os.environ.get("RESUME_MAX_BYTES", str(5 * 1024 * 1024)))  # 5 MB

# Issue #53 — bound the free-text resume description sent to Claude so a
# single request can't drive arbitrary token cost.
MAX_DESCRIPTION_CHARS = int(os.environ.get("RESUME_DESCRIPTION_MAX_CHARS", "8000"))


@resume_bp.post("/api/upload-resume")
def upload_resume():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"detail": "No file provided"}), 400
    ext = Path(f.filename).suffix.lower()
    if ext not in (".pdf", ".docx", ".txt"):
        return jsonify({"detail": "Supported formats: .pdf, .docx, .txt"}), 400
    content = f.read()
    if len(content) > MAX_RESUME_BYTES:
        return jsonify({
            "detail": f"File too large. Max size is {MAX_RESUME_BYTES // (1024 * 1024)} MB."
        }), 413
    text = ""
    if ext == ".txt":
        text = content.decode("utf-8", errors="ignore")
    elif ext == ".docx":
        try:
            from docx import Document
            doc = Document(io.BytesIO(content))
            text = "\n".join(p.text.strip() for p in doc.paragraphs if p.text.strip())
        except Exception as e:
            logger.error(f"DOCX read error: {e}", exc_info=True)
            return jsonify({"detail": "Could not read the .docx file."}), 500
    elif ext == ".pdf":
        try:
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(content))
            text = "\n".join(p.extract_text() or "" for p in reader.pages)
        except Exception as e:
            # Issue #19 — log the underlying error before silently falling
            # back to pdfplumber so failures stay diagnosable.
            logger.warning("pypdf extraction failed (%s); falling back to pdfplumber", e)
        if not text.strip():
            try:
                import pdfplumber
                with pdfplumber.open(io.BytesIO(content)) as pdf:
                    text = "\n".join(p.extract_text() or "" for p in pdf.pages)
            except Exception as e:
                logger.error(f"PDF read error: {e}", exc_info=True)
                return jsonify({"detail": "Could not read the .pdf file."}), 500
    if not text.strip():
        return jsonify({"detail": "Could not extract text. Try a .txt or .docx version."}), 422
    return jsonify({"text": text.strip(), "filename": f.filename})


@resume_bp.post("/api/generate-resume")
def generate_resume_endpoint():
    _usage = current_app.config["USAGE"]
    _usage["claude_calls"] += 1
    data = request.get_json(silent=True) or {}
    description = data.get("description", "").strip()
    if not description:
        return jsonify({"detail": "Description is required"}), 400
    # Issue #53 — bound the description length to control Claude cost/latency.
    if len(description) > MAX_DESCRIPTION_CHARS:
        return jsonify({
            "detail": f"Description too long. Max {MAX_DESCRIPTION_CHARS} characters."
        }), 413
    result = generate_resume(
        user_description=description,
        job_title=data.get("job_title", ""),
        job_description=data.get("job_description", ""),
    )
    if not result:
        return jsonify({"detail": "Resume generation failed — check ANTHROPIC_API_KEY"}), 500
    return jsonify({"resume": result})


@resume_bp.post("/api/score")
def score():
    _usage = current_app.config["USAGE"]
    data = request.get_json(silent=True) or {}
    resume_text = data.get("resume_text", "").strip()
    description = data.get("description", "").strip()
    if not resume_text:
        return jsonify({"detail": "Resume text is required"}), 400
    if not description:
        return jsonify({"detail": "Job description is required"}), 400
    _usage["total_ats_scores"] += 1
    _usage["claude_calls"]     += 1
    logger.info("ATS SCORE | requested")
    try:
        result = score_ats(resume_text, description, compact_mode=not data.get("final_check", False))
        logger.info(f"ATS SCORE | score={result.get('score')} verdict={result.get('verdict')}")
        return jsonify(result)
    except Exception as e:
        logger.error(f"ATS SCORE ERROR | {e}", exc_info=True)
        return jsonify({"detail": "ATS scoring failed. Please try again."}), 500


@resume_bp.post("/api/tailor")
def tailor():
    _usage = current_app.config["USAGE"]
    data = request.get_json(silent=True) or {}
    resume_text = data.get("resume_text", "").strip()
    description = data.get("description", "").strip()
    if not resume_text:
        return jsonify({"detail": "Resume text is required"}), 400
    if not description:
        return jsonify({"detail": "Job description is required"}), 400
    _usage["total_tailors"] += 1
    _usage["claude_calls"]  += 1
    job_title = data.get("job_title", "")
    company   = data.get("company", "")
    logger.info(f"TAILOR | job='{job_title}' company='{company}'")
    try:
        result = tailor_resume(resume_text, description, job_title, company)
        logger.info("TAILOR DONE")
        return jsonify({
            "tailored":    result["resume"],
            "report":      result.get("report", ""),
            "jd_analysis": result.get("jd_analysis", ""),
            "audit":       result.get("audit", ""),
        })
    except Exception as e:
        logger.error(f"TAILOR ERROR | {e}", exc_info=True)
        return jsonify({"detail": "Resume tailoring failed. Please try again."}), 500


@resume_bp.post("/api/improve-line")
def improve():
    _usage = current_app.config["USAGE"]
    data = request.get_json(silent=True) or {}
    line = data.get("line", "")
    if not line:
        return jsonify({"detail": "No line provided"}), 400
    _usage["claude_calls"] += 1
    return jsonify({"improved": improve_line(line, data.get("description", ""), data.get("job_title", ""))})


@resume_bp.post("/api/chat-instruction")
def chat_instruction():
    _usage = current_app.config["USAGE"]
    data = request.get_json(silent=True) or {}
    instruction = data.get("instruction", "").strip()
    resume_text  = data.get("resume_text", "").strip()
    if not instruction:
        return jsonify({"detail": "Instruction required"}), 400
    if not resume_text:
        return jsonify({"detail": "Resume text required"}), 400
    _usage["total_ai_chats"] += 1
    _usage["claude_calls"]   += 1
    version = data.get("version", 1)
    result = apply_chat_instruction(
        instruction=instruction,
        resume_text=resume_text,
        description=data.get("description", ""),
        job_title=data.get("job_title", ""),
        company=data.get("company", ""),
        chat_history=data.get("chat_history", []),
        version=version,
        original_resume=data.get("original_resume", ""),
    )
    return jsonify({
        "updated_resume": result["resume"],
        "explanation":    result["explanation"],
        "resume_changed": result.get("resume_changed", True),
        "version":        result.get("version", version),
    })


@resume_bp.post("/api/suggest-certs")
def suggest_certs():
    _usage = current_app.config["USAGE"]
    data = request.get_json(silent=True) or {}
    _usage["claude_calls"] += 1
    return jsonify(suggest_certifications(
        resume_text=data.get("resume_text", ""),
        description=data.get("description", ""),
        job_title=data.get("job_title", ""),
        company=data.get("company", ""),
    ))


@resume_bp.post("/api/answer")
def answer():
    _usage = current_app.config["USAGE"]
    data = request.get_json(silent=True) or {}
    _usage["claude_calls"] += 1
    return jsonify({"answer": answer_screening_question(
        data.get("question", ""),
        data.get("resume_text", ""),
        data.get("description", ""),
    )})


@resume_bp.post("/api/download")
def download():
    data = request.get_json(silent=True) or {}
    content = data.get("content", "")
    if not content:
        return jsonify({"detail": "No content to download"}), 400
    # Sanitize filename: strip directory components and limit to alphanumeric/dash/underscore
    raw_name  = data.get("filename", "resume")
    safe_stem = re.sub(r"[^A-Za-z0-9_\-]", "_", Path(os.path.basename(raw_name)).stem) or "resume"
    fmt       = data.get("format", "pdf")
    fit_pages = data.get("fit_pages", 0)

    try:
        if fmt == "docx":
            path = save_tailored_docx(safe_stem, content)
            return send_file(
                path,
                mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                as_attachment=True,
                download_name=Path(path).name,
            )
        if fmt == "pdf":
            path = save_tailored_pdf(safe_stem, content, max_pages=fit_pages)
            return send_file(path, mimetype="application/pdf",
                             as_attachment=True, download_name=Path(path).name)
        path = save_tailored_resume(safe_stem, content)
        return send_file(path, mimetype="text/plain",
                         as_attachment=True, download_name=Path(path).name)
    except ValueError:
        return jsonify({"detail": "Invalid filename or download failed."}), 400
