# SOC AI Suggestion — Developer & Operator Manual

**Version:** 1.3.5 | **Last Updated:** 2026-05-14 | **Model:** qwen2.5:7b (CPU)

---

## 1. System Overview

SOC AI Suggestion เป็น middleware ที่รับ Alert จาก SOAR แล้วส่งไปวิเคราะห์ด้วย AI (Ollama) และคืน Suggestion กลับไปยัง SOAR

### Data Flow

```
SOAR Playbook
    │  POST /v1/analyze  (X-API-Key)
    │  body: { alert_id, alert_name, raw_log, prompt }
    ▼
FastAPI Backend  ──→  Redis Queue (ARQ)
                               │
                               ▼ Worker dequeues
                        AI Worker
                          │ combines prompt + raw_log (Option B)
                          ▼
                       Ollama (qwen2.5:7b, CPU)
                          │ AI response
                          ▼
                       PostgreSQL ← save result + audit log
                               │
SOAR  ←── GET /v1/results/{id} ──┘  (polling with API Key)
```

### Option B — Prompt Rendering

ระบบ **รวม prompt + raw_log ให้อัตโนมัติ** ก่อนส่งให้ AI:

```
[SOAR prompt / instruction จาก Playbook]

--- RAW LOG ---
[raw_log จาก SOAR]
--- END OF LOG ---
```

SOAR ส่งแค่ instruction ใน `prompt` field — ไม่ต้อง embed log เองใน prompt

---

## 2. Docker Services

| Service | Image | Port | หน้าที่ |
|---------|-------|------|--------|
| `soc-db` | postgres:16-alpine | 5432 (internal) | PostgreSQL database |
| `soc-redis` | redis:7-alpine | 6379 (internal) | ARQ job queue |
| `soc-ollama` | ollama/ollama | 11434 (internal) | AI engine (CPU) |
| `soc-backend` | custom FastAPI | **8000** → 8000 | REST API |
| `soc-worker` | custom ARQ | — | Background job processor |
| `soc-frontend` | custom Nginx | **3000** → 80 | Admin Dashboard |

---

## 3. Deployment Guide

### 3.1 Prerequisites

- Docker Desktop (Windows) หรือ Docker Engine + Compose v2 (Linux)
- RAM ≥ 16GB (Ollama CPU mode ใช้ ~10GB)
- Disk ≥ 20GB (Ollama model ~4.7GB)

### 3.2 First-Time Setup

```bash
# 1. เข้าโฟลเดอร์โปรเจกต์
cd "e:\TI Script\SOC AI"

# 2. สร้างไฟล์ config
copy .env.example .env

# 3. แก้ไขค่าสำคัญใน .env
#    - POSTGRES_PASSWORD
#    - JWT_SECRET_KEY  (ต้องยาวอย่างน้อย 32 ตัวอักษร)
#    - DEFAULT_ADMIN_PASSWORD

# 4. Build + Start
docker compose up -d --build

# 5. ดาวน์โหลด AI Model (ครั้งแรกครั้งเดียว ~4.7GB)
docker compose exec soc-ollama ollama pull qwen2.5:7b

# 6. Init Database (ครั้งแรกครั้งเดียว)
docker compose exec soc-backend python scripts/init_db.py
```

### 3.3 เข้าใช้งาน

| URL | คำอธิบาย |
|-----|---------|
| http://localhost:3000 | Admin Dashboard |
| http://localhost:8000/docs | Swagger API Docs |
| http://localhost:8000/health | Health Check |

**Default Admin:** `admin` / `Admin@1234!`
> ⚠️ เปลี่ยน password ทันทีหลัง login ครั้งแรก

### 3.4 Daily Operations

```bash
# Start
docker compose up -d

# Stop
docker compose down

# Restart specific service
docker compose restart soc-worker

# View logs
docker compose logs -f soc-backend
docker compose logs -f soc-worker
docker compose logs -f soc-ollama

# Rebuild after code change
docker compose up -d --build soc-backend soc-worker
docker compose up -d --build soc-frontend
```

---

## 4. SOAR Integration Guide

### 4.1 สร้าง API Key

1. Login → Admin UI (http://localhost:3000)
2. ไปที่ **API Keys** → **New API Key**
3. ตั้งชื่อ เช่น `SOAR-Production`
4. **Copy key ทันที** — จะแสดงครั้งเดียวเท่านั้น
5. Format: `sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

### 4.2 ส่ง Alert จาก SOAR Playbook

```bash
curl -X POST http://YOUR_SERVER:8000/v1/analyze \
  -H "X-API-Key: sk-YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "alert_id":   "ALT-2024-00123",
    "alert_name": "Suspicious Outbound to Port 4444",
    "raw_log":    "May 06 09:12:33 fw01 DENY TCP 192.168.1.50:54321 -> 45.33.32.156:4444 flags:SYN",
    "prompt":     "You are a SOC analyst. Analyze this firewall log. Determine: 1) Is this C2 traffic? 2) Severity (CRITICAL/HIGH/MEDIUM/LOW) 3) IOCs 4) Recommended actions."
  }'
```

**Response (immediate):**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued",
  "estimated_wait_seconds": 60
}
```

