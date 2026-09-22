# API collection

Every endpoint in the stack, as a [Bruno](https://usebruno.com) collection.
59 requests across six folders, each with assertions.

```
api-tests/soc-ai/
  bruno.json          collection
  collection.bru      auto-auth, so a folder can be run on its own
  environments/       local.bru (published ports) · docker.bru (service names)
  1 core-api/         auth, API keys, users, audit, stats      14
  2 soar-path/        what FortiSOAR calls                      7
  3 ai-service/       /analyze and /llm-probe                   3
  4 llm-server/       agents, MCP registry, runs                18
  5 mcp-splunk/       catalog, tools, the guards               10
  6 mcp-threatq/      lookup, the one tool                      7
```

## In the app

Open `api-tests/soc-ai` as a collection, pick the **local** environment, and
fill the three secrets from `.env`:

| Bruno variable | from `.env` |
| --- | --- |
| `admin_password` | `DEFAULT_ADMIN_PASSWORD` |
| `mcp_splunk_token` | `MCP_AUTH_TOKEN` |
| `mcp_threatq_token` | `THREATQ_MCP_AUTH_TOKEN` |

Run **1 core-api → Login** first. It stores the JWT; **API keys - create**
stores the key the SOAR folder uses.

You do not have to: a collection-level pre-request script fetches both on
demand, so any folder can be run on its own.

## From the command line

The MCP connectors publish no port, so reach them from inside the network:

```bash
PW=$(grep '^DEFAULT_ADMIN_PASSWORD=' .env | cut -d= -f2-)
TOKEN=$(grep '^MCP_AUTH_TOKEN=' .env | cut -d= -f2-)

docker run --rm --network soc-ai_soc-network \
  -v "$PWD/api-tests/soc-ai:/c" -w /c node:22-alpine \
  npx --yes @usebruno/cli run . --env docker \
    --env-var admin_password="$PW" \
    --env-var mcp_splunk_token="$TOKEN"
```

One folder: add its name, e.g. `run "5 mcp-splunk"`.

From a workstation against published ports, use `--env local` — but the two
MCP folders will fail unless you add a `ports:` mapping to
`docker-compose.yml` first. Those variables are disabled in `local.bru` for
that reason.

## Requests named *(must fail)*

Several requests assert a **rejection**: an alert with no API key, a tool call
naming an index outside the allowlist, a lookup with no token. A pass there
means the guard held. They are part of the run, not mistakes in it.

The Splunk folder's injection test is the one worth reading. It sends
`blocked" | delete | head 1` as a filter value and asserts on the SPL that came
back, not on the row count:

```
action="blocked\" | delete | head 1"
```

The quote is escaped, so `| delete` stays inside a quoted value instead of
becoming a command. A count of zero on its own would prove nothing — that is
also what a search which ran and matched nothing returns.

## What passes today

```
1 core-api    14 requests   17/17
2 soar-path    7 requests    9/9
3 ai-service   3 requests    5/5
5 mcp-splunk  10 requests   12/12
```

`4 llm-server` runs an agent, which takes minutes on CPU-only inference — run
it on its own when you have the time.

`6 mcp-threatq` needs ThreatQ credentials. Without them the container restarts
and every request in that folder fails, which is the intended behaviour: it
refuses to start rather than serve an unauthenticated way into threat
intelligence.

## Adding a request

Bruno files are plain text, so a new endpoint is a file. Copy a neighbour, bump
`seq`, and keep the assertion specific — `responds 2xx` catches an outage but
not a wrong answer, which is why several requests check a field rather than a
status.

`.env` inside the collection folder is gitignored: Bruno reads secrets from it,
and it holds real tokens.
