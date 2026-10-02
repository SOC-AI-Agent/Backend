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

สุ่ม 3 ค่า:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
echo "JWT_SECRET_KEY=$(openssl rand -hex 32)"
echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)"
```

ThreatQ และ Confluence: ใส่ credential จริงใน `THREATQ_*` / `CONFLUENCE_*` (Backend เรียกตรง)
ปล่อยว่างได้ — summary จะบอกว่า ThreatQ NOT CHECKED และ playbook ไม่ได้ sync

> ⚠️ **`POSTGRES_PASSWORD` ต้องแก้ 2 ที่ให้ตรงกัน** — ตัวมันเองกับใน
> `CORE_DATABASE_URL` ไม่งั้น Prisma ต่อไม่ติด (`P1000 Authentication failed`)

รายละเอียดครบทุกตัว: [tokens.md](tokens.md)

---

## 2. ขึ้นระบบ

ขั้นตอนที่เหลือของเอกสารนี้อ้างถึง `AI-Service`, `MCP-Server` ด้วย ไม่ใช่แค่ Backend —
ใช้ `deploy/dev.yml` (ดู [README](../README.md#running-the-whole-thing-locally)) หรือขึ้นแต่ละ repo เอง:

```bash
docker compose -f deploy/dev.yml --project-directory . up -d --build
```

---

## 3. Agent-Server (agent platform)

แยกเป็นอีก repo ไม่ได้ขึ้นมาพร้อม `deploy/dev.yml` — ต้องขึ้นเอง (ดู
[AI-Service/README.md](../../AI-Service/README.md) หัวข้อ "Agent-Server"):

```bash
cd ../Agent-Server
cp .env.example .env               # ค่า default ใช้ได้เลย ไม่ต้องแก้
docker compose up -d --build       # http://localhost:7100
```

`LLAMA_HF_MODEL` (default `ggml-org/gemma-3-1b-it-GGUF`) โหลดเองตอน container
ขึ้นครั้งแรก ใช้เวลาสักพักตามความเร็วเน็ต ดูความคืบหน้า: `docker compose logs -f dall-m-llamacpp`

ตั้ง DB, model ตัวแรก และ admin คนแรกของ Agent-Server (คนละระบบกับ admin ของ dashboard นี้):

```bash
pip install -r script/requirements.txt
python script/create_db.py
python script/insert_default_model.py
python script/add_admin_user.py --username admin --email admin@example.com --password <รหัส>
```

> ⚠️ `add_admin_user.py` เก็บรหัสเป็น plain text (ยังไม่ hash) — อย่าใช้รหัสที่ใช้จริงที่อื่น

`AI-Service/.env`'s `LLM_SERVER_URL` (default `http://host.docker.internal:8000`)
ชี้มาที่นี่แล้ว ถ้า Agent-Server รันอยู่เครื่องอื่นต้องแก้ค่านี้

---

## 4. สร้างตารางและ seed (local เท่านั้น)

```bash
docker compose exec soc-core-api npx prisma db push
docker compose exec soc-core-api npm run seed          # roles only
```

