# การขอและตั้งค่า Token

บน production ทุก token เป็น **CI variable** ของ project ใน GitLab (**Settings → CI/CD → Variables**)
ติ๊ก **Protected** และ **Masked** ทุกตัว deploy เขียนค่าเหล่านี้ลง `.env` บนเครื่องเอง ไม่พิมพ์ใน log
และไม่เก็บเป็น artifact ห้าม commit ค่าจริงลง `.env.example` หรือไฟล์ไหนใน repo

เอกสารนี้ไล่ทีละตัวว่าแต่ละ token คืออะไร เอามาจากไหน และตั้งเป็น variable ชื่ออะไร

---

## ภาพรวม — token มีกี่ตัว ใครถืออะไร

```
soc-core-worker ──SPLUNK_MCP_TOKEN──────► Splunk MCP Server app ──► Splunk
                ──THREATQ_TOKEN/OAuth───► ThreatQ REST API      (เรียกตรง)
                ──CONFLUENCE_API_TOKEN──► Confluence REST API   (เรียกตรง)
                ──AI_SERVICE_AUTH_TOKEN─► soc-ai

FortiSOAR ──X-API-Key──► soc-core-api ──JWT_SECRET_KEY (เซ็น session)

export_catalog (CI job) ──SPLUNK_TOKEN──► Splunk REST API
```

แบ่งเป็น 2 กลุ่มที่สับสนกันบ่อย:

| กลุ่ม | ทำหน้าที่ | ใครออกให้ |
| --- | --- | --- |
| `JWT_SECRET_KEY`, `AI_SERVICE_AUTH_TOKEN`, รหัส DB | คุมว่า**ใครเข้าระบบของเราได้** | สุ่มเอง |
| `SPLUNK_MCP_TOKEN`, `SPLUNK_TOKEN`, `THREATQ_*`, `CONFLUENCE_*` | ให้ **Backend เข้าระบบปลายทาง** | ระบบปลายทางออกให้ |

ค่าที่ต้องสุ่มเอง สุ่มจากเครื่องตัวเองแล้ววางลงหน้า Variables:

```bash
openssl rand -hex 32
```

ค่า hex ผ่านเงื่อนไขของ Masked variable ใน GitLab (ยาวอย่างน้อย 8 ตัว ไม่มีช่องว่าง)

---

## 1. Token ที่สุ่มเอง

### `JWT_SECRET_KEY`

กุญแจที่ NestJS ใช้เซ็น session token ของผู้ใช้ หลุดเมื่อไหร่ = ใครก็ปลอมเป็น admin ได้

> ⚠️ **ต้องตั้ง** ถ้าไม่ตั้ง deploy จะใช้ค่าตัวอย่างใน `.env.example` ซึ่งอยู่ใน repo
> ระบบทำงานปกติและไม่มีอะไรเตือน

เปลี่ยนค่านี้ = **session ที่ล็อกอินอยู่หลุดหมด** ทุกคนต้องล็อกอินใหม่

### `AI_SERVICE_AUTH_TOKEN` — สำหรับ `soc-ai`

ตั้งเป็น **group variable ตัวเดียว** ที่กลุ่มของ project ไม่ใช่แยกใน Backend กับ AI-Service
สองค่าที่ต้องตรงกันทุกไบต์แต่เก็บสองที่ คือสองค่าที่จะไม่ตรงกันสักวัน แล้วอาการคือ 401 ที่ไม่มีอะไรบอกว่าทำไม

`soc-ai` ไม่ยอมขึ้นถ้าไม่มี และทุก route ยกเว้น `/health` ต้องใช้ ทั้งการรัน agent และการเขียน
playbook index ไม่มี token = อะไรก็ตามใน `soc-network` สั่ง agent หรือแก้ index ได้

### รหัส DB

