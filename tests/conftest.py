"""Pytest fixtures for the JobPilot smoke-test suite (Issue #30).

The fixtures intentionally avoid touching the real Apify / Adzuna / Claude
backends — they exist purely to give CI a fast, hermetic safety net that
catches import-time regressions and obvious wiring bugs in the Flask app.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Make the `jobpilot/` package importable when pytest is invoked from the
# repository root.
_REPO_ROOT = Path(__file__).resolve().parent.parent
_APP_DIR = _REPO_ROOT / "jobpilot"
sys.path.insert(0, str(_APP_DIR))


@pytest.fixture(scope="session")
def app():
    """Build a fresh Flask app with deterministic test secrets."""
    os.environ.setdefault("FLASK_SECRET", "pytest-flask-secret")
    os.environ.setdefault("JWT_SECRET", "pytest-jwt-secret")
    # Delay import so env vars are in place before app.create_app() reads them.
    from app import create_app  # type: ignore  # noqa: E402

    flask_app = create_app()
    flask_app.config.update(TESTING=True)
    return flask_app


@pytest.fixture()
def client(app):
    return app.test_client()
