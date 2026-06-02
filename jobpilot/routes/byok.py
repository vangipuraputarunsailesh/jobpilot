"""
routes/byok.py — `/api/byok/test` endpoint.

Phase 2 of the BYOK + Drive refactor. Lets the Settings modal verify a
user-supplied key before saving it: the browser POSTs the key in the
provider-specific header, this route does a minimal cheap probe against
the upstream API, and returns `{ok, detail}`.

Probes are intentionally small (no resume / no job description payload)
so they cost the user $0 (Claude) or count as a single API hit (RapidAPI
/ Adzuna / USAJobs). The route is auth-guarded by the global JWT
middleware in `app.py`; we ALSO rate-limit per IP so this can't be used
as a free key validator service.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from collections import defaultdict, deque

import requests
from flask import Blueprint, g, jsonify, request

from core.byok import get_api_key

byok_bp = Blueprint("byok", __name__)
logger = logging.getLogger("jobpilot")

# Per-IP sliding-window rate limit: max 10 probes / minute. Keeps the
# Settings "Test" button useful without letting anyone use us as an
# anonymous key-validator service.
_PROBE_WINDOW_SEC = 60
_PROBE_MAX = int(os.environ.get("BYOK_TEST_RATE", "10"))
_probe_lock = threading.Lock()
_probe_buckets: "dict[str, deque[float]]" = defaultdict(deque)


def _probe_allowed(ip: str) -> bool:
    now = time.time()
    cutoff = now - _PROBE_WINDOW_SEC
    with _probe_lock:
        bucket = _probe_buckets[ip]
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= _PROBE_MAX:
            return False
        bucket.append(now)
        return True


def _probe_anthropic(email: str) -> tuple[bool, str]:
    key = get_api_key("X-Anthropic-Key", "ANTHROPIC_API_KEY", email=email)
    if not key:
        return False, "Missing X-Anthropic-Key header."
    try:
        # Cheapest probe: a 1-token completion against the cheapest model.
        # We use the user-supplied model if any, falling back to Haiku
        # which is widely available and counts as ~$0.0001 per call.
        model = (
            get_api_key("X-Claude-Model", "CLAUDE_MODEL", email=email)
            or "claude-haiku-4-5"
        )
        import anthropic
        client = anthropic.Anthropic(api_key=key)
        client.messages.create(
            model=model,
            max_tokens=1,
            messages=[{"role": "user", "content": "ping"}],
        )
        return True, f"Anthropic key OK (model={model})."
    except Exception as e:  # noqa: BLE001 — surface any failure to UI
        msg = str(e)[:200]
        return False, f"Anthropic rejected the key: {msg}"


def _probe_jsearch(email: str) -> tuple[bool, str]:
    key = get_api_key("X-RapidAPI-Key", "RAPIDAPI_KEY", email=email)
    if not key:
        return False, "Missing X-RapidAPI-Key header."
    try:
        r = requests.get(
            "https://jsearch.p.rapidapi.com/search",
            headers={
                "X-RapidAPI-Key": key,
                "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
            },
            params={"query": "engineer", "num_pages": "1", "page": "1"},
            timeout=10,
        )
        if r.status_code == 200:
            return True, "JSearch / RapidAPI key OK."
        return False, f"JSearch rejected the key: HTTP {r.status_code}."
    except requests.RequestException as e:
        return False, f"JSearch request failed: {e}"


def _probe_adzuna(email: str) -> tuple[bool, str]:
    app_id = get_api_key("X-Adzuna-App-Id", "ADZUNA_APP_ID", email=email)
    app_key = get_api_key("X-Adzuna-App-Key", "ADZUNA_APP_KEY", email=email)
    if not app_id or not app_key:
        return False, "Missing X-Adzuna-App-Id or X-Adzuna-App-Key header."
    try:
        r = requests.get(
            "https://api.adzuna.com/v1/api/jobs/us/search/1",
            params={
                "app_id": app_id, "app_key": app_key,
                "what": "engineer", "results_per_page": 1,
            },
            timeout=10,
        )
        if r.status_code == 200:
            return True, "Adzuna credentials OK."
        return False, f"Adzuna rejected the credentials: HTTP {r.status_code}."
    except requests.RequestException as e:
        return False, f"Adzuna request failed: {e}"


def _probe_usajobs(email: str) -> tuple[bool, str]:
    api_key = get_api_key("X-USAJobs-Key", "USAJOBS_API_KEY", email=email)
    ua_email = get_api_key(
        "X-USAJobs-Email", "USAJOBS_EMAIL", email=email
    )
    if not api_key or not ua_email:
        return False, "Missing X-USAJobs-Key or X-USAJobs-Email header."
    try:
        r = requests.get(
            "https://data.usajobs.gov/api/search",
            headers={
                "Host": "data.usajobs.gov",
                "User-Agent": ua_email,
                "Authorization-Key": api_key,
            },
            params={"Keyword": "engineer", "ResultsPerPage": 1},
            timeout=10,
        )
        if r.status_code == 200:
            return True, "USAJobs credentials OK."
        return False, f"USAJobs rejected the credentials: HTTP {r.status_code}."
    except requests.RequestException as e:
        return False, f"USAJobs request failed: {e}"


_PROBES = {
    "anthropic": _probe_anthropic,
    "jsearch":   _probe_jsearch,
    "adzuna":    _probe_adzuna,
    "usajobs":   _probe_usajobs,
}


@byok_bp.get("/api/byok/test")
def test_key():
    provider = (request.args.get("provider") or "").strip().lower()
    if provider not in _PROBES:
        return jsonify({
            "ok": False,
            "detail": f"Unknown provider '{provider}'. "
                      f"Allowed: {', '.join(sorted(_PROBES))}.",
        }), 400
    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "?").split(",")[0].strip()
    if not _probe_allowed(ip):
        return jsonify({
            "ok": False,
            "detail": f"Too many probes from {ip}. Wait a minute and retry.",
        }), 429
    email = getattr(g, "email", None) or "?"
    try:
        ok, detail = _PROBES[provider](email)
    except Exception as e:  # noqa: BLE001
        logger.warning("BYOK PROBE FAIL | %s | %s | %s", provider, email, e)
        return jsonify({"ok": False, "detail": f"Probe crashed: {e}"}), 500
    logger.info("BYOK PROBE | %s | %s | ok=%s", provider, email, ok)
    return jsonify({"ok": ok, "detail": detail})