deploy เลือก DB จาก `PROD_POSTGRES_PASSWORD` ([setup.md ข้อ 3](setup.md)) และประกอบ
`CORE_DATABASE_URL` เองทั้งสองแบบ (encode อักขระพิเศษในรหัสให้แล้ว) ไม่ต้องตั้ง `CORE_DATABASE_URL`

| variable | ใช้กับ | หมายเหตุ |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | test DB (`soc-test-db`) | สุ่มเอง Postgres ตั้งรหัสเฉพาะตอนสร้าง volume ครั้งแรก เปลี่ยน variable ทีหลังแล้ว deploy จะต่อไม่ติด (`P1000 Authentication failed`) |
| `PROD_POSTGRES_PASSWORD` | `soc-db` ของ production | รหัสที่ stack FastAPI เดิมใช้อยู่ ขอจากผู้ดูแลระบบเดิม ไม่ใช่ค่าที่สุ่มใหม่ |
| `PROD_POSTGRES_USER`, `PROD_POSTGRES_DB` | `soc-db` | default `socai` ทั้งคู่ |

### `DEFAULT_ADMIN_*`

**สงวนไว้ — ไม่มีอะไรอ่านค่าเหล่านี้** seed สร้างแค่ roles ห้ามโค้ด, script หรือ CI ใช้ค่านี้สร้าง
หรือ login user ดู [setup.md ข้อ 5](setup.md)

---

## 2. Splunk

### `SPLUNK_MCP_TOKEN` — stage 2

Backend คุยกับ **Splunk MCP Server app** บน search head โดยตรง token ตัวนี้**ออกจากในแอป
Splunk MCP Server** (encrypted token ใช้ได้กับ MCP เท่านั้น แสดงครั้งเดียว) ให้ service account
ที่มี role ค้นได้อย่างเดียว + `mcp_tool_execute` ขั้นตอนครบ (แอปที่ต้องติดตั้ง, role, network,
CA, การตรวจ) อยู่ที่ [splunk-mcp.md](splunk-mcp.md)

```bash
SPLUNK_MCP_URL=https://<search-head>:8089/services/mcp
SPLUNK_MCP_TOKEN=<encrypted token>
NODE_EXTRA_CA_CERTS=/app/certs/<ca>.pem    # ถ้า 8089 ใช้ cert ภายใน: commit ไฟล์ไว้ใน certs/
```

### `SPLUNK_TOKEN` — สำหรับ job `export_catalog`

token **ธรรมดา** (ไม่ใช่ encrypted token ของ MCP) ของ service account เดียวกัน ใช้เฉพาะตอนกด
`export_catalog` เพื่อดึง catalogue ([splunk-catalog.md](splunk-catalog.md)) ตั้งคู่กับ `SPLUNK_URL`
ไม่ได้ถูกเขียนลง `.env` ของ service ใด

ออกที่ Splunk Web:

1. **Settings → Tokens**
2. ถ้ายังปิดอยู่ กด **Enable Token Authentication**
3. **New Token** → เลือก User เป็น service account, ใส่ Audience (เช่น `soc-catalog`), ตั้งวันหมดอายุ
4. **คัดลอกทันที — Splunk แสดงให้ดูครั้งเดียว**

### ⚠️ สิทธิ์ของ token — ข้อสำคัญที่สุดในเอกสารนี้

**อย่าใช้ token ของ admin**

SPL ไม่ใช่ภาษาอ่านอย่างเดียว — `| delete`, `| collect`, `| outputlookup`, `| script`
เขียนหรือลบข้อมูลได้ และ alert text ที่ขับ model เป็นสิ่งที่ผู้โจมตีแต่งได้