### 4.3 Polling ผลลัพธ์

```bash
# Poll ทุก 10-15 วินาที จนได้ status = "completed"
curl http://YOUR_SERVER:8000/v1/jobs/550e8400-e29b-41d4-a716-446655440000 \
  -H "X-API-Key: sk-YOUR_API_KEY"
```

**Response (completed):**
```json
{
  "job_id": "550e8400-...",
  "alert_id": "ALT-2024-00123",
  "alert_name": "Suspicious Outbound to Port 4444",
  "status": "completed",
  "ai_response": "SEVERITY: HIGH\nThis firewall log indicates potential C2 beacon activity...",
  "model_used": "qwen2.5:7b",
  "processing_time_ms": 45230,
  "tokens_prompt": 120,
  "tokens_eval": 350,
  "created_at": "2024-05-06T09:12:33Z",
  "completed_at": "2024-05-06T09:13:18Z"
}
```

**Job Status Values:**

| Status | ความหมาย |
|--------|---------|
| `queued` | รอ worker มารับ |
| `processing` | Worker กำลังส่งให้ Ollama |
| `completed` | ได้ผลแล้ว |
| `failed` | เกิด error (ดู `error_message`) |

### 4.4 ตัวอย่าง Use Cases + Prompts

**C2 Detection (Firewall Log):**
```
You are a SOC analyst specializing in network security.
Analyze the provided firewall log entry.
Determine if this indicates Command & Control (C2) communication.
Respond with: Severity, Threat Type, Confidence, IOCs found, Summary, Recommended Actions.
```

**Malware Analysis (Endpoint Log):**
```
You are a malware analyst. Analyze this endpoint security log.
Identify: malware family (if known), attack technique (MITRE ATT&CK), 
affected artifacts, and containment steps.
```

**Brute Force Detection (Auth Log):**
```
You are a SOC analyst. Review this authentication log for brute force patterns.
Identify: source IP, targeted accounts, attack timeline, and recommend blocking rules.
```

### 4.5 Advanced: JSON Output & Tier 1 Guidance

เพื่อให้ SOAR นำไปใช้งานต่อได้ง่ายขึ้น คุณควรสั่งให้ AI ตอบเป็น JSON และระบุคำแนะนำสำหรับเจ้าหน้าที่ Tier 1:

**Example Prompt:**
```text
Analyze the security log provided. Your response must be in valid JSON format only.
Include the following fields:
- is_threat: (boolean)
- severity: (Low, Medium, High, Critical)
- analysis_summary: (Short summary of what happened)
- tier1_steps: (List of specific actionable steps for a Tier 1 analyst)
- recommendation: (Final decision: Close, Escalate, or Block)
```

**JSON Response Example:**
```json
{
  "is_threat": true,
  "severity": "Medium",
  "analysis_summary": "Suspicious HTTP traffic detected to a known proxy-related IP.",
  "tier1_steps": [
    "Verify the source IP's recent activity history.",
    "Check if the browser used has any malicious extensions.",
    "Cross-check the destination IP with threat intelligence feeds."
  ],
  "recommendation": "Escalate"
}
```

---

## 5. Admin Dashboard Guide

### 5.1 Dashboard (/)

แสดง real-time statistics:
- **Total Jobs** — จำนวน job ทั้งหมด
- **Completed / Pending / Processing / Failed** — แยกตามสถานะ
- **Avg Time** — เวลาเฉลี่ยต่อ job + ชื่อ model
- **Total Tokens** — จำนวน Token ทั้งหมดที่ใช้ไป (Prompt + Response)
- **Avg Tokens** — ค่าเฉลี่ย Token ต่อ 1 Job

### 5.2 Dashboard Interpretation

การอ่านค่าสถิติต่างๆ บน Dashboard เพื่อประเมินสุขภาพของระบบ:
- **Total Tokens:** บอกถึงปริมาณการใช้งาน AI ยิ่งเยอะหมายถึงมีการวิเคราะห์ข้อมูลปริมาณมาก
- **Failed Jobs:** หากมีค่าสูงเกิน 5% ควรตรวจสอบ Logs ของ `soc-worker` หรือเช็คการเชื่อมต่อ Ollama
- **Avg Time:** หากค่าเฉลี่ยสูงกว่า 90s ในโหมด CPU แสดงว่าเครื่องอาจมีโหลดหนัก หรือ AI Model มีขนาดใหญ่เกินไปสำหรับทรัพยากรที่มี

### 5.3 Analysis Jobs (/jobs)

- ดู job ทั้งหมดพร้อม status
- คอลัมน์ **Tokens** แสดงผลรวม Token ของรายการนั้นๆ
- กรอง: All / pending / processing / completed / failed
- คลิก Job ID → ดู detail

### 5.3 Job Detail (/jobs/:id)

- **AI Response** — ผล analysis จาก Ollama
- **Raw Log** — log ดิบที่ SOAR ส่งมา
- **SOAR Prompt** — instruction จาก SOAR Playbook
- **Tokens (Prompt/Response)** — จำนวน token ที่ใช้ในแต่ละส่วนของ Job นั้นๆ
- Auto-refresh ทุก 5 วินาที ถ้า job ยัง pending/processing

