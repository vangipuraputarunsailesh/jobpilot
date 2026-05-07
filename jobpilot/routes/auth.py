"""
routes/auth.py — Authentication Blueprint for JobPilot Flask app.
Handles email/password login, registration, Google OAuth, GitHub OAuth, and demo access.
"""
import os
import re
import secrets
import logging
from urllib.parse import urlencode

import requests
from flask import Blueprint, request, jsonify, redirect, session, url_for, Response, g

from core.auth_db import (
    create_user, get_user, verify_password, create_token,
    get_user_resume, clear_user_resume, delete_user,
    list_user_resumes, add_user_resume, get_user_resume_by_id,
    delete_user_resume_by_id, set_default_user_resume,
)

auth_bp = Blueprint("auth", __name__)
logger = logging.getLogger("jobpilot")

# Issue #51 — pragmatic email syntax check (RFC-5322-lite). The full RFC is
# rarely useful in practice; this rejects the obvious garbage before we
# write a row to the user table.
_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")


def _is_valid_email(email: str) -> bool:
    return bool(_EMAIL_RE.match(email)) and len(email) <= 254

DEMO_EMAIL = "demo@jobpilot.app"
DEMO_PASSWORD_PLACEHOLDER = "demo-account-no-login"


@auth_bp.post("/api/auth/register")
def register():
    data = request.get_json(silent=True) or {}
    email = data.get("email", "").strip()
    password = data.get("password", "")
    if not _is_valid_email(email):
        return jsonify({"detail": "Valid email required"}), 400
    if len(password) < 6:
        return jsonify({"detail": "Password must be at least 6 characters"}), 400
    try:
        create_user(email, password)
        token = create_token(email.lower())
        logger.info(f"REGISTER | {email}")
        return jsonify({"token": token, "email": email.lower()})
    except ValueError:
        return jsonify({"detail": "Email already registered"}), 400


@auth_bp.post("/api/auth/login")
def login():
    data = request.get_json(silent=True) or {}
    user = get_user(data.get("email", ""))
    if not user or not verify_password(data.get("password", ""), user["password"]):
        logger.warning(f"LOGIN FAILED | {data.get('email')}")
        return jsonify({"detail": "Invalid email or password"}), 401
    token = create_token(user["email"])
    logger.info(f"LOGIN | {user['email']}")
    return jsonify({"token": token, "email": user["email"]})


@auth_bp.post("/api/auth/google")
def google_login():
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
    try:
        create_user(email, os.urandom(32).hex())
        logger.info(f"GOOGLE REGISTER | {email}")
    except ValueError:
        pass  # already exists
    token = create_token(email)
    logger.info(f"GOOGLE LOGIN | {email}")
    return jsonify({"token": token, "email": email})


@auth_bp.post("/api/auth/demo")
def demo_login():
    """Issue a JWT for the shared demo account (no password required)."""
    try:
        create_user(DEMO_EMAIL, os.urandom(32).hex())
        logger.info("DEMO ACCOUNT CREATED")
    except ValueError:
        pass  # already exists
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
    email = getattr(g, "email", None)
    if not email:
        return jsonify({"detail": "Not authenticated"}), 401
    if email == DEMO_EMAIL:
        return jsonify({"detail": "Demo account cannot be deleted"}), 400
    removed = delete_user(email)
    logger.info("ACCOUNT DELETED | %s | removed=%s", email, removed)
    return jsonify({"ok": True, "removed": removed})


# ── GitHub OAuth (web flow) ──────────────────────────────────────────────────
# Standard OAuth 2.0 Authorization Code grant. The button on the landing page
# 302s the browser to /api/auth/github/start, which signs a CSRF state into
# the Flask session and redirects to GitHub. GitHub redirects back to
# /api/auth/github/callback with a `code`; we exchange it for an access
# token, fetch the user's primary verified email, mint a JobPilot JWT,
# and return a small HTML page that stores the token in localStorage and
# redirects to /app — matching the behavior of every other sign-in path.

_GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
_GITHUB_TOKEN_URL     = "https://github.com/login/oauth/access_token"
_GITHUB_USER_EMAIL    = "https://api.github.com/user/emails"
_GITHUB_USER          = "https://api.github.com/user"
_GITHUB_OAUTH_TIMEOUT = 10  # seconds


def _github_redirect_uri() -> str:
    explicit = os.environ.get("GITHUB_REDIRECT_URI", "").strip()
    if explicit:
        return explicit
    # Build from the request — works in dev, prod, and Railway.
    return url_for("auth.github_callback", _external=True)


def _github_error_page(message: str) -> Response:
    safe = (message or "Sign-in failed").replace("<", "&lt;").replace(">", "&gt;")
    html = (
        "<!doctype html><meta charset='utf-8'><title>GitHub sign-in failed</title>"
        "<body style=\"font-family:Inter,system-ui;max-width:520px;margin:48px auto;"
        "padding:0 20px;color:#222\">"
        f"<h1>Sign-in failed</h1><p>{safe}</p>"
        "<p><a href='/'>Return to JobPilot</a></p></body>"
    )
    return Response(html, status=400, mimetype="text/html")


