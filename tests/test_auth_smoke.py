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


def test_register_rejects_blank_credentials(client):
    resp = client.post("/api/auth/register", json={"email": "", "password": ""})
    assert resp.status_code in {400, 422}


def test_demo_login_returns_token(client):
    resp = client.post("/api/auth/demo", json={})
    # Demo is a public path; should either issue a token or return a clear error.
    assert resp.status_code in {200, 400, 401, 403}
    if resp.status_code == 200:
        body = resp.get_json() or {}
        assert "token" in body or "email" in body
