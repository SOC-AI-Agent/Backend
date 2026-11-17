#!/usr/bin/env bash
#
# Deploy the full SOC-AI-Agent demo stack on an Ubuntu 26.04.1 LTS VPS
# (8 vCPU / 32 GB RAM) using an external OpenAI-compatible LLM API + API key
# with multiple selectable models (dall-m-llamacpp stays defined in
# vps-agent.override.yml under `local-llm` profile and is NOT started).
#
# Usage (run from Backend/):
#   LLM_API_KEY="sk-or-v1-..." ./deploy/vps-demo.sh [--host <VPS_IP_OR_DOMAIN>] [--force]
#
# Optional environment overrides:
#   VPS_HOST                 Public IP or domain (auto-detected if omitted)
#   LLM_BASE_URL             OpenAI-compatible base URL (default: https://openrouter.ai/api/v1)
#   LLM_API_KEY              API key for LLM_BASE_URL (prompted if unset)
#   LLM_PROVIDER             Provider label in Agent-Server UI (default: openrouter)
#   LLM_MODELS               Comma-separated OpenRouter model IDs (default: google/gemma-4-31b-it:free,openrouter/free,meta-llama/llama-3.1-8b-instruct,qwen/qwen3.7-flash,google/gemini-2.5-flash-lite)
#   SPLUNK_ADMIN_PASSWORD    Admin password for Splunk Web UI (:8000)
#   AGENT_ADMIN_PASSWORD     Admin password for Agent-Server UI (:7100)
#   DASHBOARD_ADMIN_USER     Username for SOC Dashboard (default: admin)
#   DASHBOARD_ADMIN_PASSWORD Admin password for SOC Dashboard (:3002)
#   CONFLUENCE_BASE_URL, CONFLUENCE_SPACE_KEY, CONFLUENCE_EMAIL,
#   CONFLUENCE_API_TOKEN, CONFLUENCE_PROXY

set -euo pipefail

FORCE=0
YES=0
VPS_HOST="${VPS_HOST:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    -y|--yes) YES=1; shift ;;
    --host)  VPS_HOST="${2:?missing value for --host}"; shift 2 ;;
    -h|--help)
      sed -n '2,28p' "$0"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPOS="$(cd "$HERE/.." && pwd)"

for cmd in docker python3 openssl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required command: $cmd" >&2; exit 1; }
done
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required" >&2; exit 1; }

for r in Agent-Server AI-Service Backend Frontend MCP-Server; do
  [ -d "$REPOS/$r" ] || { echo "Missing sibling repo: $REPOS/$r" >&2; exit 1; }
done

if [ -z "$VPS_HOST" ]; then
  VPS_HOST="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}' || true)"
  [ -n "$VPS_HOST" ] || VPS_HOST="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  [ -n "$VPS_HOST" ] || VPS_HOST="localhost"
fi
echo "==> Using VPS host address: $VPS_HOST"

gen_hex() { openssl rand -hex 32; }
gen_pw()  { openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 16; }

kept() {
  local file="$1" key="$2"
  [ "$FORCE" = 0 ] && [ -f "$file" ] || return 0
  sed -n "s/^$key=//p" "$file" | tail -n 1
}

sync_env_kv() {
  local dst="$1"
  shift
  python3 - "$dst" "$@" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
pairs = {}
for item in sys.argv[2:]:
    k, _, v = item.partition("=")
    pairs[k] = v

lines = path.read_text().splitlines() if path.exists() else []
seen = set()
updated = []
changed = False
for line in lines:
    stripped = line.lstrip()
    if "=" in line and not stripped.startswith("#"):
        k, _, old = line.partition("=")
        k_clean = k.strip()
        if k_clean in pairs:
            seen.add(k_clean)
            if old != pairs[k_clean]:
                updated.append(f"{k_clean}={pairs[k_clean]}")
                changed = True
                continue
    updated.append(line)

for k, v in pairs.items():
    if k not in seen:
        updated.append(f"{k}={v}")
        changed = True

if changed:
    path.write_text("\n".join(updated) + "\n")
    print(f"  {path.parent.name}: synced shared keys ({', '.join(pairs.keys())})")
PY
}

