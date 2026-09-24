#!/usr/bin/env bash
#
# Set up every repo's .env for local development, in one go.
#
#   ./deploy/dev-setup.sh
#
# Writes .env in Backend, AI-Service, LLM-Server and MCP-Server, filling in
# generated secrets and pointing the services at each other. Frontend needs no
# .env — its proxy targets are baked into nginx.conf at build time.
#
# Safe to re-run: it refuses to overwrite an existing .env unless you pass
# --force, so a machine already set up is not quietly reconfigured.
#
# What it cannot do is give you Splunk, ThreatQ or Confluence. Those connectors
# refuse to start without real credentials — by design, because a connector
# that starts without them would answer confidently about data it cannot see.
# What you get without them is described at the end.

set -euo pipefail

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# The repos are siblings of this one.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPOS="$(cd "$HERE/.." && pwd)"

for r in Backend AI-Service LLM-Server MCP-Server; do
  [ -d "$REPOS/$r" ] || { echo "cannot find $REPOS/$r — check the repos are checked out side by side"; exit 1; }
done

gen() { openssl rand -hex 32; }

# Generated once and written everywhere they are needed. These are the ones
# that break quietly when they drift: the connector checks the token the
# backend sends, and a mismatch is a 401 with nothing saying why.
MCP_TOKEN="$(gen)"
THREATQ_TOKEN="$(gen)"
CONFLUENCE_TOKEN="$(gen)"
AI_TOKEN="$(gen)"
JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
PG_PASSWORD="$(gen)"

# Reads .env.example and replaces any key that exists in the environment.
# Not sed: a generated secret containing | or / breaks the expression, and one
# containing & is silently replaced by the matched text.
write_env() {
  local repo="$1" src="$REPOS/$1/.env.example" dst="$REPOS/$1/.env"
  [ -f "$src" ] || { echo "  $repo: no .env.example, skipped"; return; }
  if [ -f "$dst" ] && [ "$FORCE" = 0 ]; then
    echo "  $repo: .env exists, left alone (--force to overwrite)"; return
  fi
  : > "$dst"
  local filled=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) printf '%s\n' "$line" >> "$dst"; continue ;; esac
    local key=${line%%=*}
    if [ "$key" = "$line" ]; then printf '%s\n' "$line" >> "$dst"; continue; fi
    if [ -n "${!key+x}" ]; then
      printf '%s=%s\n' "$key" "${!key}" >> "$dst"; filled=$((filled+1))
    else
      printf '%s\n' "$line" >> "$dst"
    fi
  done < "$src"
  echo "  $repo: .env written ($filled values filled in)"
}

echo "Generating .env files"

MCP_AUTH_TOKEN="$MCP_TOKEN" \
THREATQ_MCP_AUTH_TOKEN="$THREATQ_TOKEN" \
CONFLUENCE_MCP_AUTH_TOKEN="$CONFLUENCE_TOKEN" \
AI_SERVICE_AUTH_TOKEN="$AI_TOKEN" \
JWT_SECRET_KEY="$JWT_SECRET" \
POSTGRES_PASSWORD="$PG_PASSWORD" \
SPLUNK_LOOKUP_MODE="manual" \
  write_env Backend

MCP_AUTH_TOKEN="$MCP_TOKEN" \
THREATQ_MCP_AUTH_TOKEN="$THREATQ_TOKEN" \
CONFLUENCE_MCP_AUTH_TOKEN="$CONFLUENCE_TOKEN" \
  write_env MCP-Server

AI_SERVICE_AUTH_TOKEN="$AI_TOKEN" \
  write_env AI-Service
write_env LLM-Server

# The LLM server reaches the connectors itself, so it carries the same tokens.
# Rewritten rather than left to .env.example, which has them blank.
if [ -f "$REPOS/LLM-Server/.env" ]; then
  python3 - "$REPOS/LLM-Server/.env" "$THREATQ_TOKEN" "$CONFLUENCE_TOKEN" <<'PY'
import json, re, sys
path, tq, cf = sys.argv[1:4]
servers = json.dumps([
    {"name": "threatq",    "url": "http://soc-mcp-threatq:8300/mcp",    "token": tq},
    {"name": "confluence", "url": "http://soc-mcp-confluence:8600/mcp", "token": cf},
], separators=(",", ":"))
s = open(path).read()
s = re.sub(r"^MCP_SERVERS=.*$", "MCP_SERVERS=" + servers, s, flags=re.M)
open(path, "w").write(s)
PY
  echo "  LLM-Server: MCP_SERVERS points at the ThreatQ and Confluence connectors (Splunk is plain HTTP)"
fi

cat <<EOF

Done. Bring the stack up with:

  docker compose -f deploy/dev.yml up -d --build

The seed creates roles only. Create the first admin by hand — see
Backend/docs/setup.md, section 4.

Not running, and why
--------------------
Splunk, ThreatQ and Confluence connectors need real credentials and refuse to
start without them. That refusal is deliberate: a connector that started
anyway would answer /lookup and /match confidently about data it has no
access to, and nothing in the answer would say so.

deploy/dev.yml leaves them out. What you get is the full triage path up to the
point where it would search: an alert arrives, indicators are extracted, the
agent writes a suggestion, and the lookups it asks for sit on the job waiting
for a button that cannot do anything yet.

To add one, put its credentials in MCP-Server/.env and bring it up:

  cd ../MCP-Server && docker compose up -d soc-mcp-splunk
EOF
