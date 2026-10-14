#!/usr/bin/env bash
#
# Set up every repo's .env for local development, in one go.
#
#   ./deploy/dev-setup.sh
#
# Writes .env in Backend and AI-Service, filling in generated secrets and
# pointing the services at each other — and in MCP-Server when it is checked
# out, which only the Splunk mock needs. Frontend needs no .env — its proxy
# targets are baked into nginx.conf at build time.
#
# Does not touch Agent-Server (../Agent-Server, the agent platform): it is a
# separate system with its own .env and its own defaults that work as they
# are — see AI-Service/README.md, "Agent-Server", for how the two connect.
#
# Safe to re-run: it refuses to overwrite an existing .env unless you pass
# --force, so a machine already set up is not quietly reconfigured. A re-run
# fills in only the .env files that are missing, with the tokens Backend/.env
# already holds — so cloning MCP-Server later and running this again is enough.
#
# What it cannot do is give you ThreatQ or Confluence: the backend calls them
# directly and needs real credentials in Backend/.env. Splunk can run as a mock
# (the MCP-Server repo, SPLUNK_MODE=mock) until a real Splunk MCP Server is named.
# What you get without them is described at the end.

set -euo pipefail

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# The repos are siblings of this one.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPOS="$(cd "$HERE/.." && pwd)"

for r in Backend AI-Service; do
  [ -d "$REPOS/$r" ] || { echo "cannot find $REPOS/$r — check the repos are checked out side by side"; exit 1; }
done
# Optional: only the Splunk mock lives there. A real Splunk needs none of it.
HAVE_MCP=0
[ -d "$REPOS/MCP-Server" ] && HAVE_MCP=1

gen() { openssl rand -hex 32; }

# What Backend/.env already holds for a key, when that file is being kept.
kept() {
  [ "$FORCE" = 0 ] && [ -f "$REPOS/Backend/.env" ] || return 0
  sed -n "s/^$1=//p" "$REPOS/Backend/.env" | tail -n 1
}

# Generated once and written everywhere they are needed. These are the ones
# that break quietly when they drift: the server checks the token the
# backend sends, and a mismatch is a 401 with nothing saying why. When
# Backend/.env is kept, its tokens are reused rather than new ones generated:
# a .env written now, beside one left alone, has to match what is already
# being sent.
MCP_TOKEN="$(kept MCP_AUTH_TOKEN)"
MCP_TOKEN="${MCP_TOKEN:-$(gen)}"
AI_TOKEN="$(kept AI_SERVICE_AUTH_TOKEN)"
AI_TOKEN="${AI_TOKEN:-$(gen)}"
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

if [ "$HAVE_MCP" = 1 ]; then
  MCP_AUTH_TOKEN="$MCP_TOKEN" \
    write_env MCP-Server
else
  echo "  MCP-Server: not checked out, skipped — only the Splunk mock needs it"
fi

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
(default: http://host.docker.internal:8001, which already assumes it runs
on this machine)."
else
  AGENT_NOTE="
  Not found beside this repo. Clone it and run its own quick start
  (readme.md) — its defaults need no edits for local development — then
  set LLM_SERVER_URL in AI-Service/.env if it is not on this machine."
fi

if [ "$HAVE_MCP" = 1 ]; then
  SPLUNK_NOTE="
  cd ../MCP-Server && docker compose up -d --build soc-mcp-splunk"
else
  SPLUNK_NOTE="
  git clone https://gitlab.com/agentic-soc/mcp-server.git ../MCP-Server
  ./deploy/dev-setup.sh      # again: writes only MCP-Server/.env, with this token
  cd ../MCP-Server && docker compose up -d --build soc-mcp-splunk"
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

deploy/dev.yml has no Splunk. Stage 2 (the lookup button) needs a Splunk MCP
server: either the development mock, which answers from made-up events —
$SPLUNK_NOTE

— or a real Splunk's MCP Server app: see Backend/docs/splunk-mcp.md.
EOF