write_env() {
  local dir="$1" src="$REPOS/$1/.env.example" dst="$REPOS/$1/.env"
  shift
  [ -f "$src" ] || { echo "  $dir: no .env.example, skipped"; return; }
  if [ -f "$dst" ] && [ "$FORCE" = 0 ]; then
    echo "  $dir: .env exists, kept (--force to overwrite)"
    if [ $# -gt 0 ]; then
      sync_env_kv "$dst" "$@"
    fi
    return
  fi
  : > "$dst"
  local filled=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) printf '%s\n' "$line" >> "$dst"; continue ;; esac
    local key=${line%%=*}
    if [ "$key" = "$line" ]; then printf '%s\n' "$line" >> "$dst"; continue; fi
    if [ -n "${!key+x}" ]; then
      printf '%s=%s\n' "$key" "${!key}" >> "$dst"
      filled=$((filled + 1))
    else
      printf '%s\n' "$line" >> "$dst"
    fi
  done < "$src"
  chmod 600 "$dst"
  echo "  $dir: .env written ($filled values filled)"
}

# ── 1. Prepare secrets, LLM API config & .env files ─────────────────────────
echo "==> [1/6] Preparing .env files"
CREDS_FILE="$HERE/deploy/.demo-credentials.env"

LLM_BASE_URL_VAL="${LLM_BASE_URL:-$(kept "$REPOS/Agent-Server/.env" LLM_BASE_URL)}"
LLM_BASE_URL_VAL="${LLM_BASE_URL_VAL:-https://openrouter.ai/api/v1}"

LLM_API_KEY_VAL="${LLM_API_KEY:-$(kept "$REPOS/Agent-Server/.env" LLM_API_KEY)}"
if [ -z "$LLM_API_KEY_VAL" ] && [ "$YES" = 0 ] && [ -t 0 ]; then
  read -r -p "Enter LLM_BASE_URL [$LLM_BASE_URL_VAL]: " input_url
  [ -n "$input_url" ] && LLM_BASE_URL_VAL="$input_url"
  read -r -s -p "Enter OpenRouter LLM_API_KEY (sk-or-v1-...): " LLM_API_KEY_VAL
  echo ""
fi
if [ -z "$LLM_API_KEY_VAL" ]; then
  echo "Missing LLM_API_KEY. Run: LLM_API_KEY='sk-or-v1-...' ./deploy/vps-demo.sh" >&2
  exit 1
fi

LLM_PROVIDER_VAL="${LLM_PROVIDER:-$(kept "$REPOS/Agent-Server/.env" LLM_PROVIDER)}"
LLM_PROVIDER_VAL="${LLM_PROVIDER_VAL:-openrouter}"

DEFAULT_OPENROUTER_MODELS="google/gemma-4-31b-it:free,openrouter/free,meta-llama/llama-3.1-8b-instruct,qwen/qwen3.7-flash,google/gemini-2.5-flash-lite"
LLM_MODELS_VAL="${LLM_MODELS:-$(kept "$REPOS/Agent-Server/.env" LLM_MODELS)}"
if [ -z "$LLM_MODELS_VAL" ] && [ "$YES" = 0 ] && [ -t 0 ]; then
  read -r -p "Enter comma-separated LLM_MODELS [$DEFAULT_OPENROUTER_MODELS]: " input_models
  [ -n "$input_models" ] && LLM_MODELS_VAL="$input_models"
fi
LLM_MODELS_VAL="${LLM_MODELS_VAL:-$DEFAULT_OPENROUTER_MODELS}"
PRIMARY_MODEL="${LLM_MODELS_VAL%%,*}"

