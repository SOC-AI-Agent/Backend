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

## Relationship to ../ai-service

This backend is the only writer of the database. The Python AI service is
stateless on purpose — restart it, scale it, or swap the model behind it
without touching job state.

```
SOAR --POST /v1/analyze (X-API-Key)--> soc-core-api
                                          |  create ai_jobs row (PENDING)
                                          |  audit ANALYZE_REQUEST + JOB_QUEUED
                                          v
                                  BullMQ "analysis" queue (Redis)
                                          |
                                          v
                                   soc-core-worker
                                          |  POST /analyze
                                          v
                                       soc-ai  --> Ollama
                                          |
                                  ai_response back
                                          |
                        worker writes COMPLETED/FAILED + audit
```

Contract, implemented client-side in `src/modules/ai/ai.service.ts`:

```
POST {AI_SERVICE_URL}/analyze
  request   { "rendered_prompt": "<prompt + raw log>", "model": "qwen2.5:7b" }
  response  { "response": "...", "model": "qwen2.5:7b",
              "total_duration_ms": 12345, "tokens_prompt": 900, "tokens_eval": 210 }

GET {AI_SERVICE_URL}/health  ->  { "status": "ok" }
```

The AI service does not implement this yet — see `../ai-service/README.md`.

## Splunk over MCP

