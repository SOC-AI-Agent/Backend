"""Several alerts at once — what scripts/test_bulk_analyze.py did.

The alerts are in payloads.json. The script read test_payloads.json, which was
never in the repo, so it could not run.
"""

import json
from pathlib import Path

import pytest

from helpers import JOB_TIMEOUT, make_alert, submit, wait_for_jobs

pytestmark = pytest.mark.e2e

PAYLOADS = json.loads((Path(__file__).parent / "payloads.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def batch(api):
    """Queue every payload, then wait for all of them. Returns (sent, results),
    both keyed by job_id."""
    sent = {}
    for payload in PAYLOADS:
        alert = make_alert(payload["alert_name"], payload["raw_log"])
        resp = submit(api, alert)
        assert resp.status_code == 202, f"{alert['alert_name']}: {resp.status_code} {resp.text}"
        sent[resp.json()["job_id"]] = alert

    # One worker may take them in turn, so the budget is per job, not per batch.
    results = wait_for_jobs(api, list(sent), JOB_TIMEOUT * len(sent))
    return sent, results


def test_every_alert_gets_its_own_job(batch):
    sent, _ = batch
    assert len(sent) == len(PAYLOADS)


def test_no_job_fails(batch):
    _, results = batch
    failed = {
        job_id: result["error_message"]
        for job_id, result in results.items()
        if result["status"] != "completed"
    }
    assert not failed, failed


def test_every_result_belongs_to_the_alert_it_was_queued_for(batch):
    sent, results = batch
    for job_id, alert in sent.items():
        for field in ("alert_id", "alert_name", "raw_log"):
            assert results[job_id][field] == alert[field], f"{job_id}: {field}"


def test_every_job_has_an_answer(batch):
    _, results = batch
    empty = [job_id for job_id, r in results.items() if not (r["ai_response"] or "").strip()]
    assert not empty, empty
