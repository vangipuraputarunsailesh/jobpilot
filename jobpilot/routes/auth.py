"""
routes/auth.py — Authentication Blueprint for JobPilot Flask app.

Phase 1 of the BYOK + Google Drive refactor: Google Sign-In is the ONLY
identity provider. Email/password registration + login and GitHub OAuth
have been removed. The server keeps no per-user row in SQLite — identity
is the verified `email` claim baked into the JobPilot JWT we mint here.
"""
import logging
import os

from flask import Blueprint, g, jsonify, request

from core.auth_db import (
    create_token,
    get_user_resume, clear_user_resume,
    list_user_resumes, add_user_resume, get_user_resume_by_id,
    delete_user_resume_by_id, set_default_user_resume,
)

auth_bp = Blueprint("auth", __name__)
logger = logging.getLogger("jobpilot")

DEMO_EMAIL = "demo@jobpilot.app"


@auth_bp.post("/api/auth/google")
def google_login():
    """Verify a GIS id_token credential and mint a JobPilot JWT.

    This route only handles identity (the `sub` / `email` claim). The
    Drive-scoped access_token is obtained client-side via
    `google.accounts.oauth2.initTokenClient(...).requestAccessToken(...)`
    immediately after this call returns and is stored in localStorage as
    `jp_gtoken`. The server never sees or persists that access_token.
    """
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    if not client_id:
        return jsonify({"detail": "Google login not configured — GOOGLE_CLIENT_ID missing"}), 500
    data = request.get_json(silent=True) or {}
    try:
        from google.oauth2 import id_token
        from google.auth.transport import requests as google_requests
        idinfo = id_token.verify_oauth2_token(
            data.get("credential", ""), google_requests.Request(), client_id
        )
        email = idinfo["email"].lower()
    except Exception as e:
        logger.warning(f"GOOGLE AUTH FAILED | {e}")
        return jsonify({"detail": "Invalid Google token"}), 401
    token = create_token(email)
    logger.info(f"GOOGLE LOGIN | {email}")
    return jsonify({"token": token, "email": email})


@auth_bp.post("/api/auth/demo")
def demo_login():
    """Issue a JWT for the shared demo account (no password required)."""
    token = create_token(DEMO_EMAIL)
    logger.info("DEMO LOGIN")
    return jsonify({"token": token, "email": DEMO_EMAIL, "demo": True})


# ── Account / resume self-service ────────────────────────────────────────────
# All /api/me/* routes are auth-guarded by the global JWT middleware in app.py
# which populates g.email with the caller's identity.

@auth_bp.get("/api/me/resume")
def me_get_resume():
    email = getattr(g, "email", None)
    if not email:
        return jsonify({"detail": "Not authenticated"}), 401
    res = get_user_resume(email)
    if not res:
        return jsonify({"text": "", "name": "", "updated": None})
    return jsonify(res)


@auth_bp.delete("/api/me/resume")
def me_delete_resume():
    email = getattr(g, "email", None)
    if not email:
        return jsonify({"detail": "Not authenticated"}), 401
    clear_user_resume(email)
    logger.info("RESUME CLEARED | %s", email)
    return jsonify({"ok": True})


# ── Multi-resume library ────────────────────────────────────────────────────
# These endpoints back the topbar "Resumes" library modal so a user can keep
# multiple named resumes (e.g. one base + several tailored variants) and
# pick which one is "active" for new searches.

@auth_bp.get("/api/me/resumes")
def me_list_resumes():
    email = getattr(g, "email", None)
    if not email:
        return jsonify({"detail": "Not authenticated"}), 401
    return jsonify({"items": list_user_resumes(email)})


@auth_bp.get("/api/me/resumes/<int:resume_id>")
def me_get_resume_by_id(resume_id):
    email = getattr(g, "email", None)
    if not email:
        return jsonify({"detail": "Not authenticated"}), 401
    res = get_user_resume_by_id(email, resume_id)
    if not res:
        return jsonify({"detail": "Resume not found"}), 404
    return jsonify(res)


@auth_bp.post("/api/me/resumes")
def me_add_resume():
    email = getattr(g, "email", None)
    if not email:
        return jsonify({"detail": "Not authenticated"}), 401
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    name = (data.get("name") or "").strip()
    source = (data.get("source") or "manual").strip()
    if not text:
        return jsonify({"detail": "Resume text is required"}), 400
    if not name:
        return jsonify({"detail": "Resume name is required"}), 400
    try:
        new_id = add_user_resume(email, text, name, source)
    except ValueError as e:
        # Library full or bad input — surface to UI as a clean 400.
        return jsonify({"detail": str(e)}), 400
    logger.info("RESUME LIBRARY ADD | %s | id=%s | name=%s | source=%s",
                email, new_id, name, source)
    return jsonify({"id": new_id, "name": name, "source": source})


@auth_bp.delete("/api/me/resumes/<int:resume_id>")
def me_delete_resume_by_id(resume_id):
    email = getattr(g, "email", None)
    if not email:
        return jsonify({"detail": "Not authenticated"}), 401
    removed = delete_user_resume_by_id(email, resume_id)
    if not removed:
        return jsonify({"detail": "Resume not found"}), 404
    logger.info("RESUME LIBRARY DELETE | %s | id=%s", email, resume_id)
    return jsonify({"ok": True})


@auth_bp.post("/api/me/resumes/<int:resume_id>/default")
def me_set_default_resume(resume_id):
    email = getattr(g, "email", None)
    if not email:
        return jsonify({"detail": "Not authenticated"}), 401
    res = set_default_user_resume(email, resume_id)
    if not res:
        return jsonify({"detail": "Resume not found"}), 404
    logger.info("RESUME LIBRARY SET DEFAULT | %s | id=%s", email, resume_id)
    return jsonify({"id": res["id"], "name": res["name"], "text": res["text"]})


@auth_bp.delete("/api/me")
def me_delete_account():
    """Phase 1 (BYOK refactor): the server no longer owns user data — there
    is no SQLite row to hard-delete. "Delete account" is now a purely
    client-side action: the browser drops its localStorage session + BYOK
    keys, and the user revokes the JobPilot app from their Google account
    if they want Drive access cut as well. We keep the route as a 204 so
    existing UI affordances don't 404.
    """
    email = getattr(g, "email", None)
    if not email:
        return jsonify({"detail": "Not authenticated"}), 401
    if email == DEMO_EMAIL:
        return jsonify({"detail": "Demo account cannot be deleted"}), 400
    logger.info("ACCOUNT DELETE (client-side wipe) | %s", email)
    return jsonify({"ok": True, "removed": False, "client_wipe_required": True})