# The agent that writes the SPL (stage 2) and the model it is created with.
# LLM_SPL_AGENT= (empty) turns it off: the Splunk connector writes the SPL itself.
SPL_AGENT_VAL="${LLM_SPL_AGENT-soc-spl-writer}"
SPL_MODEL_VAL="${LLM_SPL_MODEL:-google/gemini-2.5-flash}"

MCP_TOKEN="$(kept "$REPOS/Backend/.env" MCP_AUTH_TOKEN)"
MCP_TOKEN="${MCP_TOKEN:-$(gen_hex)}"

AI_TOKEN="$(kept "$REPOS/Backend/.env" AI_SERVICE_AUTH_TOKEN)"
AI_TOKEN="${AI_TOKEN:-$(gen_hex)}"

JWT_SECRET_KEY_VAL="$(kept "$REPOS/Backend/.env" JWT_SECRET_KEY)"
JWT_SECRET_KEY_VAL="${JWT_SECRET_KEY_VAL:-$(gen_hex)}"

PG_PASS="$(kept "$REPOS/Backend/.env" POSTGRES_PASSWORD)"
PG_PASS="${PG_PASS:-$(gen_pw)}"

AGENT_DB_PASS="$(kept "$REPOS/Agent-Server/.env" DB_PASSWORD)"
AGENT_DB_PASS="${AGENT_DB_PASS:-$(gen_pw)}"

AGENT_JWT="$(kept "$REPOS/Agent-Server/.env" JWT_SECRET)"
AGENT_JWT="${AGENT_JWT:-$(gen_hex)}"

SPLUNK_ADMIN_PASS="${SPLUNK_ADMIN_PASSWORD:-$(sed -n 's/^SPLUNK_PASSWORD=//p' "$REPOS/MCP-Server/external/splunk/.env" 2>/dev/null | tail -n 1 || true)}"
SPLUNK_ADMIN_PASS="${SPLUNK_ADMIN_PASS:-$(gen_pw)}"

AGENT_ADMIN_PASS="${AGENT_ADMIN_PASSWORD:-$(kept "$CREDS_FILE" AGENT_ADMIN_PASSWORD)}"
AGENT_ADMIN_PASS="${AGENT_ADMIN_PASS:-$(gen_pw)}"

DASHBOARD_ADMIN_USER="${DASHBOARD_ADMIN_USER:-admin}"
DASHBOARD_ADMIN_EMAIL="${DASHBOARD_ADMIN_EMAIL:-admin@soc-demo.local}"
DASHBOARD_ADMIN_PASS="${DASHBOARD_ADMIN_PASSWORD:-$(kept "$CREDS_FILE" DASHBOARD_ADMIN_PASSWORD)}"
DASHBOARD_ADMIN_PASS="${DASHBOARD_ADMIN_PASS:-$(gen_pw)}"

CONFLUENCE_MCP_TOKEN="$(gen_hex)"

# CONFLUENCE_* given to this script go into Backend/.env even when it already
# exists: without them the worker never syncs, soc-ai's playbook index (Qdrant)
# stays empty, and no alert gets a playbook as reference.
CONFLUENCE_PAIRS=()
for key in CONFLUENCE_BASE_URL CONFLUENCE_SPACE_KEY CONFLUENCE_EMAIL CONFLUENCE_API_TOKEN CONFLUENCE_PROXY; do
  if [ -n "${!key:-}" ]; then CONFLUENCE_PAIRS+=("$key=${!key}"); fi
done

