"""Fixtures for the API tests.

These run against a live Backend — the same thing scripts/test_*.py did by hand.

    SOC_BASE_URL      where the API is        (default http://localhost:8081)
    SOC_API_KEY       a key for X-API-Key     (tests that need one skip without it)
    SOC_JOB_TIMEOUT   seconds to wait for one job to finish   (default 300)
    SOC_POLL_INTERVAL seconds between polls                   (default 2)

Issue a key on the dashboard's API Keys page, or POST /admin/api-keys.
"""

from __future__ import annotations

import os

import pytest
import requests

BASE_URL = os.environ.get("SOC_BASE_URL", "http://localhost:8081").rstrip("/")
API_KEY = os.environ.get("SOC_API_KEY", "")
REQUEST_TIMEOUT = 15


def pytest_report_header(config):
    return [
        f"soc api: {BASE_URL}",
        "api key: " + ("set" if API_KEY else "NOT SET — tests that need a key will be skipped"),
    ]


class Client(requests.Session):
    """A session that takes paths instead of URLs and never waits forever."""

    def request(self, method, path, **kwargs):
        kwargs.setdefault("timeout", REQUEST_TIMEOUT)
        return super().request(method, f"{BASE_URL}{path}", **kwargs)


@pytest.fixture(scope="session", autouse=True)
def _stack_is_up():
    # Stopping here is louder than a hundred connection errors, one per test.
    try:
        requests.get(f"{BASE_URL}/health", timeout=5)
    except requests.RequestException as exc:
        pytest.exit(
            f"cannot reach {BASE_URL} ({exc.__class__.__name__}). "
            "Start the stack, or point SOC_BASE_URL at it.",
            returncode=2,
        )


@pytest.fixture(scope="session")
def anon():
    """No credentials at all."""
    with Client() as client:
        yield client


@pytest.fixture(scope="session")
def api():
    """Authenticated with SOC_API_KEY, the way SOAR calls in."""
    if not API_KEY:
        pytest.skip("set SOC_API_KEY to run the tests that need a key")
    with Client() as client:
        client.headers["X-API-Key"] = API_KEY
        yield client
