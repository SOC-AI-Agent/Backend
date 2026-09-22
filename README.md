# backend (NestJS)

Central backend for SOC AI Suggestion. Owns the database, both auth schemes, the
audit trail and the alert-analysis job lifecycle.

## Layout

```
src/
  main.ts                  bootstrap; APP_ROLE=api serves HTTP, APP_ROLE=worker consumes the queue
  seed.ts                  roles + bootstrap admin (replaces python scripts/init_db.py)
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
docker compose exec soc-core-api npm run seed          # roles + admin user
docker compose logs -f soc-core-worker
```

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


---

## Where this came from

Split out of the SOC-AI monorepo. The other pieces:

| Repo | What it is |
| --- | --- |
| `Backend` | API, queue worker, Postgres, Redis. The only writer to the database. |
| `AI-Service` | The backend's stateless door to the agent platform. |
| `LLM-Server` | Agents as data — model, prompt, tools — and the loop that runs them. |
| `MCP-Server` | Tool servers for Splunk, ThreatQ and Confluence. |
| `Frontend` | The analyst dashboard. |

They meet on one Docker network called `soc-network`, created by whichever
stack comes up first, and address each other by container name. Bring up
`MCP-Server` and `LLM-Server` first: those are the ones the rest call.

Each repo carries only the settings its own services read. In the monorepo one
`.env` was shared by every container, which meant the Splunk connector's
environment also held the database password and the ThreatQ credentials — a
compromise of any one service read the secrets of all of them.