# Backend/.env (ThreatQ disabled, Confluence passed through if provided)
POSTGRES_PASSWORD="$PG_PASS" \
CORE_DATABASE_URL="postgresql://socai:${PG_PASS}@soc-db:5432/socai" \
DATABASE_URL="postgresql+asyncpg://socai:${PG_PASS}@soc-db:5432/socai" \
AI_SERVICE_AUTH_TOKEN="$AI_TOKEN" \
MCP_AUTH_TOKEN="$MCP_TOKEN" \
JWT_SECRET_KEY="$JWT_SECRET_KEY_VAL" \
THREATQ_BASE_URL="" \
SPLUNK_LOOKUP_MODE="${SPLUNK_LOOKUP_MODE:-manual}" \
SPLUNK_ALERT_FREQUENCY="false" \
LLM_SPL_AGENT="$SPL_AGENT_VAL" \
OLLAMA_MODEL="$PRIMARY_MODEL" \
ALLOWED_ORIGINS="http://${VPS_HOST}:3002,http://localhost:3002,http://soc-frontend" \
  write_env Backend \
    "AI_SERVICE_AUTH_TOKEN=$AI_TOKEN" \
    "MCP_AUTH_TOKEN=$MCP_TOKEN" \
    "SPLUNK_ALERT_FREQUENCY=false" \
    "LLM_SPL_AGENT=$SPL_AGENT_VAL" \
    "ALLOWED_ORIGINS=http://${VPS_HOST}:3002,http://localhost:3002,http://soc-frontend" \
    ${CONFLUENCE_PAIRS[@]+"${CONFLUENCE_PAIRS[@]}"}

# AI-Service/.env
AI_SERVICE_AUTH_TOKEN="$AI_TOKEN" \
LLM_SERVER_URL="http://host.docker.internal:8001" \
  write_env AI-Service \
    "AI_SERVICE_AUTH_TOKEN=$AI_TOKEN" \
    "LLM_SERVER_URL=http://host.docker.internal:8001"

# MCP-Server/.env
MCP_AUTH_TOKEN="$MCP_TOKEN" \
CONFLUENCE_MCP_AUTH_TOKEN="$CONFLUENCE_MCP_TOKEN" \
SPLUNK_ALERT_INDEX="" \
  write_env MCP-Server \
    "MCP_AUTH_TOKEN=$MCP_TOKEN" \
    "SPLUNK_ALERT_INDEX="

# MCP-Server/external/splunk/.env
SPLUNK_PASSWORD="$SPLUNK_ADMIN_PASS" \
  write_env MCP-Server/external/splunk

# Agent-Server/.env (external API key + multi-model list)
DB_PASSWORD="$AGENT_DB_PASS" \
JWT_SECRET="$AGENT_JWT" \
NEXT_PUBLIC_BASE_URL="http://${VPS_HOST}:8001" \
NEXT_PUBLIC_LLM_BASE_URL="http://${VPS_HOST}:8080" \
LLM_BASE_URL="$LLM_BASE_URL_VAL" \
LLM_API_KEY="$LLM_API_KEY_VAL" \
LLM_PROVIDER="$LLM_PROVIDER_VAL" \
LLM_MODELS="$LLM_MODELS_VAL" \
  write_env Agent-Server \
    "NEXT_PUBLIC_BASE_URL=http://${VPS_HOST}:8001" \
    "NEXT_PUBLIC_LLM_BASE_URL=http://${VPS_HOST}:8080" \
    "LLM_BASE_URL=$LLM_BASE_URL_VAL" \
    "LLM_API_KEY=$LLM_API_KEY_VAL" \
    "LLM_PROVIDER=$LLM_PROVIDER_VAL" \
    "LLM_MODELS=$LLM_MODELS_VAL"

# Persist demo admin credentials locally (gitignored via *.env)
cat > "$CREDS_FILE" <<EOF
VPS_HOST=$VPS_HOST
LLM_BASE_URL=$LLM_BASE_URL_VAL
LLM_MODELS=$LLM_MODELS_VAL
DASHBOARD_ADMIN_USER=$DASHBOARD_ADMIN_USER
DASHBOARD_ADMIN_PASSWORD=$DASHBOARD_ADMIN_PASS
AGENT_ADMIN_USERNAME=admin
AGENT_ADMIN_PASSWORD=$AGENT_ADMIN_PASS
SPLUNK_ADMIN_USERNAME=admin
SPLUNK_ADMIN_PASSWORD=$SPLUNK_ADMIN_PASS
EOF
chmod 600 "$CREDS_FILE"