token ต้องผูกกับ role ที่:
- ค้นได้อย่างเดียว
- เข้าได้เฉพาะ index ที่ต้องใช้จริง (`srchIndexesAllowed`) Backend ไม่จำกัด index เอง
- **ไม่มี capability `delete_by_keyword`, `run_collect`, `run_mcollect`, `run_dump`, `run_sendalert`, `output_file`, `run_custom_command`** (ชื่อตาม [authorize.conf](https://help.splunk.com/en/data-management/splunk-enterprise-admin-manual/10.4/configuration-file-reference/10.4.0-configuration-file-reference/authorize.conf) — ไม่มี capability ชื่อ `run_script`)

SPL ที่ Text-to-SPL เขียนถูกตรวจโดย [`spl.check_readonly`](../../MCP-Server/Splunk/spl.py) ใน connector
ก่อนส่งรัน และ Splunk MCP Server มี guardrail ของตัวเอง แต่ defence in depth ต้องมีหลายชั้น
ชั้น role ของ token คือชั้นที่ขาดไม่ได้

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
> Reference v5.12 ถ้าไม่ตรงกับ deployment ปรับได้ที่ CI variable `THREATQ_TOKEN_PATH`, `THREATQ_SEARCH_PATH`

### สิทธิ์ของ account

ใช้ service account ที่**อ่าน indicator ได้อย่างเดียว** Backend ไม่เขียนอะไรกลับ ThreatQ

---

## 3.1 Confluence

Backend (worker) อ่านทุกหน้าใน space playbook ตรงจาก REST API ทุก `PLAYBOOK_SYNC_MINUTES`

**Cloud** (`*.atlassian.net`): ใช้ API v2 เองอัตโนมัติ และออกเน็ตผ่าน proxy ของ office ตัวเดียวกับที่ใช้ build
(`BUILD_PROXY`) deploy ใส่ให้เอง ไม่ต้องตั้ง `CONFLUENCE_PROXY`

```bash
CONFLUENCE_BASE_URL=https://your-org.atlassian.net/wiki/spaces/SOC/overview   # URL ของ space จาก browser ได้เลย
# หรือแยกเป็นสองตัว:
#   CONFLUENCE_BASE_URL=https://your-org.atlassian.net/wiki
#   CONFLUENCE_SPACE_KEY=SOC
CONFLUENCE_EMAIL=<อีเมล service account>                  # basic auth คู่กับ API token
CONFLUENCE_API_TOKEN=<API token จาก id.atlassian.com → Security → API tokens>
```

`CONFLUENCE_BASE_URL` ใส่ URL ที่ copy จาก browser ได้เลย ระบบแยกที่อยู่ของ Confluence กับ space key ให้เอง
(space key ใน URL มาก่อน `CONFLUENCE_SPACE_KEY`) และ URL บอกว่าจะอ่านอะไร:

| URL | อ่าน |
| --- | --- |
| `.../wiki/spaces/CMS/overview` | ทุกหน้าใน space |
| `.../wiki/spaces/CMS/pages/123456/Use+Case+Category` | หน้านั้นและหน้าย่อยทุกระดับใต้มัน (เช่น use case ทั้งหมด ไม่รวม Knowledge Base) |
| `.../wiki/spaces/CMS/folder/456` | ทุกหน้าใน folder นั้น |

หน้าที่ `soc-ai` ใช้เป็น playbook ต้องมีตาราง Page Properties ที่มีแถว `Use Case` หรือ `Alert Name` หน้าที่ไม่มี
(เช่นหน้าสารบัญ) ถูกข้ามเอง
ถ้าใส่แค่ที่อยู่ของ Confluence ต้องตั้ง `CONFLUENCE_SPACE_KEY` คือส่วนหลัง `/spaces/` ใน URL ของ space
(หรือ Space settings → Space details → Key)

proxy ใช้เฉพาะการเรียก Confluence ไม่มีผลกับ `soc-ai`, Splunk หรือ ThreatQ ถ้าต้องการ proxy ตัวอื่น ตั้ง CI variable
`CONFLUENCE_PROXY` เอง ตั้งเป็นค่าว่างคือไม่ใช้ proxy

**Server / Data Center** ภายในบริษัท: ใช้ API v1 ต่อตรง ไม่ต้องตั้ง proxy

```bash
CONFLUENCE_BASE_URL=https://confluence.corp
CONFLUENCE_SPACE_KEY=SOC
CONFLUENCE_API_TOKEN=<personal access token>   # ไม่ต้องตั้ง EMAIL: ส่งเป็น bearer
```

ใช้ account ที่เห็นเฉพาะ space playbook และอ่านได้อย่างเดียว ตรวจว่าใช้ได้ด้วย job `check_confluence`
(รันเองหลัง deploy บน `main`): บอกจำนวนหน้าที่อ่านได้ หรือบอกว่าติดที่ DNS, firewall, proxy, certificate
หรือ 401/403/404 และแสดงผล sync ล่าสุดของ worker

---

## 4. API Key สำหรับ FortiSOAR

ตัวนี้ไม่ได้เป็น CI variable — ออกจากในระบบ ต้องมี user admin ของ dashboard ก่อน ([setup.md ข้อ 5](setup.md))

### ทาง Dashboard

`http://10.40.35.18:3002` → login → **API Keys** → Create → คัดลอกค่า (แสดงครั้งเดียว)

### ทาง API

```bash
API=http://10.40.35.18:8082

# 1. login เอา JWT
JWT=$(curl -s -X POST $API/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<admin>","password":"<รหัส>"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

# 2. ออก API key
curl -s -X POST $API/admin/api-keys \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"name":"fortisoar-prod"}'
```

เอาค่าที่ได้ไปใส่ใน FortiSOAR playbook เป็น header `X-API-Key`

---

## 5. เปลี่ยน token / เพิกถอน

แก้ CI variable แล้วรัน **CI/CD → Pipelines → Run pipeline** บน `main` deploy จะเขียน `.env` ใหม่
และสร้าง container ใหม่ด้วยค่านั้น

| token | ขั้นตอน |
| --- | --- |
| `SPLUNK_MCP_TOKEN` | ออกใหม่ในแอป Splunk MCP Server → แก้ CI variable → Run pipeline (หลุด: แอปมีปุ่ม **Invalidate Keys** เพิกถอน MCP token ทั้งหมด) |
| `SPLUNK_TOKEN` | ลบ token เดิมใน Splunk → ออกใหม่ → แก้ CI variable (ใช้แค่ `export_catalog` ไม่ต้อง deploy) |
| ThreatQ / Confluence | เปลี่ยนรหัส service account หรือเพิกถอน token → แก้ CI variable → Run pipeline |
| API Key ของ SOAR | หน้า API Keys → Revoke (มีผลทันที) แล้วออกใหม่ |
| `JWT_SECRET_KEY` | แก้ CI variable → Run pipeline → **ทุก session หลุด** |
| `AI_SERVICE_AUTH_TOKEN` | แก้ group variable → Run pipeline ของ AI-Service แล้วตามด้วย Backend ระหว่างนั้นการรัน agent จะได้ 401 |
| `POSTGRES_PASSWORD` | ห้ามเปลี่ยน test DB จำรหัสแรกไว้ |

---

## ⚠️ ข้อควรรู้เรื่องการแจก secret

`docker-compose.yml` ใช้ `env_file: .env` กับทั้ง `soc-core-api` และ `soc-core-worker` แปลว่า API
ซึ่งเป็นตัวที่เปิด port ออกนอกเครื่อง ถือ token ของ Splunk, ThreatQ และ Confluence อยู่ด้วย
ทั้งที่ worker เป็นคนเดียวที่ใช้ ใครได้ shell ใน container ของ API ก็อ่านได้หมด

ทางแก้คือเลิกใช้ `env_file` แล้วระบุทีละตัวว่า service ไหนต้องรู้อะไร ยังไม่ได้ทำ — บันทึกไว้เป็น
งานค้างใน [`restructure.md`](restructure.md)
