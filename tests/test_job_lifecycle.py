"""One alert, all the way to an answer — what scripts/test_full_flow.py did.

That script asked the model for JSON through `prompt` and parsed it. `prompt`
is no longer read: the agent's instructions belong to the agent, so ai_response
is whatever the agent writes and these tests do not expect a shape inside it.
"""

import pytest

from helpers import LOOKUP_STATES, make_alert, submit, wait_for_job

pytestmark = pytest.mark.e2e


@pytest.fixture(scope="module")
def alert():
    return make_alert("pytest lifecycle: allowed HTTP session")


@pytest.fixture(scope="module")
def finished(api, alert):
    resp = submit(api, alert)
    assert resp.status_code == 202, resp.text
    return wait_for_job(api, resp.json()["job_id"])


def test_the_job_completes(finished):
    assert finished["status"] == "completed", finished["error_message"]


def test_a_completed_job_carries_an_answer(finished):
    assert isinstance(finished["ai_response"], str)
    assert finished["ai_response"].strip()
    assert finished["error_message"] is None
    assert finished["created_at"]
    assert finished["completed_at"]
    assert isinstance(finished["processing_time_ms"], int)
    assert finished["processing_time_ms"] > 0


def test_the_result_is_the_alert_that_was_sent(finished, alert):
    for field in ("alert_id", "alert_name", "raw_log"):
        assert finished[field] == alert[field]


def test_the_splunk_stage_fields_are_well_formed(finished):
    requirements = finished["splunk_requirements"]
    assert isinstance(requirements, list)
    assert all(isinstance(line, str) for line in requirements)
    assert finished["lookup_status"] in LOOKUP_STATES


def test_a_finished_result_does_not_change(api, finished):
    again = api.get(f"/v1/results/{finished['job_id']}").json()
    assert again["status"] == finished["status"]
    assert again["ai_response"] == finished["ai_response"]