# ── 2. Shared Docker network ────────────────────────────────────────────────
echo "==> [2/6] Ensuring Docker network soc-network exists"
docker network inspect soc-network >/dev/null 2>&1 || docker network create soc-network

# ── 3. Agent-Server (external LLM API mode; dall-m-llamacpp not started) ────
echo "==> [3/6] Starting Agent-Server (API key mode -> $LLM_BASE_URL_VAL)"
(
  cd "$REPOS/Agent-Server"
  docker compose -f docker-compose.yml -f "$HERE/deploy/vps-agent.override.yml" up -d --build
)

echo "    Waiting for dall-m-server (:8001)..."
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8001/ >/dev/null 2>&1; then
    break
  fi
  if [ "$i" = 60 ]; then
    echo "Timed out waiting for Agent-Server (:8001). Check: docker compose -f Agent-Server/docker-compose.yml logs -f" >&2
    exit 1
  fi
  sleep 3
done

echo "    Bootstrapping Agent-Server database & admin user..."
(
  cd "$REPOS/Agent-Server"
  docker compose -f docker-compose.yml -f "$HERE/deploy/vps-agent.override.yml" \
    run --rm -T --no-deps -v "$PWD/script:/app/script:ro" \
    dall-m-server python /app/script/create_db.py
  docker compose -f docker-compose.yml -f "$HERE/deploy/vps-agent.override.yml" \
    run --rm -T --no-deps \
    -e AGENT_ADMIN_USERNAME=admin \
    -e AGENT_ADMIN_PASSWORD="$AGENT_ADMIN_PASS" \
    -v "$PWD/script:/app/script:ro" \
    dall-m-server python /app/script/add_admin_user.py --if-missing
)

echo "    Registering models ($LLM_MODELS_VAL) & creating SOC agents..."
AGENT_ADMIN_PASSWORD="$AGENT_ADMIN_PASS" \
LLM_MODELS_LIST="$LLM_MODELS_VAL" \
LLM_PROVIDER_VAL="$LLM_PROVIDER_VAL" \
SPL_AGENT_VAL="$SPL_AGENT_VAL" \
SPL_MODEL_VAL="$SPL_MODEL_VAL" \
python3 - <<'PY'
import json
import os
import urllib.request

