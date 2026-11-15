"""FortiSOAR playbook simulator: CLI + web UI for POST /v1/analyze and GET /v1/results/{job_id}."""

from __future__ import annotations

import argparse
import http.server
import json
import os
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse

APP_DIR = Path(__file__).resolve().parent
DEFAULT_ALERTS_FILE = Path(os.environ.get("SOC_ALERTS_FILE") or (APP_DIR / "alerts" / "lab-alerts.json"))
UI_HTML_FILE = APP_DIR / "static" / "index.html"


def _http_json(method: str, url: str, api_key: str, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"X-API-Key": api_key, "Content-Type": "application/json"}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", errors="replace")
        try:
            return err.code, json.loads(raw)
        except json.JSONDecodeError:
            return err.code, {"detail": raw}
    except urllib.error.URLError as err:
        return 502, {"detail": f"Backend unreachable: {err.reason}"}


def _poll_job(base_url: str, api_key: str, job_id: str, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    url = f"{base_url}/v1/results/{job_id}"
    while True:
        status_code, data = _http_json("GET", url, api_key)
        if status_code != 200:
            raise RuntimeError(f"GET {url} -> {status_code}: {data}")
        state = data.get("status")
        if state in ("completed", "failed"):
            return data
        if time.monotonic() >= deadline:
            raise TimeoutError(f"job {job_id} still {state!r} after {timeout:.0f}s")
        time.sleep(2)


def _select_alerts(alerts: list[dict], ids: list[str] | None, send_all: bool) -> list[dict]:
    if send_all:
        return alerts
    if not ids:
        sys.exit("specify --id <ALERT_ID>, --all, --list, or --web")
    by_id = {a["alert_id"]: a for a in alerts}
    missing = [i for i in ids if i not in by_id]
    if missing:
        sys.exit(f"unknown alert_id(s): {', '.join(missing)}")
    return [by_id[i] for i in ids]


def _serve_web(
    alerts_file: Path,
    default_base_url: str,
    default_api_key: str,
    host: str,
    port: int,
) -> None:
    if not UI_HTML_FILE.is_file():
        sys.exit(f"missing UI template: {UI_HTML_FILE}")
    ui_bytes = UI_HTML_FILE.read_bytes()

    class Handler(http.server.BaseHTTPRequestHandler):
        def _send(self, code: int, content_type: str, body: bytes) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, code: int, payload: object) -> None:
            self._send(code, "application/json", json.dumps(payload).encode("utf-8"))

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == "/":
                self._send(200, "text/html; charset=utf-8", ui_bytes)
            elif parsed.path == "/health":
                self._send_json(200, {"status": "ok"})
            elif parsed.path == "/api/config":
                self._send_json(
                    200,
                    {"base_url": default_base_url, "has_env_key": bool(default_api_key)},
                )
            elif parsed.path == "/api/alerts":
                if not alerts_file.is_file():
                    self._send_json(404, {"detail": f"Alerts file not found: {alerts_file}"})
                    return
                self._send(200, "application/json", alerts_file.read_bytes())
            elif parsed.path.startswith("/api/results/"):
                job_id = parsed.path.removeprefix("/api/results/")
                qs = parse_qs(parsed.query)
                base_url = (qs.get("base_url") or [default_base_url])[0].rstrip("/")
                api_key = (qs.get("api_key") or [default_api_key])[0]
                code, resp = _http_json("GET", f"{base_url}/v1/results/{job_id}", api_key)
                if code >= 400:
                    print(f"[sim] GET /api/results/{job_id} -> {code}: {resp}", flush=True)
                self._send_json(code, resp)
            else:
                self._send_json(404, {"detail": "Not found"})

        def do_POST(self) -> None:
            if self.path != "/api/analyze":
                self._send_json(404, {"detail": "Not found"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                payload = body["payload"]
            except (ValueError, KeyError, TypeError) as err:
                self._send_json(400, {"detail": f"Invalid request body: {err}"})
                return

            base_url = (body.get("base_url") or default_base_url).rstrip("/")
            api_key = body.get("api_key") or default_api_key
            code, resp = _http_json("POST", f"{base_url}/v1/analyze", api_key, payload)
            alert_id = payload.get("alert_id", "?") if isinstance(payload, dict) else "?"
            job_id = resp.get("job_id", "-") if isinstance(resp, dict) else "-"
            print(f"[sim] POST /api/analyze alert={alert_id} -> {code} job={job_id}", flush=True)
            self._send_json(code, resp)

        def log_message(self, fmt: str, *args: object) -> None:
            pass

    class ReusableThreadingHTTPServer(http.server.ThreadingHTTPServer):
        allow_reuse_address = True
        daemon_threads = True

    server = ReusableThreadingHTTPServer((host, port), Handler)

    def _shutdown_handler(signum: int, _frame: object) -> None:
        print(f"[sim] received signal {signum}, shutting down...", flush=True)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _shutdown_handler)
    signal.signal(signal.SIGINT, _shutdown_handler)

    print(
        f"FortiSOAR Simulator UI: http://{host}:{port} (backend={default_base_url}, alerts={alerts_file})",
        flush=True,
    )
    try:
        server.serve_forever()
    finally:
        server.server_close()


def main(argv: list[str] | None = None) -> None:
    if sys.platform == "win32" and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="Simulate FortiSOAR sending alerts to SOC-AI-AGENT.")
    parser.add_argument("--file", type=Path, default=DEFAULT_ALERTS_FILE, help="Path to alerts JSON.")
    parser.add_argument("--list", action="store_true", help="List available alerts and exit.")
    parser.add_argument("--web", action="store_true", help="Start local web UI simulator.")
    parser.add_argument("--host", default=os.environ.get("SOC_SIM_HOST", "127.0.0.1"), help="Web UI bind host.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("SOC_SIM_PORT", "8090")), help="Web UI port.")
    parser.add_argument("--id", nargs="+", help="One or more alert_id values to send.")
    parser.add_argument("--all", action="store_true", help="Send all alerts in the file.")
    parser.add_argument("--dry-run", action="store_true", help="Print POST /v1/analyze payloads without sending.")
    parser.add_argument("--no-wait", action="store_true", help="Do not poll GET /v1/results/{job_id}.")
    parser.add_argument("--exact-id", action="store_true", help="Keep exact alert_id instead of adding a run suffix.")
    parser.add_argument("--base-url", default=os.environ.get("SOC_BASE_URL", "http://localhost:8082"))
    parser.add_argument("--api-key", default=os.environ.get("SOC_API_KEY", ""))
    parser.add_argument("--timeout", type=float, default=300.0, help="Poll timeout per job in seconds.")
    args = parser.parse_args(argv)

    if args.web:
        _serve_web(args.file, args.base_url.rstrip("/"), args.api_key, args.host, args.port)
        return

    alerts = json.loads(args.file.read_text(encoding="utf-8"))

    if args.list:
        for a in alerts:
            ind_count = len(a.get("indicators", []))
            print(f"{a['alert_id']}  [{ind_count} indicators]  {a['alert_name']}")
        return

    selected = _select_alerts(alerts, args.id, args.all)

    if not args.dry_run and not args.api_key:
        sys.exit("set SOC_API_KEY or pass --api-key (use --dry-run to preview without a key)")

    base_url = args.base_url.rstrip("/")
    run_tag = uuid.uuid4().hex[:4]
    queued: list[tuple[str, str]] = []

    for alert in selected:
        payload = dict(alert)
        if not args.exact_id:
            payload["alert_id"] = f"{alert['alert_id']}-{run_tag}"

        if args.dry_run:
            print(f"POST {base_url}/v1/analyze")
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            print("-" * 60)
            continue

        code, resp = _http_json("POST", f"{base_url}/v1/analyze", args.api_key, payload)
        if code != 202:
            sys.exit(f"POST /v1/analyze failed for {payload['alert_id']} ({code}): {resp}")
        job_id = resp["job_id"]
        queued.append((payload["alert_id"], job_id))
        print(f"[queued] {payload['alert_id']} -> job_id={job_id} ({payload['alert_name']})")

    if args.dry_run or args.no_wait:
        return

    for alert_id, job_id in queued:
        result = _poll_job(base_url, args.api_key, job_id, args.timeout)
        print(f"\n=== {alert_id} ({job_id}) -> {result['status']} ===")
        if result["status"] == "failed":
            print(f"error: {result.get('error_message')}")
            continue
        reqs = result.get("splunk_requirements") or []
        print(f"splunk_requirements: {len(reqs)}")
        for r in reqs:
            print(f"  - {r.get('requirement')} (fields={r.get('fields')}, scope={r.get('scope')})")
        print(f"ai_response:\n{result.get('ai_response') or ''}")


if __name__ == "__main__":
    main()
