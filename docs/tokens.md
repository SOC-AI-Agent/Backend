# การขอและตั้งค่า Token

ทุก token ในระบบนี้เก็บที่ [`.env`](../.env.example) ไฟล์เดียว ซึ่ง **git ไม่ track**
(อยู่ใน [`.gitignore`](../.gitignore) บรรทัดแรก) ห้าม commit ค่าจริงลง `.env.example`

เอกสารนี้ไล่ทีละตัวว่าแต่ละ token คืออะไร เอามาจากไหน และเอาไปใส่ตรงไหน

---

## ภาพรวม — token มีกี่ตัว ใครถืออะไร

```
soc-core-worker ──SPLUNK_MCP_TOKEN──────► Splunk MCP Server app (production) ──► Splunk
                ──MCP_AUTH_TOKEN────────► soc-mcp-splunk (development, mock)
                ──THREATQ_TOKEN/OAuth───► ThreatQ REST API      (เรียกตรง)
                ──CONFLUENCE_API_TOKEN──► Confluence REST API   (เรียกตรง)
                ──AI_SERVICE_AUTH_TOKEN─► soc-ai

FortiSOAR ──X-API-Key──► soc-core-api ──JWT_SECRET_KEY (เซ็น session)
```

แบ่งเป็น 2 กลุ่มที่สับสนกันบ่อย:

| กลุ่ม | ทำหน้าที่ | ใครออกให้ |
| --- | --- | --- |
| `MCP_AUTH_TOKEN`, `AI_SERVICE_AUTH_TOKEN` | คุมว่า**ใครเรียก service ของเราได้** | คุณสุ่มเอง |
| `SPLUNK_MCP_TOKEN`, `THREATQ_*`, `CONFLUENCE_*` | ให้ **Backend เข้าระบบปลายทาง** | ระบบปลายทางออกให้ |

---

## 1. Token ที่สุ่มเอง

### `JWT_SECRET_KEY`

กุญแจที่ NestJS ใช้เซ็น session token ของผู้ใช้ หลุดเมื่อไหร่ = ใครก็ปลอมเป็น admin ได้

```bash
openssl rand -hex 32
```

> ⚠️ เปลี่ยนค่านี้ = **session ที่ล็อกอินอยู่หลุดหมด** ทุกคนต้องล็อกอินใหม่

### `MCP_AUTH_TOKEN` — สำหรับ `soc-mcp-splunk` (development)

```bash
openssl rand -hex 32
```

ใส่ค่าเดียวกันใน `Backend/.env` และ `MCP-Server/.env` — ใช้เฉพาะตอนต่อ mock
(`SPLUNK_MCP_TOKEN` ว่าง) production ไม่ใช้ตัวนี้

**ทำไมต้องมี** — `soc-mcp-splunk` ไม่ publish port ออกนอกเครื่อง แต่ทุก container
ใน `soc-network` ยิงถึงได้ ไม่มี token = ใครอยู่ในเน็ตเวิร์กนั้นก็ query ได้ฟรี

(`THREATQ_MCP_AUTH_TOKEN` และ `CONFLUENCE_MCP_AUTH_TOKEN` เลิกใช้แล้ว — Backend เรียก
ThreatQ/Confluence ตรง ไม่มี connector ตรงกลาง)

### `AI_SERVICE_AUTH_TOKEN` — สำหรับ `soc-ai`

```bash
openssl rand -hex 32
```

ใส่ค่าเดียวกันใน `Backend/.env` และ `AI-Service/.env` (ใน GitLab ตั้งเป็น group variable
ตัวเดียว) — `soc-ai` ไม่ยอมขึ้นถ้าไม่มี ทุก route ยกเว้น `/health` ต้องใช้ ทั้งการรัน agent
และการเขียน playbook index ไม่มี token = อะไรก็ตามใน `soc-network` สั่ง agent หรือแก้ index ได้

### `POSTGRES_PASSWORD`

```bash
openssl rand -hex 16
```

