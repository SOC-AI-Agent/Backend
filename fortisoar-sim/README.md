# FortiSOAR Simulator (`soc-fortisoar-sim`)

Self-contained Docker image for the FortiSOAR playbook simulator (Web UI + CLI) targeting `POST /v1/analyze` and `GET /v1/results/{job_id}`.

## Layout

- `app.py` — HTTP proxy / web UI server and CLI runner (Python stdlib only)
- `static/index.html` — Dark FortiSOAR-style web UI
- `alerts/lab-alerts.json` — Default lab alerts (`FSR-LAB-001`..`042`), each built on a real event from the lab logs:
  - `001`..`020` — the web server KBTG-Bootcamp (directory scan, web shell, service install)
  - `021`..`027` — one per synthetic scenario (`gen_*.csv`), named as its playbook
  - `028`..`036` — the same attacks under other names: an alias, a later step of the chain, or a name that matches nothing, with a `use_case_id` as a SOAR synced with the SIEM would send
  - `037`..`042` — false positives: a playbook's alert name on an ordinary event (a mistyped password, Defender reading lsass, an SPF lookup), which the playbook's False Condition should close
- `Dockerfile` — Non-root `python:3.12-slim` image with `/health` healthcheck
- `docker-compose.yml` — Standalone Compose attached to `soc-network`

## Run with Docker Compose

Included automatically in `Backend/deploy/vps-demo.yml`, or run standalone:

```bash
cd Backend/fortisoar-sim
docker compose up -d --build
```

Open: `http://<HOST>:8090`

## Environment Variables

| Variable | Default (Docker) | Purpose |
| --- | --- | --- |
| `SOC_BASE_URL` | `http://soc-core-api:8000` | Default Backend base URL shown in the UI and used by CLI |
| `SOC_API_KEY` | `""` | Default `X-API-Key` (optional; can also be typed in the UI topbar) |
| `SOC_ALERTS_FILE` | `/app/alerts/lab-alerts.json` | Alerts JSON loaded by `GET /api/alerts` |
| `SOC_SIM_HOST` | `0.0.0.0` | Bind host for `--web` |
| `SOC_SIM_PORT` | `8090` | Listen port for `--web` |

## CLI one-off via Docker

```bash
docker compose run --rm soc-fortisoar-sim --list
docker compose run --rm -e SOC_API_KEY=<key> soc-fortisoar-sim --id FSR-LAB-001
```
