# backend (NestJS)

Central backend for SOC AI Suggestion. Owns the database, both auth schemes, the
audit trail and the alert-analysis job lifecycle.

## Layout

```
src/
  main.ts                  bootstrap; APP_ROLE=api serves HTTP, APP_ROLE=worker consumes the queue
  seed.ts                  roles only (replaces python scripts/init_db.py)
  app.module.ts
  config/configuration.ts  env -> typed config (same env names as the old FastAPI backend)
  prisma/                  PrismaService (global)
  common/
    guards/                JwtAuthGuard, RolesGuard, ApiKeyGuard
    decorators/            @CurrentUser, @CurrentApiKey, @Roles
    filters/               renders errors as { "detail": ... }, like FastAPI
    crypto.ts              API key generate / SHA-256 hash / 11-char prefix
  modules/
    auth/                  /auth/login, /auth/refresh, /auth/me
    analysis/              /v1/analyze, /v1/results, /v1/results/:id, /v1/jobs/:id
    queue/                 BullMQ queue + AnalysisProcessor (worker role only)
    ai/                    HTTP client for the Python AI service
    users/                 /admin/users
    api-keys/              /admin/api-keys
    audit/                 /admin/audit-logs, /admin/audit-logs/export, AuditService
    stats/                 /admin/stats
    health/                /health, /
    maintenance/           retention cron (worker role only)
prisma/schema.prisma       maps onto the existing SQLAlchemy tables
```

## Relationship to AI-Service and Agent-Server

This backend is the only writer of the database. AI-Service (`soc-ai`) is
stateless on purpose, and the agents themselves live in Agent-Server — restart
either, or swap the model behind them, without touching job state.

```
SOAR --POST /v1/analyze (X-API-Key)--> soc-core-api
                                          |  create ai_jobs row (PENDING)
                                          |  audit ANALYZE_REQUEST + JOB_QUEUED
                                          v
                                  BullMQ "analysis" queue (Redis)
                                          |
                                          v
                                   soc-core-worker
                                          |  indicators, ThreatQ, playbook match
                                          |  POST /analyze (Bearer AI_SERVICE_AUTH_TOKEN)
                                          v
                                       soc-ai  --> Agent-Server: the named agent
                                          |        (soc-suggest, soc-requirements, soc-conclude)
                                  ai_response back
                                          |
                        worker writes COMPLETED/FAILED + audit
```

Contract, implemented client-side in `src/modules/ai/ai.service.ts`:

```
POST {AI_SERVICE_URL}/analyze          Authorization: Bearer AI_SERVICE_AUTH_TOKEN
  request   { "rendered_prompt": "...", "agent": "soc-suggest", "model": "..." }
  response  { "response": "...", "model": "...", "total_duration_ms": 12345,
              "tokens_prompt": 900, "tokens_eval": 210, "run_id": "..." }

GET {AI_SERVICE_URL}/health  (no token)
```

## Splunk over MCP

Stage 2 asks Splunk over MCP, and the worker is the MCP client of the Splunk
connector (`soc-mcp-splunk`, the MCP-Server repo): each requirement goes, as
stage 1 stored it, to one tool, `splunk_lookup`, and the SPL that ran and its rows
come back (`src/modules/enrichment/splunk-mcp.service.ts`). The connector builds
the prompt, has Text-to-SPL write the search, checks it (`spl.check_readonly`) and
runs it. Nothing Splunk-shaped is left in the backend, and it holds no Splunk
credentials.

| | |
| --- | --- |
| MCP server | `soc-mcp-splunk` (MCP-Server/Splunk), on `soc-network` |
| `SPLUNK_MCP_URL` | `http://soc-mcp-splunk:8200/services/mcp` |
| `MCP_AUTH_TOKEN` | the connector's bearer token, the same value in both `.env` files |
| Splunk's URL, token, CA, index allowlist, AI Assistant | `MCP-Server/.env` |

Which Splunk answers is the connector's setting: mock events, a Splunk container
(`MCP-Server/external/splunk`), or the company's. For the company's it needs two
apps (MCP Server, AI Assistant with Agent Mode on), a search-only role and token,
a network path, and a certificate for the name in the URL first. How:
[docs/splunk-mcp.md](splunk-mcp.md). The `check_splunk` job checks the
connector after every deploy; it may fail (⚠) without failing the pipeline.

## Auth

Unchanged from the FastAPI backend, so existing tokens, passwords and API keys
keep working:

- **JWT bearer** — HS256 with `JWT_SECRET_KEY`, payload `{sub, username, type}`,
  `type` is `access` or `refresh`.
- **X-API-Key** — `sk-` + 43 url-safe chars, looked up by the first 11 chars,
  compared as a SHA-256 hex digest.
- **Passwords** — bcrypt cost 12, interchangeable with passlib's hashes.

## Database

Prisma maps onto the tables SQLAlchemy created (`users`, `roles`, `api_keys`,
`ai_jobs`, `audit_logs`), including the enum type names (`jobstatus`,
`eventtype`, `actortype`) and their uppercase labels. API responses still emit
snake_case fields and lowercase job statuses.

