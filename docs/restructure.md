# Backend Restructure — FastAPI เดี่ยว → NestJS + AI Service

เอกสารสรุปว่าอะไรเปลี่ยนไปบ้างจากการแยก backend ระบุถึงระดับไฟล์และโค้ด
ใครที่เคยรันของเดิมอยู่ อ่านหัวข้อ [Migration](#migration) กับ
[Breaking changes](#breaking-changes) ให้ครบ

---

## ทำไมต้องแยก

เดิม backend เป็น FastAPI ก้อนเดียวทำทุกอย่าง — auth, users, API keys, audit log,
job queue, และเรียก Ollama. ตอนนี้แยกตามหน้าที่:

| ส่วน | Stack | หน้าที่ |
| --- | --- | --- |
| `backend/` | NestJS + Prisma | backend กลาง ถือ DB, auth, audit, job lifecycle, queue ทั้งหมด |
| `ai-service/` | FastAPI | AI/LLM อย่างเดียว รับ prompt ตอบ text ไม่มี state |

หลักการ: **backend เป็นตัวจัดการ Python แค่รับงาน** — `ai-service` ไม่แตะ DB
ไม่แตะ Redis ไม่มีคิวของตัวเอง restart/scale/สลับ model ได้โดยไม่กระทบสถานะงาน

---

## โครงสร้างไฟล์

**ก่อน**

```
backend/           FastAPI ทั้งหมด (core/ models/ routers/ schemas/ services/ workers/ scripts/)
frontend/
```

**หลัง**

```
backend/           NestJS + Prisma
ai-service/        FastAPI — prompt -> text เท่านั้น (ตัดเหลือ stateless แล้ว, ดูรอบที่ 2)
mcp/splunk/        MCP server — Splunk (เขียนเอง)
mcp/threatq/       MCP gateway — ThreatQ (ThreatQ มี MCP ของตัวเอง)
frontend/
```

ไฟล์ Python เดิมย้ายเป็น `git mv` ทั้งหมด ประวัติไฟล์ยังตามได้:

| เดิม | ตอนนี้ |
| --- | --- |
| `backend/main.py` | `ai-service/main.py` |
| `backend/core/` `models/` `routers/` `schemas/` `services/` `workers/` `scripts/` | `ai-service/<ชื่อเดิม>/` |
| `backend/requirements.txt` `backend/Dockerfile` | `ai-service/` |

ไฟล์ `__pycache__/*.pyc` ที่เคยถูก track ไว้ 28 ไฟล์ ถอดออกจาก git แล้ว และเพิ่ม
[`.gitignore`](../.gitignore) (ก่อนหน้านี้ repo ไม่มี)

### ไฟล์ใน `backend/` (NestJS)

```
prisma/schema.prisma                        map ตารางเดิมที่ SQLAlchemy สร้าง
src/
  main.ts                                   bootstrap — APP_ROLE ตัดสินว่าเป็น API หรือ worker
  app.module.ts                             รวมทุก module
  seed.ts                                   roles + admin user (แทน scripts/init_db.py)
  config/configuration.ts                   อ่าน env เป็น typed config
  prisma/
    prisma.service.ts                       PrismaClient + lifecycle hooks
    prisma.module.ts                        @Global — inject ได้ทุกที่ไม่ต้อง import
  common/
    crypto.ts                               สร้าง/hash API key + ตัด prefix 11 ตัว
    request-context.ts                      ดึง client IP (X-Forwarded-For) + user agent
    types/auth-user.ts                      type ของ user ที่ guard แนบไว้กับ request
    guards/jwt-auth.guard.ts                verify JWT + โหลด user (แทน get_current_user)
    guards/roles.guard.ts                   เช็ค role (แทน require_role)
    guards/api-key.guard.ts                 X-API-Key (แทน get_api_key_record)
    decorators/current-user.decorator.ts    @CurrentUser()
    decorators/api-key.decorator.ts         @CurrentApiKey()
    decorators/roles.decorator.ts           @Roles('admin', ...)
    filters/http-exception.filter.ts        แปลง error ทุกตัวเป็น {"detail": ...}
  modules/
    auth/         auth.controller.ts / auth.service.ts / dto/login.dto.ts
    analysis/     analysis.controller.ts / analysis.service.ts / dto/analysis.dto.ts
    queue/        queue.module.ts / analysis.processor.ts / analysis-job.payload.ts
    ai/           ai.service.ts — HTTP client ไปหา ai-service
    users/        users.controller.ts / users.service.ts / dto/user.dto.ts
    api-keys/     api-keys.controller.ts / api-keys.service.ts / dto/api-key.dto.ts
    audit/        audit.controller.ts / audit.service.ts / dto/list-audit-logs.query.ts
    stats/        stats.controller.ts
    health/       health.controller.ts
    maintenance/  maintenance.service.ts — cron ลบข้อมูลเก่า
```

---

## ไฟล์เดิม → ไฟล์ใหม่

ถ้าเคยอ่านโค้ด FastAPI มาก่อน ตารางนี้บอกว่าของแต่ละชิ้นย้ายไปอยู่ไหน

| FastAPI เดิม | NestJS ตอนนี้ | หมายเหตุ |
| --- | --- | --- |
| `main.py` | [`src/main.ts`](../backend/src/main.ts) + [`src/app.module.ts`](../backend/src/app.module.ts) | lifespan `create_all` หายไป ใช้ `prisma db push` แทน |
| `core/config.py` (`Settings`) | [`src/config/configuration.ts`](../backend/src/config/configuration.ts) | ชื่อ env เหมือนเดิมทุกตัว |
| `core/database.py` | [`src/prisma/prisma.service.ts`](../backend/src/prisma/prisma.service.ts) | async session → PrismaClient |
| `models/*.py` (SQLAlchemy) | [`prisma/schema.prisma`](../backend/prisma/schema.prisma) | 4 ไฟล์รวมเป็นไฟล์เดียว |
| `core/security.py` — password + JWT | [`auth.service.ts`](../backend/src/modules/auth/auth.service.ts) | `passlib` → `bcrypt`, `python-jose` → `@nestjs/jwt` |
| `core/security.py` — API key | [`common/crypto.ts`](../backend/src/common/crypto.ts) | `secrets.token_urlsafe(32)` → `randomBytes(32).toString('base64url')` |
| `core/deps.py` — `get_current_user` | [`guards/jwt-auth.guard.ts`](../backend/src/common/guards/jwt-auth.guard.ts) | |
| `core/deps.py` — `require_role` | [`guards/roles.guard.ts`](../backend/src/common/guards/roles.guard.ts) + [`decorators/roles.decorator.ts`](../backend/src/common/decorators/roles.decorator.ts) | |
| `core/deps.py` — `get_api_key_record` | [`guards/api-key.guard.ts`](../backend/src/common/guards/api-key.guard.ts) | รวม audit ตอน auth ล้มเหมือนเดิม |
| `core/audit.py` (`AuditLogger`) | [`audit/audit.service.ts`](../backend/src/modules/audit/audit.service.ts) | |
| `routers/auth.py` | [`auth/auth.controller.ts`](../backend/src/modules/auth/auth.controller.ts) | |
| `routers/analysis.py` | [`analysis.controller.ts`](../backend/src/modules/analysis/analysis.controller.ts) + [`analysis.service.ts`](../backend/src/modules/analysis/analysis.service.ts) | แยก route ออกจาก business logic |
| `routers/admin.py` (450 บรรทัด) | แตกเป็น 4 module: `users/` `api-keys/` `audit/` `stats/` | |
| `schemas/auth.py` | [`auth/dto/login.dto.ts`](../backend/src/modules/auth/dto/login.dto.ts) | Pydantic → class-validator |
| `schemas/analysis.py` | [`analysis/dto/analysis.dto.ts`](../backend/src/modules/analysis/dto/analysis.dto.ts) | |
| `schemas/admin.py` | [`users/dto/user.dto.ts`](../backend/src/modules/users/dto/user.dto.ts) + [`api-keys/dto/api-key.dto.ts`](../backend/src/modules/api-keys/dto/api-key.dto.ts) | |
| `schemas/audit.py` | [`audit/dto/list-audit-logs.query.ts`](../backend/src/modules/audit/dto/list-audit-logs.query.ts) | |
| `services/auth_service.py` | [`auth/auth.service.ts`](../backend/src/modules/auth/auth.service.ts) | |
| `services/maintenance_service.py` | [`maintenance/maintenance.service.ts`](../backend/src/modules/maintenance/maintenance.service.ts) | |
| `services/ollama_service.py` | [`ai/ai.service.ts`](../backend/src/modules/ai/ai.service.ts) | **เปลี่ยนบทบาท** — เดิมเรียก Ollama ตรง ตอนนี้เป็น HTTP client ไปหา `ai-service` |
| `workers/ai_worker.py` (`analyze_alert`) | [`queue/analysis.processor.ts`](../backend/src/modules/queue/analysis.processor.ts) | |
| `workers/queue.py` (`WorkerSettings`) | [`queue/queue.module.ts`](../backend/src/modules/queue/queue.module.ts) + [`analysis-job.payload.ts`](../backend/src/modules/queue/analysis-job.payload.ts) | ARQ → BullMQ |
| `scripts/init_db.py` | [`src/seed.ts`](../backend/src/seed.ts) | |

---

## Docker Compose

| เดิม | ตอนนี้ | หมายเหตุ |
| --- | --- | --- |
| `soc-backend` (uvicorn :8000) | `soc-core-api` (node :8000) | port เดิม |
| `soc-worker` (arq) | `soc-core-worker` (node, `APP_ROLE=worker`) | image เดียวกับ core-api คนละ role |
| — | `soc-ai` (:8100) | ใหม่ อยู่ใต้ profile `ai` ไม่ start เอง |
| `soc-db` `soc-redis` `soc-ollama` `soc-frontend` | เหมือนเดิม | |

`soc-ai` ต้องสั่งเองถึงจะขึ้น:

```bash
docker compose --profile ai up -d soc-ai
```

`build.context` ของ backend ยังเป็น `./backend` (แต่เป็น Node แล้ว) และเพิ่ม
`./ai-service` เข้ามา ฝั่ง frontend ต้องเปลี่ยน `proxy_pass` ตามชื่อ service ใหม่ —
ดูหัวข้อ [Frontend](#frontend)

### API กับ worker ใช้ image เดียวกัน

[`src/main.ts:59`](../backend/src/main.ts#L59) เป็นตัวตัดสิน:

```ts
void (process.env.APP_ROLE === 'worker' ? bootstrapWorker() : bootstrapApi());
```

- `bootstrapApi()` — `NestFactory.create()` เปิด HTTP, CORS, ValidationPipe,
  exception filter, Swagger ที่ `/docs`
- `bootstrapWorker()` — `NestFactory.createApplicationContext()` ไม่เปิด port เลย

module สองตัวเช็ค `APP_ROLE` ตอนโหลดเพื่อไม่ให้ทำงานซ้ำซ้อน:

- [`queue.module.ts:11`](../backend/src/modules/queue/queue.module.ts#L11) — ลงทะเบียน
  `AnalysisProcessor` เฉพาะ role worker (API เป็นแค่ producer)
- [`maintenance.module.ts:6`](../backend/src/modules/maintenance/maintenance.module.ts#L6) —
  cron ลบข้อมูลเก่ารันเฉพาะ worker กัน API หลาย replica ลบซ้ำกัน

---

## API — ไม่มีอะไรเปลี่ยน

พอร์ตครบ 1:1 path เดิม auth เดิม response shape เดิม
**frontend ไม่ต้องแก้แม้แต่บรรทัดเดียว**

| Endpoint | Auth | ไฟล์ที่รับผิดชอบ |
| --- | --- | --- |
| `POST /auth/login` | — | [`auth.controller.ts`](../backend/src/modules/auth/auth.controller.ts#L21) |
| `POST /auth/refresh` | — | [`auth.controller.ts`](../backend/src/modules/auth/auth.controller.ts#L53) |
| `GET /auth/me` | JWT | [`auth.controller.ts`](../backend/src/modules/auth/auth.controller.ts#L61) |
| `POST /v1/analyze` | X-API-Key | [`analysis.controller.ts:19`](../backend/src/modules/analysis/analysis.controller.ts#L19) |
| `GET /v1/results` | JWT | [`analysis.controller.ts:32`](../backend/src/modules/analysis/analysis.controller.ts#L31) |
| `GET /v1/results/:jobId` | X-API-Key | [`analysis.controller.ts:39`](../backend/src/modules/analysis/analysis.controller.ts#L38) |
| `GET /v1/jobs/:jobId` | JWT | [`analysis.controller.ts:46`](../backend/src/modules/analysis/analysis.controller.ts#L45) |
| `GET POST /admin/users`, `PUT DELETE /admin/users/:id` | JWT + admin | [`users.controller.ts`](../backend/src/modules/users/users.controller.ts) |
| `GET POST /admin/api-keys`, `DELETE /admin/api-keys/:id` | JWT + admin/analyst | [`api-keys.controller.ts`](../backend/src/modules/api-keys/api-keys.controller.ts) |
| `GET /admin/audit-logs`, `GET /admin/audit-logs/export` | JWT + admin | [`audit.controller.ts`](../backend/src/modules/audit/audit.controller.ts) |
| `GET /admin/stats` | JWT + ทุก role | [`stats.controller.ts`](../backend/src/modules/stats/stats.controller.ts) |
| `GET /health` `GET /` | — | [`health.controller.ts`](../backend/src/modules/health/health.controller.ts) |
| `GET /docs` | — | Swagger — [`main.ts:52`](../backend/src/main.ts#L52) |

ที่ยังเหมือนเดิมและตั้งใจให้เหมือน:

- **response** เป็น snake_case, `status` ของ job เป็นตัวเล็ก — แปลงที่ `toJobResponse()`
  ใน [`analysis.service.ts`](../backend/src/modules/analysis/analysis.service.ts#L111)
  (`job.status.toLowerCase()`)
- **error** เป็น `{"detail": "..."}` เหมือน FastAPI ผ่าน
  [`http-exception.filter.ts`](../backend/src/common/filters/http-exception.filter.ts) —
  รองรับทั้ง `HttpException` ปกติ และ error array ที่ ValidationPipe คืนมา
  (join ด้วย `; ` ที่บรรทัด 36) เพราะ frontend อ่าน `err.response.data.detail` ทุกที่
- **`/docs`** ยังมี Swagger UI (NestJS Swagger แทน FastAPI)

---

## Frontend

หน้าบ้าน **ไม่ต้องแก้อะไรเพื่อให้ทำงานกับ backend ใหม่** — path, auth, response
shape เหมือนเดิมทุกอย่าง สิ่งที่เปลี่ยนเป็นการจัดโครงสร้างล้วน ๆ ทำแยกจากงาน
restructure backend

### รวม API path ไว้ที่เดียว

เดิม path เป็น string เขียนติดอยู่ในแต่ละหน้า กระจาย **17 จุดใน 8 ไฟล์** เส้นเดียวกัน
ถูกพิมพ์ซ้ำหลายที่ (`/v1/results` อยู่ทั้ง `Jobs.jsx` และ `Dashboard.jsx`) พิมพ์ผิด
ที่เดียวก็ 404 ตอน runtime โดยไม่มีอะไรเตือน

ไฟล์ใหม่ [`frontend/src/api/endpoints.js`](../frontend/src/api/endpoints.js):

```js
export const endpoints = {
  auth:      { login, refresh, me },
  jobs:      { list, detail: (jobId) => ... },
  users:     { list, byId: (userId) => ... },
  apiKeys:   { list, byId: (keyId) => ... },
  auditLogs: { list, export },
  stats,
}
```

path ที่รับ id เป็นฟังก์ชัน ที่เหลือเป็น string. collection path ใช้ได้หลาย verb —
`users.list` เป็นทั้ง GET ที่ list และ POST ที่ create ส่วน `users.byId(id)` เป็นทั้ง
PUT และ DELETE

ในไฟล์มี comment ระบุ **เส้นที่ backend มีแต่หน้าบ้านไม่เรียก** ไว้ด้วย
(`POST /v1/analyze`, `GET /v1/results/:jobId`, `/health`, `/docs`) กันเข้าใจผิดว่า
ไฟล์นี้คือ API ทั้งหมดของระบบ — มันคือเฉพาะที่หน้าบ้านใช้

### จุดที่แก้ ครบทั้ง 17 จุด

| ไฟล์ | บรรทัด | เดิม | ตอนนี้ |
| --- | --- | --- | --- |
| [`api/client.js`](../frontend/src/api/client.js#L27) | 27 | `axios.post('/auth/refresh', …)` | `axios.post(endpoints.auth.refresh, …)` |
| [`pages/Login.jsx`](../frontend/src/pages/Login.jsx#L18) | 18, 20 | `client.post('/auth/login', form)` | `client.post(endpoints.auth.login, form)` |
| [`pages/Jobs.jsx`](../frontend/src/pages/Jobs.jsx#L21) | 21 | `` client.get(`/v1/results?${params}`) `` | `` client.get(`${endpoints.jobs.list}?${params}`) `` |
| [`pages/JobDetail.jsx`](../frontend/src/pages/JobDetail.jsx#L16) | 16 | `` client.get(`/v1/jobs/${id}`) `` | `client.get(endpoints.jobs.detail(id))` |
| [`pages/Dashboard.jsx`](../frontend/src/pages/Dashboard.jsx#L15) | 15, 16 | `client.get('/admin/stats')` | `client.get(endpoints.stats)` |
| [`pages/Users.jsx`](../frontend/src/pages/Users.jsx#L28) | 28, 43, 45, 56, 65 | `` client.put(`/admin/users/${u.id}`, …) `` | `client.put(endpoints.users.byId(u.id), …)` |
| [`pages/ApiKeys.jsx`](../frontend/src/pages/ApiKeys.jsx#L28) | 28, 43, 70 | `client.get('/admin/api-keys')` | `client.get(endpoints.apiKeys.list)` |
| [`pages/AuditLogs.jsx`](../frontend/src/pages/AuditLogs.jsx#L59) | 59, 75 | `` client.get(`/admin/audit-logs?${params}`) `` | `` client.get(`${endpoints.auditLogs.list}?${params}`) `` |

ยืนยันด้วย `npm run build` ผ่าน (106 modules) และ grep แล้วไม่เหลือ path ดิบใน
`.js`/`.jsx` นอกจากใน `endpoints.js` เอง

### เส้นที่หน้าบ้านเรียกจริง

| Method | Path | หน้า | หมายเหตุ |
| --- | --- | --- | --- |
| POST | `/auth/login` | Login | |
| GET | `/auth/me` | Login | แนบ token ที่เพิ่งได้เอง ไม่รอ store |
| POST | `/auth/refresh` | — | เรียกจาก axios interceptor ตอนเจอ 401 แล้ว retry อัตโนมัติ |
| GET | `/v1/results` | Jobs, Dashboard | `skip`, `limit`, `status_filter` |
| GET | `/v1/jobs/:id` | JobDetail | **poll ทุก 5 วินาที** ตอนสถานะ pending/processing |
| GET | `/admin/stats` | Dashboard | |
| GET POST | `/admin/users` | Users | |
| PUT DELETE | `/admin/users/:id` | Users | toggle active ส่งแค่ `{is_active}` |
| GET POST | `/admin/api-keys` | ApiKeys | full key คืนครั้งเดียวตอน create |
| DELETE | `/admin/api-keys/:id` | ApiKeys | revoke ไม่ได้ลบจริง |
| GET | `/admin/audit-logs` | AuditLogs | 8 query params |
| GET | `/admin/audit-logs/export` | AuditLogs | ตอบ CSV รับเป็น blob |

ทั้งหมดใช้ JWT — [`client.js`](../frontend/src/api/client.js) แนบ
`Authorization: Bearer` ให้อัตโนมัติใน request interceptor

### nginx

[`frontend/nginx.conf`](../frontend/nginx.conf) เปลี่ยน `proxy_pass` จาก
`soc-backend:8000` เป็น `soc-core-api:8000`
`vite.config.js` ไม่ต้องแก้ (ยังชี้ `localhost:8000` เหมือนเดิม)

### package-lock.json

เดิมฝั่ง frontend **ไม่มี lockfile เลย** ทำให้ทุก build ได้เวอร์ชัน dependency
ไม่เหมือนกัน ตอนนี้ commit `frontend/package-lock.json` แล้ว

`frontend/Dockerfile` ยังใช้ `npm install` อยู่ ควรเปลี่ยนเป็น `npm ci` ให้ล็อกตาม
lockfile เหมือนฝั่ง backend — ดูหัวข้อ [ยังไม่ได้ทำ](#ยังไม่ได้ทำ)

---

## ของเดิมที่ใช้ต่อได้ ไม่ต้อง migrate

| อย่าง | ทำไมยังใช้ได้ | โค้ด |
| --- | --- | --- |
| รหัสผ่านผู้ใช้เดิม | bcrypt cost 12 เท่ากับ default ของ passlib hash เดิม verify ผ่าน | [`auth.service.ts:25`](../backend/src/modules/auth/auth.service.ts#L25) `BCRYPT_ROUNDS = 12` |
| JWT ที่ออกไปแล้ว | HS256 `JWT_SECRET_KEY` เดิม payload `{sub, username, type}` เหมือนเดิม | [`auth.service.ts:44`](../backend/src/modules/auth/auth.service.ts#L44) |
| API key เดิม | `sk-` + 43 ตัว lookup ด้วย prefix 11 ตัว เทียบ SHA-256 hex | [`crypto.ts:11`](../backend/src/common/crypto.ts#L11) |
| ตารางใน DB | Prisma map ตารางที่ SQLAlchemy สร้าง ไม่ได้สร้างใหม่ | [`schema.prisma`](../backend/prisma/schema.prisma) |

### รายละเอียด schema mapping

SQLAlchemy ตั้งชื่อ PG enum type ตามชื่อคลาสตัวเล็ก และเก็บ **ชื่อ member** ไม่ใช่ value
(`JobStatus.PENDING` มี value เป็น `"pending"` แต่ในฐานข้อมูลเก็บ `PENDING`) Prisma
เลยต้อง `@@map` ให้ตรง:

```prisma
enum JobStatus {
  PENDING PROCESSING COMPLETED FAILED
  @@map("jobstatus")     // schema.prisma:21
}
enum EventType  { ... @@map("eventtype")  }   // schema.prisma:42
enum ActorType  { ... @@map("actortype")  }
```

field ทุกตัวใช้ `@map` ไปหาคอลัมน์ snake_case เดิม เช่น
`hashedPassword @map("hashed_password")` และ `@@map` ไปหาชื่อตาราง
(`users`, `roles`, `api_keys`, `ai_jobs`, `audit_logs`)

`audit_logs.id` เป็น `BigInt` ซึ่ง `JSON.stringify` โยน error ตามปกติ แก้ด้วย polyfill ที่
[`main.ts:12`](../backend/src/main.ts#L12):

```ts
(BigInt.prototype as any).toJSON = function () { return Number(this); };
```

---

## Breaking changes

สิ่งที่**เปลี่ยนพฤติกรรมจริง** ถึงจะเล็กก็ควรรู้

### 1. คิวเปลี่ยนจาก ARQ เป็น BullMQ

งานที่ค้างอยู่ในคิว ARQ เดิมจะไม่ถูกหยิบมาทำต่อ (คนละ format ใน Redis)
ควรรอให้งานเดิมหมดก่อนสลับ หรือยิงซ้ำ

idempotency ยังมีอยู่ — [`analysis.service.ts:71`](../backend/src/modules/analysis/analysis.service.ts#L71)
ส่ง `{ jobId: job.jobId }` เป็น option ของ `queue.add()` เหมือนที่ ARQ ใช้ `_job_id`
ยิงซ้ำด้วย job เดิมจึงไม่เข้าคิวสองรอบ

ค่าอื่นที่ย้ายมาให้ตรงของเดิม ([`queue.module.ts:30`](../backend/src/modules/queue/queue.module.ts#L30)):

| ARQ เดิม | BullMQ ตอนนี้ |
| --- | --- |
| ไม่ retry | `attempts: 1` |
| `keep_result = 3600` | `removeOnComplete: { age: 3600 }` |
| `max_jobs = 1` | `WORKER_CONCURRENCY=1` (อ่านใน `@Processor`) |
| `job_timeout = 180` | **ไม่มีของเทียบตรง** — BullMQ ไม่มี per-job timeout ใช้ axios timeout (`OLLAMA_TIMEOUT`) แทน |

### 2. `POST /v1/analyze` ตอบ 202 แทน 200

เดิมโค้ดตอบ 200 (ทั้งที่ audit บันทึกเป็น 202) ตอนนี้ตอบ 202 จริงที่
[`analysis.controller.ts:20`](../backend/src/modules/analysis/analysis.controller.ts#L20)
(`@HttpCode(202)`)

body เหมือนเดิม `{job_id, status, estimated_wait_seconds}`
client ที่เช็ค `status_code == 200` ตรง ๆ ต้องแก้ (`raise_for_status()` ไม่กระทบ)

### 3. `GET /health` เพิ่ม field `ai_service`

[`health.controller.ts:21`](../backend/src/modules/health/health.controller.ts#L21) เพิ่ม
`ai_service: "up" | "down"` — field เดิม (`status`, `app`, `model`) ยังอยู่ครบ

### 4. `POST /admin/users` validate เข้มขึ้น

[`user.dto.ts`](../backend/src/modules/users/dto/user.dto.ts):

| กติกา | บรรทัด |
| --- | --- |
| `email` ต้องเป็นอีเมลจริง (เดิมรับ string อะไรก็ได้ตอน create) | 9 |
| `password` ต้องยาว ≥ 8 ตัว (เดิมไม่เช็คเลย) | 12 |
| `role` ต้องเป็น `admin` / `analyst` / `readonly` | 15 |

และ ValidationPipe ตั้ง `whitelist: true` ที่
[`main.ts:36`](../backend/src/main.ts#L36) — field ที่ไม่รู้จักใน body ถูกตัดทิ้งเงียบ ๆ

### 5. enum `eventtype` เพิ่ม label `AUTH_KEY_FAILED`

`core/deps.py` เดิมเขียน audit ด้วย `event_type="AUTH_KEY_FAILED"` แต่ไม่ได้ประกาศ
ไว้ใน `EventType` enum — insert จริงจะพัง ตอนนี้ประกาศไว้ที่
[`schema.prisma:33`](../backend/prisma/schema.prisma#L33) แล้ว `prisma db push` จะเพิ่ม
label ให้กับ DB ที่มีอยู่

### 6. การ init DB เปลี่ยนคำสั่ง

`python scripts/init_db.py` → `npx prisma db push` + `npm run seed`

`npm run seed` รัน `dist/seed.js` เพราะงั้น**ต้อง build ก่อน** ตัว seed ใช้ `upsert`
สำหรับ role และเช็คก่อนสร้าง admin ([`seed.ts`](../backend/src/seed.ts)) รันซ้ำได้ไม่พัง

### 7. ลำดับการลบใน maintenance สลับกัน

`services/maintenance_service.py` เดิมลบ jobs ก่อน audit logs ตอนนี้
[`maintenance.service.ts:34`](../backend/src/modules/maintenance/maintenance.service.ts#L34)
ลบ audit logs ก่อนแล้วค่อยลบ jobs เพราะ `audit_logs.job_id` อ้างถึง `ai_jobs`
(ผลลัพธ์สุดท้ายเหมือนกัน เพราะ FK เป็น `ON DELETE SET NULL` อยู่แล้ว)

### 8. `ai-service` ยังไม่มี `POST /analyze` — **แก้แล้วในรอบที่ 2**

~~งานที่ยิงเข้ามาตอนนี้จะจบที่สถานะ `FAILED` พร้อม `error_message` ว่า
`AI service error: ...` จนกว่าจะเขียนฝั่ง Python ตาม contract~~

เขียนแล้ว pipeline ต่อครบเส้น ดู [รอบที่ 2](#รอบที่-2--ai-service-stateless--mcp-connectors)

---

## Environment

ตัวที่**เพิ่ม** ใน [`.env.example`](../.env.example) — ทุกตัวอ่านที่
[`configuration.ts`](../backend/src/config/configuration.ts)

| ตัวแปร | ใช้ทำอะไร |
| --- | --- |
| `CORE_DATABASE_URL` | Prisma ต้องใช้ scheme `postgresql://` ธรรมดา — `DATABASE_URL` ที่เป็น `postgresql+asyncpg://` ใช้กับ Prisma ไม่ได้ จึงต้องมีสองตัวชี้ DB เดียวกัน |
| `AI_SERVICE_URL` | base URL ของ `ai-service` (default `http://soc-ai:8100`) |
| `REDIS_DB` | เดิมมีแต่ใน `config.py` ไม่ได้อยู่ใน `.env.example` |
| `WORKER_CONCURRENCY` | จำนวนงานพร้อมกันของ worker (default 1 เท่ากับ ARQ `max_jobs=1` เดิม) |
| `APP_NAME` `PORT` | เดิม hardcode อยู่ใน `config.py` |
| `RETENTION_DAYS_JOBS` `RETENTION_DAYS_AUDIT` `CLEANUP_HOUR` `CLEANUP_MINUTE` | เดิมมีแต่ใน `config.py` |

`APP_ROLE` (`api` / `worker`) ตั้งให้แล้วใน `docker-compose.yml` ไม่ต้องใส่ใน `.env`

ตัวเดิมที่ชื่อไม่เปลี่ยนเลย: `JWT_*`, `OLLAMA_*`, `POSTGRES_*`, `REDIS_HOST/PORT`,
`ALLOWED_ORIGINS`, `DEFAULT_ADMIN_*`, `APP_ENV`, `DEBUG`

**ข้อควรระวังตอนรัน local:** `ConfigModule` อ่าน `.env` จาก working directory ซึ่งคือ
`backend/` ไม่ใช่ root ของ repo — `.env` ที่ root จะไม่ถูกอ่าน ใน Docker ไม่มีปัญหา
เพราะ compose ใช้ `env_file` ฉีดเข้ามาเป็น environment variable โดยตรง

---

## Job lifecycle

```
SOAR --POST /v1/analyze (X-API-Key)--> soc-core-api
                                          |  สร้างแถว ai_jobs (PENDING)
                                          |  audit ANALYZE_REQUEST + JOB_QUEUED
                                          |  ตอบ 202 ทันที
                                          v
                                  BullMQ "analysis" queue (Redis)
                                          |
                                          v
                                   soc-core-worker
                                          |  PROCESSING + audit JOB_PROCESSING
                                          |  POST /analyze
                                          v
                                       soc-ai  --> Ollama
                                          |
                                     ai_response
                                          |
                        COMPLETED / FAILED + audit JOB_COMPLETED|JOB_FAILED
```

### ทีละขั้น พร้อมโค้ด

| ขั้น | ไฟล์ | บรรทัด |
| --- | --- | --- |
| ตรวจ API key, stamp `last_used_at`, audit `AUTH_KEY_FAILED` ถ้าไม่ผ่าน | [`api-key.guard.ts`](../backend/src/common/guards/api-key.guard.ts) | ทั้งไฟล์ |
| สร้างแถว `ai_jobs` สถานะ `PENDING` | [`analysis.service.ts`](../backend/src/modules/analysis/analysis.service.ts#L33) | 33 |
| audit `ANALYZE_REQUEST` | `analysis.service.ts` | 46 |
| `queue.add()` พร้อม `jobId` กันซ้ำ | `analysis.service.ts` | 59–72 |
| audit `JOB_QUEUED` | `analysis.service.ts` | 75 |
| worker รับงาน → `PROCESSING` + เก็บ `rendered_prompt` | [`analysis.processor.ts`](../backend/src/modules/queue/analysis.processor.ts#L47) | 47 |
| audit `JOB_PROCESSING` | `analysis.processor.ts` | 50 |
| เรียก AI service | `analysis.processor.ts` | 59 |
| ล้มเหลว → `FAILED` + audit `JOB_FAILED` | `analysis.processor.ts` | 67, 73 |
| สำเร็จ → `COMPLETED` + audit `JOB_COMPLETED` | `analysis.processor.ts` | 87, 98 |

เทียบกับของเดิม: ขั้นตอนและ audit event เหมือนเดิมทุกตัว ต่างแค่ขั้น "เรียก Ollama"
กลายเป็น HTTP call ไป `ai-service` แทนที่จะเรียกในโปรเซสเดียวกัน

## สองสเตจ — suggestion ก่อน แล้วค่อยค้น Splunk

เดิม alert หนึ่งใบคือ agent loop เดียวยาวๆ: วิเคราะห์ ถาม Splunk ผ่าน delegate
รอผล แล้วสรุป วัดจริงได้ 470–726 วินาทีต่อใบบน CPU ล้วน ซึ่งแปลว่า analyst
รอเกือบสิบนาทีกว่าจะเห็นอะไรสักอย่าง

ตอนนี้แยกเป็นสองสเตจ

```
FortiSOAR ──► backend ──► enrich (IOC + ThreatQ + playbook hook)
                              │
                              ▼
                       stage 1: soc-suggest      ← ไม่มี tool ไม่มี delegate
                       เรียก model ครั้งเดียว     เรียกอะไรไม่ได้เลย
                              │
                  ┌───────────┴───────────┐
                  ▼                       ▼
            == SUGGESTION ==      == NEEDED FROM SPLUNK ==
            ai_response           splunk_requirements  (เก็บไว้ ยังไม่รัน)
                                          │
                                   ปุ่ม / SPLUNK_LOOKUP_MODE=auto
                                          ▼
                               stage 2: splunk-query ต่อ requirement
                                          ▼
                                      lookup_result
```

### ทำไมเรียก model ครั้งเดียวแต่ได้สองอย่าง

บนเครื่องที่ไม่มี GPU การเรียกรอบที่สองคือหลายนาทีที่ไม่ได้อะไรเพิ่ม
prompt ของ `soc-suggest` เลยสั่งให้ตอบเป็นสองหัวข้อที่ระบุชื่อไว้ตายตัว แล้ว
[`suggestion.ts`](../backend/src/modules/ai/suggestion.ts) แยกกลับเป็นสองค่า

parser เขียนแบบยอมความ เพราะ model 7B ที่ถูกสั่งให้ทำหัวข้อ มันทำได้จริง
แต่ก็เขียน `**== SUGGESTION ==**` บ้าง ใส่เลขหน้า bullet บ้าง และต่อท้าย
`- none` หลังจากเขียน requirement จริงมาสี่ข้อแล้ว เพราะคำสั่งให้เขียน `none`
ตอนไม่มีอะไร เป็นสิ่งสุดท้ายที่มันอ่าน ไม่มีอันไหนควรทำให้ analyst เสียคำตอบ

ถ้าหาหัวข้อไม่เจอเลย: เก็บข้อความทั้งก้อนเป็น suggestion, requirements ว่าง,
แล้วตั้ง flag `malformed` — "ไม่มีอะไรต้องค้น" กับ "model ตอบผิดฟอร์แมต" เป็น
คนละเรื่องกัน และการไม่มีปุ่มไม่ควรเป็นเบาะแสเดียว

### ทำไม stage 2 อยู่คนละคิว

คิวเดียวกันแปลว่า lookup ที่กินเวลาหลายนาทีต่อ requirement จะไปนั่งขวางหน้า
alert ใบถัดไปที่ยังรอคำตอบแรกอยู่ ซึ่งทำลายเหตุผลของการแยกสเตจทั้งหมด
`splunk-lookup` เลยเป็นคิวของตัวเอง

`processing_time_ms` จึงหมายถึงสิ่งที่ analyst รอจริง — suggestion — ไม่รวม
อย่างอื่น ส่วน `lookup_time_ms` แยกอีกช่อง

### `lookup_status` ไม่ได้ยุบรวมกับ `status`

job เป็น COMPLETED ตอน suggestion พร้อม ซึ่งคือสิ่งที่ SOAR poll รอ ส่วนจะมี
ใครไปจ่ายเวลา inference ค้น Splunk ต่อไหม เป็นคำถามคนละข้อที่มีคำตอบคนละแบบ

| ค่า | หมายความว่า |
| --- | --- |
| `NOT_REQUESTED` | ยังไม่มีใครกด |
| `QUEUED` / `RUNNING` | กำลังทำ — กดซ้ำจะได้ 409 |
| `COMPLETED` | ค้นแล้ว ผลอยู่ที่ `lookup_result` |
| `FAILED` | ทุก requirement ล้ม (บางอันล้มยังนับ COMPLETED ช่องว่างเห็นในผล) |

### config

| ตัวแปร | default | ความหมาย |
| --- | --- | --- |
| `SPLUNK_LOOKUP_MODE` | `manual` | `auto` = ต่อคิวเองทันทีที่ suggestion เสร็จ |
| `SPLUNK_LOOKUP_MAX_REQUIREMENTS` | `5` | เพดานจำนวนที่รันจริง |
| `SPLUNK_LOOKUP_AGENT` | `splunk-query` | agent ที่แปลง requirement เป็น search |
| `LLM_SUGGEST_AGENT` | `soc-suggest` | agent ของ stage 1 |

---

### rendered prompt

ประกอบที่
[`ai.service.ts`](../backend/src/modules/ai/ai.service.ts) — เหตุการณ์ก่อน
แล้วตามด้วยสิ่งที่ backend หาไว้ให้แล้ว:

```
--- RAW LOG ---
{raw_log}
--- END OF LOG ---

{enrichment}
```

**ไม่มีบรรทัด instruction** เดิม `prompt` ที่ playbook ส่งมาถูกวางไว้บนสุด
เหนือ raw log ซึ่งแปลว่ามันแข่งกับ system prompt ของ agent โดยตรง — ใครถือ
API key ก็เขียนทับกฎ "ห้ามแต่งข้อมูล" กับ "ห้ามแนะนำ action" ได้
ตอนนี้คำสั่งมาจาก agent บน `llm-server` ที่เดียว ซึ่งเป็นสิ่งเดียวใน pipeline นี้
ที่ผู้เรียกแก้ไม่ได้

### contract ระหว่าง backend กับ ai-service

```
POST {AI_SERVICE_URL}/analyze
  request   { "rendered_prompt": "...", "model": "qwen2.5:7b" }
  response  { "response": "...", "model": "qwen2.5:7b",
              "total_duration_ms": 12345, "tokens_prompt": 900, "tokens_eval": 210 }

GET {AI_SERVICE_URL}/health  ->  { "status": "ok" }
```

ฝั่ง client อยู่ที่ [`ai.service.ts`](../backend/src/modules/ai/ai.service.ts) — timeout
มาจาก `OLLAMA_TIMEOUT` (วินาที × 1000) และ error ถูกห่อเป็น
`ServiceUnavailableException` พร้อมข้อความ `AI service error: <detail>`

---

## Migration

ของเดิมรันอยู่ ทำตามนี้:

```bash
# 1. หยุดของเดิม (เก็บ volume ไว้)
docker compose down

# 2. เพิ่ม env ตัวใหม่ลง .env — อย่างน้อย CORE_DATABASE_URL กับ AI_SERVICE_URL
#    CORE_DATABASE_URL ต้องชี้ DB เดียวกับ DATABASE_URL แต่ใช้ scheme postgresql://
#    เทียบตัวที่ขาดกับ .env.example

# 3. build + start
docker compose up -d --build

# 4. sync schema (idempotent — ของเดิมไม่หาย เพิ่มแค่ label AUTH_KEY_FAILED)
docker compose exec soc-core-api npx prisma db push

# 5. seed roles + admin (ข้ามถ้ามีอยู่แล้ว)
docker compose exec soc-core-api npm run seed
```

ผู้ใช้เดิม รหัสผ่านเดิม API key เดิม ใช้ได้ทันที ไม่ต้องออกใหม่

ตรวจว่าขึ้นครบ:

```bash
curl localhost:8000/health
docker compose logs -f soc-core-worker
```

---

## Dependency ที่เปลี่ยนไปพร้อมกัน

ระหว่างพอร์ตมี 3 อย่างที่ตั้งใจเลือกไว้ เขียนไว้ละเอียดใน
[`backend/README.md`](../backend/README.md) หัวข้อ Dependency security

| เรื่อง | ทำอะไร |
| --- | --- |
| `overrides` ใน `package.json` | pin `multer@^2.3.0` และ `deepmerge-ts@^8.0.2` เพราะ parent (`@nestjs/platform-express`, `prisma`) ยังส่งเวอร์ชันที่มี DoS advisory มาให้ |
| `bullmq@^6` | v6 ใช้ `cron-parser@5` แทน v4 ที่เลิกดูแลแล้ว และต้องเพิ่ม `ioredis` เป็น direct dependency เพราะ v6 ทำให้เป็น optional peer |
| `.npmrc` `min-release-age=7` | ไม่ติดตั้ง version ที่เพิ่งออกไม่ถึง 7 วัน กันกรณี publish ถูกยึด |

`backend/Dockerfile` ใช้ `npm ci` (ไม่ใช่ `npm install`) และรันเป็น user `node`
ไม่ใช่ root

---

## รอบที่ 2 — `ai-service` stateless + MCP connectors

*2026-09-16*

รอบแรกย้ายโค้ด Python มาไว้ที่ `ai-service/` เฉยๆ ไม่แตะข้างใน รอบนี้ตัดจริง
และเพิ่ม connector ชั้น MCP

### `ai-service` — 1,777 → 217 บรรทัด

เดิมมันคือ backend เต็มตัวที่ NestJS ทำแทนไปหมดแล้ว แต่ยังรันคู่กันอยู่

| ลบ | บรรทัด | เพราะ |
| --- | --- | --- |
| `routers/admin.py` `analysis.py` `auth.py` | 597 | NestJS ถือ `/admin/*` `/auth/*` `/v1/*` แล้ว |
| `models/` (ai_job, user, api_key, audit_log) | ~180 | Prisma เป็นเจ้าของ schema |
| `workers/ai_worker.py` `queue.py` | 167 | BullMQ ใน NestJS แทน ARQ |
| `core/database.py` `deps.py` `audit.py` `security.py` | ~270 | ไม่ต่อ DB ไม่ออก token อีกแล้ว |
| `services/auth_service.py` `maintenance_service.py` | 109 | |
| `schemas/admin.py` `audit.py` `auth.py` | ~120 | |
| `scripts/init_db.py` | 62 | `prisma db push` + `npm run seed` แทน |

เหลือ 10 ไฟล์:

```
main.py                     51   /analyze + /health
services/ollama_service.py  71   เรียก Ollama
schemas/analysis.py         24   contract กับ backend
core/config.py              25   OLLAMA_* เท่านั้น
Dockerfile  README.md  requirements.txt  + __init__.py 3 ตัว
```

**จุดที่อันตรายที่สุดที่หายไป** — `main.py` เดิมเรียก
`Base.metadata.create_all` ตอน startup คือ SQLAlchemy สร้างตารางทับ schema ที่
Prisma เป็นเจ้าของ ตอนนั้นยังไม่ชนเพราะชื่อตารางบังเอิญตรงกัน แต่ Prisma
migration ครั้งถัดไปที่เปลี่ยน column จะกลายเป็นสองฝั่งแย่งกันเป็นเจ้าของ

ตอนนี้ไม่มีอะไรใน `ai-service` แตะ DB — stateless จริงตามที่ออกแบบไว้ตั้งแต่รอบแรก

### `POST /analyze` — breaking change #8 ปิดแล้ว

ก่อนหน้านี้เส้นทั้งเส้น**ขาด** worker ยิง `POST {AI_SERVICE_URL}/analyze` แล้วได้
404 ทุกครั้ง เพราะ FastAPI มีแต่ `/v1/analyze` (คนละเส้น มี auth มี DB มีคิวของตัวเอง)

ทดสอบ pipeline เต็มเส้นแล้วผ่าน:

```
POST /v1/analyze (X-API-Key) -> ai_jobs PENDING -> BullMQ -> worker
  -> POST soc-ai/analyze -> Ollama -> COMPLETED
status: completed   4.4s   tokens 92/44
```

`error` mapping ที่เพิ่ม — backend ปฏิบัติกับสองกรณีนี้ต่างกัน:

| กรณี | status |
| --- | --- |
| Ollama เกิน `OLLAMA_TIMEOUT` | `504` — retry ได้ |
| Ollama ติดต่อไม่ได้ | `503` |
| `rendered_prompt` ว่าง | `422` |

`requirements.txt` 15 → 5 package (ตัด sqlalchemy, asyncpg, alembic, arq, redis,
jose, passlib, bcrypt, multipart, dotenv) และ `Dockerfile` ตัด `gcc` `libpq-dev`
ที่ติดมาเพื่อ compile asyncpg, เพิ่ม non-root user, แก้ `EXPOSE 8000` → `8100`
ให้ตรงกับ port ที่รันจริง, ใส่ `CMD` ที่เดิมไม่มี (พึ่ง `command:` ใน compose อย่างเดียว)

### `mcp/threatq/` — gateway ตัวใหม่

> **อัปเดต 2026-09-21:** ตัดเหลือ HTTP service + tool เดียวแล้ว โหมด proxy กับ
> โหมด agent ที่อธิบายข้างล่างถูกลบออก (`proxy.py`, `agent_mode.py`, `trim.py`
> รวม 426 บรรทัด) เพราะไม่มีใครเรียก และทั้งคู่ตั้งอยู่บนสมมติฐานว่า ThreatQ มี
> `/api/mcp` ซึ่งยังไม่เคยยืนยัน ส่วนที่เหลือคือ `POST /lookup` ที่ backend ใช้จริง
> กับ tool `lookup_indicator` ตัวเดียว — ดู
> [`mcp-server/Threatq/README.md`](../mcp-server/Threatq/README.md)

ThreatQ ต่างจาก Splunk ตรงที่**มี MCP service ของตัวเองอยู่แล้ว** (`/api/mcp` และ
`/api/agent`) จึงไม่เขียน connector ใหม่ แต่ทำเป็น gateway คร่อมของเดิม

สองโหมด เลือกด้วย `THREATQ_MODE`:

| โหมด | ต่อกับ | LLM |
| --- | --- | --- |
| `mcp` (default) | ThreatQ `/api/mcp` | ไม่มี — model ของเราคิดคนเดียว |
| `agent` | ThreatQ `/api/agent` | **ThreatQ ใช้ LLM ของตัวเอง** |

สิ่งที่ gateway เพิ่มจากการต่อ `/api/mcp` ตรงๆ:

- **auth boundary** — `soc-ai` ถือ token ของเรา ไม่เคยเห็น credential ของ ThreatQ
- **write barrier** — operations ของ ThreatQ เขียนข้อมูลได้ (เพิ่ม indicator,
  เปลี่ยน status, ยิง action) republish เฉพาะ tool ที่ read-only เว้นแต่ตั้ง
  `THREATQ_ALLOW_WRITE=true`
- **size cap** — indicator ที่มี attribute ครบชุดใหญ่กว่า context ทั้งก้อนของ model
  (`num_ctx=4096`) ตัดที่ `THREATQ_MAX_RESULT_CHARS` พร้อมบอกในข้อความว่าตัดไปเท่าไหร่
- **สลับโหมดโดยไม่แตะ `ai-service`**

tool schema **discover ตอน runtime ไม่ hardcode** — ThreatQ เพิ่ม tool ใหม่
เห็นทันทีหลัง `POST /refresh` หรือ restart ไม่ต้องแก้โค้ด

ทดสอบกับ MCP server ปลอม (ยังไม่เคยเจอ ThreatQ จริง): discovery, schema fidelity
(enum/default/description ส่งถึง model ครบ), forwarding, write barrier
(`add_indicator` → `Unknown tool`), การ trim (20k → 6k), และกรณี ThreatQ ล่ม
(ขึ้นได้ปกติ tool list ว่าง ไม่ restart loop)

**ข้อสมมติที่ยังไม่ได้ยืนยันกับ instance จริง** 4 ข้อ เขียนไว้เป็นตารางใน
[`mcp/threatq/README.md`](../mcp-server/Threatq/README.md) ว่าถ้าผิดต้องแก้ตรงไหน —
สามข้อแรกแก้ได้ด้วย env ไม่ต้องแตะโค้ด

service อยู่หลัง profile `threatq` ไม่ขึ้นตอน `docker compose up` ปกติ

### `OLLAMA_KEEP_ALIVE` `5m` → `-1`

`5m` แปลว่าเงียบเกิน 5 นาที Ollama unload weight ทิ้ง งานถัดไปจ่ายค่าโหลด 4.7GB ใหม่
ซึ่งขัดกับเหตุผลที่มี model server กลางตั้งแต่แรก

วัดจริง:

```
cold (หลัง restart):  17.7s
warm:                  0.95s
ollama ps UNTIL:       Forever
```

`OLLAMA_NUM_PARALLEL=1` กับ `WORKER_CONCURRENCY=1` คงไว้เหมือนเดิม — คุมความขนาน
ที่ BullMQ ดีกว่าปล่อยให้ไปชนกันที่ Ollama เพราะเห็นคิวได้และปรับได้ทีละขั้น
การเพิ่ม `NUM_PARALLEL` ไม่ฟรี: Ollama จัดสรร KV cache ต่อ slot ซึ่งแล้วแต่เวอร์ชัน
ว่าแบ่ง context ที่มีหรือคูณ memory ที่ใช้ — ที่ `num_ctx=4096` กับ `mem_limit: 12g`
ต้องวัดก่อนไม่ใช่เดา

`ollama ps` ยังบอกด้วยว่ารันบน **CPU 100% ไม่มี GPU** — prompt สั้นๆ 44 token
ใช้ 4.4 วิ พอใส่ agent loop (หลายรอบ + ผล tool ที่ยาวกว่านี้มาก) จะเป็นหลักนาที
ต่อ alert ต้องเผื่อตอนตั้ง timeout

### เอกสารกับ env

- [`.env.example`](../.env.example) เพิ่ม `MCP_*` / `SPLUNK_*` ของ `mcp/splunk`
  (เดิมไม่มีเลยทั้งที่ container refuse to start ถ้าไม่ตั้ง) และ `THREATQ_*` 15 ตัว
- [`README.md`](README.md) แก้ `docker compose up` เป็น `--profile ai` (เดิมตกไป
  ทำให้ worker ไม่มี `soc-ai` ให้เรียก) และเพิ่มกับดัก 2 ข้อที่เจอตอนรันจริง:
  `seed` ไม่ทับ user เดิม (เปลี่ยน `DEFAULT_ADMIN_PASSWORD` หลัง seed ครั้งแรกไม่มีผล)
  และ Postgres ใช้ `POSTGRES_PASSWORD` เฉพาะตอน init volume เปล่า (ใช้ volume เก่า
  กับรหัสใหม่ = `P1000 Authentication failed`)

---

## รอบที่ 3 — agent platform (`llm-server`)

*2026-09-21*

รอบที่ 2 ตัด `ai-service` ให้เหลือ prompt -> text รอบนี้ย้ายงานคิดออกไปอีกชั้น

> **`llm-server/` ในรีโปนี้เป็นตัวทดลอง ไม่ใช่โค้ดหลัก** ของจริงอีกทีมกำลังเขียน
> และใช้ SSE สิ่งที่ต้องอยู่ทน คือฝั่ง `ai-service` ที่ต้องรับได้ — ดู
> [รับจาก LLM Server](#รับจาก-llm-server-ที่ยังไม่รู้หน้าตา) ท้ายหัวข้อนี้
> ตัวทดลองมีไว้ให้เส้นทางทั้งเส้นทำงานได้ก่อนของจริงมา และไว้เทียบว่า client
> อ่านถูกไหม

### ทำไมต้องมีชั้นใหม่

เดิมวิธีวิเคราะห์ถูกกำหนดด้วย `prompt` ที่ playbook ส่งมา บวกกับโค้ดใน
`ai-service` เปลี่ยน model หรือแก้วิธีคิด = แก้โค้ดแล้ว deploy

`llm-server` ทำให้ agent กลายเป็น**ข้อมูลแถวหนึ่ง** — ชื่อ, model, system prompt,
MCP server ที่เรียกได้, เพดานของ loop แก้ในหน้า UI มีผลทันที

### โครงใหม่

```
soc-core-worker ──POST /analyze──► soc-ai ══SSE══► LLM Server
                                  (ไม่มี state)      │        │
                                         /api/chat   │        │ MCP
                                              ▼      │        ▼
                                         soc-ollama  │  soc-mcp-splunk
                                         (weight)    │  soc-mcp-threatq
```

`soc-ai` อ่านคำตอบจาก stream ไม่ได้รอ JSON ก้อนเดียว เพราะ LLM Server ตัวจริง
สตรีมด้วย SSE

| service | หน้าที่ | state |
| --- | --- | --- |
| `soc-ai` | ประตู อ่าน SSE แปลง error เป็น status ที่ backend ใช้ตัดสินใจ retry | ไม่มี |
| LLM Server | agent definition + agent loop + MCP client + UI | SQLite ของตัวเอง |
| `soc-ollama` | ถือ weight อย่างเดียว agent ทุกตัวใช้ร่วมกัน | volume |

**contract กับ NestJS ไม่เปลี่ยน** — `POST /analyze` รับ `rendered_prompt` คืน
`{response, model, total_duration_ms, tokens_prompt, tokens_eval}` เหมือนเดิม
ไม่ต้องแก้อะไรใน `backend/` เลยทั้งที่การวิเคราะห์กลายเป็น agentic

### MCP client — ชิ้นที่ค้างมาตั้งแต่รอบที่ 2

รอบที่ 2 จบลงด้วย MCP server สองตัวที่ไม่มีใครเรียก รอบนี้มีคนเรียกแล้ว
([`llm-server/agent/loop.py`](../llm-server/agent/loop.py), [`mcp_client.py`](../llm-server/agent/mcp_client.py))

> อยู่ใน prototype วันนี้ แต่ตามที่ตกลงกันไว้ loop จะย้ายไป `ai-service` —
> รายละเอียดท้ายหัวข้อนี้ สิ่งที่เขียนไว้ตรงนี้คือข้อจำกัดของ loop เอง
> ซึ่งไม่เปลี่ยนไม่ว่ามันจะอยู่ service ไหน

สิ่งที่ loop จัดการ:

- **`/api/chat` ไม่ใช่ `/api/generate`** — tool schema เดินทางใน `tools` parameter
- **เพดาน** `max_steps` รอบ แล้วบังคับตอบโดยไม่ให้ tool (ไม่งั้นวนไม่จบ)
  และ `AGENT_RUN_TIMEOUT` ครอบทั้ง run อีกชั้น
- **ตัดผล tool** ที่ `max_tool_chars` พร้อมบอกในข้อความว่าตัดไปเท่าไหร่ —
  model ที่ไม่เห็นว่าโดนตัดจะสรุปว่า "ไม่พบ event เพิ่มเติม" ทั้งที่ความจริงคือ
  "รายการหยุดตรงนี้"
- **connector ล่มไม่ทำให้ run พัง** — model แค่ไม่ได้รับ tool นั้น trace บันทึกว่าทำไม
- **ชื่อ tool ชนกัน** — ใช้ชื่อเดิมตราบใดที่ไม่ซ้ำ ถ้าซ้ำทั้งคู่กลายเป็น
  `<server>__<tool>` เพราะ model ที่ถูกบอกว่ามี `search` สองตัวเลือกไม่ถูก
- **`num_ctx` 8192 ไม่ใช่ 4096** — tool schema กับผล tool แย่ง context กับ alert

### ทดสอบเส้น agent → MCP → Splunk

4 endpoint เรียงตามลำดับที่ใช้จริงตอนผลออกมาผิด ([`/docs`](http://localhost:8400/docs)):

| ขั้น | endpoint | ตอบคำถาม |
| --- | --- | --- |
| 1 | `GET /mcp-servers` | connector ลงทะเบียนไว้ไหม มี token ไหม |
| 2 | `GET /mcp-servers/{name}/tools` | ต่อติดไหม publish อะไร schema หน้าตายังไง |
| 3 | `POST /mcp-servers/call` | เรียก tool ตรงๆ ไม่ผ่าน model |
| 4 | `POST /agents/{ref}/run` | ทั้ง loop พร้อม trace ทุก tool call |

ขั้น 3 คือตัวที่ตัดสินข้อถกเถียงส่วนใหญ่ — แยกระหว่าง *model คิดผิด* กับ
*tool คืนค่าไม่ตรงที่เราคิด*

### `llm-server` ตั้งค่าตัวเอง

compose, `.env`, volume, Dockerfile อยู่ในโฟลเดอร์ตัวเองหมด รันเดี่ยวได้:

```bash
cd llm-server && cp .env.example .env && docker compose up -d --build
```

root compose ใช้นิยาม**เดียวกัน**ผ่าน `extends` ไม่ได้เขียนซ้ำสองที่ —
root เพิ่มแค่ `container_name`, `depends_on: soc-ollama`, `networks`

**ผลพลอยได้ที่สำคัญกว่า:** มันอ่าน `llm-server/.env` ไม่ใช่ `.env` ของ root
จึงเป็น service แรกในสแตกที่**ไม่ได้ถือ secret ของคนอื่น**

```
$ docker compose exec soc-llm-server env | grep -cE 'POSTGRES_PASSWORD|JWT_SECRET'
0
```

เทียบกับ `soc-mcp-splunk` ที่ยังถือ `JWT_SECRET_KEY` อยู่เพราะใช้ `env_file: .env`
ทั้งไฟล์ — ใครได้ shell ใน container นั้นเซ็น JWT เป็น admin ได้ นี่คือรูปแบบที่
service อื่นควรตามต่อไป

`MCP_SERVERS` เป็น JSON array แทนตัวแปรแยกชื่อ (`SPLUNK_MCP_URL`, `MCP_AUTH_TOKEN`)
เพิ่ม connector ตัวที่สามไม่ต้องแก้ `config.py`

> ⚠️ compose ตั้งชื่อ volume ตาม project — รันจาก root ได้ `soc-ai_llm-agents`
> รันจากโฟลเดอร์ได้ `llm-server_llm-agents` คนละก้อน agent ที่สร้างทางหนึ่ง
> อีกทางมองไม่เห็น เลือกทางเดียวหรือใส่ `-p soc-ai`

### เก็บ agent ที่ไหน

SQLite ของ `llm-server` เอง ไม่ใช่ Postgres ที่ backend ถือ — agent definition
เป็น configuration ไม่ใช่ job state และไม่ควรอยู่ใน job schema
`backend/` ยังเป็นตัวเดียวที่เขียน Postgres ตามหลักเดิม

### `soc-ai` ออกจาก profile `ai`

เดิมอยู่หลัง profile ทำให้ `docker compose up` ปกติไม่ขึ้น `soc-ai` แล้ว worker
ยิง `/analyze` ไม่ถึง = job FAILED ทุกตัว ตอนนี้อยู่ใน default profile
เพราะ pipeline ทำงานไม่ได้ถ้าขาดมัน

### รับจาก LLM Server ที่ยังไม่รู้หน้าตา

LLM Server ตัวจริงเป็นของอีกทีม สตรีมด้วย SSE และรูปแบบอาจเปลี่ยน `ai-service`
จึงถูกเขียนให้**ไม่ผูกกับ format ใด format หนึ่ง** และปรับด้วย `.env` ไม่ใช่แก้โค้ด

[`services/sse.py`](../ai-service/services/sse.py) อ่าน event ด้วยกฎเดียว:
**ทุก event ให้ข้อความเท่าที่มี ถ้า event ไหนมีคำตอบเต็ม อันนั้นชนะ** —
server ที่ส่ง token ทีละตัวกับที่ส่งก้อนเดียวจึงใช้ได้เหมือนกัน

ทดสอบแล้ว 6 รูปแบบ ผ่านทั้งหมด:

| รูปแบบ | ตัวอย่าง |
| --- | --- |
| OpenAI deltas | `data: {"choices":[{"delta":{"content":"…"}}]}` + `[DONE]` |
| Ollama NDJSON | `{"message":{"content":"…"},"done":false}` ไม่มี `data:` |
| SSE + event name | `event: token` / `data: {"token":"…"}` |
| ก้อนเดียวจบ | `data: {"output":"…","run_id":"…"}` |
| delta แล้วสรุปซ้ำ | ไม่ได้ข้อความซ้ำสองรอบ |
| text ล้วนไม่ใช่ JSON | `data: some text` + comment keepalive |

ดึง metadata ให้ด้วยถ้ามี (`model`, `run_id`, `agent`, `steps_used`, token) รองรับ
ทั้งชื่อแบบ OpenAI (`prompt_eval_count`) และแบบตรงตัว (`tokens_prompt`)

**สิ่งที่ปรับได้ด้วย `.env`:**

| setting | ใช้เมื่อ |
| --- | --- |
| `LLM_RUN_PATH` | path ไม่ใช่ `/agents/{agent}/run` |
| `LLM_INPUT_FIELD` | field ไม่ชื่อ `input` |
| `LLM_AGENT_FIELD` | agent ส่งใน body ไม่ใช่ path |
| `LLM_EXTRA_BODY` | ต้องส่ง field เพิ่ม เช่น `{"stream":true}` |
| `LLM_AUTH_TOKEN` / `LLM_EXTRA_HEADERS` | ถ้าต้อง auth |
| `LLM_STREAM_MODE` | `auto` / `always` / `never` |

**`POST /llm-probe`** — ยิงเหมือน `/analyze` แต่คืนทั้ง request ที่ส่งไปและ raw SSE
ที่ได้กลับมา ใช้ตอนของจริงมาแล้ว format ไม่ตรง จะเห็นทันทีว่าข้อความอยู่ใต้ key
อะไรแล้วปรับ `.env` ให้ตรง ไม่ต้องยิง alert ผ่านคิวก่อน (ไม่ echo `Authorization`)

prototype ก็สตรีมได้ถ้าส่ง `Accept: text/event-stream` — `event: start` →
`event: step` ต่อ tool call → `event: result` → `[DONE]` พร้อม comment keepalive
ระหว่าง tool call ที่ใช้เวลานาน

**บั๊กที่เจอตอนทดสอบ** — รอบแรก `total_duration_ms` ได้ 810ms ซึ่งเป็นเวลาของ
*tool call เดียว* ไม่ใช่ทั้ง run เพราะกฎ "event แรกชนะ" ทำให้ `duration_ms` จาก
event `step` ทับค่าจาก event `result` ที่มาทีหลัง แก้เป็น event ที่มีคำตอบสมบูรณ์
เขียนทับได้ ส่วน event ความคืบหน้าเติมได้เฉพาะช่องว่าง

### ทิศทางที่ตกลงไว้ แต่ยังไม่ทำ

agent loop จะย้ายไปอยู่ `ai-service` ส่วน LLM Server เหลือแค่ custom agent/prompt
ข้อจำกัดเดิมยังใช้ได้ — loop กับ MCP client ต้องอยู่ process เดียวกัน ซึ่งท่านี้
ก็ยังอยู่ด้วยกัน (ย้ายไปพร้อมกัน)

ยังไม่ย้ายเพราะต้องตัดสินก่อนว่า run history กับ "Test run" ใน UI จะอยู่ที่ไหน —
ถ้า `ai-service` เก็บ history เองก็ไม่ stateless อีกต่อไป ซึ่งขัดกับหลักที่ยึดมา
ตั้งแต่รอบที่ 1

### เอกสาร token

[`tokens.md`](tokens.md) — ขอ token แต่ละตัวจากไหน เอาไปใส่ตรงไหน เปลี่ยน/เพิกถอนยังไง
รวมขั้นตอนตั้ง Splunk ทดสอบด้วย image `splunk/splunk`

---

## ยังไม่ได้ทำ

- **ย้าย agent loop ไป `ai-service`** — ตกลงทิศทางแล้ว ยังไม่ทำ ติดที่ต้องตัดสินก่อน
  ว่า run history กับปุ่ม Test run ใน UI จะอยู่ที่ไหน
- **ต่อกับ LLM Server ตัวจริง** — client รับ SSE ได้แล้วและทดสอบกับ 6 รูปแบบ
  แต่ยังไม่เคยเจอของจริง ใช้ `POST /llm-probe` ดู raw event แล้วปรับ `.env`
- **`llm-server` ไม่มี auth เลย** — ใครถึง port 8400 ได้ก็แก้ system prompt ของ agent ได้
  ซึ่งเท่ากับแก้วิธีวิเคราะห์ alert ทุกใบ และ bind `0.0.0.0` อยู่ด้วย
- **run history โตไม่มีที่สิ้นสุด** — ไม่มี retention job เหมือนที่ `ai_jobs` มี
- **`related_events` กับ field map ของ Splunk ใช้ชื่อ CIM** (`src_ip`, `dest_ip`) ไม่ตรง
  log FortiGate ดิบ (`srcip`, `dstip`) — agent ค้นผิด field แล้วรายงานว่า "ไม่พบอะไร"
  อย่างมั่นใจ ซึ่งอันตรายกว่า error ทดสอบเห็นแล้วกับ Splunk จริง
- **`ai_jobs` ยังไม่มีคอลัมน์ `evidence`** — แผนคือแยกผลลัพธ์เป็นสองชุด: `suggestion`
  (model เขียน) กับ `evidence` (โค้ดดึงจาก ThreatQ/Splunk ตรวจย้อนได้) ตอนนี้มีแค่
  `aiResponse String?` ก้อนเดียว ต้องเพิ่ม `evidence Json?`
- **`ai-service` ไม่มี system prompt ของตัวเอง** — `buildRenderedPrompt` ต่อ string
  เปล่าๆ คำสั่งทั้งหมดมาจาก `prompt` ที่ playbook ส่งมา แปลว่าบังคับรูปแบบ output
  (เช่น "สรุปหลักฐาน ห้ามให้คำแนะนำ") จากฝั่งเราไม่ได้เลย ใครแก้ playbook ก็เปลี่ยนได้
- **`legacy-manual.md` / `.html`** ยังอ้าง `soc-backend` `soc-worker` `init_db.py` แบบเดิม
- **`test_*.py`** ที่ root hardcode API key เก่า `sk-8k141RfY_...` ที่ตายไปแล้ว
  ยิงตอนนี้ได้ `401` ควรอ่านจาก env แทน
- **`frontend/Dockerfile` ยังใช้ `npm install`** ทั้งที่มี lockfile แล้ว ควรเป็น `npm ci`
  และ base image ยังเป็น `node:20-alpine` ขณะที่ backend ไปถึง `node:24-slim`
- **`/v1/results` ไม่กรองตาม owner** — ใครล็อกอินได้ (รวม readonly) เห็น job ของทุกคน
  `AnalysisService.list()` ไม่ได้ filter `ownerId` เหมือนของเดิมเป๊ะ ๆ ถ้าไม่ได้ตั้งใจ
  ให้เป็นแบบนั้น นี่คือช่องโหว่ระดับ authorization
- **ไม่มี CI** ทั้ง GitLab CI และ GitHub Actions ตอนนี้ไม่มีอะไรตรวจ build อัตโนมัติเลย
- ไม่มี unit test / linter ทั้งฝั่ง NestJS และ Python (เหมือนเดิม)
