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

        # Multi-resume library. The legacy `users.resume_*` columns above
        # remain the "active" pointer (so older code paths and the
        # /api/me/resume endpoint keep working unchanged); this table is the
        # full library of named resumes the user can pick from.
        con.execute("""
            CREATE TABLE IF NOT EXISTS user_resumes (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                email   TEXT NOT NULL,
                name    TEXT NOT NULL,
                text    TEXT NOT NULL,
                source  TEXT NOT NULL DEFAULT 'upload',
                created TEXT DEFAULT (datetime('now'))
            )
        """)
        con.execute(
            "CREATE INDEX IF NOT EXISTS idx_user_resumes_email "
            "ON user_resumes (email, created DESC)"
        )
        con.commit()


# ── Multi-resume library ─────────────────────────────────────────────────────
# Per-user cap so a single account cannot grow the SQLite file unboundedly.
_RESUME_LIBRARY_MAX = int(os.environ.get("RESUME_LIBRARY_MAX", "20"))
_RESUME_NAME_MAX = 120
_VALID_SOURCES = {"upload", "tailored", "generated", "manual"}


def list_user_resumes(email: str) -> list[dict]:
    """Return library metadata (no full text) ordered newest-first."""
    email = (email or "").strip().lower()
    if not email:
        return []
    with _conn() as con:
        rows = con.execute(
            "SELECT id, name, source, created, length(text) AS chars, "
            "substr(text, 1, 160) AS preview "
            "FROM user_resumes WHERE email = ? ORDER BY datetime(created) DESC, id DESC",
            (email,),
        ).fetchall()
        active_name = con.execute(
            "SELECT resume_name FROM users WHERE email = ?", (email,)
        ).fetchone()
    active = (active_name[0] if active_name else None) or ""
    return [
        {
            "id": r[0],
            "name": r[1],
            "source": r[2],
            "created": r[3],
            "chars": r[4],
            "preview": (r[5] or "").strip().replace("\n", " ")[:160],
            "is_active": (r[1] == active) if active else False,
        }
        for r in rows
    ]


def add_user_resume(email: str, text: str, name: str, source: str = "upload") -> int:
    email = (email or "").strip().lower()
    if not email:
        raise ValueError("email required")
    text = (text or "").strip()
    if not text:
        raise ValueError("resume text required")
    text = text[:_RESUME_TEXT_MAX_CHARS]
    name = ((name or "resume").strip())[:_RESUME_NAME_MAX] or "resume"
    if source not in _VALID_SOURCES:
        source = "upload"
    with _conn() as con:
        count = con.execute(
            "SELECT COUNT(*) FROM user_resumes WHERE email = ?", (email,)
        ).fetchone()[0]
        if count >= _RESUME_LIBRARY_MAX:
            raise ValueError(
                f"Resume library is full ({_RESUME_LIBRARY_MAX}). "
                "Delete an entry before adding another."
            )
        cur = con.execute(
            "INSERT INTO user_resumes (email, name, text, source) VALUES (?, ?, ?, ?)",
            (email, name, text, source),
        )
        con.commit()
        return int(cur.lastrowid)


def get_user_resume_by_id(email: str, resume_id: int) -> dict | None:
    email = (email or "").strip().lower()
    if not email:
        return None
    with _conn() as con:
        row = con.execute(
            "SELECT id, name, text, source, created FROM user_resumes "
            "WHERE email = ? AND id = ?",
            (email, int(resume_id)),
        ).fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "name": row[1],
        "text": row[2],
        "source": row[3],
        "created": row[4],
    }


def delete_user_resume_by_id(email: str, resume_id: int) -> bool:
    """Returns True if a row was deleted. Also clears the active pointer if
    it referenced the deleted entry."""
    email = (email or "").strip().lower()
    if not email:
        return False
    with _conn() as con:
        target = con.execute(
            "SELECT name FROM user_resumes WHERE email = ? AND id = ?",
            (email, int(resume_id)),
        ).fetchone()
        if not target:
            return False
        cur = con.execute(
            "DELETE FROM user_resumes WHERE email = ? AND id = ?",
            (email, int(resume_id)),
        )
        # If the deleted row was the active one, fall back to most-recent.
        active = con.execute(
            "SELECT resume_name FROM users WHERE email = ?", (email,)
        ).fetchone()
        if active and active[0] == target[0]:
            nxt = con.execute(
                "SELECT name, text FROM user_resumes WHERE email = ? "
                "ORDER BY datetime(created) DESC, id DESC LIMIT 1",
                (email,),
            ).fetchone()
            if nxt:
                con.execute(
                    "UPDATE users SET resume_text = ?, resume_name = ?, "
                    "resume_updated = datetime('now') WHERE email = ?",
                    (nxt[1], nxt[0], email),
                )
            else:
                con.execute(
                    "UPDATE users SET resume_text = NULL, resume_name = NULL, "
                    "resume_updated = NULL WHERE email = ?",
                    (email,),
                )
        con.commit()
        return cur.rowcount > 0


def set_default_user_resume(email: str, resume_id: int) -> dict | None:
    """Mirror the named library entry into the legacy active pointer."""
    res = get_user_resume_by_id(email, resume_id)
    if not res:
        return None
    email_norm = email.strip().lower()
    with _conn() as con:
        con.execute(
            "UPDATE users SET resume_text = ?, resume_name = ?, "
            "resume_updated = datetime('now') WHERE email = ?",
            (res["text"], res["name"], email_norm),
        )
        con.commit()
    return res


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
        # Mirror into the multi-resume library so the active resume always
        # appears in the library UI. Upsert by name to avoid duplicates when
        # the user re-uploads the same file. Best-effort — never block the
        # primary update on the library cap.
        try:
            existing = con.execute(
                "SELECT id FROM user_resumes WHERE email = ? AND name = ?",
                (email, filename),
            ).fetchone()
            if existing:
                con.execute(
                    "UPDATE user_resumes SET text = ?, source = 'upload', "
                    "created = datetime('now') WHERE id = ?",
                    (text, existing[0]),
                )
            else:
                count = con.execute(
                    "SELECT COUNT(*) FROM user_resumes WHERE email = ?", (email,)
                ).fetchone()[0]
                if count < _RESUME_LIBRARY_MAX:
                    con.execute(
                        "INSERT INTO user_resumes (email, name, text, source) "
                        "VALUES (?, ?, ?, 'upload')",
                        (email, filename, text),
                    )
        except sqlite3.Error:
            pass  # library mirror is best-effort
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