@auth_bp.get("/api/auth/github/start")
def github_start():
    client_id = os.environ.get("GITHUB_CLIENT_ID", "").strip()
    client_secret = os.environ.get("GITHUB_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        return _github_error_page("GitHub Sign-In is not configured on this deployment.")
    state = secrets.token_urlsafe(32)
    session["github_oauth_state"] = state
    params = {
        "client_id":    client_id,
        "redirect_uri": _github_redirect_uri(),
        "scope":        "read:user user:email",
        "state":        state,
        "allow_signup": "true",
    }
    return redirect(f"{_GITHUB_AUTHORIZE_URL}?{urlencode(params)}")


@auth_bp.get("/api/auth/github/callback")
def github_callback():
    client_id = os.environ.get("GITHUB_CLIENT_ID", "").strip()
    client_secret = os.environ.get("GITHUB_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        return _github_error_page("GitHub Sign-In is not configured on this deployment.")

    code  = request.args.get("code", "")
    state = request.args.get("state", "")
    expected_state = session.pop("github_oauth_state", None)
    if not code or not state or not expected_state or not secrets.compare_digest(state, expected_state):
        logger.warning("GITHUB AUTH FAILED | bad state or missing code")
        return _github_error_page("Invalid OAuth state — please try signing in again.")

    # Exchange code for access token.
    try:
        tok_resp = requests.post(
            _GITHUB_TOKEN_URL,
            data={
                "client_id":     client_id,
                "client_secret": client_secret,
                "code":          code,
                "redirect_uri":  _github_redirect_uri(),
            },
            headers={"Accept": "application/json"},
            timeout=_GITHUB_OAUTH_TIMEOUT,
        )
        tok_resp.raise_for_status()
        tok_data = tok_resp.json()
    except (requests.RequestException, ValueError) as e:
        logger.warning("GITHUB TOKEN EXCHANGE FAILED | %s", e)
        return _github_error_page("Could not reach GitHub to complete sign-in.")

    access_token = tok_data.get("access_token")
    if not access_token:
        logger.warning("GITHUB TOKEN EXCHANGE FAILED | no access_token in response")
        return _github_error_page("GitHub did not return an access token.")

    # Resolve a usable email address.
    auth_headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept":        "application/vnd.github+json",
        "User-Agent":    "JobPilot",
    }
    try:
        emails_resp = requests.get(_GITHUB_USER_EMAIL, headers=auth_headers, timeout=_GITHUB_OAUTH_TIMEOUT)
        emails_resp.raise_for_status()
        emails = emails_resp.json() if emails_resp.content else []
    except (requests.RequestException, ValueError) as e:
        logger.warning("GITHUB EMAILS FETCH FAILED | %s", e)
        return _github_error_page("Could not read your GitHub email address.")

    email = ""
    if isinstance(emails, list):
        primary_verified = next(
            (e for e in emails if isinstance(e, dict) and e.get("primary") and e.get("verified")),
            None,
        )
        any_verified = next(
            (e for e in emails if isinstance(e, dict) and e.get("verified")),
            None,
        )
        chosen = primary_verified or any_verified
        if chosen:
            email = (chosen.get("email") or "").strip().lower()

    if not email:
        # Fallback: profile endpoint (only set when user's email is public).
        try:
            user_resp = requests.get(_GITHUB_USER, headers=auth_headers, timeout=_GITHUB_OAUTH_TIMEOUT)
            user_resp.raise_for_status()
            user_data = user_resp.json()
            email = (user_data.get("email") or "").strip().lower()
        except (requests.RequestException, ValueError):
            email = ""

    if not email or not _is_valid_email(email):
        return _github_error_page(
            "We couldn't find a verified email on your GitHub account. "
            "Please verify an email at github.com/settings/emails and try again."
        )

    try:
        create_user(email, os.urandom(32).hex())
        logger.info("GITHUB REGISTER | %s", email)
    except ValueError:
        pass  # already exists

    token = create_token(email)
    logger.info("GITHUB LOGIN | %s", email)

    # Hand the JWT back to the SPA via a small bootstrap page that mirrors
    # the localStorage shape used by setLoginSession() in landing.html.
    safe_token = token.replace("<", "").replace(">", "")
    safe_email = email.replace("<", "").replace(">", "")
    html = f"""<!doctype html><meta charset="utf-8"><title>Signing you in…</title>
<body style="font-family:Inter,system-ui;max-width:420px;margin:80px auto;padding:0 20px;color:#222;text-align:center">
<p>Finishing GitHub sign-in…</p>
<script>
(function () {{
  try {{
    localStorage.setItem('jp_token', {repr(safe_token)});
    localStorage.setItem('jp_email', {repr(safe_email)});
    localStorage.removeItem('jp_demo');
    var ttl = 7 * 24 * 60 * 60 * 1000;
    localStorage.setItem('jp_session_expiry', String(Date.now() + ttl));
  }} catch (e) {{ /* localStorage disabled — user will see /app guard */ }}
  window.location.replace('/app');
}})();
</script>
</body>"""
    return Response(html, mimetype="text/html")