BASE = "http://127.0.0.1:8001"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def req(method, path, body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    with opener.open(r, timeout=30) as resp:
        return json.loads(resp.read().decode())

login = req("POST", "/restful/auth/login", {
    "username": "admin",
    "password": os.environ["AGENT_ADMIN_PASSWORD"],
})
token = login["access_token"]
owner_id = login["user"]["id"]

provider = os.environ["LLM_PROVIDER_VAL"]
raw_models = [m.strip() for m in os.environ["LLM_MODELS_LIST"].split(",") if m.strip()]
if not raw_models:
    raise SystemExit("LLM_MODELS is empty")

registered = []
for m in raw_models:
    # Support optional "Display Name=model_id" or plain "model_id"
    if "=" in m:
        label, _, model_id_str = m.partition("=")
    else:
        label, model_id_str = m, m
    res = req("POST", "/restful/models", {
        "name": label.strip(),
        "model_name": model_id_str.strip(),
        "provider": provider,
        "is_active": True,
    }, token=token)
    registered.append(res)
    print(f"    [+] model ready: {res['model_name']} ({res['provider']})")

default_model_id = registered[0]["id"]

# The SPL writer gets its own model, registered if LLM_MODELS did not list it.
spl_slug = os.environ.get("SPL_AGENT_VAL", "").strip()
spl_model_name = os.environ.get("SPL_MODEL_VAL", "").strip()
spl_model = next((r for r in registered if r["model_name"] == spl_model_name), None)
if spl_slug and spl_model_name and spl_model is None:
    spl_model = req("POST", "/restful/models", {
        "name": spl_model_name,
        "model_name": spl_model_name,
        "provider": provider,
        "is_active": True,
    }, token=token)
    print(f"    [+] model ready: {spl_model['model_name']} ({spl_model['provider']}) — SPL writer")
existing_by_slug = {a["slug"]: a for a in req("GET", "/restful/agents", token=token)}

AGENTS = [
    {
        "slug": "soc-suggest",
        "name": "soc-suggest",
        "description": "Stage 1 triage suggestion for SOC alerts",
        "system_prompt": (
            "You are a senior SOC Tier-2 analyst. Read the alert log, any matched playbook, "
            "and threat intelligence summary provided. Write a concise, accurate triage "
            "assessment: likely cause, severity, affected entities, recommended containment/next "
            "steps, and explicitly state what remains unverified."
        ),
        "config": {"temperature": 0.2, "max_tokens": 1536, "context_window": 8192, "streaming_enabled": True},
    },
    {
        "slug": "soc-requirements",
        "name": "soc-requirements",
        "description": "Stage 2 Splunk investigation question generator",
        "system_prompt": (
            "You are a SOC analyst's assistant. You read one alert — the raw log, the threat "
            "intelligence (ThreatQ) results and the playbook for it — and the first-pass "
            "suggestion already written, and decide what still has to be asked of Splunk to "
            "confirm or rule out that suggestion.\n\n"
            "Rules:\n"
            "1. Ask only distinct questions that pivot on different extracted indicators or "
            "different aspects of the alert. Never write two questions about the same indicator "
            "that would run the same search.\n"
            "2. Each question must name the exact indicator value from the alert (an IP address, "
            "a username, a hostname, a hash, a URL/URI path, a process/service name, or a domain).\n"
            "3. Under each question, list only the `key: value` details from the alert needed to "
            "scope that specific search (e.g. `source`, `user`, `device`, `url`, `process`, `hash`). "
            "Copy each value verbatim as a single value from the alert.\n"
            "4. Never write `-`, `none`, `N/A`, or multi-field labels, and never invent a value.\n\n"
            "Answer in the ANSWER FORMAT given at the end of the message, and nothing else."
        ),
        "config": {"temperature": 0.1, "max_tokens": 2048, "context_window": 8192, "streaming_enabled": True},
    },
    {
        "slug": "soc-conclude",
        "name": "soc-conclude",
        "description": "Post-Splunk correlation and final analysis",
        "system_prompt": (
            "You are a senior SOC analyst writing the final investigation note. Compare the "
            "initial suggestion with the Splunk search results ([splunk N]). Cite findings "
            "with [splunk N], state clearly whether the alert looks like a true positive, "
            "false positive, or inconclusive, and note any failed or empty searches."
        ),
        "config": {"temperature": 0.2, "max_tokens": 1536, "context_window": 8192, "streaming_enabled": True},
    },
]

if spl_slug:
    AGENTS.append({
        "slug": spl_slug,
        "name": spl_slug,
        "description": "Stage 2 SPL writer: one read-only Splunk search per requirement",
        # Short on purpose: the request and the ANSWER FORMAT arrive in every message
        # (the connector's splunk_prompt), so the rules live in one place.
        "system_prompt": (
            "You write Splunk SPL for a SOC. Each message is one search request followed by an "
            "ANSWER FORMAT. Reply with exactly one ```spl code block holding one search, and "
            "nothing else — no explanation, no alternatives.\n\n"
            "Use only the index, sourcetype, field names, values and time range the request "
            "gives. Never invent a field name or a value. Copy values verbatim."
        ),
        # Deterministic and short: a search is one line. The headroom over ~150 tokens
        # is for a model that spends some on reasoning before it answers.
        "config": {"temperature": 0, "max_tokens": 1024, "context_window": 4096, "streaming_enabled": False},
        "model_id": spl_model["id"] if spl_model else default_model_id,
    })

for spec in AGENTS:
    if spec["slug"] in existing_by_slug:
        agent_id = existing_by_slug[spec["slug"]]["id"]
        req(
            "PUT",
            f"/restful/agents/{agent_id}",
            {
                "description": spec["description"],
                "system_prompt": spec["system_prompt"],
                "config": spec["config"],
                "is_active": True,
            },
            token=token,
        )
        print(f"    [~] agent updated: {spec['slug']}")
        continue
    payload = {
        "slug": spec["slug"],
        "name": spec["name"],
        "description": spec["description"],
        "owner_id": owner_id,
        "model_id": spec.get("model_id", default_model_id),
        "is_active": True,
        "system_prompt": spec["system_prompt"],
        "config": spec["config"],
    }
    req("POST", "/restful/agents", payload, token=token)
    made_with = spl_model["model_name"] if spec.get("model_id") and spl_model else registered[0]["model_name"]
    print(f"    [+] agent created: {spec['slug']} (model={made_with})")
PY

# ── 4. Splunk Enterprise container + live token + sample data ───────────────
echo "==> [4/6] Starting Splunk Enterprise container (soc-splunk)"
(
  cd "$REPOS/MCP-Server/external/splunk"
  docker compose -f docker-compose.yml -f "$HERE/deploy/vps-splunk.override.yml" up -d
  echo "    Waiting for Splunk management API & creating soc-mcp user/token + sample events..."
  python3 setup.py --write-env --wait 600
  echo "    Loading lab raw logs (Apache, Sysmon, Windows Event Logs) into index=main..."
  python3 load_raw_logs.py
)

# ── 5. SOC Core stack (DB, Redis, AI-Service, MCP-Splunk, Backend, Frontend) ─
echo "==> [5/6] Building and starting SOC core stack (Backend/deploy/vps-demo.yml)"
(
  cd "$HERE"
  docker compose -f deploy/vps-demo.yml --project-directory . --env-file .env build
  docker compose -f deploy/vps-demo.yml --project-directory . --env-file .env up -d --wait soc-db soc-redis

  echo "    Running database migrations and role seed..."
  docker compose -f deploy/vps-demo.yml --project-directory . --env-file .env \
    run --rm --no-deps -T soc-core-api sh scripts/migrate.sh
  docker compose -f deploy/vps-demo.yml --project-directory . --env-file .env \
    run --rm --no-deps -T soc-core-api node dist/seed.js

  echo "    Creating initial Dashboard admin user if missing..."
  docker compose -f deploy/vps-demo.yml --project-directory . --env-file .env \
    run --rm --no-deps -T \
    -e ADMIN_USER="$DASHBOARD_ADMIN_USER" \
    -e ADMIN_EMAIL="$DASHBOARD_ADMIN_EMAIL" \
    -e ADMIN_PASS="$DASHBOARD_ADMIN_PASS" \
    soc-core-api node -e '
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");
(async () => {
  const prisma = new PrismaClient();
  try {
    const role = await prisma.role.findUnique({ where: { name: "admin" } });
    if (!role) throw new Error("admin role not found");
    const existing = await prisma.user.findUnique({ where: { username: process.env.ADMIN_USER } });
    if (existing) {
      console.log("    [=] dashboard user exists:", existing.username);
      return;
    }
    const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASS, 12);
    const created = await prisma.user.create({
      data: {
        username: process.env.ADMIN_USER,
        email: process.env.ADMIN_EMAIL,
        hashedPassword,
        isActive: true,
        roleId: role.id,
      },
    });
    console.log("    [+] dashboard admin created:", created.username);
  } finally {
    await prisma.$disconnect();
  }
})();
'

  docker compose -f deploy/vps-demo.yml --project-directory . --env-file .env up -d --wait
)