### 5.4 API Keys (/api-keys)

- สร้าง API Key สำหรับ SOAR
- ตั้งวันหมดอายุ (optional)
- Copy key (แสดงครั้งเดียว)
- Revoke key ที่ไม่ใช้แล้ว

### 5.5 Users (/users) — Admin only

- สร้าง/แก้ไข user
- กำหนด Role: `admin` / `analyst` / `readonly`
- Enable/Disable user

### 5.6 Audit Logs (/audit) — Admin only

ระบบบันทึกประวัติการใช้งานทุกขั้นตอนเพื่อใช้ในการตรวจสอบย้อนหลัง (Forensics)

| Event Type | ความหมาย |
|------------|----------|
| `AUTH_LOGIN` | เข้าสู่ระบบสำเร็จ |
| `AUTH_FAILED` | Login ไม่สำเร็จ (รหัสผ่านผิด) |
| `AUTH_KEY_FAILED` | การยิง API ด้วย Key ที่ผิด/หมดอายุ |
| `USER_CREATED` | สร้าง User ใหม่ |
| `USER_UPDATED` | แก้ไขข้อมูล User / เปลี่ยนรหัสผ่าน |
| `USER_DELETED` | ลบ User ออกจากระบบ |
| `KEY_CREATED` | สร้าง API Key ใหม่ |
| `KEY_REVOKED` | ยกเลิกการใช้งาน API Key |
| `ANALYZE_REQUEST` | รับ Alert และกำลังเตรียมส่งให้ AI |
| `JOB_QUEUED` | งานถูกส่งเข้าคิวรอดำเนินการ |
| `JOB_PROCESSING` | Worker กำลังส่งให้ AI (Ollama) ประมวลผล |
| `JOB_COMPLETED` | AI วิเคราะห์เสร็จสิ้น |
| `JOB_FAILED` | AI วิเคราะห์ล้มเหลว |
| `SYSTEM_CLEANUP` | การล้างข้อมูลเก่าอัตโนมัติ (Retention) |
| `AUDIT_EXPORTED` | การสั่ง Export Audit Log ออกเป็น CSV |

### 5.7 User Experience Features

- **Classic Pagination:** ทุกหน้าตารางมีระบบแบ่งหน้าแบบคลาสสิก พร้อม Dropdown เลือกจำนวนแถว (10, 20, 50, 100)
- **Confirm Modals:** การลบข้อมูลสำคัญ (User, API Key) จะมีหน้าต่างยืนยันสไตล์ Cyber Dark Theme พร้อมแสดง Error ทันทีหากลบไม่สำเร็จ
- **Data Retention:** ระบบจะล้างข้อมูลเก่าอัตโนมัติตามระยะเวลาที่กำหนดใน `.env` เพื่อรักษาพื้นที่ฐานข้อมูล
    - `RETENTION_DAYS_JOBS`: เก็บข้อมูลวิเคราะห์ไว้ (Default: 30 วัน)
    - `RETENTION_DAYS_AUDIT`: เก็บประวัติการใช้งานไว้ (Default: 90 วัน)
    - ระบบจะเริ่มล้างข้อมูลตามเวลา `CLEANUP_HOUR` และ `CLEANUP_MINUTE` ที่ตั้งไว้ (Default: 02:00)
- **Error Handling:** เมื่อเกิด Error ในระบบ (เช่น AI ล่ม) ระบบจะแสดง Modal แจ้งเตือนสีแดงพร้อมรายละเอียด Error ให้ Admin ทราบทันที

### 5.8 API Response Codes (for SOAR)

| Code | Meaning | Action for SOAR |
|------|---------|-----------------|
| **201** | Created | Job ถูกเข้าคิวแล้ว นำ `job_id` ไป Polling ต่อ |
| **401** | Unauthorized | API Key ผิด หมดอายุ หรือไม่ได้ส่งมา |
| **403** | Forbidden | API Key ไม่มีสิทธิ์เข้าถึง Endpoint นี้ |
| **422** | Validation Error | Payload ผิด Format หรือ Email ไม่ถูกต้อง |
| **500** | Internal Error | ระบบหลังบ้านมีปัญหา (เช่น DB ล่ม) |
| **502** | Bad Gateway | Backend ล่ม หรือ Nginx หา Backend ไม่เจอ |

---

## 6. API Endpoint Reference

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/login` | — | Login → JWT tokens |
| POST | `/auth/refresh` | JWT | Refresh access token |
| GET | `/auth/me` | JWT | ดูข้อมูล user ปัจจุบัน |

### Analysis (ใช้ API Key)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/analyze` | ส่ง alert เข้าคิว |
| GET | `/v1/results` | List all jobs (JWT) |
| GET | `/v1/results/{job_id}` | ดึงผลลัพธ์ (API Key/JWT) |

