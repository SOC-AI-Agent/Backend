#!/usr/bin/env bash
#
# Set up every repo's .env for local development, in one go.
#
#   ./deploy/dev-setup.sh
#
# Writes .env in Backend, AI-Service and MCP-Server, filling in generated
# secrets and pointing the services at each other. Frontend needs no .env —
# its proxy targets are baked into nginx.conf at build time.
#
# Does not touch Agent-Server (../Agent-Server, the agent platform): it is a
# separate system with its own .env and its own defaults that work as they
# are — see AI-Service/README.md, "Agent-Server", for how the two connect.
#
# Safe to re-run: it refuses to overwrite an existing .env unless you pass
# --force, so a machine already set up is not quietly reconfigured.
#
# What it cannot do is give you ThreatQ or Confluence: the backend calls them
# directly and needs real credentials in Backend/.env. Splunk runs as a mock
# (MCP-Server/Splunk, SPLUNK_MODE=mock) until a real Splunk MCP Server is named.
# What you get without them is described at the end.

set -euo pipefail

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# The repos are siblings of this one.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPOS="$(cd "$HERE/.." && pwd)"

for r in Backend AI-Service MCP-Server; do
  [ -d "$REPOS/$r" ] || { echo "cannot find $REPOS/$r — check the repos are checked out side by side"; exit 1; }
done

gen() { openssl rand -hex 32; }

# Generated once and written everywhere they are needed. These are the ones
# that break quietly when they drift: the connector checks the token the
# backend sends, and a mismatch is a 401 with nothing saying why.
MCP_TOKEN="$(gen)"
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
AI_SERVICE_AUTH_TOKEN="$AI_TOKEN" \
JWT_SECRET_KEY="$JWT_SECRET" \
POSTGRES_PASSWORD="$PG_PASSWORD" \
SPLUNK_LOOKUP_MODE="manual" \
  write_env Backend

MCP_AUTH_TOKEN="$MCP_TOKEN" \
  write_env MCP-Server

AI_SERVICE_AUTH_TOKEN="$AI_TOKEN" \
  write_env AI-Service

# Built ahead of the final message rather than nested inside its heredoc —
# a heredoc's body is read verbatim until its own terminator, so a second
# <<HERE inside one does not open a nested heredoc, it just becomes text.
if [ -d "$REPOS/Agent-Server" ]; then
  AGENT_NOTE="
  cd ../Agent-Server
  cp .env.example .env   # its defaults work as they are for local dev
  docker compose up -d --build   # http://localhost:7100

Then create the three agents (soc-suggest, soc-requirements, soc-conclude —
or whatever LLM_SUGGEST_AGENT / LLM_REQUIREMENTS_AGENT / LLM_CONCLUDE_AGENT
name in Backend/.env) at that UI, or POST /restful/agents. Nothing here
restores or checks them.

soc-ai reaches it at AI-Service/.env's LLM_SERVER_URL
(default: http://host.docker.internal:8000, which already assumes it runs
on this machine)."
else
  AGENT_NOTE="
  Not found beside this repo. Clone it and run its own quick start
  (readme.md) — its defaults need no edits for local development — then
  set LLM_SERVER_URL in AI-Service/.env if it is not on this machine."
fi

cat <<EOF

Done. Bring the stack up with:

  docker compose -f deploy/dev.yml --project-directory . up -d --build

The seed creates roles only. Create the first admin by hand — see
Backend/docs/setup.md, section 4.

Agent platform (Agent-Server) — separate, not written by this script
----------------------------------------------------------------------
$AGENT_NOTE

Not running, and why
--------------------
ThreatQ and Confluence are called by the backend directly, with the
credentials in Backend/.env (THREATQ_*, CONFLUENCE_*). Left blank, the
summary says ThreatQ was NOT CHECKED and every playbook match says nothing is
indexed — weaker, and said out loud, rather than made up.

deploy/dev.yml leaves the Splunk MCP server out. To run stage 2 against mock
data (SPLUNK_MODE=mock in MCP-Server/.env, the default there):

  cd ../MCP-Server && docker compose up -d --build soc-mcp-splunk

For a real Splunk, see MCP-Server/Splunk/README.md, "Production".
EOF