`CORE_DATABASE_URL` uses the plain `postgresql://` scheme — the `+asyncpg`
variant in `DATABASE_URL` is for the Python service only.

## Deploying

Production is one host, `10.40.35.18`, and nobody has a shell on it. Every push
to `main` runs `deploy_production` on the `llm` runner installed there, which
drives that host's Docker directly; settings are CI/CD variables, written into
`.env` by the job and never printed or kept as an artifact. Anything to be
seen on the host is a pipeline job:

| Job | When | What |
| --- | --- | --- |
| `inspect_db_schema` | on `main`, before the deploy | the database's structure, migrations and drift |
| `inspect_ports` | on `main`, before the deploy | host ports, who holds each, the firewall |
| `deploy_production` | on `main` | ports, build, database, backup, migrate, seed roles, start, health, address |
| `check_splunk` | on `main`, after the deploy | can stage 2 reach Splunk |
| `check_splunk_requirement` | ▶ | one requirement end to end against Splunk |
| `check_confluence` | on `main`, after the deploy | can the worker read the playbook space; its last syncs |
| `export_catalog` | ▶ | the Splunk data catalogue, as an artifact |

The inspection and check jobs are allowed to fail: a ⚠, never a failed
pipeline. Step by step, with the variables each repo needs:
[docs/setup.md](setup.md).

## Schema changes

The schema changes only through `prisma/migrations/`: `scripts/migrate.sh`, run
by deploy_production before the new API starts, applies what the database has
not had yet, then fails the deploy unless the database matches
`prisma/schema.prisma`.

- `0_init` is the production database as the FastAPI backend left it, read by
  the `inspect_db_schema` job. A database with those tables and no migration
  history (production, the first time) is marked as having had it, with nothing
  run, and then gets the migrations after it.
- `20261014120000_nest_backend` only adds: the lookup columns, `lookupstatus`,
  `AUTH_KEY_FAILED`, and `prompt` made optional. Nothing is dropped.

To change the schema, edit `schema.prisma`, generate the migration with
`npx prisma migrate dev --name <what-changed>` (it needs a scratch database),
read the SQL it wrote, and commit it. Never `prisma db push`: on a database
with data in it, it drops whatever the schema no longer mentions.

The CI variable `PROD_POSTGRES_PASSWORD` decides which database
deploy_production uses:

- **unset**: a test database of the backend's own, `soc-test-db`, created
  empty with `POSTGRES_*`. Production's `soc-db` is not touched.
- **set**: production's database, the `soc-db` container the FastAPI-era stack
  already runs, with its data, as `PROD_POSTGRES_USER` on `PROD_POSTGRES_DB`
  (both default to `socai`). It is attached to soc-network, dumped to the
  volume `backend_db-backups`, then migrated.

`CORE_DATABASE_URL` is built from those variables at deploy time. Redis is the
backend's own in both cases (`soc-core-redis`).

For a temporary VPN-only schema inspection, set the CI variable
`DB_SCHEMA_DEBUG=true`, deploy, and call `GET /internal/db/schema` with an admin
JWT. It returns public table/column
metadata only and redacts password, secret, token, hash, and API-key columns.
With the flag off the route answers 404. Set it back to `false` and redeploy
after the inspection.

## Dependency security

Three habits, because `npm audit` alone only catches *known* advisories in
packages you already have.

**1. Check, from more than one source**

```bash
npm audit                # GitHub Advisory DB, the tree you have
npm audit --omit=dev     # only what ships to production
npm audit signatures     # registry signatures + build attestations
npm outdated
```