> ⚠️ ต้องแก้ 3 ที่ให้ตรงกัน ไม่งั้น Prisma ต่อ DB ไม่ติด (`P1000 Authentication failed`):
> ```
> POSTGRES_PASSWORD=<ค่าใหม่>
> CORE_DATABASE_URL=postgresql://socai:<ค่าใหม่>@soc-db:5432/socai
> ```
>
> และ **Postgres ใช้ `POSTGRES_PASSWORD` เฉพาะตอน init volume เปล่าเท่านั้น**
> ถ้าใช้ volume เดิมที่มีข้อมูลอยู่แล้ว ต้องเปลี่ยนรหัสใน DB เอง:
> ```bash
> docker compose exec soc-db psql -U socai -d socai \
>   -c "ALTER USER socai WITH PASSWORD '<ค่าใหม่>';"
> ```

### `DEFAULT_ADMIN_PASSWORD`

**สงวนไว้ — ไม่มีอะไรอ่านค่านี้** เก็บไว้ใน `.env.example` ชั่วคราวเท่านั้น
`npm run seed` สร้างแค่ roles ห้ามโค้ด, script หรือ CI ใช้ค่านี้สร้างหรือ login user
admin คนแรกสร้างเองตาม [setup.md ข้อ 4](setup.md)

---

## 2. Splunk

### `SPLUNK_MCP_TOKEN` — production

