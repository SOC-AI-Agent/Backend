"""Submitting one alert — what scripts/test_request.py posted and printed.

Nothing here waits for the model: a request is accepted, or refused, at once.
"""

import uuid

import pytest

from helpers import JOB_STATES, RESULT_FIELDS, make_alert, submit


# ── No credentials needed, so these run against any stack ──────────────────

def test_analyze_without_a_key_is_refused(anon):
    resp = submit(anon, make_alert())
    assert resp.status_code == 401
    assert "X-API-Key" in resp.json()["detail"]


def test_analyze_with_a_wrong_key_is_refused(anon):
    resp = anon.post(
        "/v1/analyze", json=make_alert(),
        headers={"X-API-Key": "not-a-real-key-0000000000"},
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Invalid API Key"


def test_results_without_a_key_are_refused(anon):
    resp = anon.get(f"/v1/results/{uuid.uuid4()}")
    assert resp.status_code == 401


# ── Refused before a job exists ────────────────────────────────────────────

@pytest.mark.parametrize("field", ["alert_id", "alert_name", "raw_log"])
def test_a_missing_field_is_a_400_that_names_it(api, field):
    alert = make_alert()
    del alert[field]
    resp = submit(api, alert)
    assert resp.status_code == 400
    assert field in resp.json()["detail"]


@pytest.mark.parametrize("field", ["alert_id", "alert_name", "raw_log"])
def test_an_empty_field_is_a_400_that_names_it(api, field):
    resp = submit(api, make_alert(**{field: ""}))
    assert resp.status_code == 400
    assert field in resp.json()["detail"]


def test_an_indicator_without_a_value_is_a_400(api):
    resp = submit(api, make_alert(indicators=[{"type": "ip"}]))
    assert resp.status_code == 400
    assert "value" in resp.json()["detail"]


def test_an_unknown_job_is_a_404(api):
    resp = api.get(f"/v1/results/{uuid.uuid4()}")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Job not found"


# ── Accepted ───────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def accepted(api):
    """One alert, sent the way an older playbook might: with a `prompt`, which
    the API no longer reads, and with the indicators SOAR already parsed."""
    alert = make_alert(
        "pytest request: allowed HTTP session",
        prompt="Analyze if this is malicious. Provide a brief summary.",
        indicators=[{"type": "ip", "value": "23.59.154.35", "source": "soar"}],
    )
    return alert, submit(api, alert)


def test_an_alert_is_accepted_with_a_job_id(accepted):
    _, resp = accepted
    assert resp.status_code == 202, resp.text
    body = resp.json()
    uuid.UUID(body["job_id"])
    assert body["status"] == "queued"
    assert isinstance(body["estimated_wait_seconds"], int)


def test_the_result_can_be_read_straight_away(api, accepted):
    alert, resp = accepted
    result = api.get(f"/v1/results/{resp.json()['job_id']}")
    assert result.status_code == 200
    body = result.json()
    assert RESULT_FIELDS <= body.keys()
    assert body["status"] in JOB_STATES
    for field in ("alert_id", "alert_name", "raw_log"):
        assert body[field] == alert[field]


def test_a_caller_supplied_prompt_is_dropped_not_stored(api, accepted):
    # The agent owns its instructions. A playbook that still sends `prompt` is
    # not rejected — the field is discarded — and must not come back out.
    _, resp = accepted
    body = api.get(f"/v1/results/{resp.json()['job_id']}").json()
    assert "prompt" not in body