For a second opinion that is not GHSA-only, query [OSV](https://osv.dev)
directly with every version in the lockfile:

```bash
python3 - <<'PY' > /tmp/osv.json
import json
lock = json.load(open('package-lock.json'))
q = [{"package": {"name": p.split('node_modules/')[-1], "ecosystem": "npm"},
      "version": m["version"]}
     for p, m in lock["packages"].items()
     if p.startswith("node_modules/") and m.get("version")]
json.dump({"queries": q}, open('/dev/stdout', 'w'))
PY
curl -s -X POST -d @/tmp/osv.json https://api.osv.dev/v1/querybatch | \
  python3 -c "import json,sys; r=json.load(sys.stdin)['results']; print(sum(1 for x in r if x.get('vulns')), 'packages with advisories')"
```

**2. Pin the supply chain, not just the versions**

- `package-lock.json` is committed, and both the Dockerfile and CI must use
  `npm ci` — never `npm install`. `npm install` re-resolves caret ranges at
  build time, which is exactly how a hijacked release reaches an image whose
  source "did not change".
- `.npmrc` sets `min-release-age=7`, so a version has to survive a week in the
  registry before it can be installed. Malicious publishes are typically pulled
  within hours.
- `.github/dependabot.yml` applies the same cooldown to update PRs.

**3. Revisit the `overrides` block**

`package.json` pins two transitive packages that their parents still ship
vulnerable:

| Override | Parent | Remove it when |
| --- | --- | --- |
| `multer@^2.3.0` | `@nestjs/platform-express` | the parent's own dependency range resolves to ≥ 2.3.0 |
| `deepmerge-ts@^8.0.2` | `prisma` → `@prisma/config` | `prisma` resolves to ≥ 8.0.0 itself |

An override that outlives its reason silently holds a package *back*. Check
with `npm ls multer deepmerge-ts` after any parent upgrade, and delete the entry
once the parent is clean on its own.


---

## Tooling

`scripts/derive_signatures.py` works out which fields identify a log family,
from alerts that could not be placed — the input to `ALERT_SOURCE_SIGNATURES`.
It trusts explicit source metadata first; a `search_name` prefix counts only
with `--allow-search-name-prefix`, because alert names are not a production
source of truth. Reviewed domains come from `--domains domains.json`. Groups
under five alerts are printed as candidates but not emitted as rules unless
`--min-group-size 0` is passed.

`samples/mockup.json` holds recovered ES notables to post at the API.

## API docs (Swagger)

`http://10.40.35.18:8082/docs` (also through the dashboard's nginx at `http://10.40.35.18:3002/docs`); the OpenAPI document
itself is `/docs-json`. **Authorize** takes either credential — an API key for `X-API-Key`, or the
`access_token` from `POST /auth/login` for Bearer — and every operation shows which one it needs, so
Try it out sends it. The token survives a page reload.

The document is generated from the code, so it stays true only if the code keeps saying it:

- **Request and query DTOs** (`*.dto.ts`, `*.query.ts`) document themselves — the `@nestjs/swagger`
  plugin in `nest-cli.json` reads their types and class-validator decorators, and turns a `/** comment */`
  above a field into its description. It only runs under `nest build`, not a bare `tsc`.
- **Responses** are classes in `*.response.ts`, named on the route with `@ApiOkResponse({ type: … })`.
  A controller returns a plain object, so nothing infers them: change what a route returns, change its
  response class. `JobDetailResponse` is the one that matters most — it is where `lookup_result` and
  `final_analysis` are described.
- **Credentials** are `@ApiApiKeyAuth()`, `@ApiJwtAuth()` and `@ApiRoleAuth(...roles)` from
  `common/decorators/api-docs.decorator.ts`. They have to match the guard on the route.
- Every operation needs an `@ApiOperation({ summary })`.

`tests/test_openapi.py` checks all of that against the running API, with no key.

## Tests

`tests/` is a pytest suite for the running API. It replaces the hand-run
`scripts/test_request.py`, `test_full_flow.py` and `test_bulk_analyze.py` with
the same alerts and assertions.

```bash
pip install -r tests/requirements.txt
export SOC_BASE_URL=http://10.40.35.18:8082
SOC_API_KEY=<key> pytest                 # everything; submits real jobs
SOC_API_KEY=<key> pytest -m "not e2e"    # request/auth/validation only, no waiting on the model
pytest                                   # no key: only the 401 checks run, the rest skip
```

Run it from a machine that reaches the API. `SOC_BASE_URL` is where it points;
`SOC_JOB_TIMEOUT` (default 300 s per job) is how long an `e2e` test waits for
the model. Jobs it creates are named `PYTEST-…` and age out with the rest.

`docs/` covers the production stack: `setup.md` to bring it up, `tokens.md`
for which credential each service needs, `splunk-mcp.md` to connect stage 2 to
Splunk, `splunk-catalog.md` for the data catalogue, `testing.md` for what to
check when an answer looks wrong, and `restructure.md` for why the architecture
is shaped the way it is.

## The other repos

Split out of the SOC-AI monorepo. Production runs four repos on the one host,
each deployed by its own pipeline:

| Repo | What it is | On the host |
| --- | --- | --- |
| `Backend` | API, queue worker, Postgres, Redis. The only writer to the database. | `soc-core-api` :8082, `soc-core-worker` |
| `AI-Service` | The backend's stateless door to the agent platform, and the playbook index. | `soc-ai`, not published |
| `Frontend` | The analyst dashboard; proxies the API under the same origin. | `soc-dashboard` :3002 |
| `Agent-Server` | DALL-M: agents as data (model, prompt) and the loop that runs them, on llama.cpp. | admin UI :7100, API :8001 |

Backend, AI-Service and Frontend meet on one Docker network called
`soc-network`, created by whichever deploys first, and address each other by
container name. Agent-Server is its own system with its own Postgres and its
own network; `soc-ai` is the only thing that calls it, through the host
(`host.docker.internal:8001`). ThreatQ, Confluence and Splunk are outside the
host and the backend calls them directly.

Each repo carries only the settings its own services read. In the monorepo one
`.env` was shared by every container, which meant every service's environment
held the database password and the ThreatQ credentials — a compromise of any
one service read the secrets of all of them.