Stage 2 asks Splunk over MCP, and the worker is the MCP client: each requirement
goes as text to `saia_generate_spl` (Splunk AI Assistant's Text-to-SPL), the SPL
that comes back is checked by `spl-guard`, and `splunk_run_query` runs it
(`src/modules/enrichment/splunk-mcp.service.ts`).

| | Development | A real Splunk (lab or production) |
| --- | --- | --- |
| MCP server | the mock, `MCP-Server/Splunk` | Splunk's own MCP Server app |
| `SPLUNK_MCP_URL` | `http://soc-mcp-splunk:8200/services/mcp` | `https://<splunk>:8089/services/mcp` |
| `SPLUNK_MCP_TOKEN` | blank — `MCP_AUTH_TOKEN` is sent | the encrypted token from the MCP Server app |
| `NODE_EXTRA_CA_CERTS` | — | the CA that signed the certificate on 8089 |

A real Splunk needs two apps (MCP Server, AI Assistant with Agent Mode on), a
search-only role and token, a network path, and a certificate for the name in the
URL first. How, and how to check it:
[docs/splunk-mcp.md](docs/splunk-mcp.md).

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

## Commands

```bash
docker compose up -d --build soc-core-api soc-core-worker
docker compose exec soc-core-api sh scripts/migrate.sh   # create/upgrade schema
docker compose exec soc-core-api npm run seed            # roles only
docker compose logs -f soc-core-worker
```

## Schema changes

The schema changes only through `prisma/migrations/`, the same way on a laptop
and in production: `scripts/migrate.sh` applies what a database has not had yet,
then fails unless the database matches `prisma/schema.prisma`.

- `0_init` is the production database as the FastAPI backend left it, read by
  the `inspect_db_schema` job. A database with those tables and no migration
  history (production, the first time) is marked as having had it, with nothing
  run, and then gets the migrations after it.
- `20261014120000_nest_backend` only adds: the lookup columns, `lookupstatus`,
  `AUTH_KEY_FAILED`, and `prompt` made optional. Nothing is dropped.

To change the schema, edit `schema.prisma`, run
`npx prisma migrate dev --name <what-changed>` against a local database, read the
SQL it wrote, and commit it. deploy_production applies it before the new API
starts. Never `prisma db push`: on a database with data in it, it drops whatever
the schema no longer mentions.

A local database made with `db push` before there were migrations already has
every column. Mark both as applied (`npx prisma migrate resolve --applied 0_init`,
then the same for `20261014120000_nest_backend`) and run `scripts/migrate.sh`
to confirm it matches.

On the production host, the CI variable `PROD_POSTGRES_PASSWORD` decides which
database deploy_production uses:

- **unset**: a test database of the backend's own, `soc-test-db`, created
  empty with `POSTGRES_*`. Production's `soc-db` is not touched.
- **set**: production's database, the `soc-db` container the FastAPI-era stack
  already runs, with its data, as `PROD_POSTGRES_USER` on `PROD_POSTGRES_DB`
  (both default to `socai`). It is attached to soc-network, dumped to the
  volume `backend_db-backups`, then migrated.

`CORE_DATABASE_URL` is built from those variables at deploy time. Redis is the
backend's own in both cases (`soc-core-redis`).

For a temporary VPN-only schema inspection, set `DB_SCHEMA_DEBUG=true` and call
`GET /internal/db/schema` with an admin JWT. It returns public table/column
metadata only and redacts password, secret, token, hash, and API-key columns.
With the flag off the route answers 404. Set it back to `false` and redeploy
after the inspection.

Local, outside Docker:

```bash
npm install
npx prisma generate
npm run start:dev
```

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

`http://localhost:8081/docs` (also through the dashboard's nginx at `:3001/docs`); the OpenAPI document
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
SOC_API_KEY=<key> pytest                 # everything; submits real jobs
SOC_API_KEY=<key> pytest -m "not e2e"    # request/auth/validation only, no waiting on the model
pytest                                   # no key: only the 401 checks run, the rest skip
```

`SOC_BASE_URL` (default `http://localhost:8081`) points it elsewhere;
`SOC_JOB_TIMEOUT` (default 300 s per job) is how long an `e2e` test waits for
the model. Jobs it creates are named `PYTEST-…` and age out with the rest.

`docs/` covers the whole stack: `setup.md` to bring it up, `tokens.md` for
which credential each service needs, `splunk-mcp.md` to connect stage 2 to a real
Splunk, `testing.md` for what to check when an answer looks wrong, and
`restructure.md` for why the architecture is shaped the way it is.

## Running all four repos together

`deploy/stack.yml` brings up the whole SOC, expecting AI-Service and Frontend
checked out beside this one. Each repo also runs alone with its own compose file.
[Agent-Server](../Agent-Server/readme.md), the agent platform, is not part of
this: it is a separate system on its own network, brought up with its own
compose (see "What is not running, and why" below).

```bash
docker compose -f deploy/stack.yml --project-directory . up -d --build
```

The Splunk mock is off unless asked for with `--profile mock-splunk`, and only
then needs the MCP-Server repo beside this one. It takes `MCP_AUTH_TOKEN` from
`Backend/.env`, so it needs no `.env` of its own.

## Running the whole thing locally

Check AI-Service and Frontend out beside this repo, plus
[Agent-Server](../Agent-Server/readme.md) — and MCP-Server only if you want the
Splunk mock — then:

```bash
cd Backend
./deploy/dev-setup.sh                            # writes .env in Backend, AI-Service (and MCP-Server if present)
docker compose -f deploy/dev.yml --project-directory . up -d --build   # http://localhost:3001

cd ../Agent-Server
cp .env.example .env && docker compose up -d --build   # http://localhost:7100
```

`dev-setup.sh` generates the secrets and writes them into every repo that needs
them. Two of those — `AI_SERVICE_AUTH_TOKEN` and the mock's `MCP_AUTH_TOKEN` —
have to be identical in more than one file, and they are the ones that break
quietly: a mismatch is a 401 with nothing saying why. Generating them once and
writing them everywhere is the point of the script.

It refuses to overwrite an existing `.env`. Pass `--force` when you mean to.
Run again, it writes only the `.env` files that are missing, with the tokens
`Backend/.env` already holds — so cloning MCP-Server later and re-running it is
enough.

### What is not running, and why

ThreatQ and Confluence are not services here: the backend calls them directly,
with the credentials in `Backend/.env` (`THREATQ_*`, `CONFLUENCE_*`). Left blank,
the summary says ThreatQ was NOT CHECKED and every playbook match says nothing
is indexed.

`deploy/dev.yml` has no Splunk. What works without it is most of the path: an
alert arrives, its indicators are extracted, the agent writes a suggestion, and
the searches it asks for sit on the job waiting for a button that has nothing
to call yet. To give the button something to call, run the mock from the
MCP-Server repo (made-up events, `dev-setup.sh` prints the commands):

```bash
cd ../MCP-Server && docker compose up -d --build soc-mcp-splunk
```

— or point `SPLUNK_MCP_URL` at a real Splunk: [docs/splunk-mcp.md](docs/splunk-mcp.md).
Neither compose file brings up Agent-Server — see the previous section.

---

## Where this came from

Split out of the SOC-AI monorepo. The other pieces:

| Repo | What it is |
| --- | --- |
| `Backend` | API, queue worker, Postgres, Redis. The only writer to the database. |
| `AI-Service` | The backend's stateless door to the agent platform. |
| `MCP-Server` | Connectors for Splunk, ThreatQ and Confluence. |
| `Frontend` | The analyst dashboard. |

Plus [`Agent-Server`](../Agent-Server/readme.md) (internal name DALL-M):
agents as data — model, prompt, tools — and the loop that runs them. It
replaced an earlier in-house LLM server; it is its own system with its own
Postgres and its own network, not one of the four above, and `AI-Service` is
the only thing that calls it (see `AI-Service/README.md`, "Agent-Server").

They meet on one Docker network called `soc-network`, created by whichever
stack comes up first, and address each other by container name. Bring up
`MCP-Server` first: it is the one the rest call. Agent-Server is not on
`soc-network` and brings itself up on its own.

Each repo carries only the settings its own services read. In the monorepo one
`.env` was shared by every container, which meant the Splunk connector's
environment also held the database password and the ThreatQ credentials — a
compromise of any one service read the secrets of all of them.