Backend คุยกับ **Splunk MCP Server app** บน search head โดยตรง token ตัวนี้**ออกจากในแอป
Splunk MCP Server** (encrypted token ใช้ได้กับ MCP เท่านั้น แสดงครั้งเดียว) ให้ service account
ที่มี role ค้นได้อย่างเดียว + `mcp_tool_execute` ขั้นตอนครบ (แอปที่ต้องติดตั้ง, role, network,
CA, การตรวจ) อยู่ที่
[MCP-Server/Splunk/README.md — Production](../../MCP-Server/Splunk/README.md#production-connecting-to-splunk)

```bash
SPLUNK_MCP_URL=https://<search-head>:8089/services/mcp
SPLUNK_MCP_TOKEN=<encrypted token>      # GitLab CI variable, masked + protected
SPLUNK_ALLOWED_INDEXES=<index ของ SOC>  # ชุดเดียวกับที่ role อ่านได้
NODE_EXTRA_CA_CERTS=/certs/<ca>.pem     # ถ้า 8089 ใช้ cert ภายใน/self-signed
```

### `SPLUNK_TOKEN` — สำหรับ job `export_catalog` (CI)

token **ธรรมดา** (ไม่ใช่ encrypted token ของ MCP) ของ service account เดียวกัน ใช้เฉพาะตอนกด
`export_catalog` เพื่อดึง catalogue ([splunk-catalog.md](splunk-catalog.md)) — ตั้งเป็น CI variable
`SPLUNK_TOKEN` คู่กับ `SPLUNK_URL` ใน project Backend (protected + masked) ไม่ได้อยู่ใน `.env`
ของ service ใดๆ (connector `soc-mcp-splunk` โหมด live ก็ใช้ชื่อนี้ แต่ connector ใช้เฉพาะตอน dev)
Splunk ใช้ JWT ที่ต้องเปิด token auth ก่อน

### ทางหน้าเว็บ

1. เข้า Splunk Web → **Settings → Tokens**
2. ถ้ายังปิดอยู่ กด **Enable Token Authentication**
3. **New Token** → เลือก User, ใส่ Audience (เช่น `soc-mcp`), ตั้งวันหมดอายุ
4. **คัดลอกทันที — Splunk แสดงให้ดูครั้งเดียว**

### ทาง REST API

```bash
SPLUNK=https://splunk.example.com:8089
ADMIN=admin
PW='<รหัส admin>'

# เปิด token auth (ทำครั้งเดียว)
curl -sk -u "$ADMIN:$PW" -X POST \
  "$SPLUNK/services/admin/token-auth/tokens_auth" -d disabled=false

# ออก token
curl -sk -u "$ADMIN:$PW" -X POST \
  "$SPLUNK/services/authorization/tokens?output_mode=json" \
  -d name="$ADMIN" -d audience=soc-mcp \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['entry'][0]['content']['token'])"
```

> `expires_on` รับเฉพาะบางรูปแบบ ถ้าใส่แล้วได้ `expires_on argument is in an invalid format`
> ให้ตัดออก Splunk จะใช้ค่า default (ดูได้ที่ `tokens_auth` field `expiration`)

### ⚠️ สิทธิ์ของ token — ข้อสำคัญที่สุดในเอกสารนี้

**อย่าใช้ token ของ admin ใน production**

SPL ไม่ใช่ภาษาอ่านอย่างเดียว — `| delete`, `| collect`, `| outputlookup`, `| script`
เขียนหรือลบข้อมูลได้ และ alert text ที่ขับ model เป็นสิ่งที่ผู้โจมตีแต่งได้

token ต้องผูกกับ role ที่:
- ค้นได้อย่างเดียว
- เข้าได้เฉพาะ index ที่ต้องใช้จริง
- **ไม่มี capability `delete_by_keyword`, `run_collect`, `run_mcollect`, `run_dump`, `run_sendalert`, `output_file`, `run_custom_command`** (ชื่อตาม [authorize.conf](https://help.splunk.com/en/data-management/splunk-enterprise-admin-manual/10.4/configuration-file-reference/10.4.0-configuration-file-reference/authorize.conf) — ไม่มี capability ชื่อ `run_script`)

SPL ที่ Text-to-SPL เขียนถูกตรวจโดย [`spl-guard.ts`](../src/modules/enrichment/spl-guard.ts)
ก่อนส่งรัน และ Splunk MCP Server มี guardrail ของตัวเอง แต่ defence in depth ต้องมีหลายชั้น
ชั้น role ของ token คือชั้นที่ขาดไม่ได้

### ค่าอื่นที่มากับ Splunk

```bash
SPLUNK_BASE_URL=https://splunk.example.com:8089   # management port ไม่ใช่ web (8000)
SPLUNK_ALLOWED_INDEXES=main,notable               # allowlist, "*" = ปิดการจำกัด (ตั้งใจเท่านั้น)
SPLUNK_VERIFY_SSL=true                            # false เฉพาะ lab ที่ cert self-signed
```

---

## 3. ThreatQ

Backend เรียก ThreatQ REST API ตรง (อ่านอย่างเดียว: ขอ token + ค้น indicator)
ตั้ง `THREATQ_BASE_URL` และเลือกได้ 2 แบบด้วย `THREATQ_AUTH_MODE`

### `oauth` (ค่า default) — OAuth2 password grant

```bash
THREATQ_AUTH_MODE=oauth
THREATQ_CLIENT_ID=<client id จาก ThreatQ>
THREATQ_EMAIL=<อีเมล service account>
THREATQ_PASSWORD=<รหัส service account>
```

`client_id` หาได้จาก ThreatQ → **Settings → API / Integrations**
Backend จะขอ token เองที่ `POST /api/token` และต่ออายุให้อัตโนมัติ
([`threatq.service.ts`](../src/modules/enrichment/threatq.service.ts))

### `bearer` — token ตายตัว

```bash
THREATQ_AUTH_MODE=bearer
THREATQ_TOKEN=<token>
```

> ⚠️ ทั้งสองแบบ **ยังไม่ได้ทดสอบกับ ThreatQ จริง** — path และรูปแบบ body ตาม REST API
> Reference v5.12 ถ้าไม่ตรงกับ deployment ปรับได้ที่ `THREATQ_TOKEN_PATH`, `THREATQ_SEARCH_PATH`

### สิทธิ์ของ account

ใช้ service account ที่**อ่าน indicator ได้อย่างเดียว** Backend ไม่เขียนอะไรกลับ ThreatQ

---

## 3.1 Confluence

Backend (worker) อ่านทุกหน้าใน space playbook ตรงจาก REST API ทุก `PLAYBOOK_SYNC_MINUTES`

```bash
CONFLUENCE_BASE_URL=https://your-org.atlassian.net/wiki   # Server/DC: https://confluence.corp
CONFLUENCE_SPACE_KEY=SOC
CONFLUENCE_EMAIL=<อีเมล service account>   # Cloud — basic auth คู่กับ API token
CONFLUENCE_API_TOKEN=<API token>            # Server/DC: personal access token, ปล่อย EMAIL ว่าง
```

ใช้ account ที่เห็นเฉพาะ space playbook และอ่านได้อย่างเดียว

---

## 4. API Key สำหรับ FortiSOAR

ตัวนี้ไม่ได้อยู่ใน `.env` — ออกจากในระบบ

### ทาง Dashboard

`http://localhost:3001` → login → **API Keys** → Create → คัดลอกค่า (แสดงครั้งเดียว)

### ทาง API

```bash
# 1. login เอา JWT
JWT=$(curl -s -X POST http://localhost:8081/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<รหัส admin>"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

# 2. ออก API key
curl -s -X POST http://localhost:8081/admin/api-keys \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"name":"fortisoar-prod"}'
```

เอาค่าที่ได้ไปใส่ใน FortiSOAR playbook เป็น header `X-API-Key`

สคริปต์ทดสอบอ่านจาก env:

```bash
export SOC_API_KEY=sk-xxxxx
python3 test_full_flow.py
```

---

## 5. ตั้งค่าครั้งแรก — รวบทุกขั้นตอน

```bash
cp .env.example .env

# สุ่ม 4 ค่า
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
echo "JWT_SECRET_KEY=$(openssl rand -hex 32)"
echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)"         # ค่าเดียวกันใน MCP-Server/.env (mock)
echo "AI_SERVICE_AUTH_TOKEN=$(openssl rand -hex 32)"   # ค่าเดียวกันใน AI-Service/.env
```

แก้ `.env` ให้ครบ:

| ตัวแปร | ที่มา |
| --- | --- |
| `POSTGRES_PASSWORD` + ใน `CORE_DATABASE_URL` | สุ่ม |
| `JWT_SECRET_KEY` | สุ่ม |
| `DEFAULT_ADMIN_PASSWORD` | สงวนไว้ ไม่ถูกอ่าน — ไม่ต้องตั้ง (ดูข้อ 1) |
| `MCP_AUTH_TOKEN` | สุ่ม — ค่าเดียวกับใน `MCP-Server/.env` |
| `AI_SERVICE_AUTH_TOKEN` | สุ่ม — ค่าเดียวกับใน `AI-Service/.env` |
| `SPLUNK_MCP_URL` + `SPLUNK_MCP_TOKEN` + `SPLUNK_ALLOWED_INDEXES` | ข้อ 2 (dev: ปล่อย token ว่าง ใช้ mock) |
| `THREATQ_*` | ข้อ 3 |
| `CONFLUENCE_*` | ข้อ 3.1 |

แล้วขึ้นระบบ:

```bash
docker compose -f deploy/dev.yml --project-directory . up -d --build
docker compose exec soc-core-api npx prisma db push
docker compose exec soc-core-api npm run seed          # roles only
```

Agent-Server (agent platform) เป็นอีก repo ขึ้นแยก ไม่มีในคำสั่งข้างบน — ดู
[setup.md ข้อ 3](setup.md)

สร้าง admin คนแรกเอง: [setup.md ข้อ 4](setup.md)

ตรวจว่าตั้งครบ:

```bash
curl -s localhost:8081/health   # ai_service: "up"
docker exec soc-ai python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8100/health').read())"
                                # llm_server: true
curl -s localhost:8000/         # Agent-Server: {"status": "ok"}
docker compose exec soc-mcp-splunk python -c \
  "import urllib.request; print(urllib.request.urlopen('http://localhost:8200/health').read())"
  # splunk: true
```

container ที่ขาด token จะ **ไม่ยอมขึ้นเลย** พร้อมบอกว่าขาดตัวไหน:

```
RuntimeError: refusing to start, unset required env: MCP_AUTH_TOKEN, SPLUNK_TOKEN, ...
```

ตั้งใจให้ fail แบบนี้ ดีกว่าขึ้นมาแล้วเปิด proxy เข้า Splunk แบบไม่มีการยืนยันตัวตน

---

## 6. Splunk สำหรับทดสอบ (เฉพาะเมื่อต่อ Splunk ของบริษัทไม่ได้)

```bash
PW="Splunk@Test$(openssl rand -hex 3)"; echo "$PW"

docker run -d --name soc-splunk \
  --network soc-network --network-alias splunk \
  -e SPLUNK_GENERAL_TERMS=--accept-sgt-current-at-splunk-com \
  -e SPLUNK_START_ARGS=--accept-license \
  -e SPLUNK_PASSWORD="$PW" \
  -p 8089:8089 -p 8001:8000 \
  splunk/splunk:latest
```

> ต้องใส่ทั้ง `SPLUNK_GENERAL_TERMS` และ `SPLUNK_START_ARGS` — **นี่คือการยอมรับ
> Splunk General Terms** ขาดตัวใดตัวหนึ่ง container จะไม่ขึ้น
>
> web map ไปที่ `8001` เพื่อไม่ชนกับ port 8000 ของเครื่องที่อาจใช้อยู่
>
> บน Apple Silicon image เป็น amd64 ต้อง emulate — boot ครั้งแรกกินเวลาหลายนาที

รอจน healthy แล้วออก token ตามข้อ 2 และตั้ง:

```bash
SPLUNK_BASE_URL=https://splunk:8089
SPLUNK_VERIFY_SSL=false        # cert self-signed — ห้ามใช้ค่านี้ใน production
SPLUNK_ALLOWED_INDEXES=main
```

ใส่ข้อมูลทดสอบ:

```bash
curl -sk -u admin:"$PW" -X POST \
  "https://localhost:8089/services/receivers/simple?index=main&sourcetype=fortigate" \
  --data-binary 'date=2026-09-21 time=07:30:00 srcip=10.1.100.11 dstip=45.83.122.9 dstport=443 action="blocked" service="HTTPS" user="jdoe"'
```

> ⚠️ **เวลาใน event ต้องเป็นอดีต** เทียบกับนาฬิกาของ Splunk (`docker exec soc-splunk date -u`)
> ถ้าใส่เวลาอนาคต event จะเข้า index แต่ tool ที่ค้นด้วยหน้าต่าง `-24h..now` จะหาไม่เจอ

---

## 7. เปลี่ยน token / เพิกถอน

| token | ขั้นตอน |
| --- | --- |
| `MCP_AUTH_TOKEN` | แก้ `.env` ทั้ง Backend และ MCP-Server แล้ว `docker compose up -d` ทั้งสองฝั่ง |
| `SPLUNK_MCP_TOKEN` | ออกใหม่ในแอป Splunk MCP Server → แก้ CI variable / `.env` → restart `soc-core-worker` (หลุด: แอปมีปุ่มเพิกถอน MCP token ทั้งหมด) |
| `SPLUNK_TOKEN` | ลบ token เดิมใน Splunk → ออกใหม่ → แก้ CI variable `SPLUNK_TOKEN` ใน project Backend (ใช้แค่ `export_catalog` ไม่ต้อง restart อะไร) |
| ThreatQ / Confluence | เปลี่ยนรหัส service account หรือเพิกถอน token → แก้ `.env` → restart `soc-core-worker` |
| API Key ของ SOAR | หน้า API Keys → Revoke (มีผลทันที) แล้วออกใหม่ |
| `JWT_SECRET_KEY` | แก้ `.env` → restart `soc-core-api` + `soc-core-worker` → **ทุก session หลุด** |

---

## ⚠️ ข้อควรรู้เรื่องการแจก secret

ตอนนี้ `docker-compose.yml` ใช้ `env_file: .env` ซึ่งฉีด **`.env` ทั้งไฟล์**
เข้าทุก service แปลว่า `soc-mcp-splunk` ถือ `JWT_SECRET_KEY` อยู่ด้วย ทั้งที่
มันแค่ query Splunk — ใครได้ shell ใน container นั้นเซ็น JWT เป็น admin ได้

ทางแก้คือเลิกใช้ `env_file` แล้วระบุทีละตัวว่า service ไหนต้องรู้อะไร:

```yaml
soc-ai:
  environment:
    OLLAMA_BASE_URL: ${OLLAMA_BASE_URL}
    OLLAMA_MODEL: ${OLLAMA_MODEL}
    OLLAMA_TIMEOUT: ${OLLAMA_TIMEOUT}
```

ยังไม่ได้ทำ — บันทึกไว้เป็นงานค้างใน [`restructure.md`](restructure.md)