### Admin (JWT required)

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/admin/users` | admin | List users |
| POST | `/admin/users` | admin | สร้าง user |
| PUT | `/admin/users/{id}` | admin | แก้ไข user |
| GET | `/admin/api-keys` | admin/analyst | List API keys |
| POST | `/admin/api-keys` | admin/analyst | สร้าง API key |
| DELETE | `/admin/api-keys/{id}` | admin/analyst | Revoke key |
| GET | `/admin/audit-logs` | admin | ดู audit trail |
| GET | `/admin/audit-logs/export` | admin | Export CSV |
| GET | `/admin/stats` | admin/analyst/readonly | Dashboard stats |

---

## 7. Environment Variables Reference

| Variable | Default | คำอธิบาย |
|----------|---------|---------|
| `POSTGRES_DB` | `socai` | ชื่อ database |
| `POSTGRES_USER` | `socai` | DB username |
| `POSTGRES_PASSWORD` | — | **ต้องเปลี่ยน** |
| `DATABASE_URL` | — | Full connection string |
| `REDIS_HOST` | `soc-redis` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_DB` | `0` | Redis database index |
| `OLLAMA_BASE_URL` | `http://soc-ollama:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | `qwen2.5:7b` | AI model ที่ใช้ |
| `OLLAMA_TIMEOUT` | `120` | Max seconds รอ Ollama |
| `JWT_SECRET_KEY` | — | **ต้องเปลี่ยน** (≥32 chars) |
| `JWT_ACCESS_EXPIRE_MINUTES` | `15` | Access token TTL |
| `JWT_REFRESH_EXPIRE_DAYS` | `7` | Refresh token TTL |
| `DEFAULT_ADMIN_USERNAME` | `admin` | Admin username เริ่มต้น |
| `DEFAULT_ADMIN_PASSWORD` | `Admin@1234!` | **เปลี่ยนหลัง deploy** |
| `RETENTION_DAYS_JOBS` | `30` | จำนวนวันที่เก็บ Analysis Jobs |
| `RETENTION_DAYS_AUDIT` | `90` | จำนวนวันที่เก็บ Audit Logs |
| `CLEANUP_HOUR` | `2` | ชั่วโมงที่จะเริ่มล้างข้อมูล (0-23) |
| `CLEANUP_MINUTE` | `0` | นาทีที่จะเริ่มล้างข้อมูล (0-59) |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | CORS origins |

---

## 8. Role & Permission Matrix

> **คำจำกัดความของ Roles:**
> - **admin:** สิทธิ์สูงสุด จัดการระบบ User, API Key, และดู Audit Logs ได้ทั้งหมด
> - **analyst:** สิทธิ์ระดับปฏิบัติการ สร้าง API Key สำหรับ Automation ได้ และดู Jobs ทั้งหมดเพื่อวิเคราะห์ผล
> - **readonly:** สิทธิ์สำหรับ Auditor หรือผู้บริหาร เข้ามาดู Jobs ทั้งหมดและดู Dashboard ได้ แต่ไม่สามารถตั้งค่าระบบหรือออก API Key ได้

| Permission | admin | analyst | readonly |
|-----------|:-----:|:-------:|:--------:|
| Login to Admin UI | ✅ | ✅ | ✅ |
| ส่ง analyze request (ใช้ API Key) | ✅ | ✅ | ❌ |
| ดู jobs ทั้งหมด และ Dashboard | ✅ | ✅ | ✅ |
| สร้าง API Key (ของตัวเอง) | ✅ | ✅ | ❌ |
| Revoke API Key ทั้งระบบ | ✅ | ❌ | ❌ |
| เข้าถึงหน้า API Keys | ✅ | ✅ | ❌ |
| จัดการ Users | ✅ | ❌ | ❌ |
| ดู Audit Logs | ✅ | ❌ | ❌ |
| Export Audit CSV | ✅ | ❌ | ❌ |

---

## 9. Troubleshooting

### 9.1 Frontend build error: `npm ci` failed

**Error:** `The npm ci command can only install with an existing package-lock.json`

**Fix:** เปลี่ยน `RUN npm ci` เป็น `RUN npm install` ใน `frontend/Dockerfile`

```dockerfile
# แก้จาก
RUN npm ci
# เป็น
RUN npm install
```

### 9.2 Backend error: `ModuleNotFoundError`

```bash
docker compose logs soc-backend
# ถ้าพบ import error ให้ rebuild
docker compose up -d --build soc-backend soc-worker
```

### 9.3 Ollama timeout / Job stuck processing

Ollama CPU mode ช้า (~30-90 วินาที) เพิ่ม timeout:
```env
# .env
OLLAMA_TIMEOUT=180
```

ตรวจสอบ Ollama:
```bash
docker compose logs soc-ollama
# ตรวจสอบว่า model โหลดแล้ว
docker compose exec soc-ollama ollama list
```

### 9.4 Database connection failed

```bash
# ตรวจสอบ DB health
docker compose ps soc-db
# ตรวจสอบ DATABASE_URL ใน .env
# format: postgresql+asyncpg://USER:PASS@soc-db:5432/DB
```

### 9.5 Redis connection failed

```bash
docker compose ps soc-redis
docker compose exec soc-redis redis-cli ping
# ควรได้ PONG
```

### 9.6 Worker ไม่รับ job

```bash
docker compose logs soc-worker
# restart worker
docker compose restart soc-worker
```

### 9.7 Admin UI แสดง 401 ทุก request

JWT หมดอายุ หรือ logout แล้ว login ใหม่ ถ้าเกิดบ่อยให้ตรวจสอบ `JWT_SECRET_KEY` ใน `.env`

### 9.8 Admin UI แสดง 502 Bad Gateway

**สาเหตุ:** เกิดขึ้นบ่อยหลังจากมีการ Restart Backend ทำให้ IP ภายในของ Container เปลี่ยน แต่ Nginx ยังจำค่าเก่าอยู่

**Fix:** สั่ง Restart เฉพาะตัว Frontend เพื่อให้ Re-resolve DNS ใหม่:
```bash
docker compose restart soc-frontend
```

### 9.9 แก้ไข Code UI แล้วไม่เปลี่ยนตาม

**สาเหตุ:** `soc-frontend` เป็น Production Build (Nginx) ไม่ได้ใช้ Volume Mount เหมือน Backend

**Fix:** ต้องสั่ง Rebuild เท่านั้น:
```bash
docker compose up -d --build soc-frontend
```

### 9.10 422 Unprocessable Entity (Validation Error)

**สาเหตุ:** มักเกิดจาก Schema ของข้อมูลไม่ตรงกัน เช่น ลืมส่ง Field ที่จำเป็น หรือ Format อีเมลไม่ผ่านเกณฑ์ (ปัจจุบันผ่อนปรนให้ใช้ `.local` ได้แล้ว)

---

## 10. Development Guide

### 10.1 Project Structure

```
e:\TI Script\SOC AI\
├── docker-compose.yml
├── .env.example
├── .env                     ← gitignored
├── README.md
│
├── backend/
│   ├── main.py              ← FastAPI app entry
│   ├── requirements.txt
│   ├── Dockerfile
│   ├── core/
│   │   ├── config.py        ← Environment settings (Pydantic)
│   │   ├── database.py      ← Async SQLAlchemy engine
│   │   ├── security.py      ← JWT + bcrypt + API Key utils
│   │   ├── deps.py          ← FastAPI dependencies
│   │   └── audit.py         ← AuditLogger utility
│   ├── models/
│   │   ├── user.py          ← User, Role ORM
│   │   ├── api_key.py       ← APIKey ORM
│   │   ├── ai_job.py        ← AIJob ORM (+ JobStatus enum)
│   │   └── audit_log.py     ← AuditLog ORM (+ EventType enum)
│   ├── schemas/
│   │   ├── auth.py          ← LoginRequest, TokenResponse
│   │   ├── analysis.py      ← AnalyzeRequest, JobStatusResponse
│   │   ├── admin.py         ← User/APIKey request/response
│   │   └── audit.py         ← AuditLogResponse
│   ├── routers/
│   │   ├── auth.py          ← /auth/*
│   │   ├── analysis.py      ← /v1/*
│   │   └── admin.py         ← /admin/*
│   ├── services/
│   │   ├── auth_service.py  ← authenticate_user, issue_tokens
│   │   └── ollama_service.py ← Ollama HTTP client + prompt builder
│   ├── workers/
│   │   ├── queue.py         ← ARQ WorkerSettings
│   │   └── ai_worker.py     ← analyze_alert() job function
│   └── scripts/
│       └── init_db.py       ← Bootstrap roles + admin user
│
└── frontend/
    ├── Dockerfile
    ├── nginx.conf
    ├── package.json
    ├── vite.config.js
    └── src/
        ├── index.css        ← Dark theme design system
        ├── App.jsx          ← Router setup
        ├── main.jsx         ← React entry
        ├── api/client.js    ← Axios + auto-refresh interceptor
        ├── stores/authStore.js  ← Zustand auth state
        ├── components/
        │   ├── Layout.jsx       ← Sidebar + TopBar
        │   ├── ProtectedRoute.jsx
        │   └── StatusBadge.jsx
        └── pages/
            ├── Login.jsx
            ├── Dashboard.jsx
            ├── Jobs.jsx
            ├── JobDetail.jsx
            ├── ApiKeys.jsx
            ├── Users.jsx
            └── AuditLogs.jsx
```

### 10.2 เปลี่ยน AI Model

แก้ใน `.env`:
```env
# CPU Mode Options:
OLLAMA_MODEL=qwen2.5:3b    # เร็วกว่า, RAM น้อยกว่า (~4GB)
OLLAMA_MODEL=qwen2.5:7b    # Default — balance ดี (~10GB RAM)
OLLAMA_MODEL=llama3.1:8b   # ทางเลือก, English ดี

# ถ้ามี GPU (VRAM 16GB+)
OLLAMA_MODEL=qwen2.5:14b   # แม่นยำกว่ามาก
```

Pull model ใหม่:
```bash
docker compose exec soc-ollama ollama pull qwen2.5:3b
docker compose restart soc-worker
```

### 10.3 เพิ่ม API Endpoint ใหม่

1. สร้าง schema ใน `backend/schemas/`
2. เพิ่ม route ใน `backend/routers/` (หรือไฟล์ใหม่)
3. Register router ใน `backend/main.py`
4. Rebuild: `docker compose up -d --build soc-backend`

### 10.4 Local Development (ไม่ใช้ Docker สำหรับ backend)

```bash
# เริ่ม infrastructure เท่านั้น
docker compose up -d soc-db soc-redis soc-ollama

# Backend (local)
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# Worker (local, terminal แยก)
python -m arq workers.queue.WorkerSettings

# Frontend (local)
cd frontend
npm install
npm run dev
```

> แก้ `.env` ให้ชี้หา localhost:
> ```env
> DATABASE_URL=postgresql+asyncpg://socai:pass@localhost:5432/socai
> REDIS_HOST=localhost
> OLLAMA_BASE_URL=http://localhost:11434
> ```

### 10.5 Database Schema Changes

ปัจจุบันใช้ `Base.metadata.create_all()` ที่ startup (สะดวกสำหรับ dev)

สำหรับ production migration ให้ใช้ Alembic:
```bash
# Install
pip install alembic

# Init (ทำครั้งแรก)
alembic init alembic

# สร้าง migration
alembic revision --autogenerate -m "add_new_column"

# Apply
alembic upgrade head
```

---

## 11. Security Checklist

- [ ] เปลี่ยน `POSTGRES_PASSWORD` จาก default
- [ ] เปลี่ยน `JWT_SECRET_KEY` เป็น random string ยาว ≥ 32 chars
- [ ] เปลี่ยน `DEFAULT_ADMIN_PASSWORD` หลัง deploy
- [ ] ปิด port 8000 จาก internet (ใช้ reverse proxy เช่น Nginx)
- [ ] ปิด port 5432, 6379, 11434 จาก internet
- [ ] ตั้ง `expires_days` บน API Key ทุกอัน
- [ ] Revoke API Key ที่ไม่ใช้แล้ว
- [ ] ตรวจสอบ Audit Log เป็นประจำ

---

## 11. Production Deployment & Hardening

เพื่อให้ระบบมีความปลอดภัยสูงสุดเมื่อใช้งานจริง (Production) ควรปฏิบัติดังนี้:

### 11.1 HTTPS/SSL Setup
ปัจจุบันระบบรันบน HTTP (Port 3000/8000) สำหรับ Production ควรใช้ Reverse Proxy (Nginx) มาครอบ:
```nginx
# ตัวอย่างการทำ SSL Termination
server {
    listen 443 ssl;
    server_name soc-ai.yourdomain.com;
    ssl_certificate /etc/letsencrypt/live/yourdomain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain/privkey.pem;

    location / {
        proxy_pass http://localhost:3000; # Frontend
    }
    location /v1 {
        proxy_pass http://localhost:8000; # API
    }
}
```

### 11.2 Disabling API Docs
ใน Prod ควรปิดหน้า `/docs` และ `/redoc` เพื่อไม่ให้บุคคลภายนอกเห็นโครงสร้าง API:
แก้ไขใน `.env`:
```env
# ในอนาคต (ถ้ามีการเพิ่มตัวแปรนี้ในโค้ด)
SHOW_DOCS=false
```

### 11.3 API Key Management
- อย่าส่ง API Key ผ่านช่องทางที่ไม่ปลอดภัย (เช่น Chat/Email ที่ไม่เข้ารหัส)
- ควรมีนโยบาย **Rotate API Key** ทุกๆ 90 วัน
- หากพบว่า Key หลุด ให้ใช้เมนู **Revoke** ในหน้า API Keys ทันที

---

## 12. Maintenance & Monitoring

### 12.1 Database Backup (PostgreSQL)
ควรสำรองข้อมูลสม่ำเสมอด้วยคำสั่ง `pg_dump`:
```bash
# สำรองข้อมูล (Backup)
docker exec soc-db pg_dump -U socai socai > backup_$(date +%F).sql

# กู้คืนข้อมูล (Restore)
cat backup.sql | docker exec -i soc-db psql -U socai -d socai
```

### 12.2 Container Health Monitoring
ตรวจสอบสถานะทรัพยากรที่ Container ใช้งาน:
```bash
docker stats
```
> ⚠️ หาก `soc-ollama` ใช้ RAM เกิน 90% ของเครื่อง อาจส่งผลให้ระบบค้าง ควรพิจารณาจำกัดทรัพยากรใน `docker-compose.yml`

### 12.3 Updating AI Models
เมื่อมีโมเดลใหม่ หรือต้องการเปลี่ยนเวอร์ชัน:
```bash
docker compose exec soc-ollama ollama pull qwen2.5:7b-instruct
# แก้ไข OLLAMA_MODEL ใน .env แล้ว Restart worker
docker compose restart soc-worker
```

---

## 13. Disaster Recovery

### 13.1 Resetting Admin Password
หากลืมรหัสผ่าน Admin และเข้าหน้าเว็บไม่ได้:
```bash
docker compose exec soc-backend python -c "from services.auth_service import get_password_hash; print(get_password_hash('NewPassword123!'))"
# จากนั้นเอา Hash ที่ได้ไป Update ใน DB ตาราง users ด้วย SQL
```

### 13.2 System Re-initialization
กรณีระบบล่มหนักและต้องการล้างทั้งหมด (ข้อมูลจะหายหมด):
```bash
docker compose down -v
docker compose up -d
docker compose exec soc-backend python scripts/init_db.py
```

---

## 14. Performance Notes (Updated)

| Scenario | Estimated Time | Memory (RAM) |
|----------|---------------|--------------|
| CPU, qwen2.5:7b, Normal Log | 30–60s | ~8GB |
| CPU, qwen2.5:7b, Heavy Load | 90s+ | ~12GB |
| GPU (RTX 3060), qwen2.5:7b | 3–10s | ~6GB VRAM |

---

## 15. Changelog & Known Fixes

### v1.3.5 (2026-05-14)

#### Bug Fix 8 — Backend & Worker Crash Loop
- **ปัญหา:** พบ `ImportError: SessionLocal` และ `AttributeError: CLEANUP_HOUR` เนื่องจาก Code บางส่วนเรียกใช้ตัวแปรที่ไม่มีใน Config หรือถูกเปลี่ยนชื่อเป็น Async
- **แก้ไข:** ปรับปรุง `ai_worker.py` และ `config.py` ให้รองรับระบบ Async และ Maintenance ครบถ้วน
- **ไฟล์ที่เปลี่ยน:** `backend/workers/ai_worker.py`, `backend/core/config.py`

#### Bug Fix 9 — Arq Cron Jobs ไม่ทำงาน
- **ปัญหา:** การประกาศ `cron_jobs` ใน `queue.py` ใช้ Format ผิด ทำให้ ARQ แจ้ง `RuntimeError: must be instances of CronJob`
- **แก้ไข:** เปลี่ยนมาใช้ `arq.cron()` Wrapper ให้ถูกต้องตามมาตรฐาน
- **ไฟล์ที่เปลี่ยน:** `backend/workers/queue.py`

#### Bug Fix 10 — Audit Export 500 Error
- **ปัญหา:** Postgres `eventtype` ขาดค่า `AUDIT_EXPORTED` และ `SYSTEM_CLEANUP` ทำให้เวลาบันทึก Log แล้วระบบล่ม
- **แก้ไข:** เพิ่มค่าใน Enum ของทั้ง Database และ Python Model
- **ไฟล์ที่เปลี่ยน:** `backend/models/audit_log.py`

#### Bug Fix 11 — React Crash on Validation Error
- **ปัญหา:** เมื่อ API ตอบกลับ 422 (Array of Errors) Frontend พยายาม Render Object ลงใน UI ทำให้เกิด React Error #31
- **แก้ไข:** เพิ่ม Logic ในการเช็คประเภทข้อมูล Error และแปลงเป็น String ก่อนแสดงผล
- **ไฟล์ที่เปลี่ยน:** `frontend/src/pages/Users.jsx`, `frontend/src/pages/ApiKeys.jsx`

### v1.3.4 (2026-05-14)

#### Bug Fix 7 — ปรับปรุงสิทธิ์ Readonly (RBAC Realignment)
- **ปัญหา:** ผู้ใช้ที่ระดับ `readonly` เข้าหน้า Dashboard แล้วโหลดสถิติไม่ได้ (หน้าจอว่างเปล่า) และมีข้อขัดแย้งเชิงตรรกะในคู่มือที่บอกว่า `readonly` ดูได้เฉพาะ Job ตัวเอง (ซึ่งเป็นไปไม่ได้เพราะสร้าง API Key ไม่ได้)
- **แก้ไข (Backend):** ปลดล็อก API `GET /admin/stats` ให้ `readonly` สามารถเข้าถึงได้ เพื่อให้หน้า Dashboard แสดงข้อมูลสถิติของระบบได้
- **แก้ไข (คู่มือ):** ปรับปรุงตาราง Role & Permission Matrix ให้ถูกต้องตามความเป็นจริง ว่าในระบบ SOC นี้ `readonly` สามารถมองเห็นภาพรวมของ Jobs ทั้งระบบได้เสมือน Analyst แต่แก้ไขหรือตั้งค่าไม่ได้
- **ไฟล์ที่เปลี่ยน:** `backend/routers/admin.py`, `legacy-manual.md`

### v1.3.3 (2026-05-14)

#### Bug Fix 4 — Audit Log Export ใช้ Browser `alert()` ที่ขัดกับ Dark Theme
- **ปัญหา:** ฟังก์ชัน Export CSV ในหน้า Audit Trail ใช้ `alert()` ของ Browser ซึ่งหน้าตาล้าสมัย ขัดกับ Dark Theme และบล็อก JavaScript Thread
- **แก้ไข:** เปลี่ยนเป็น **SweetAlert2 Popup** ธีม Dark ที่เข้ากับ UI ของระบบ
- **ไฟล์ที่เปลี่ยน:** `frontend/src/pages/AuditLogs.jsx`

#### Bug Fix 5 — ApiKeys สร้าง Key ล้มเหลวแบบ Silent (ไม่มีการแจ้งเตือน)
- **ปัญหา:** ฟังก์ชัน `create` ใน API Keys ไม่มี `catch` block ทำให้หาก API ล้มเหลว (เช่น ชื่อ Key ซ้ำ, Network Error) ผู้ใช้จะไม่ได้รับแจ้งเตือนใดๆ เลย (Silent Failure)
- **แก้ไข:** เพิ่ม `catch` block พร้อม **SweetAlert2 Error Popup** แสดงสาเหตุที่ชัดเจน
- **ไฟล์ที่เปลี่ยน:** `frontend/src/pages/ApiKeys.jsx`

#### Bug Fix 6 — readonly Role เห็นและเข้าถึงหน้า API Keys ได้ (ไม่ควรเห็น)
- **ปัญหา:** เมนู "API Keys" ใน Sidebar แสดงให้ผู้ใช้ทุก Role เห็น รวมถึง `readonly` ซึ่งไม่มีสิทธิ์สร้างหรือ Revoke Key แม้ Backend จะ Reject แต่ Frontend ยังแสดงปุ่มและเมนูให้ ทำให้ UX สับสน
- **แก้ไข (Layout.jsx):** แยก `ANALYST_NAV` ออกจาก `NAV` และใช้ `isAnalystOrAbove` เพื่อแสดงเมนู "API Keys" เฉพาะ `admin` และ `analyst` เท่านั้น
- **แก้ไข (ApiKeys.jsx):** เพิ่มการตรวจสอบ `canManageKeys` เพื่อซ่อนปุ่ม "+ Create Key" และปุ่ม "Revoke" จาก `readonly` ในกรณีที่เข้าถึง URL โดยตรง
- **ไฟล์ที่เปลี่ยน:** `frontend/src/components/Layout.jsx`, `frontend/src/pages/ApiKeys.jsx`

### v1.3.2 (2026-05-14)

#### Bug Fix 1 — Login Error Disappears Too Quickly
- **ปัญหา:** ข้อความ Error ที่หน้า Login (เช่น บัญชีถูก Disable) แสดงแล้วหายเร็วเกินไปก่อนที่ผู้ใช้จะอ่านได้
- **แก้ไข:** เปลี่ยนมาใช้ **SweetAlert2 Popup** ซึ่งจะค้างรอให้ผู้ใช้กด **OK** ก่อนถึงจะปิด
- **ไฟล์ที่เปลี่ยน:** `frontend/src/pages/Login.jsx`, `frontend/package.json`

#### Bug Fix 2 — Default Admin เปลี่ยนรหัสผ่านไม่ได้
- **ปัญหา:** User `admin` ที่สร้างมาจาก `init_db.py` มี email เป็น `admin@localhost` ซึ่งไม่ผ่าน Pydantic `EmailStr` Validation ทำให้ API `/admin/users/{id}` ตอบกลับ 422 ทุกครั้งที่พยายาม Save
- **แก้ไข:**
  1. เปลี่ยน `DEFAULT_ADMIN_EMAIL` ใน `config.py` เป็น `admin@soc.local` (สำหรับการติดตั้งใหม่)
  2. เปลี่ยน `UpdateUserRequest.email` จาก `Optional[EmailStr]` เป็น `Optional[str]` พร้อม Custom Validator ที่ยืดหยุ่นกว่า รองรับ Internal Address ได้
  3. **สำหรับระบบที่ติดตั้งแล้ว:** แก้ Email ของ Admin เป็น `admin@soc.local` ผ่านหน้า Edit User แล้วกด Save ก่อน จากนั้นเปลี่ยนรหัสผ่านได้ตามปกติ
- **ไฟล์ที่เปลี่ยน:** `backend/core/config.py`, `backend/schemas/admin.py`

#### Bug Fix 3 — Audit Trail Filter ไม่ครอบคลุม
- **ปัญหา:** หน้า Audit Logs กรองได้เฉพาะ Event Type และ Actor เท่านั้น
- **แก้ไข (Frontend):**
  - เพิ่ม Filter: **IP Address**, **Status Code** (Dropdown), **Date From**, **Date To**
  - เพิ่มปุ่ม **✕ Clear** เพื่อล้าง Filter ทั้งหมดในคลิกเดียว
  - เพิ่ม Event Types ใหม่ใน Dropdown: `AUTH_KEY_FAILED`, `USER_UPDATED`, `SYSTEM_CLEANUP`, `AUDIT_EXPORTED`
- **แก้ไข (Backend):** เพิ่ม Query Parameters ให้ `/admin/audit-logs` รองรับ `ip_address`, `status_code`, `date_from`, `date_to` พร้อม Filter Count ที่ถูกต้องสำหรับ Pagination
- **ไฟล์ที่เปลี่ยน:** `frontend/src/pages/AuditLogs.jsx`, `backend/routers/admin.py`

### v1.3.1 (2026-05-14)
- เพิ่มระบบ Audit Logging ครอบคลุมทุก Critical Action (`AUTH_KEY_FAILED`, `USER_UPDATED`, `SYSTEM_CLEANUP`, `AUDIT_EXPORTED`)
- แก้ไข `generate_html_manual.py` ให้ดึง Version จาก Markdown มาใส่ `<title>` ของ HTML โดยอัตโนมัติ
- เพิ่ม Log Rotation ให้ทุก Docker Service (10MB × 3 ไฟล์)

### v1.3.0 (2026-05-14)
- เพิ่มระบบ Data Retention อัตโนมัติ (ตั้งค่าผ่าน `.env`)
- เพิ่ม Healthchecks ให้ `soc-backend`
- เพิ่ม Restart Policy (`unless-stopped`) ทุก Service

---
**Status:** Enterprise Ready | **Maintained by:** SOC AI Team
