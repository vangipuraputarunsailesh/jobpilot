"""Smoke tests for the unauthenticated public surface (Issue #30)."""
from __future__ import annotations


def test_health_endpoint_is_public(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body is not None
    assert body.get("status") in {"ok", "healthy"} or "status" in body


def test_landing_page_renders(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert b"<!DOCTYPE html" in resp.data or b"<html" in resp.data


def test_protected_route_requires_auth(client):
    # /api/jobs is behind the JWT guard; an unauth request must be rejected.
    resp = client.get("/api/jobs/search?title=engineer&location=remote")
    assert resp.status_code in {401, 403}


def test_register_route_removed(client):
    # Phase 1 of the BYOK refactor removed email/password registration.
    # Google Sign-In is the only identity path; the legacy route must be
    # unreachable. The auth guard fires before Flask's 404 (because the
    # path isn't in _PUBLIC_PATHS), so either 401 or 404 proves the
    # endpoint is gone — what we care about is "no token is ever minted".
    resp = client.post("/api/auth/register", json={"email": "a@b.com", "password": "secret"})
    assert resp.status_code in {401, 404}
    assert b"token" not in (resp.data or b"").lower()


def test_login_route_removed(client):
    resp = client.post("/api/auth/login", json={"email": "a@b.com", "password": "secret"})
    assert resp.status_code in {401, 404}
    assert b"token" not in (resp.data or b"").lower()


def test_github_oauth_route_removed(client):
    # GitHub OAuth was removed in Phase 1 — both endpoints must be unreachable.
    assert client.get("/api/auth/github/start").status_code in {401, 404}
    assert client.get("/api/auth/github/callback?code=x&state=y").status_code in {401, 404}


def test_demo_login_returns_token(client):
    resp = client.post("/api/auth/demo", json={})
    # Demo is a public path; should either issue a token or return a clear error.
    assert resp.status_code in {200, 400, 401, 403}
    if resp.status_code == 200:
        body = resp.get_json() or {}
        assert "token" in body or "email" in body


# ── Phase 2 BYOK ─────────────────────────────────────────────────────────────


def _real_user_token(monkeypatch):
    """Mint a JobPilot JWT for a non-demo email, bypassing Google verification."""
    from core.auth_db import create_token
    return create_token("real-user@example.com")


def test_tailor_requires_byok_header_for_real_user(client, monkeypatch):
    """Phase 4 contract: /api/tailor is demo-only. Real users get a 410
    because the tailoring path now runs in the browser via
    static/js/ai.js (POST direct to Anthropic with their own BYOK key).

    Replaces the original Phase 2 BYOK 400 contract for this route.
    """
    # Make sure no server env key leaks the test result either way.
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    token = _real_user_token(monkeypatch)
    resp = client.post(
        "/api/tailor",
        json={"resume_text": "x", "description": "y"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 410
    body = resp.get_json() or {}
    assert "demo-only" in (body.get("detail") or "")


def test_byok_test_route_rejects_unknown_provider(client, monkeypatch):
    token = _real_user_token(monkeypatch)
    resp = client.get(
        "/api/byok/test?provider=bogus",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 400
    body = resp.get_json() or {}
    assert body.get("ok") is False
    assert "Unknown provider" in (body.get("detail") or "")


def test_jobs_search_works_for_real_user_without_byok_headers(client, monkeypatch):
    """A real user with NO job-board BYOK headers must still get a 200 from
    /api/jobs/search — missing creds just disable that source, the request
    itself must not fail. Phase 2B contract: scraper credentials are threaded
    via JobSearchCreds, missing keys = empty result, not a hard error."""
    # Strip all server-side fallbacks so we prove the request really runs
    # with no credentials at all.
    for var in (
        "RAPIDAPI_KEY",
        "ADZUNA_APP_ID",
        "ADZUNA_APP_KEY",
        "USAJOBS_EMAIL",
        "USAJOBS_API_KEY",
    ):
        monkeypatch.delenv(var, raising=False)

    # Stub the scraper so we don't hit the network — we only care that
    # the route threads creds through correctly and returns 200.
    import routes.jobs as jobs_mod

    captured = {}

    def fake_search_all_platforms(title, location, seniority, date_posted, *, creds=None):
        captured["creds"] = creds
        return []

    monkeypatch.setattr(jobs_mod, "search_all_platforms", fake_search_all_platforms)

    token = _real_user_token(monkeypatch)
    resp = client.post(
        "/api/jobs",
        json={"title": "engineer", "location": "remote"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    body = resp.get_json() or {}
    assert isinstance(body.get("jobs"), list)

    # Verify the creds object was constructed and threaded through —
    # all five fields should be None for a real user with no BYOK headers.
    creds = captured.get("creds")
    assert creds is not None
    assert creds.rapidapi_key is None
    assert creds.adzuna_app_id is None
    assert creds.adzuna_app_key is None
    assert creds.usajobs_email is None
    assert creds.usajobs_key is None