# ── 6. Verification & Summary ───────────────────────────────────────────────
echo "==> [6/6] Verifying services"
sleep 3
curl -fsS http://127.0.0.1:8082/health && echo ""
(
  cd "$HERE"
  docker compose -f deploy/vps-demo.yml --project-directory . --env-file .env \
    exec -T soc-mcp-splunk python check_connection.py || true
)

cat <<EOF

====================================================================
SOC-AI-Agent Demo Deployed!
Credentials saved to: $CREDS_FILE (chmod 600)

LLM API Config:
  Endpoint         : $LLM_BASE_URL_VAL
  Models available : $LLM_MODELS_VAL
  (Switch model per agent anytime in Agent-Server UI -> Agents)

Web URLs:
  Dashboard        : http://${VPS_HOST}:3002
                     login: ${DASHBOARD_ADMIN_USER} / ${DASHBOARD_ADMIN_PASS}
  Backend Swagger  : http://${VPS_HOST}:8082/docs
  Agent-Server UI  : http://${VPS_HOST}:7100
                     login: admin / ${AGENT_ADMIN_PASS}
  Splunk Web UI    : http://${VPS_HOST}:8000
                     login: admin / ${SPLUNK_ADMIN_PASS}
  FortiSOAR Sim    : http://${VPS_HOST}:8090