`prisma db push` ใช้สำหรับ local database ที่สร้างใหม่เท่านั้น ห้ามใช้กับ
production database ที่มีข้อมูลอยู่แล้ว สำหรับ production ให้ตรวจ schema จริง
และวางแผน migration แยกก่อน (ดู [README](../README.md#commands))

`seed` สร้างแค่ roles ไม่สร้าง user จาก env อีกแล้ว admin คนแรกสร้างเอง
(รหัสไม่ผ่าน argv และไม่ลง `.env`):

```bash
read -rsp 'admin password: ' PW; echo
HASH=$(docker compose exec -T -e PW="$PW" soc-core-api \
  node -e "require('bcrypt').hash(process.env.PW, 12).then(h => process.stdout.write(h))")
unset PW
docker compose exec -T soc-db psql -U socai -d socai -v hash="$HASH" <<'SQL'
INSERT INTO users (id, username, email, hashed_password, role_id, updated_at)
SELECT gen_random_uuid(), 'admin', 'admin@soc.example', :'hash', id, now()
FROM roles WHERE name = 'admin';
SQL
```

user คนถัดไปสร้างผ่านหน้า Users ด้วย admin คนนี้

> ⚠️ **ถ้าใช้ volume เดิมที่มีข้อมูลอยู่** Postgres จะไม่รับรหัสใหม่ — มันตั้งรหัส
> เฉพาะตอน init volume เปล่า เปลี่ยนเองด้วย:
> ```bash
> docker compose exec soc-db psql -U socai -d socai \
>   -c "ALTER USER socai WITH PASSWORD '<รหัสใหม่>';"
> ```

---

## 5. สร้าง agent

Backend เรียก agent 3 ตัว **ถ้าขาดตัวไหน job จะ fail หรือได้ผลไม่ครบ** ทั้งหมดไม่มี tool และไม่ต่อ MCP server ตัวไหน:

| agent | ตั้งชื่อด้วย | ทำอะไร |
| --- | --- | --- |
| `soc-suggest` | `LLM_SUGGEST_AGENT` | อ่าน alert + ข้อมูลที่ Backend เตรียมไว้ (ThreatQ, playbook) เขียน suggestion — ขาดตัวนี้ job fail |
| `soc-requirements` | `LLM_REQUIREMENTS_AGENT` | อ่านเหมือนกัน (alert + ThreatQ + playbook) พร้อม suggestion แล้วเขียนว่าอยากถาม Splunk อะไร พร้อมรายละเอียดจาก alert ใต้แต่ละคำถาม — ขาดหรือพัง: ใช้แผนที่ Backend ได้จากตัวโค้ดแทน |
| `soc-conclude` | `LLM_CONCLUDE_AGENT` | หลังค้น Splunk เสร็จ อ่านผลค้นคู่กับ suggestion เขียนบทวิเคราะห์ — ขาดหรือพัง: ผลค้นยังอยู่ครบ ไม่มีบทวิเคราะห์ |

การค้น Splunk ไม่ผ่าน agent: Backend ส่งแต่ละ requirement เป็นข้อความไป Text-to-SPL ของ Splunk
ผ่าน MCP (`saia_generate_spl`) ตรวจ SPL ที่ได้ แล้วสั่งรัน (`splunk_run_query`)

### รูปแบบคำตอบของ `soc-requirements`

Backend ต่อท้าย prompt ทุกครั้งด้วย `--- ANSWER FORMAT ---` ([requirements.ts](../src/modules/ai/requirements.ts)
`requirementsFormat`) จึงไม่ขึ้นกับ system prompt — agent ตอบแบบนี้:

```
1. What else did 45.83.122.9 touch in the 24 hours around the alert
   source: 45.83.122.9
   device: FGT-01
   type: event
   user_agent: FortiClient/7.2
```

- **บรรทัดคำถาม** ต้องมีค่าที่ extract จาก alert (IP, user, host, hash, domain) — Backend ใช้ค่านี้หา
  index/sourcetype/field จาก catalogue
- **รายละเอียด `key: value`** ใต้คำถาม (device, source, destination, domain, user, user_agent, type,
  action, signature, …) ถูกส่งไป Text-to-SPL ด้วย ช่วยให้รู้ว่าคำถามเกี่ยวกับข้อมูลชุดไหน
- **ค่าที่ไม่มีอยู่ในสิ่งที่ agent อ่าน ถูกตัดทิ้ง** (model เล็กชอบเติมค่าที่ดูสมเหตุสมผลแต่ไม่มีจริง)
  และเก็บไว้ใน `droppedContext` หน้า job แสดงว่า "not in the alert, left out"
- key ที่ catalogue รู้ความหมาย (`source`, `destination`, `user`, `device`/`host`, `domain`, `hash`,
  `action`, …) ได้ชื่อ field ของ sourcetype นั้นแนบไปด้วย เช่น `FGT-01 is in devname`

system prompt ที่แนะนำ (อย่ากำหนดรูปแบบคำตอบใน system prompt ให้ขัดกับ ANSWER FORMAT):

```text
You are a SOC analyst's assistant. You read one alert — the raw log, the threat
intelligence (ThreatQ) results and the playbook for it — and the first-pass
suggestion already written, and decide what still has to be asked of Splunk to
confirm or rule out that suggestion.

Ask only what the alert and the suggestion leave open. Each question names one
value from the alert (an address, a user, a host, a hash or a domain) and says
what to find out about it.

Under each question, list the details from the alert that tell Splunk which data
the question is about — device, source, destination, domain, user, user_agent,
type, action, signature — copied exactly as they appear in the alert. Never
invent a value, and leave out a detail the alert does not have.

Answer in the ANSWER FORMAT given at the end of the message, and nothing else.
```

สร้างที่ Agent-Server (คนละระบบ, คนละ auth กับ dashboard นี้) — ไม่มีไฟล์ JSON ให้ import
เหมือนเดิม เพราะ agent ของมันเก็บใน Postgres ของมันเอง:

เปิด `http://localhost:7100` ล็อกอินด้วย admin ที่สร้างไว้ในข้อ 3 แล้วสร้าง agent 3 ตัว
ตาม slug ในตาราง (Model เลือกจาก dropdown ที่ `insert_default_model.py` ลงทะเบียนไว้ ใส่
system prompt ตามที่ตั้งใจไว้ในตัวเดิม) — `LLM_DEFAULT_AGENT` (default `soc-suggest`)
มีไว้สำหรับผู้เรียกที่ไม่ระบุชื่อ agent

หรือทาง API (ต้อง login เอา JWT ก่อน, และต้องรู้ `owner_id`/`model_id` เป็น UUID):

```bash
TOKEN=$(curl -s -X POST localhost:8000/restful/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<รหัส Agent-Server>"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

curl -s -X POST localhost:8000/restful/agents -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "slug":"soc-suggest","name":"soc-suggest","owner_id":"<user uuid>",
    "model_id":"<model uuid>","system_prompt":"<system prompt เดิม>"}'
```

Backend ต้องตั้ง `SPLUNK_ALLOWED_INDEXES` ด้วย (ชุดเดียวกับ `MCP-Server/.env`) เพราะมันเป็นตัวเขียน SPL
รายการว่าง = ปฏิเสธทุกการค้น

---

## 6. ตรวจว่าขึ้นครบ

```bash
curl -s localhost:8081/health    # ai_service: "up"
docker exec soc-ai python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8100/health').read())"
                                 # llm_server: true, playbooks: จำนวนที่ index แล้ว
curl -s localhost:8000/         # Agent-Server: {"status": "ok"} — ไม่มี /health รวม ollama/agents
docker compose exec soc-mcp-splunk python -c \
  "import urllib.request; print(urllib.request.urlopen('http://localhost:8200/health').read())"
```

### Playbook จาก Confluence

worker อ่าน playbook ทั้ง space ผ่าน Confluence connector (`GET /pages`) ทุก
`PLAYBOOK_SYNC_MINUTES` แล้วส่งให้ `soc-ai` (`PUT /playbooks/index`) ซึ่ง extract
field, embed และเก็บ index ลง volume `playbook-index` — embed เฉพาะ field ที่ข้อความเปลี่ยน
รอบที่ไม่มีอะไรเปลี่ยนจึงไม่ embed เลย ทุก alert จะ match กับ index ของ `soc-ai`
(ชื่อตรง → สะกดใกล้ → ความหมาย) ไม่ได้ถาม connector แล้ว

ดูว่า index อะไรไปแล้ว และ tier ความหมายทำงานไหม:

```bash
docker exec soc-ai python -c "import os,urllib.request as u; print(u.urlopen(u.Request('http://localhost:8100/playbooks', headers={'Authorization': 'Bearer '+os.environ['AI_SERVICE_AUTH_TOKEN']})).read().decode())"
docker compose logs soc-core-worker | grep -i "playbook"   # "playbooks synced: ..." หรือ "playbook sync failed ..."
```

container ที่ขาด token จะ **ไม่ยอมขึ้นเลย** พร้อมบอกว่าขาดตัวไหน — ตั้งใจให้ fail
แบบนั้น ดีกว่าขึ้นมาแล้วเปิดทางเข้า Splunk แบบไม่มีการยืนยันตัวตน

---

## 7. ยิง alert แรก

```bash
JWT=$(curl -s -X POST localhost:8081/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<รหัส>"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

KEY=$(curl -s -X POST localhost:8081/admin/api-keys -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' -d '{"name":"first-test"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('api_key') or d['key'])")

curl -s -X POST localhost:8081/v1/analyze -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{
    "alert_id":"FIRST-001","alert_name":"test",
    "raw_log":"srcip=10.1.100.11 dstip=45.83.122.9 action=\"blocked\""}'
```

ไม่มี field `prompt` — agent บน Agent-Server ถือ system prompt ของตัวเอง
playbook เก่าที่ยังส่งมาไม่ error เฉยๆ ถูกตัดทิ้งที่ validation pipe

ได้ `job_id` แล้ว poll:

```bash
curl -s localhost:8081/v1/results/<job_id> -H "X-API-Key: $KEY"
```

---

## ที่อยู่ของแต่ละหน้า

| | |
| --- | --- |
| Dashboard | `http://localhost:3001` |
| Agent-Server UI | `http://localhost:7100` (คนละ stack, ขึ้นแยก — ดูข้อ 3) |
| Agent-Server API (Swagger) | `http://localhost:8000/docs` |
| Core API | `http://localhost:8081` |
| Core API docs (Swagger) | `http://localhost:8081/docs` |
| AI service | ไม่เปิด port — เรียกได้จากใน `soc-network` เท่านั้น และต้องมี `AI_SERVICE_AUTH_TOKEN` |

---

## ระบบภายนอก

### Splunk

Splunk อยู่นอก stack นี้ (ในเครือข่ายบริษัท) Backend คุยกับ **Splunk MCP Server app** ตรง —
ตั้งใน `Backend/.env` สิ่งที่ต้องขอจากทีม Splunk (แอป, role, token, network, CA) และวิธีเช็คว่า
ต่อสำเร็จอยู่ใน [MCP-Server/Splunk/README.md — Production](../../MCP-Server/Splunk/README.md#production-connecting-to-splunk)

```
SPLUNK_MCP_URL=https://splunk.corp.example:8089/services/mcp
SPLUNK_MCP_TOKEN=                 # encrypted token จากแอป Splunk MCP Server
SPLUNK_ALLOWED_INDEXES=
NODE_EXTRA_CA_CERTS=              # /certs/<ca>.pem ถ้า 8089 ใช้ cert ภายใน
```

catalogue (index/sourcetype/field) ดึงจาก Splunk ด้วย job `export_catalog` — [splunk-catalog.md](splunk-catalog.md)

dev: ไม่มี Splunk ก็ได้ — ใช้ `soc-mcp-splunk` (`SPLUNK_MODE=mock` ใน `MCP-Server/.env`)

ถ้ายังต่อ Splunk ของบริษัทไม่ได้ ใช้ image ทดสอบแทนได้ (เฉพาะเครื่อง dev):

```bash
PW="Splunk@Test$(openssl rand -hex 3)"; echo "$PW"
docker run -d --name soc-splunk \
  --network soc-network --network-alias splunk \
  -e SPLUNK_GENERAL_TERMS=--accept-sgt-current-at-splunk-com \
  -e SPLUNK_START_ARGS=--accept-license -e SPLUNK_PASSWORD="$PW" \
  -p 8089:8089 -p 8001:8000 splunk/splunk:latest
```

ขั้นตอนออก token และใส่ข้อมูลทดสอบ: [tokens.md](tokens.md) หัวข้อ 6

มีของจริงแล้ว — **ดึง catalog ก่อนใช้งาน** ไม่งั้น agent จะเดาชื่อ field ผิดแล้ว
รายงานว่า "ไม่พบอะไร" อย่างมั่นใจ: [splunk-catalog.md](splunk-catalog.md)

### ThreatQ

ต้องใช้ ThreatQ จริง (เป็น appliance ไม่มี image สาธารณะ และไม่มี stand-in แล้ว)
ตั้งใน `MCP-Server/.env`:

```
THREATQ_BASE_URL=https://threatq.example.com
THREATQ_AUTH_MODE=oauth
THREATQ_CLIENT_ID=
THREATQ_EMAIL=
THREATQ_PASSWORD=
THREATQ_VERIFY_SSL=true
```

ตั้งไม่ครบ connector จะไม่ยอมขึ้น เช็คว่าต่อสำเร็จไหมด้วย `GET /check-connection` —
[MCP-Server/Threatq/README.md](../../MCP-Server/Threatq/README.md)

### FortiSOAR

playbook ยิง `POST /v1/analyze` พร้อม header `X-API-Key` แล้ว poll
`GET /v1/results/{job_id}` — [tokens.md](tokens.md) หัวข้อ 4

---

## ก่อนขึ้น production

| เรื่อง | ทำอะไร |
| --- | --- |
| รหัส admin | เปลี่ยนที่หน้า Users ทันที |
| `SPLUNK_MCP_TOKEN` / `SPLUNK_TOKEN` | role **search-only** ไม่มี `delete_by_keyword`, `run_collect`, `run_mcollect`, `run_dump`, `run_sendalert`, `output_file`, `run_custom_command` — ดู [MCP-Server/Splunk/README.md](../../MCP-Server/Splunk/README.md#2-service-account-role-and-token) |
| `SPLUNK_VERIFY_SSL` | ต้องเป็น `true` (lab ตั้ง false) |
| ThreatQ account | read-only |
| `Agent-Server` | **ไม่มี auth บน `/v1/agents/...` เลย** (ยังไม่มีระบบ API key — ดู readme ของมัน "Known limitations") ใครถึง port 8000 ได้ก็เรียก agent ได้ฟรี ต้องอยู่หลัง reverse proxy หรือ firewall เฉพาะ `soc-ai` |
| Firewall | เปิดเฉพาะ 3001 และ 8081 ให้ IP ที่อนุญาต |
| `env_file: .env` | ฉีด `.env` ทั้งไฟล์เข้าทุก container — `soc-mcp-splunk` ถือ `JWT_SECRET_KEY` อยู่ ทั้งที่แค่ query Splunk |

สองข้อล่างยังไม่ได้แก้ บันทึกไว้ใน [restructure.md](restructure.md)
