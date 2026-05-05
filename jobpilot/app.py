"""
app.py — JobPilot Flask Backend (v4.0)
Run: python app.py
"""
import os
import time
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

import jwt as pyjwt
from flask import Flask, render_template, jsonify, request, g
from flask_cors import CORS
from dotenv import load_dotenv

# NOTE: load_dotenv is the single, authoritative env loader for the app.
# Submodules (e.g. core/ai_engine.py) MUST NOT call load_dotenv themselves
# (Issue #10). This call is intentionally first so all subsequent imports
# can rely on os.environ being populated.
load_dotenv(override=True)

# Imported at module scope (Issue #5) — was previously imported per-request
# inside the auth guard.
from core.auth_db import decode_token  # noqa: E402

# ── In-memory usage counters (reset on restart) ────────────────────────────────
_USAGE = {
    "jsearch_requests":  0,
    "adzuna_requests":   0,
    "claude_calls":      0,
    "total_searches":    0,
    "total_tailors":     0,
    "total_ats_scores":  0,
    "total_ai_chats":    0,
}

_PUBLIC_PATHS = {"/", "/app", "/api/auth/login", "/api/auth/register",
                 "/api/auth/google", "/api/auth/demo", "/api/health"}


def create_app() -> Flask:
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.secret_key = os.environ.get("FLASK_SECRET", "jobpilot-flask-secret")
    app.config["USAGE"] = _USAGE

    CORS(app)

    # ── Logging ───────────────────────────────────────────────────────────────
    _log_dir = Path(__file__).parent / "logs"
    _log_dir.mkdir(exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=[
            RotatingFileHandler(
                _log_dir / "jobpilot.log",
                maxBytes=5 * 1024 * 1024,
                backupCount=5,
                encoding="utf-8",
            ),
            logging.StreamHandler(),
        ],
    )

    @app.before_request
    def _start_timer():
        g.start = time.time()

    @app.after_request
    def _log_request(response):
        ms = (time.time() - g.start) * 1000
        logging.getLogger("jobpilot").info(
            f"{request.method} {request.path} -> {response.status_code} ({ms:.0f}ms)"
        )
        return response

    # ── JWT auth guard ────────────────────────────────────────────────────────
    @app.before_request
    def _auth_guard():
        path = request.path
        if path in _PUBLIC_PATHS or path.startswith("/static"):
            return None
        if path.startswith("/api/"):
            auth_header = request.headers.get("Authorization", "")
            token = auth_header.removeprefix("Bearer ").strip()
            if not token:
                return jsonify({"detail": "Not authenticated"}), 401
            try:
                decode_token(token)
            except pyjwt.PyJWTError:
                return jsonify({"detail": "Invalid or expired token"}), 401
        return None

    # ── Register blueprints ───────────────────────────────────────────────────
    from routes.auth   import auth_bp
    from routes.jobs   import jobs_bp
    from routes.resume import resume_bp
    app.register_blueprint(auth_bp)
    app.register_blueprint(jobs_bp)
    app.register_blueprint(resume_bp)

    from core.auth_db import init_db
    init_db()

    # Surface common misconfigurations once at startup (Issue #80).
    if not os.environ.get("GOOGLE_CLIENT_ID"):
        logging.getLogger("jobpilot").warning(
            "GOOGLE_CLIENT_ID is not set; Google Sign-In is disabled. "
            "Set it in .env / Railway env to enable the button."
        )

    @app.get("/")
    def landing():
        return render_template("landing.html",
                               google_client_id=os.environ.get("GOOGLE_CLIENT_ID", ""))

    @app.get("/app")
    def index():
        return render_template("index.html")

    @app.get("/terms")
    def terms_page():
        # Minimal placeholder so footer/auth links resolve. Replace body
        # with the real legal copy before public launch.
        return ("<!doctype html><meta charset='utf-8'><title>Terms \u2014 JobPilot</title>"
                "<body style='font-family:Inter,system-ui;max-width:680px;margin:48px auto;padding:0 20px;color:#222'>"
                "<h1>Terms of Service</h1>"
                "<p>JobPilot is currently in private beta. Final Terms of Service will be published prior to general availability. "
                "By using JobPilot you agree to use it for lawful job-search purposes only.</p>"
                "<p><a href='/'>\u2190 Back to JobPilot</a></p></body>")

    @app.get("/privacy")
    def privacy_page():
        return ("<!doctype html><meta charset='utf-8'><title>Privacy Policy \u2014 JobPilot</title>"
                "<body style='font-family:Inter,system-ui;max-width:680px;margin:48px auto;padding:0 20px;color:#222'>"
                "<h1>Privacy Policy</h1>"
                "<p>JobPilot stores only the email address you sign in with and the resumes you upload. "
                "Resumes are processed by Anthropic Claude for tailoring/scoring; no resume content is sold "
                "or shared with third parties. The full privacy notice will be published prior to general availability.</p>"
                "<p><a href='/'>\u2190 Back to JobPilot</a></p></body>")

    @app.get("/api/health")
    def health():
        from core.resume_reader import get_resume_list
        resumes = get_resume_list()
        return jsonify({
            "status":       "ok",
            "api_key_set":  bool(os.environ.get("ANTHROPIC_API_KEY")),
            "resume_count": len(resumes),
            "resumes":      [r["name"] for r in resumes],
            "sources": {
                "jsearch":   bool(os.environ.get("RAPIDAPI_KEY")),
                "adzuna":    bool(os.environ.get("ADZUNA_APP_ID")) and bool(os.environ.get("ADZUNA_APP_KEY")),
                "themuse":   True,
                "remotive":  True,
                "usajobs":   bool(os.environ.get("USAJOBS_API_KEY")),
                "arbeitnow": True,
            },
        })

    @app.get("/api/usage")
    def get_usage():
        u = _USAGE
        jsearch_key = bool(os.environ.get("RAPIDAPI_KEY"))
        adzuna_key  = bool(os.environ.get("ADZUNA_APP_ID"))
        js_used = u["jsearch_requests"]
        az_used = u["adzuna_requests"]
        return jsonify({
            "usage": u,
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
            "note": "Counters reset on server restart.",
        })

    return app


app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    logging.getLogger("jobpilot").info(f"JobPilot Flask v4.0 — http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)
