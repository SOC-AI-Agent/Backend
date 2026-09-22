# การขอและตั้งค่า Token

ทุก token ในระบบนี้เก็บที่ [`.env`](../.env.example) ไฟล์เดียว ซึ่ง **git ไม่ track**
(อยู่ใน [`.gitignore`](../.gitignore) บรรทัดแรก) ห้าม commit ค่าจริงลง `.env.example`

เอกสารนี้ไล่ทีละตัวว่าแต่ละ token คืออะไร เอามาจากไหน และเอาไปใส่ตรงไหน

---

## ภาพรวม — token มีกี่ตัว ใครถืออะไร

```
soc-ai ──MCP_AUTH_TOKEN──────────► soc-mcp-splunk ──SPLUNK_TOKEN──────► Splunk
       ──THREATQ_MCP_AUTH_TOKEN──► soc-mcp-threatq ─THREATQ_TOKEN/OAuth► ThreatQ

FortiSOAR ──X-API-Key──► soc-core-api ──JWT_SECRET_KEY (เซ็น session)
```

แบ่งเป็น 2 กลุ่มที่สับสนกันบ่อย:

| กลุ่ม | ทำหน้าที่ | ใครออกให้ |
| --- | --- | --- |
| `*_MCP_AUTH_TOKEN` | คุมว่า**ใครเรียก MCP server ของเราได้** | คุณสุ่มเอง |
| `SPLUNK_TOKEN`, `THREATQ_*` | เอาไว้ให้ **MCP server ของเราเข้าระบบปลายทาง** | ระบบปลายทางออกให้ |

---

## 1. Token ที่สุ่มเอง

### `JWT_SECRET_KEY`

กุญแจที่ NestJS ใช้เซ็น session token ของผู้ใช้ หลุดเมื่อไหร่ = ใครก็ปลอมเป็น admin ได้

```bash
openssl rand -hex 32
```

> ⚠️ เปลี่ยนค่านี้ = **session ที่ล็อกอินอยู่หลุดหมด** ทุกคนต้องล็อกอินใหม่

### `MCP_AUTH_TOKEN` — สำหรับ `soc-mcp-splunk`

### `THREATQ_MCP_AUTH_TOKEN` — สำหรับ `soc-mcp-threatq`

```bash
openssl rand -hex 32   # รันแยกกัน คนละค่า
```

**ทำไมต้องแยกคนละตัว** — connector หลุดตัวเดียวไม่ควรเปิดทั้งสองระบบ
ถ้าใช้ค่าเดียวกัน คนที่ได้ shell ใน `soc-mcp-splunk` จะยิง ThreatQ ได้ด้วย

**ทำไมต้องมี** — connector พวกนี้ไม่ publish port ออกนอกเครื่อง แต่ทุก container
ใน `soc-network` ยิงถึงได้ ไม่มี token = ใครอยู่ในเน็ตเวิร์กนั้นก็ query Splunk ได้ฟรี

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

รหัส admin ตอน seed ครั้งแรก

> ⚠️ **`npm run seed` ไม่ทับ user ที่มีอยู่แล้ว** — เปลี่ยนค่านี้หลัง seed ครั้งแรกไม่มีผล
> ถ้าลืมรหัส ต้องเปลี่ยนผ่านหน้า Users หรือล้าง DB แล้ว seed ใหม่

---

## 2. `SPLUNK_TOKEN` — เอามาจาก Splunk

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
- **ถอด capability `delete_by_keyword` และ `run_script` ออก**

ชั้น [`spl.py`](../mcp-server/Splunk/spl.py) กันการแต่ง SPL ไว้อีกชั้น (ทดสอบแล้วว่ากันได้จริง)
แต่ defence in depth ต้องมีสองชั้น ชั้น token คือชั้นที่สอง

### ค่าอื่นที่มากับ Splunk

```bash
SPLUNK_BASE_URL=https://splunk.example.com:8089   # management port ไม่ใช่ web (8000)
SPLUNK_ALLOWED_INDEXES=main,notable               # allowlist, "*" = ปิดการจำกัด (ตั้งใจเท่านั้น)
SPLUNK_VERIFY_SSL=true                            # false เฉพาะ lab ที่ cert self-signed
```

---

## 3. ThreatQ

เลือกได้ 2 แบบด้วย `THREATQ_AUTH_MODE`

### `oauth` (ค่า default) — OAuth2 password grant

```bash
THREATQ_AUTH_MODE=oauth
THREATQ_CLIENT_ID=<client id จาก ThreatQ>
THREATQ_EMAIL=<อีเมล service account>
THREATQ_PASSWORD=<รหัส service account>
```

