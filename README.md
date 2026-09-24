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
docker compose exec soc-core-api npx prisma db push   # create/sync schema
docker compose exec soc-core-api npm run seed          # roles only
docker compose logs -f soc-core-worker
```

`prisma db push` is for a fresh local database only. The production schema must
be inventoried before enabling automated Prisma migrations — this repository's
schema is not proof of what production currently contains. Start with a
read-only dump and compare it with `prisma/schema.prisma`:

```bash
pg_dump --schema-only --no-owner --no-privileges "$CORE_DATABASE_URL" \
  > production-schema.sql
```

Do not run `prisma migrate resolve`, `prisma migrate deploy`, or `prisma db push`
against production until the existing tables, enums, indexes, constraints, and
the password hash column have been reviewed. Then create a baseline from the
actual production schema and test it against a database clone.

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
which credential each service needs, `testing.md` for what to check when an
answer looks wrong, and `restructure.md` for why the architecture is shaped the
way it is.

`api-tests/` is a Bruno collection for this API — auth, admin, and the SOAR
path. It carries the shared pre-request script that fetches a JWT and an API
key, because this is the service that issues them.

## Running all five repos together

`deploy/stack.yml` brings up the whole SOC, expecting the other repos checked
out beside this one. Each repo also runs alone with its own compose file.

```bash
docker compose -f deploy/stack.yml up -d --build
```

## Running the whole thing locally

Check the five repos out side by side, then:

```bash
cd Backend
./deploy/dev-setup.sh                            # writes .env in all four
docker compose -f deploy/dev.yml up -d --build   # http://localhost:3001
```

`dev-setup.sh` generates the secrets and writes them into every repo that needs
them. Three of those — the tokens the connectors check — have to be identical
in more than one file, and they are the ones that break quietly: a mismatch is
a 401 with nothing saying why. Generating them once and writing them everywhere
is the point of the script.

It refuses to overwrite an existing `.env`. Pass `--force` when you mean to.

### What is not running, and why

`deploy/dev.yml` leaves out the Splunk, ThreatQ and Confluence connectors. They
refuse to start without real credentials, and that refusal is deliberate — one
that started anyway would answer confidently about data it cannot reach.

What works without them is most of the path: an alert arrives, its indicators
are extracted, the agent writes a suggestion, and the searches it asks for sit
on the job waiting for a button that has nothing to call yet.

To add one, put its credentials in `MCP-Server/.env` and bring it up on the
same network:

```bash
cd ../MCP-Server && docker compose up -d soc-mcp-splunk
```

`deploy/stack.yml` is the version with all of them, for a machine that has
those platforms.

---

## Where this came from

Split out of the SOC-AI monorepo. The other pieces:

| Repo | What it is |
| --- | --- |
| `Backend` | API, queue worker, Postgres, Redis. The only writer to the database. |
| `AI-Service` | The backend's stateless door to the agent platform. |
| `LLM-Server` | Agents as data — model, prompt, tools — and the loop that runs them. |
| `MCP-Server` | Connectors for Splunk, ThreatQ and Confluence. |
| `Frontend` | The analyst dashboard. |

They meet on one Docker network called `soc-network`, created by whichever
stack comes up first, and address each other by container name. Bring up
`MCP-Server` and `LLM-Server` first: those are the ones the rest call.

Each repo carries only the settings its own services read. In the monorepo one
`.env` was shared by every container, which meant the Splunk connector's
environment also held the database password and the ThreatQ credentials — a
compromise of any one service read the secrets of all of them.
