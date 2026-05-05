"""
auth_db.py — Email + password authentication for JobPilot
Uses SQLite for user storage, pbkdf2_sha256 for passwords, JWT for sessions.
"""

import os
import re
import sqlite3
import jwt
from datetime import datetime, timedelta, timezone
from pathlib import Path
from passlib.context import CryptContext

# ── Config ────────────────────────────────────────────────────────────────────

SECRET_KEY  = os.environ.get("JWT_SECRET", "jobpilot-secret-change-in-production")
ALGORITHM   = "HS256"
TOKEN_HOURS = 24 * 7   # token valid for 7 days

DB_PATH  = Path(__file__).parent.parent / "users.db"
pwd_ctx  = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

# ── DB setup ──────────────────────────────────────────────────────────────────

def _conn():
    return sqlite3.connect(str(DB_PATH))

def init_db():
    with _conn() as con:
        con.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                email    TEXT    UNIQUE NOT NULL,
                password TEXT    NOT NULL,
                created  TEXT    DEFAULT (datetime('now'))
            )
        """)
        # Idempotent column adds for the resume-persistence feature. SQLite
        # has no IF NOT EXISTS for ADD COLUMN, so we sniff PRAGMA first.
        cols = {row[1] for row in con.execute("PRAGMA table_info(users)").fetchall()}
        if "resume_text" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN resume_text TEXT")
        if "resume_name" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN resume_name TEXT")
        if "resume_updated" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN resume_updated TEXT")
        con.commit()


# ── Resume storage (server-side) ─────────────────────────────────────────────
# Bound the persisted resume text to keep SQLite rows reasonable. The
# /api/upload-resume route already enforces a 5 MB byte cap on the file
# itself, but extracted text from a packed PDF can still balloon.
_RESUME_TEXT_MAX_CHARS = int(os.environ.get("RESUME_TEXT_MAX_CHARS", "200000"))


def save_user_resume(email: str, text: str, filename: str) -> None:
    email = (email or "").strip().lower()
    if not email:
        raise ValueError("email required")
    text = (text or "")[:_RESUME_TEXT_MAX_CHARS]
    filename = (filename or "resume")[:255]
    with _conn() as con:
        cur = con.execute(
            "UPDATE users SET resume_text = ?, resume_name = ?, "
            "resume_updated = datetime('now') WHERE email = ?",
            (text, filename, email),
        )
        if cur.rowcount == 0:
            raise ValueError("user not found")
        con.commit()


def get_user_resume(email: str) -> dict | None:
    email = (email or "").strip().lower()
    if not email:
        return None
    with _conn() as con:
        row = con.execute(
            "SELECT resume_text, resume_name, resume_updated FROM users WHERE email = ?",
            (email,),
        ).fetchone()
    if not row or not row[0]:
        return None
    return {"text": row[0], "name": row[1] or "resume", "updated": row[2]}


def clear_user_resume(email: str) -> None:
    email = (email or "").strip().lower()
    if not email:
        return
    with _conn() as con:
        con.execute(
            "UPDATE users SET resume_text = NULL, resume_name = NULL, "
            "resume_updated = NULL WHERE email = ?",
            (email,),
        )
        con.commit()


def delete_user(email: str) -> bool:
    """Hard-delete a user row. Returns True if a row was removed."""
    email = (email or "").strip().lower()
    if not email:
        return False
    with _conn() as con:
        cur = con.execute("DELETE FROM users WHERE email = ?", (email,))
        con.commit()
        return cur.rowcount > 0

# ── Password helpers ──────────────────────────────────────────────────────────

def hash_password(plain: str) -> str:
    return pwd_ctx.hash(plain)

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_ctx.verify(plain, hashed)

# ── User CRUD ─────────────────────────────────────────────────────────────────

# Issue #92 — defense-in-depth at the DB layer. Route handlers in
# routes/auth.py do their own (stricter) validation; this is the safety net
# for any future caller (admin script, batch import, etc.) that bypasses
# the route layer.
_EMAIL_RE_DB = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")
_MIN_PASSWORD_LEN_DB = 6


def create_user(email: str, password: str) -> dict:
    email = (email or "").strip().lower()
    if not email or len(email) > 254 or not _EMAIL_RE_DB.match(email):
        raise ValueError("Invalid email")
    if not isinstance(password, str) or len(password) < _MIN_PASSWORD_LEN_DB:
        raise ValueError("Password too short")
    with _conn() as con:
        try:
            con.execute(
                "INSERT INTO users (email, password) VALUES (?, ?)",
                (email, hash_password(password))
            )
            con.commit()
        except sqlite3.IntegrityError:
            raise ValueError("Email already registered")
    return {"email": email}

def get_user(email: str) -> dict | None:
    email = email.strip().lower()
    with _conn() as con:
        row = con.execute(
            "SELECT id, email, password FROM users WHERE email = ?", (email,)
        ).fetchone()
    if not row:
        return None
    return {"id": row[0], "email": row[1], "password": row[2]}

# ── JWT ───────────────────────────────────────────────────────────────────────

def create_token(email: str) -> str:
    payload = {
        "sub": email,
        "exp": datetime.now(timezone.utc) + timedelta(hours=TOKEN_HOURS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

def decode_token(token: str) -> str:
    """Returns email from valid token, raises jwt.PyJWTError if invalid/expired.

    Issue #98 — also raises ``jwt.InvalidTokenError`` (a ``PyJWTError``
    subclass) when the ``sub`` claim is missing, instead of leaking a
    bare ``KeyError`` to callers narrowing on ``PyJWTError``.
    """
    payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    sub = payload.get("sub")
    if not sub:
        raise jwt.InvalidTokenError("sub claim missing")
    return sub
