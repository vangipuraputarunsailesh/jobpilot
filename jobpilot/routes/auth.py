"""
routes/auth.py — Authentication Blueprint for JobPilot Flask app.
Handles email/password login, registration, and Google OAuth.
"""
import os
import logging

from flask import Blueprint, request, jsonify

from core.auth_db import create_user, get_user, verify_password, create_token

auth_bp = Blueprint("auth", __name__)
logger = logging.getLogger("jobpilot")


@auth_bp.post("/api/auth/register")
def register():
    data = request.get_json(silent=True) or {}
    email = data.get("email", "").strip()
    password = data.get("password", "")
    if not email or "@" not in email:
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
