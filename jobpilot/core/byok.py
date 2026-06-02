"""
core/byok.py — Bring Your Own Key helper.

Phase 2 of the BYOK + Drive refactor. Every paid third-party API call now
resolves its credential from a per-request header instead of a server-side
env var. The server env vars remain ONLY as fallback for the shared demo
account (so anyone can click "Try Demo" without first signing up for an
Anthropic key) — real Google-signed-in users must supply their own keys
via the Settings modal, which stores them client-side (AES-GCM in
localStorage) and re-sends them on every authenticated request.

Header contract (all optional; missing -> 400 for real users, env
fallback for demo):

  X-Anthropic-Key     -> ANTHROPIC_API_KEY     (Claude — required for AI)
  X-Claude-Model      -> CLAUDE_MODEL          (model override, optional)
  X-RapidAPI-Key      -> RAPIDAPI_KEY          (JSearch)
  X-Adzuna-App-Id     -> ADZUNA_APP_ID         (Adzuna)
  X-Adzuna-App-Key    -> ADZUNA_APP_KEY        (Adzuna)
  X-USAJobs-Email     -> USAJOBS_EMAIL         (USAJobs User-Agent)
  X-USAJobs-Key       -> USAJOBS_API_KEY       (USAJobs)

All getters reject keys containing CR / LF / NUL (header-injection guard,
also a sanity check that the client didn't accidentally include quotes
or line wrapping when pasting the value).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

from flask import has_request_context, request

DEMO_EMAIL = "demo@jobpilot.app"


# Forbidden control characters in any header value — anything that would
# let an attacker smuggle a second header / split the response.
_FORBIDDEN_CHARS = ("\r", "\n", "\x00")


def _is_safe(value: str) -> bool:
    return not any(c in value for c in _FORBIDDEN_CHARS)


def is_demo(email: Optional[str]) -> bool:
    return email == DEMO_EMAIL


def get_api_key(
    header_name: str,
    env_name: str,
    *,
    email: Optional[str],
    allow_env_for_demo: bool = True,
) -> Optional[str]:
    """Resolve a single BYOK header.

    Order of precedence:
      1. `request.headers[header_name]` (always wins, even for demo users)
      2. If `email` is the demo account AND `allow_env_for_demo` is True,
         fall back to `os.environ[env_name]`.
      3. Otherwise return `None` (caller raises 400).

    Returns the trimmed value, or None if neither source had one (or the
    header contained forbidden control characters — in which case we
    treat it as "not provided" rather than silently passing tainted
    bytes through to the third-party API).
    """
    value = ""
    if has_request_context():
        value = (request.headers.get(header_name) or "").strip()
    if value:
        if not _is_safe(value):
            return None
        return value
    if allow_env_for_demo and is_demo(email):
        env_val = (os.environ.get(env_name) or "").strip()
        if env_val and _is_safe(env_val):
            return env_val
    return None


def require_api_key(
    header_name: str,
    env_name: str,
    *,
    email: Optional[str],
    allow_env_for_demo: bool = True,
) -> tuple[Optional[str], Optional[tuple[dict, int]]]:
    """Like `get_api_key`, but returns a Flask error tuple on failure.

    Usage in a route:
        key, err = require_api_key("X-Anthropic-Key", "ANTHROPIC_API_KEY", email=g.email)
        if err:
            return jsonify(err[0]), err[1]
    """
    key = get_api_key(header_name, env_name, email=email,
                      allow_env_for_demo=allow_env_for_demo)
    if key:
        return key, None
    provider_hint = header_name.removeprefix("X-").replace("-", " ")
    return None, (
        {
            "detail": (
                f"Missing {header_name} — open Settings and paste your "
                f"{provider_hint} so JobPilot can call this API on your behalf."
            ),
            "byok_required": True,
            "header": header_name,
        },
        400,
    )


# ── Job-search credential bundle ─────────────────────────────────────────────
# `flask.g` doesn't propagate across `ThreadPoolExecutor` threads, and the
# job scraper fans out to ~6 sources in parallel — so we resolve every
# job-search credential up-front on the request thread and pass it down as
# an explicit dataclass kwarg. Each field is Optional: a missing credential
# just disables that one source (matching the existing pre-BYOK behaviour
# where unset env vars made a scraper log "skipping").
@dataclass(frozen=True)
class JobSearchCreds:
    rapidapi_key:    Optional[str] = None  # JSearch
    adzuna_app_id:   Optional[str] = None  # Adzuna
    adzuna_app_key:  Optional[str] = None  # Adzuna
    usajobs_email:   Optional[str] = None  # USAJobs User-Agent
    usajobs_key:     Optional[str] = None  # USAJobs API key


def read_job_search_creds(email: Optional[str]) -> JobSearchCreds:
    """Read every job-board BYOK header on the current request thread.

    Safe to call only inside a Flask request handler. For demo users,
    missing headers fall back to the server env vars; for real users,
    missing headers leave the field as None (which makes the matching
    scraper skip itself, just like in pre-BYOK mode).
    """
    return JobSearchCreds(
        rapidapi_key   = get_api_key("X-RapidAPI-Key",   "RAPIDAPI_KEY",   email=email),
        adzuna_app_id  = get_api_key("X-Adzuna-App-Id",  "ADZUNA_APP_ID",  email=email),
        adzuna_app_key = get_api_key("X-Adzuna-App-Key", "ADZUNA_APP_KEY", email=email),
        usajobs_email  = get_api_key("X-USAJobs-Email",  "USAJOBS_EMAIL",  email=email),
        usajobs_key    = get_api_key("X-USAJobs-Key",    "USAJOBS_API_KEY", email=email),
    )
