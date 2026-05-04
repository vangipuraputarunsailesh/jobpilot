"""
auth_db.py — Email + password authentication for JobPilot
Uses SQLite for user storage, pbkdf2_sha256 for passwords, JWT for sessions.
"""

import os
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
        con.commit()

# ── Password helpers ──────────────────────────────────────────────────────────

def hash_password(plain: str) -> str:
    return pwd_ctx.hash(plain)

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_ctx.verify(plain, hashed)

# ── User CRUD ─────────────────────────────────────────────────────────────────

def create_user(email: str, password: str) -> dict:
    email = email.strip().lower()
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
    """Returns email from valid token, raises jwt.PyJWTError if invalid/expired."""
    payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    return payload["sub"]
