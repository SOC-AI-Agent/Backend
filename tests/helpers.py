"""Plain functions the tests share. Fixtures live in conftest.py."""

from __future__ import annotations

import os
import time
import uuid

# The alert every script in scripts/test_*.py used: a FortiGate traffic log for
# an allowed HTTP session, nothing in it a person would call suspicious.
BENIGN_LOG = (
    'date=2019-05-10 time=11:37:47 logid="0000000013" type="traffic" '
    'subtype="forward" level="notice" vd="vdom1" eventtime=1557513467369913239 '
    'srcip=10.1.100.11 srcport=58012 srcintf="port12" dstip=23.59.154.35 '
    'dstport=80 dstintf="port11" sessionid=105048 proto=6 action="close" '
    'policyid=1 policytype="policy" service="HTTP" dstcountry="Canada" '
    'srccountry="Reserved" appid=34050 app="HTTP.BROWSER_Firefox" '
    'appcat="Web.Client" apprisk="elevated" duration=116 sentbyte=1188 '
    'rcvdbyte=1224 sentpkt=17 rcvdpkt=16 utmaction="allow" osname="Ubuntu"'
)

JOB_TIMEOUT = float(os.environ.get("SOC_JOB_TIMEOUT", "300"))
POLL_INTERVAL = float(os.environ.get("SOC_POLL_INTERVAL", "2"))

TERMINAL_STATES = {"completed", "failed"}
JOB_STATES = {"pending", "processing"} | TERMINAL_STATES
LOOKUP_STATES = {"not_requested", "queued", "running", "completed", "failed"}

# What GET /v1/results/{job_id} always returns, whatever state the job is in.
RESULT_FIELDS = {
    "job_id", "alert_id", "alert_name", "raw_log", "status", "ai_response",
    "error_message", "model_used", "processing_time_ms", "created_at",
    "completed_at", "splunk_requirements", "lookup_status",
}


def make_alert(name: str = "pytest alert", raw_log: str = BENIGN_LOG, **extra) -> dict:
    """A payload for POST /v1/analyze. The alert_id is unique per call, so two
    runs — or two tests — never collide, and PYTEST- makes the rows easy to
    find in the dashboard afterwards."""
    return {
        "alert_id": f"PYTEST-{uuid.uuid4().hex[:8]}",
        "alert_name": name,
        "raw_log": raw_log,
        **extra,
    }


def submit(client, alert: dict):
    return client.post("/v1/analyze", json=alert)


def wait_for_jobs(client, job_ids, timeout: float) -> dict[str, dict]:
    """Poll until every job is completed or failed.

    Returns job_id -> the last body seen. Raises AssertionError, naming the
    states, if any job is still running when the time is up.
    """
    deadline = time.monotonic() + timeout
    pending = set(job_ids)
    latest: dict[str, dict] = {}

    while pending:
        for job_id in sorted(pending):
            resp = client.get(f"/v1/results/{job_id}")
            assert resp.status_code == 200, (
                f"GET /v1/results/{job_id} -> {resp.status_code}: {resp.text}"
            )
            latest[job_id] = resp.json()
            if latest[job_id]["status"] in TERMINAL_STATES:
                pending.discard(job_id)

        if not pending:
            break
        if time.monotonic() >= deadline:
            states = {job_id: latest[job_id]["status"] for job_id in sorted(pending)}
            raise AssertionError(f"not finished after {timeout:.0f}s: {states}")
        time.sleep(POLL_INTERVAL)

    return latest


def wait_for_job(client, job_id: str, timeout: float = JOB_TIMEOUT) -> dict:
    return wait_for_jobs(client, [job_id], timeout)[job_id]
