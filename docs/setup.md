# Setup

ตั้งระบบตั้งแต่ศูนย์จนวิเคราะห์ alert ได้จริง

ถ้าต้องการรายละเอียดของ token แต่ละตัว: [tokens.md](tokens.md)
ถ้าตั้งเสร็จแล้วแต่คำตอบดูผิด: [testing.md](testing.md)

---

## ต้องมีอะไรก่อน

- Docker + Compose v2
- **Python 3.12** สำหรับสคริปต์ใน [`scripts/`](../scripts/README.md) — macOS มาพร้อม 3.9
  ซึ่งเก่าเกินไป ใช้ `python3.12 -m venv .venv` แล้วเรียกผ่าน `.venv/bin/python`
- RAM อย่างน้อย 16GB (แนะนำ 32GB สำหรับ model 7B ขึ้นไป)
- Disk 20GB+
- **GPU ไม่จำเป็น แต่ต่างกันมาก** — บน CPU ล้วน agent run หนึ่งครั้งใช้ 1-5 นาที

ไม่ต้องมีตอนเริ่ม แต่ต้องมีก่อนใช้จริง: Splunk, ThreatQ, FortiSOAR
สามอย่างนี้มีตัวทดสอบให้ใช้ระหว่างพัฒนา

---

## 1. ค่าใน `.env`

```bash
cp .env.example .env
```

สุ่ม 4 ค่า:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
echo "JWT_SECRET_KEY=$(openssl rand -hex 32)"
echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)"
echo "THREATQ_MCP_AUTH_TOKEN=$(openssl rand -hex 32)"
```

> ⚠️ **`POSTGRES_PASSWORD` ต้องแก้ 2 ที่ให้ตรงกัน** — ตัวมันเองกับใน
> `CORE_DATABASE_URL` ไม่งั้น Prisma ต่อไม่ติด (`P1000 Authentication failed`)

> ⚠️ **`DEFAULT_ADMIN_PASSWORD` เปลี่ยนทีหลังไม่ได้** — `seed` ไม่ทับ user ที่มีอยู่
> ตั้งให้เรียบร้อยก่อน seed ครั้งแรก

รายละเอียดครบทุกตัว: [tokens.md](tokens.md)

---

## 2. ขึ้นระบบ

```bash
docker compose up -d --build
```

ตัวที่อยู่หลัง profile (ไม่ขึ้นเอง):

```bash
docker compose --profile threatq up -d soc-threatq-fake soc-mcp-threatq
```

---

## 3. โหลด model

```bash
docker compose exec soc-ollama ollama pull qwen2.5:7b
```

~4.7GB `OLLAMA_KEEP_ALIVE=-1` ทำให้มันค้างใน memory — call แรก ~18 วิ หลังจากนั้น ~1 วิ

---

## 4. สร้างตารางและ seed

```bash
docker compose exec soc-core-api npx prisma db push
docker compose exec soc-core-api npm run seed
```

> ⚠️ **ถ้าใช้ volume เดิมที่มีข้อมูลอยู่** Postgres จะไม่รับรหัสใหม่ — มันตั้งรหัส
> เฉพาะตอน init volume เปล่า เปลี่ยนเองด้วย:
> ```bash
> docker compose exec soc-db psql -U socai -d socai \
>   -c "ALTER USER socai WITH PASSWORD '<รหัสใหม่>';"
> ```

---

## 5. สร้าง agent

`soc-ai` เรียก agent ตามชื่อใน `LLM_DEFAULT_AGENT` (default `soc-triage`)
**ถ้ายังไม่มี agent นั้น job จะ fail ทุกใบ**

เปิด `http://localhost:8400` → New agent

| ช่อง | ใส่อะไร |
| --- | --- |
| Name | ตรงกับ `LLM_DEFAULT_AGENT` |
| Model | เลือกจาก dropdown (เห็นเฉพาะที่ pull ไว้จริง) |
| System prompt | พฤติกรรมของ agent |
| Context | **8192** ถ้าใช้ tool — schema กับผล tool แย่ง context กับ alert |
| MCP servers | ติ๊ก `splunk` ถ้าให้ค้น log ได้ |

หรือทาง API:

```bash
curl -s -X POST localhost:8400/agents -H 'Content-Type: application/json' -d '{
  "name": "soc-triage",
  "model": "qwen2.5:7b",
  "system_prompt": "You are a SOC Tier-1 triage agent. Use ONLY facts from the alert and tool results. Do NOT recommend actions.",
  "temperature": 0.1, "num_ctx": 8192, "max_steps": 4, "max_tool_chars": 4000,
  "mcp_servers": ["splunk"], "delegates": [], "enabled": true
}'
```

---

## 6. ตรวจว่าขึ้นครบ

