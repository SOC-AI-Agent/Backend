"""FortiSOAR playbook simulator: CLI + local web UI for POST /v1/analyze and GET /v1/results/{job_id}."""

from __future__ import annotations

import argparse
import http.server
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

DEFAULT_ALERTS_FILE = Path(__file__).resolve().parent.parent / "samples" / "lab-alerts.json"

UI_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Alerts | FortiSOAR Simulator</title>
  <style>
    :root { color-scheme: dark; --bg:#141a21; --nav:#0f141a; --panel:#1b222c; --row:#1f2733; --border:#2d3746; --text:#e2e8f0; --muted:#8b99ad; --teal:#1eb6aa; --teal-dk:#168f86; --low:#2ea043; --med:#d29922; --high:#db6d28; --crit:#f85149; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: var(--bg); color: var(--text); font-size: 13px; display: flex; min-height: 100vh; }
    .sidebar { width: 48px; background: var(--nav); border-right: 1px solid var(--border); display: flex; flex-direction: column; align-items: center; padding: 10px 0; gap: 14px; flex-shrink: 0; }
    .nav-icon { width: 34px; height: 34px; border-radius: 6px; display: grid; place-items: center; color: var(--muted); cursor: pointer; font-size: 15px; }
    .nav-icon.active { background: #1e2c38; color: var(--teal); border-left: 3px solid var(--teal); border-radius: 0 6px 6px 0; width: 48px; }
    .shell { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .topbar { height: 46px; background: var(--nav); border-bottom: 1px solid var(--border); padding: 0 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .brand { font-weight: 700; letter-spacing: .4px; color: var(--teal); font-size: 14px; }
    .cfg { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    input, textarea, select { font: inherit; color: var(--text); background: #0f141a; border: 1px solid var(--border); border-radius: 4px; padding: 5px 8px; }
    button { font: inherit; color: #fff; background: var(--teal); border: 1px solid var(--teal); border-radius: 4px; padding: 5px 12px; cursor: pointer; font-weight: 600; }
    button:hover { background: var(--teal-dk); }
    button.sec { background: var(--panel); border-color: var(--border); color: var(--text); }
    button.sec:hover { border-color: var(--teal); }
    .content { padding: 16px 20px; flex: 1; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    h1 { margin: 0; font-size: 20px; font-weight: 600; }
    .toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .count { color: var(--muted); margin-right: 4px; }
    .table-wrap { background: var(--panel); border: 1px solid var(--border); border-radius: 4px; overflow: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 820px; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
    th { background: #161d26; color: var(--muted); font-weight: 600; font-size: 12px; }
    tr.filter-row th { padding: 4px 8px; background: #141a21; }
    tr.filter-row input { width: 100%; padding: 3px 6px; font-size: 12px; }
    tbody tr { cursor: pointer; }
    tbody tr:hover { background: var(--row); }
    tbody tr.selected { background: #1b2d38; }
    .pill { display: inline-block; padding: 2px 10px; border-radius: 3px; font-size: 11px; font-weight: 700; color: #fff; min-width: 64px; text-align: center; }
    .sev-Low { background: var(--low); }
    .sev-Medium { background: var(--med); }
    .sev-High { background: var(--high); }
    .sev-Critical { background: var(--crit); }
    .st-Open { color: var(--muted); }
    .st-queued, .st-pending, .st-processing { color: var(--med); font-weight: 600; }
    .st-completed { color: var(--low); font-weight: 600; }
    .st-failed { color: var(--crit); font-weight: 600; }
    .drawer { position: fixed; top: 46px; right: 0; bottom: 0; width: 480px; max-width: 95vw; background: var(--panel); border-left: 2px solid var(--teal); box-shadow: -8px 0 24px rgba(0,0,0,.5); display: none; flex-direction: column; z-index: 20; }
    .drawer.open { display: flex; }
    .drawer-head { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: #161d26; }
    .drawer-body { padding: 14px 16px; overflow: auto; display: flex; flex-direction: column; gap: 10px; flex: 1; }
    label { font-size: 11px; color: var(--muted); display: block; margin-bottom: 3px; }
    textarea { width: 100%; font-family: ui-monospace, Consolas, monospace; font-size: 12px; resize: vertical; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; background: #0f141a; border: 1px solid var(--border); border-radius: 4px; padding: 10px; font-size: 12px; font-family: ui-monospace, Consolas, monospace; }
  </style>
</head>
<body>
  <aside class="sidebar" title="FortiSOAR Simulator">
    <div class="nav-icon">&#9635;</div>
    <div class="nav-icon">&#128737;</div>
    <div class="nav-icon active" title="Alerts">&#9889;</div>
    <div class="nav-icon">&#9881;</div>
  </aside>
  <div class="shell">
    <header class="topbar">
      <div class="brand">FortiSOAR Simulator &middot; SOC-AI-AGENT</div>
      <div class="cfg">
        <input id="baseUrl" size="24" placeholder="http://localhost:8082" title="Backend Base URL" />
        <input id="apiKey" type="password" size="24" placeholder="X-API-Key" title="X-API-Key" />
      </div>
    </header>
    <div class="content">
      <h1>Alerts</h1>
      <div class="toolbar">
        <span class="count" id="itemCount">0 Items</span>
        <button class="sec" onclick="init()" title="Reload">&#8635;</button>
        <button onclick="openNewAlert()">+ Add</button>
        <button onclick="executeSelected()">&#9654; Execute Playbook</button>
        <label style="margin:0 0 0 8px;display:flex;align-items:center;gap:4px;cursor:pointer">
          <input type="checkbox" id="exactId" /> Keep exact ID
        </label>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:32px"><input type="checkbox" id="chkAll" onchange="toggleAll(this.checked)" /></th>
              <th>ID</th>
              <th>Severity</th>
              <th>Assigned To</th>
              <th>Name</th>
              <th>Source</th>
              <th>Type</th>
              <th>Status</th>
            </tr>
            <tr class="filter-row">
              <th></th>
              <th><input id="fltId" placeholder="Search" oninput="renderTable()" /></th>
              <th></th>
              <th></th>
              <th><input id="fltName" placeholder="Search" oninput="renderTable()" /></th>
              <th><input id="fltSrc" placeholder="Search" oninput="renderTable()" /></th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody id="tbody"></tbody>
        </table>
      </div>
    </div>
  </div>

  <aside class="drawer" id="drawer">
    <div class="drawer-head">
      <strong id="drawerTitle">Alert Detail</strong>
      <button class="sec" onclick="closeDrawer()">&times;</button>
    </div>
    <div class="drawer-body">
      <div><label>alert_id</label><input id="fId" style="width:100%" /></div>
      <div><label>alert_name</label><input id="fName" style="width:100%" /></div>
      <div><label>raw_log</label><textarea id="fRaw" rows="6"></textarea></div>
      <div><label>indicators (JSON)</label><textarea id="fInd" rows="4"></textarea></div>
      <div style="display:flex;gap:8px">
        <button onclick="runFromDrawer()">&#9654; Execute Triage Playbook</button>
        <button class="sec" id="saveNewBtn" style="display:none" onclick="saveNewAlert()">Save to Queue</button>
      </div>
      <div id="resultBox" style="display:none">
        <label>Playbook Result (<span id="resStatus"></span>)</label>
        <pre id="resOut"></pre>
      </div>
    </div>
  </aside>

  <script>
    let rows = [];
    let activeIdx = -1;

    function inferMeta(a) {
      const n = (a.alert_name || '').toLowerCase();
      if (n.includes('webshell') || n.includes('service') || n.includes('system')) return { sev: 'High', src: n.includes('sysmon') ? 'Splunk - Sysmon' : n.includes('7045') ? 'Splunk - WinEventLog' : 'Splunk - Apache', type: n.includes('webshell') ? 'Web Attack' : n.includes('sysmon') ? 'Execution' : 'Persistence' };
      if (n.includes('logon')) return { sev: 'Medium', src: 'Splunk - WinEventLog', type: 'Lateral Movement' };
      return { sev: 'Low', src: 'Splunk - Apache', type: 'Reconnaissance' };
    }

    async function init() {
      const cfg = await (await fetch('/api/config')).json();
      document.getElementById('baseUrl').value = cfg.base_url;
      if (cfg.has_env_key) document.getElementById('apiKey').placeholder = 'Using SOC_API_KEY env (or override)';
      const alerts = await (await fetch('/api/alerts')).json();
      rows = alerts.map(a => ({ ...a, ...inferMeta(a), assigned: 'SOC Tier 1', status: 'Open', checked: false, job: null }));
      renderTable();
    }

    function renderTable() {
      const fId = document.getElementById('fltId').value.toLowerCase();
      const fName = document.getElementById('fltName').value.toLowerCase();
      const fSrc = document.getElementById('fltSrc').value.toLowerCase();
      const tb = document.getElementById('tbody');
      tb.innerHTML = '';
      let visible = 0;
      rows.forEach((r, i) => {
        if (fId && !r.alert_id.toLowerCase().includes(fId)) return;
        if (fName && !r.alert_name.toLowerCase().includes(fName)) return;
        if (fSrc && !r.src.toLowerCase().includes(fSrc)) return;
        visible++;
        const tr = document.createElement('tr');
        if (i === activeIdx) tr.className = 'selected';
        tr.onclick = (e) => { if (e.target.type !== 'checkbox') openDrawer(i); };
        tr.innerHTML = `
          <td><input type="checkbox" ${r.checked ? 'checked' : ''} onchange="rows[${i}].checked=this.checked" /></td>
          <td style="color:var(--teal);font-weight:600">${esc(r.alert_id)}</td>
          <td><span class="pill sev-${r.sev}">${r.sev}</span></td>
          <td style="color:var(--teal)">${esc(r.assigned)}</td>
          <td>${esc(r.alert_name)}</td>
          <td>${esc(r.src)}</td>
          <td>${esc(r.type)}</td>
          <td class="st-${r.status}">${esc(r.status)}</td>`;
        tb.appendChild(tr);
      });
      document.getElementById('itemCount').textContent = visible + ' Items';
    }

    function toggleAll(v) { rows.forEach(r => r.checked = v); renderTable(); }

    function openDrawer(i) {
      activeIdx = i;
      const r = rows[i];
      document.getElementById('drawerTitle').textContent = r.alert_id;
      document.getElementById('fId').value = r.alert_id;
      document.getElementById('fName').value = r.alert_name;
      document.getElementById('fRaw').value = r.raw_log;
      document.getElementById('fInd').value = JSON.stringify(r.indicators || [], null, 2);
      document.getElementById('saveNewBtn').style.display = 'none';
      showJobResult(r.job);
      document.getElementById('drawer').classList.add('open');
      renderTable();
    }

    function openNewAlert() {
      activeIdx = -1;
      document.getElementById('drawerTitle').textContent = 'New Alert';
      document.getElementById('fId').value = 'FSR-CUSTOM-' + Math.random().toString(16).slice(2, 6).toUpperCase();
      document.getElementById('fName').value = '';
      document.getElementById('fRaw').value = '';
      document.getElementById('fInd').value = '[]';
      document.getElementById('saveNewBtn').style.display = 'inline-block';
      showJobResult(null);
      document.getElementById('drawer').classList.add('open');
    }

    function saveNewAlert() {
      let ind = [];
      try { ind = JSON.parse(document.getElementById('fInd').value || '[]'); } catch (e) { return alert('Invalid JSON: ' + e.message); }
      const a = { alert_id: document.getElementById('fId').value.trim(), alert_name: document.getElementById('fName').value.trim(), raw_log: document.getElementById('fRaw').value, indicators: ind };
      rows.unshift({ ...a, ...inferMeta(a), assigned: 'SOC Tier 1', status: 'Open', checked: true, job: null });
      openDrawer(0);
    }

    function closeDrawer() { document.getElementById('drawer').classList.remove('open'); }

    function showJobResult(job) {
      const box = document.getElementById('resultBox');
      if (!job) { box.style.display = 'none'; return; }
      box.style.display = 'block';
      document.getElementById('resStatus').textContent = job.status + (job.job_id ? ` (${job.job_id})` : '');
      if (job.error_message) {
        document.getElementById('resOut').textContent = 'Error: ' + job.error_message;
      } else if (job.status === 'completed') {
        const reqs = (job.splunk_requirements || []).map(r => `- ${r.requirement} [fields=${(r.fields||[]).join(',')}, scope=${r.scope}]`).join('\\n');
        document.getElementById('resOut').textContent = (reqs ? `Splunk Requirements:\\n${reqs}\\n\\n` : '') + `AI Response:\\n${job.ai_response || ''}`;
      } else {
        document.getElementById('resOut').textContent = 'Waiting for SOC-AI-AGENT...';
      }
    }

    async function executeSelected() {
      const targets = rows.map((r, i) => r.checked ? i : -1).filter(i => i >= 0);
      if (!targets.length) return alert('Select at least one alert checkbox first.');
      for (const i of targets) await runRow(i);
    }

    async function runFromDrawer() {
      let ind = [];
      try { ind = JSON.parse(document.getElementById('fInd').value || '[]'); } catch (e) { return alert('Invalid JSON: ' + e.message); }
      if (activeIdx >= 0) {
        rows[activeIdx].alert_id = document.getElementById('fId').value.trim();
        rows[activeIdx].alert_name = document.getElementById('fName').value.trim();
        rows[activeIdx].raw_log = document.getElementById('fRaw').value;
        rows[activeIdx].indicators = ind;
        await runRow(activeIdx);
      } else {
        saveNewAlert();
        await runRow(0);
      }
    }

    async function runRow(i) {
      const r = rows[i];
      const baseUrl = document.getElementById('baseUrl').value.trim();
      const apiKey = document.getElementById('apiKey').value.trim();
      const suffix = document.getElementById('exactId').checked ? '' : '-' + Math.random().toString(16).slice(2, 6);
      const payload = { alert_id: r.alert_id + suffix, alert_name: r.alert_name, raw_log: r.raw_log, indicators: r.indicators || [] };
      r.status = 'queued';
      r.job = { status: 'submitting' };
      renderTable();
      if (activeIdx === i) showJobResult(r.job);
      try {
        const res = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, payload }) });
        const data = await res.json();
        if (res.status !== 202) {
          r.status = 'failed';
          r.job = { status: 'failed', error_message: `${res.status}: ${JSON.stringify(data)}` };
          renderTable(); if (activeIdx === i) showJobResult(r.job);
          return;
        }
        r.job = { job_id: data.job_id, status: data.status || 'queued' };
        r.status = r.job.status;
        renderTable(); if (activeIdx === i) showJobResult(r.job);
        const qs = new URLSearchParams({ base_url: baseUrl });
        if (apiKey) qs.set('api_key', apiKey);
        while (true) {
          await new Promise(ok => setTimeout(ok, 2000));
          const jr = await (await fetch(`/api/results/${encodeURIComponent(data.job_id)}?${qs}`)).json();
          r.job = jr;
          r.status = jr.status || 'unknown';
          renderTable(); if (activeIdx === i) showJobResult(r.job);
          if (jr.status === 'completed' || jr.status === 'failed') break;
        }
      } catch (e) {
        r.status = 'failed';
        r.job = { status: 'failed', error_message: e.message };
        renderTable(); if (activeIdx === i) showJobResult(r.job);
      }
    }

    function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    init();
  </script>
</body>
</html>
"""


def _http_json(method: str, url: str, api_key: str, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"X-API-Key": api_key, "Content-Type": "application/json"}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
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


def _serve_web(alerts_file: Path, default_base_url: str, default_api_key: str, host: str, port: int) -> None:
    from urllib.parse import parse_qs, urlparse

    class Handler(http.server.BaseHTTPRequestHandler):
        def _send(self, code: int, content_type: str, body: bytes) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == "/":
                self._send(200, "text/html; charset=utf-8", UI_HTML.encode("utf-8"))
            elif parsed.path == "/api/config":
                cfg = {"base_url": default_base_url, "has_env_key": bool(default_api_key)}
                self._send(200, "application/json", json.dumps(cfg).encode("utf-8"))
            elif parsed.path == "/api/alerts":
                self._send(200, "application/json", alerts_file.read_bytes())
            elif parsed.path.startswith("/api/results/"):
                job_id = parsed.path.removeprefix("/api/results/")
                qs = parse_qs(parsed.query)
                base_url = (qs.get("base_url") or [default_base_url])[0].rstrip("/")
                api_key = (qs.get("api_key") or [default_api_key])[0]
                code, resp = _http_json("GET", f"{base_url}/v1/results/{job_id}", api_key)
                self._send(code, "application/json", json.dumps(resp).encode("utf-8"))
            else:
                self._send(404, "application/json", b'{"detail":"Not found"}')

        def do_POST(self) -> None:
            if self.path != "/api/analyze":
                self._send(404, "application/json", b'{"detail":"Not found"}')
                return
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            base_url = (body.get("base_url") or default_base_url).rstrip("/")
            api_key = body.get("api_key") or default_api_key
            code, resp = _http_json("POST", f"{base_url}/v1/analyze", api_key, body["payload"])
            self._send(code, "application/json", json.dumps(resp).encode("utf-8"))

        def log_message(self, fmt: str, *args: object) -> None:
            pass

    server = http.server.ThreadingHTTPServer((host, port), Handler)
    print(f"FortiSOAR Simulator UI: http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


def main() -> None:
    if sys.platform == "win32" and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="Simulate FortiSOAR sending alerts to SOC-AI-AGENT.")
    parser.add_argument("--file", type=Path, default=DEFAULT_ALERTS_FILE, help="Path to alerts JSON.")
    parser.add_argument("--list", action="store_true", help="List available alerts and exit.")
    parser.add_argument("--web", action="store_true", help="Start local web UI simulator.")
    parser.add_argument("--host", default="127.0.0.1", help="Web UI bind host.")
    parser.add_argument("--port", type=int, default=8090, help="Web UI port.")
    parser.add_argument("--id", nargs="+", help="One or more alert_id values to send.")
    parser.add_argument("--all", action="store_true", help="Send all alerts in the file.")
    parser.add_argument("--dry-run", action="store_true", help="Print POST /v1/analyze payloads without sending.")
    parser.add_argument("--no-wait", action="store_true", help="Do not poll GET /v1/results/{job_id}.")
    parser.add_argument("--exact-id", action="store_true", help="Keep exact alert_id instead of adding a run suffix.")
    parser.add_argument("--base-url", default=os.environ.get("SOC_BASE_URL", "http://localhost:8082"))
    parser.add_argument("--api-key", default=os.environ.get("SOC_API_KEY", ""))
    parser.add_argument("--timeout", type=float, default=300.0, help="Poll timeout per job in seconds.")
    args = parser.parse_args()

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
