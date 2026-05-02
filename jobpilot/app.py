"""
app.py — JobPilot Flask Backend (v4.0)
Run: python app.py
"""
import os
import time
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

from flask import Flask, render_template, jsonify, request, g
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv(override=True)

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
                 "/api/auth/google", "/api/health"}


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
            import jwt as pyjwt
            from core.auth_db import decode_token
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

    @app.get("/")
    def landing():
        return render_template("landing.html",
                               google_client_id=os.environ.get("GOOGLE_CLIENT_ID", ""))

    @app.get("/app")
    def index():
        return render_template("index.html")

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