```bash
curl -s localhost:8000/health    # ai_service: "up"
curl -s localhost:8100/health    # llm_server: true
curl -s localhost:8400/health    # ollama: true, agents: 1
docker compose exec soc-mcp-splunk python -c \
  "import urllib.request; print(urllib.request.urlopen('http://localhost:8200/health').read())"
```

container ที่ขาด token จะ **ไม่ยอมขึ้นเลย** พร้อมบอกว่าขาดตัวไหน — ตั้งใจให้ fail
แบบนั้น ดีกว่าขึ้นมาแล้วเปิดทางเข้า Splunk แบบไม่มีการยืนยันตัวตน

---

## 7. ยิง alert แรก

```bash
JWT=$(curl -s -X POST localhost:8000/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<รหัส>"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

KEY=$(curl -s -X POST localhost:8000/admin/api-keys -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' -d '{"name":"first-test"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('api_key') or d['key'])")

curl -s -X POST localhost:8000/v1/analyze -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{
    "alert_id":"FIRST-001","alert_name":"test",
    "raw_log":"srcip=10.1.100.11 dstip=45.83.122.9 action=\"blocked\""}'
```

ไม่มี field `prompt` — agent บน `llm-server` ถือ system prompt ของตัวเอง
playbook เก่าที่ยังส่งมาไม่ error เฉยๆ ถูกตัดทิ้งที่ validation pipe

ได้ `job_id` แล้ว poll:

```bash
curl -s localhost:8000/v1/results/<job_id> -H "X-API-Key: $KEY"
```

---

## ที่อยู่ของแต่ละหน้า

| | |
| --- | --- |
| Dashboard | `http://localhost:3000` |
| Agent UI | `http://localhost:8400` |
| Agent API (Swagger) | `http://localhost:8400/docs` |
| Core API | `http://localhost:8000` |
| AI service | `http://localhost:8100/docs` |

---

## ระบบภายนอก

### Splunk

ไม่มีของจริง — ใช้ image ทดสอบได้:

```bash
PW="Splunk@Test$(openssl rand -hex 3)"; echo "$PW"
docker run -d --name soc-splunk \
  --network soc-ai_soc-network --network-alias splunk \
  -e SPLUNK_GENERAL_TERMS=--accept-sgt-current-at-splunk-com \
  -e SPLUNK_START_ARGS=--accept-license -e SPLUNK_PASSWORD="$PW" \
  -p 8089:8089 -p 8001:8000 splunk/splunk:latest
```

ขั้นตอนออก token และใส่ข้อมูลทดสอบ: [tokens.md](tokens.md) หัวข้อ 6

มีของจริงแล้ว — **ดึง catalog ก่อนใช้งาน** ไม่งั้น agent จะเดาชื่อ field ผิดแล้ว
รายงานว่า "ไม่พบอะไร" อย่างมั่นใจ: [splunk-catalog.md](splunk-catalog.md)

### ThreatQ

ไม่มี image สาธารณะ (เป็น appliance) — สแตกมี stand-in ให้:

```bash
docker compose --profile threatq up -d soc-threatq-fake soc-mcp-threatq
```

```
THREATQ_BASE_URL=http://threatq:8500
THREATQ_AUTH_MODE=oauth
THREATQ_CLIENT_ID=local-dev
THREATQ_EMAIL=dev@example.com
THREATQ_PASSWORD=local-dev
THREATQ_VERIFY_SSL=false
```

ต่อของจริง: แก้ 6 ค่านี้ ไม่ต้องแตะอย่างอื่น —
[mcp-server/Threatq/README.md](../mcp-server/Threatq/README.md)

### FortiSOAR

playbook ยิง `POST /v1/analyze` พร้อม header `X-API-Key` แล้ว poll
`GET /v1/results/{job_id}` — [tokens.md](tokens.md) หัวข้อ 4

---

## ก่อนขึ้น production

| เรื่อง | ทำอะไร |
| --- | --- |
| รหัส admin | เปลี่ยนที่หน้า Users ทันที |
| `SPLUNK_TOKEN` | ต้องเป็น role **search-only** ถอด `delete_by_keyword` และ `run_script` |
| `SPLUNK_VERIFY_SSL` | ต้องเป็น `true` (lab ตั้ง false) |
| ThreatQ account | read-only |
| `llm-server` | **ไม่มี auth เลย** ใครถึง port 8400 ได้ก็แก้ system prompt ของ agent ได้ ต้องอยู่หลัง reverse proxy |
| Firewall | เปิดเฉพาะ 3000 และ 8000 ให้ IP ที่อนุญาต |
| `env_file: .env` | ฉีด `.env` ทั้งไฟล์เข้าทุก container — `soc-mcp-splunk` ถือ `JWT_SECRET_KEY` อยู่ ทั้งที่แค่ query Splunk |

สองข้อล่างยังไม่ได้แก้ บันทึกไว้ใน [restructure.md](restructure.md)