Next steps:
  1) Confluence playbooks (the model's reference Use Case / Playbook):
     Confluence: $( [ ${#CONFLUENCE_PAIRS[@]} -gt 0 ] && echo "set from this run (${#CONFLUENCE_PAIRS[@]} value(s))" || echo "NOT set — the playbook index stays empty" )
     Either re-run this script with CONFLUENCE_* exported, or edit Backend/.env:
       CONFLUENCE_BASE_URL=https://<site>.atlassian.net/wiki
       CONFLUENCE_SPACE_KEY=...
       CONFLUENCE_EMAIL=...
       CONFLUENCE_API_TOKEN=...
       CONFLUENCE_PROXY=          # only if the VPS reaches Confluence through a proxy
     Then restart, check, and sync now (instead of waiting PLAYBOOK_SYNC_MINUTES):
       cd $HERE
       docker compose -f deploy/vps-demo.yml --project-directory . --env-file .env up -d soc-core-api soc-core-worker
       docker compose -f deploy/vps-demo.yml --project-directory . --env-file .env exec -T soc-core-worker node dist/scripts/confluence-check.js
       Dashboard → "Sync from Confluence" (admin), or POST http://${VPS_HOST}:8082/admin/playbooks/sync

  2) Threat intelligence — MISP with the lab's IOCs (optional, ~1.5 GB RAM):
       cd $REPOS/MCP-Server/external/misp
       cp .env.example .env          # fill passwords/keys; MISP_BASE_URL_PUBLIC=http://${VPS_HOST}:8095
       docker compose up -d          # first start takes a few minutes
       python3 setup.py --write-env  # read-only user + IOCs, writes MISP_* into Backend/.env
       cd $HERE && docker compose -f deploy/vps-demo.yml --project-directory . --env-file .env up -d soc-core-api soc-core-worker
     MISP's UI listens on 127.0.0.1:8095; reach it with: ssh -L 8095:127.0.0.1:8095 <user>@${VPS_HOST}

  3) Firewall (UFW) — DO NOT leave Agent-Server (:8001) or Splunk (:8000) open to the public internet without IP allowlist:
       sudo ufw allow OpenSSH
       sudo ufw allow 3002/tcp
       # Allow 7100/8000/8001/8082/8090 only from your IP (recommended):
       # sudo ufw allow from <YOUR_IP> to any port 7100,8000,8001,8082,8090 proto tcp
       sudo ufw enable
====================================================================
EOF