`client_id` หาได้จาก ThreatQ → **Settings → API / Integrations**
ตัว connector จะขอ token เองที่ `POST /api/token` และต่ออายุให้อัตโนมัติ
([`threatq_api.py`](../mcp-server/Threatq/threatq_api.py))

### `bearer` — token ตายตัว

```bash
THREATQ_AUTH_MODE=bearer
THREATQ_TOKEN=<token>
```

> ⚠️ ทั้งสองแบบ **ยังไม่ได้ทดสอบกับ ThreatQ จริง** — ดูตารางข้อสมมติใน
> [`mcp-server/Threatq/README.md`](../mcp-server/Threatq/README.md) ว่าถ้าผิดต้องแก้ตรงไหน

### สิทธิ์ของ account

`THREATQ_ALLOW_WRITE=false` (ค่า default) กัน tool ที่เขียนข้อมูลไม่ให้ถูก republish
แต่**โหมด `agent` ไม่ได้ถูกกันด้วยชั้นนี้** เพราะมันคุม tool ที่ gateway ส่งต่อ
ไม่ได้คุม tool ที่ agent ของ ThreatQ เรียกเอง — ชั้นเดียวที่เหลือคือสิทธิ์ของ account

---

## 4. API Key สำหรับ FortiSOAR

ตัวนี้ไม่ได้อยู่ใน `.env` — ออกจากในระบบ

### ทาง Dashboard

`http://localhost:3000` → login → **API Keys** → Create → คัดลอกค่า (แสดงครั้งเดียว)

### ทาง API

```bash
# 1. login เอา JWT
JWT=$(curl -s -X POST http://localhost:8000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<รหัส admin>"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

# 2. ออก API key
curl -s -X POST http://localhost:8000/admin/api-keys \
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
echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)"
echo "THREATQ_MCP_AUTH_TOKEN=$(openssl rand -hex 32)"
```

แก้ `.env` ให้ครบ:

| ตัวแปร | ที่มา |
| --- | --- |
| `POSTGRES_PASSWORD` + ใน `CORE_DATABASE_URL` | สุ่ม |
| `JWT_SECRET_KEY` | สุ่ม |
| `DEFAULT_ADMIN_PASSWORD` | ตั้งเอง (เปลี่ยนทีหลังไม่ได้ ดูข้อ 1) |
| `MCP_AUTH_TOKEN` | สุ่ม |
| `THREATQ_MCP_AUTH_TOKEN` | สุ่ม |
| `SPLUNK_TOKEN` + `SPLUNK_BASE_URL` + `SPLUNK_ALLOWED_INDEXES` | ข้อ 2 |
| `THREATQ_*` | ข้อ 3 |

แล้วขึ้นระบบ:

```bash
docker compose --profile ai up -d --build
docker compose exec soc-ollama ollama pull qwen2.5:7b
docker compose exec soc-core-api npx prisma db push
docker compose exec soc-core-api npm run seed
```

ตรวจว่าตั้งครบ:

```bash
curl -s localhost:8000/health   # ai_service: "up"
curl -s localhost:8100/health   # ollama: true
curl -s localhost:8400/health   # agents, mcp_servers
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

## 6. Splunk สำหรับทดสอบ (ไม่มี Splunk จริง)

```bash
PW="Splunk@Test$(openssl rand -hex 3)"; echo "$PW"

docker run -d --name soc-splunk \
  --network soc-ai_soc-network --network-alias splunk \
  -e SPLUNK_GENERAL_TERMS=--accept-sgt-current-at-splunk-com \
  -e SPLUNK_START_ARGS=--accept-license \
  -e SPLUNK_PASSWORD="$PW" \
  -p 8089:8089 -p 8001:8000 \
  splunk/splunk:latest
```

> ต้องใส่ทั้ง `SPLUNK_GENERAL_TERMS` และ `SPLUNK_START_ARGS` — **นี่คือการยอมรับ
> Splunk General Terms** ขาดตัวใดตัวหนึ่ง container จะไม่ขึ้น
>
> web map ไปที่ `8001` เพราะ `8000` ถูก `soc-core-api` ใช้อยู่
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
| `MCP_AUTH_TOKEN` / `THREATQ_MCP_AUTH_TOKEN` | แก้ `.env` แล้ว `docker compose up -d` ตัวที่เกี่ยว (client กับ server อ่านค่าเดียวกัน ต้องขึ้นพร้อมกัน) |
| `SPLUNK_TOKEN` | ลบ token เดิมใน Splunk → ออกใหม่ → แก้ `.env` → restart `soc-mcp-splunk` |
| ThreatQ | เปลี่ยนรหัส service account หรือเพิกถอน token → แก้ `.env` → restart `soc-mcp-threatq` |
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
