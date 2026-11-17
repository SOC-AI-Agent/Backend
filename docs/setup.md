# Setup — production

ขึ้นระบบบนเครื่อง production (`10.40.35.18`) ตั้งแต่ศูนย์จนวิเคราะห์ alert ได้จริง

ไม่มีใครเข้า shell ของเครื่องนี้ได้ ทุกอย่างทำผ่าน GitLab: ตั้งค่าใน **Settings → CI/CD → Variables**
ของแต่ละ project แล้ว deploy ด้วย pipeline บน branch `main` ถ้าต้องดูอะไรบนเครื่อง ให้ใช้ job
ตรวจใน pipeline (หัวข้อ 2)

ถ้าต้องการรายละเอียดของ token แต่ละตัว: [tokens.md](tokens.md)
ถ้าตั้งเสร็จแล้วแต่ผลค้น Splunk ดูผิด: [testing.md](testing.md)

---

## ภาพรวม

ระบบมี 4 repo แต่ละ repo deploy ตัวเองด้วย job `deploy_production` ซึ่งรันทุกครั้งที่ push ขึ้น `main`
บน runner tag `llm` ซึ่งติดตั้งอยู่บนเครื่อง production เอง job จึงสั่ง Docker ของเครื่องนั้นได้ตรงๆ
ทุก job ออกเน็ตผ่าน proxy ของ office (`BUILD_PROXY`, ค่า default ตั้งไว้ใน `.gitlab-ci.yml` แล้ว)

| repo | container | port บนเครื่อง | หน้าที่ |
| --- | --- | --- | --- |
| **Agent-Server** | `dall-m-*` | 7100 (admin UI), 8001 (API), 8080 (llama.cpp) | agent platform และ model (Qwen2.5-7B บน llama.cpp) network แยกของตัวเอง |
| **AI-Service** | `soc-ai` | ไม่เปิด port | ประตูจาก Backend ไป Agent-Server และ index ของ playbook |
| **Backend** (repo นี้) | `soc-core-api`, `soc-core-worker`, `soc-core-redis`, `soc-test-db` | 8082 | API, คิวงาน, ฐานข้อมูล |
| **Frontend** | `soc-dashboard` | 3002 | dashboard ของ analyst ส่ง `/auth`, `/v1`, `/admin`, `/docs` ต่อไปที่ `soc-core-api` |

Backend, AI-Service และ Frontend คุยกันใน Docker network `soc-network` ด้วยชื่อ container
`soc-ai` ไปหา Agent-Server ทาง `host.docker.internal:8001`

บนเครื่องเดียวกันยังมี stack FastAPI ชุดเดิม (`soc-ai-ops`: `soc-db`, `soc-redis`, `soc-backend` :8000,
`soc-frontend` :3000 และชุด dev :8081, :3001) port ของระบบใหม่จึงตั้งไม่ให้ชนกับชุดนั้น

### ที่อยู่ของแต่ละหน้า

| | |
| --- | --- |
| Dashboard | `http://10.40.35.18:3002` |
| Backend API | `http://10.40.35.18:8082` (Swagger: `/docs`, สถานะ: `/health`) |
| Agent-Server admin UI | `http://10.40.35.18:7100` |
| Agent-Server API | `http://10.40.35.18:8001` (Swagger: `/docs`) |
| AI-Service | `http://soc-ai:8100` เรียกได้จากใน `soc-network` เท่านั้น ต้องมี `AI_SERVICE_AUTH_TOKEN` |

ที่อยู่จริงดูได้จาก step **Address** ท้าย `deploy_production` ของแต่ละ repo ซึ่งพิมพ์ IP และ port
แล้วลองเรียกจากเครื่องเองด้วย ถ้า step นั้นบอกว่า `answers` แต่ browser เปิดไม่ได้ (timeout)
แปลว่า firewall ของเครื่อง (firewalld) กั้นอยู่ job `inspect_ports` พิมพ์ rule ที่ใช้อยู่ให้ดู
การเปิด port ต้องให้ผู้ดูแลเครื่องทำ

---

## 1. ลำดับ deploy

| ลำดับ | repo | ดูอะไรใน log ของ deploy |
| --- | --- | --- |
| 1 | Agent-Server | step 1 ครั้งแรกโหลด model ราว 35 นาที (พิมพ์ขนาดทุกนาที), step 3 สร้าง admin, step 5 ที่อยู่ของ admin UI |
| 2 | AI-Service | step Address: `Agent-Server ... answers` |
| 3 | Backend | step 2 บอกว่าใช้ DB ตัวไหน, step 6 `answers {"status":"ok",...,"ai_service":"up"}` แล้ว `check_splunk` รันต่อ |
| 4 | Frontend | dashboard ที่ port 3002 |

ลำดับอื่นก็ใช้ได้ (`soc-network` ถูกสร้างโดย deploy ตัวแรกที่รัน) แต่ลำดับนี้ทำให้การตรวจท้าย
deploy ของแต่ละตัวเจอตัวที่มันต้องเรียกพร้อมแล้ว

---

## 2. CI variables

ตั้งที่ **Settings → CI/CD → Variables** ของแต่ละ project ค่าที่เป็นความลับให้ติ๊ก **Protected** และ
**Masked** ตัวแปรแบบ Protected จะเห็นเฉพาะ job บน branch ที่ protected ดังนั้น `main` ต้องเป็น
protected branch และ environment scope ต้องเป็น All หรือ `production`

deploy ของ Backend สร้าง `.env` จาก `.env.example` โดยแทนทุก key ที่มี CI variable ชื่อเดียวกัน
**key ไหนใน `.env.example` ก็ตั้งเป็น CI variable ได้** (เช่น `SPLUNK_LOOKUP_MODE`, `LLM_SUGGEST_AGENT`)
ยกเว้น `CORE_DATABASE_URL`, `REDIS_URL`, `REDIS_HOST` ที่ deploy เขียนเอง `.env` ไม่ถูกพิมพ์ใน log
และไม่ถูกเก็บเป็น artifact

### Backend

| ตัวแปร | ต้องตั้งไหม | ใช้ทำอะไร |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | ต้อง ระหว่างที่ยังไม่มี `PROD_POSTGRES_PASSWORD` | รหัสของ test DB (`soc-test-db`) DB ถูกสร้างด้วยรหัสนี้ใน deploy ครั้งแรก แล้วจำรหัสนั้นไว้ อย่าเปลี่ยนทีหลัง |
| `PROD_POSTGRES_PASSWORD` | เมื่อพร้อมใช้ DB จริง | ตั้งแล้ว deploy ใช้ `soc-db` ของ production แทน (หัวข้อ 3) |
| `PROD_POSTGRES_USER`, `PROD_POSTGRES_DB` | ไม่ต้อง (default `socai`) | user และชื่อ DB ของ `soc-db` |
| `JWT_SECRET_KEY` | **ต้อง** | กุญแจเซ็น session ถ้าไม่ตั้ง จะได้ค่าตัวอย่างใน `.env.example` ซึ่งใครอ่าน repo ก็ปลอม session ได้ และ deploy ไม่เตือน |
| `AI_SERVICE_AUTH_TOKEN` | **ต้อง** | ตั้งเป็น group variable ตัวเดียว ใช้ร่วมกับ AI-Service |
| `SPLUNK_MCP_URL`, `SPLUNK_MCP_TOKEN` (+ `NODE_EXTRA_CA_CERTS` เมื่อ cert ของ 8089 ไม่ได้ออกโดย CA สาธารณะ) | สำหรับ stage 2 | [splunk-mcp.md](splunk-mcp.md) ค่า default ของ `SPLUNK_MCP_URL` ชี้ไปที่ตัวที่ไม่มีบน production ถ้ายังไม่พร้อม ให้ตั้ง `SPLUNK_LOOKUP_MODE=off` |
| `THREATQ_*` | สำหรับ ThreatQ | [tokens.md ข้อ 3](tokens.md) ถ้าไม่ตั้ง summary จะบอกว่า ThreatQ NOT CHECKED |
| `MISP_BASE_URL`, `MISP_API_KEY` | ใช้ MISP แทน ThreatQ | ตั้งครบทั้งสองตัวแล้วจะใช้ MISP แทน ThreatQ รัน MISP พร้อม IOC ของ lab ได้ที่ [MCP-Server/external/misp](../../MCP-Server/external/misp/README.md) โดย `setup.py --write-env` เขียนค่าให้เอง |
| `CONFLUENCE_*` | สำหรับ playbook | [tokens.md ข้อ 3.1](tokens.md) ถ้าไม่ตั้ง ทุก alert จะไม่มี playbook Cloud ออกผ่าน proxy ของ office ให้เอง |
| `SPLUNK_URL`, `SPLUNK_TOKEN`, `SSL_CERT_FILE` | สำหรับ `export_catalog` | [splunk-catalog.md](splunk-catalog.md) |
| `BACKEND_HOST_PORT` | ไม่ต้อง (default 8082) | port ของ API บนเครื่อง เปลี่ยนเฉพาะเมื่อ 8082 ถูกใช้ (`inspect_ports` บอก port ที่ว่าง) |
| `DEPLOY_HOST` | ไม่ต้อง | ชื่อหรือ IP ที่ step Address ใช้ แทน IP ที่หาเองจาก route ของเครื่อง |

### repo อื่น

| project | ตัวแปรที่ต้องตั้ง |
| --- | --- |
| Agent-Server | `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `JWT_SECRET`, `AGENT_ADMIN_PASSWORD`, `NEXT_PUBLIC_BASE_URL` (`http://10.40.35.18:8001`), `NEXT_PUBLIC_LLM_BASE_URL` (`http://10.40.35.18:8080`) ขาดตัวไหน deploy หยุดที่ step 0 พร้อมรายชื่อ |
| AI-Service | `AI_SERVICE_AUTH_TOKEN` (group variable ตัวเดียวกับ Backend) `LLM_SERVER_URL` ไม่ต้องตั้ง ค่า default `http://host.docker.internal:8001` ชี้ไปที่ Agent-Server บนเครื่องเดียวกันแล้ว |
| Frontend | ไม่มีตัวที่ต้องตั้ง (`FRONTEND_HOST_PORT` default 3002) |

model ของ Agent-Server ไม่ใช่ CI variable เลือกที่ `llamacpp/preload_models.py` ใน repo Agent-Server

---

## 3. Pipeline ของ Backend

| job | stage | รันเมื่อ | ทำอะไร |
| --- | --- | --- | --- |
| `build_image`, `code_test` | build, test | ทุก branch | build image, `tsc` |
| `inspect_db_schema` | inspect | อัตโนมัติบน `main` | โครงสร้าง DB ก่อน deploy (ตาราง, migration, drift) ไม่พิมพ์ข้อมูลหรือรหัส |
| `inspect_ports` | inspect | อัตโนมัติบน `main` | port ที่แต่ละ container ใช้ ใครถือ port ไหน และ firewall ของเครื่อง |
| `deploy_production` | deploy | อัตโนมัติบน `main` | step 0–6 ด้านล่าง |
| `check_splunk` | verify | อัตโนมัติหลัง deploy | ตรวจการต่อ Splunk ([splunk-mcp.md ข้อ 5](splunk-mcp.md#5-ตรวจว่าใช้ได้-job-check_splunk)) |
| `check_confluence` | verify | อัตโนมัติหลัง deploy | อ่าน space ของ playbook แบบเดียวกับที่ worker sync และแสดงผล sync ล่าสุด ([tokens.md ข้อ 3.1](tokens.md)) |
| `export_catalog` | verify | กด ▶ เอง | ดึง catalogue จาก Splunk ([splunk-catalog.md](splunk-catalog.md)) |

job ตรวจทั้งหมด (`inspect_*`, `check_splunk`, `export_catalog`) ตั้ง `allow_failure` ไว้ ถ้า fail
จะขึ้น ⚠ พร้อมเหตุผลใน log แต่ pipeline และ deploy ยังผ่าน บน protected branch อื่นที่ไม่ใช่ `main`
job เหล่านี้เป็นปุ่ม ▶

### ขั้นตอนของ `deploy_production`

| step | ทำอะไร | ถ้า fail |
| --- | --- | --- |
| 0. Host ports | เช็กว่า port ที่จะ publish ไม่ถูก container ของ stack อื่นถืออยู่ | บอกว่าใครถือ ให้ตั้ง `BACKEND_HOST_PORT` |
| 1. Build | build image ผ่าน proxy | |
| 2. Database and Redis | เลือก DB (ด้านล่าง) และขึ้น `soc-core-redis` | test DB: ยังไม่ได้ตั้ง `POSTGRES_PASSWORD` |
| 3. Backup, schema and roles | backup (เฉพาะ DB จริง), `scripts/migrate.sh`, seed roles | migration ไม่ผ่าน หรือ DB ไม่ตรงกับ `schema.prisma` deploy หยุดก่อน API ตัวใหม่ขึ้น |
| 4. Start | ขึ้น `soc-core-api` และ `soc-core-worker` | พิมพ์ log 50 บรรทัดท้าย |
| 5. Health | รอ `/health` จากใน container | |
| 6. Address | ถาม `/health` ผ่าน IP และ port ของเครื่อง แล้วตั้งลิงก์ environment ของ GitLab | port publish แล้วแต่เรียกจากที่อยู่นั้นไม่ได้ |
| 7. Splunk connection | จาก worker ตัวใหม่: ต่อ `SPLUNK_MCP_URL` แบบไม่ตรวจ cert (ไม่ส่ง token) แล้วแสดง cert ว่าใครออกและ worker เชื่อไหม ([splunk-mcp.md ข้อ 5](splunk-mcp.md#5-ตรวจว่าใช้ได้-job-check_splunk)) | ไม่ fail ไม่ว่าผลจะเป็นอะไร แค่รายงาน |
| 8. Confluence connection | จาก worker ตัวใหม่: ต่อ Confluence ผ่าน proxy และ CA เดียวกับที่ sync ใช้ โดยไม่ส่ง credential แล้วบอกว่าติดที่ DNS, proxy, certificate หรือ path ไหม (`check_confluence` ตรวจ credential และจำนวนหน้าต่อ) | ไม่ fail แค่รายงาน |

### DB ตัวไหน

CI variable `PROD_POSTGRES_PASSWORD` เป็นตัวเลือก:

- **ไม่มี**: test DB ของ Backend เอง (`soc-test-db`, volume `backend_test-postgres-data`) สร้างเปล่า
  ใน deploy ครั้งแรกด้วย `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` แล้วเก็บไว้ต่อ
  `soc-db` ของ production ไม่ถูกแตะเลย
- **มี**: `soc-db` ของ stack FastAPI เดิม พร้อมข้อมูลที่มีอยู่ deploy สั่ง start ถ้ามันหยุดอยู่,
  ต่อเข้า `soc-network`, **dump ลง volume `backend_db-backups` ก่อนทุกครั้ง** (เก็บ 10 ไฟล์ล่าสุด)
  แล้วจึง migrate ส่วน `soc-test-db` ถูกหยุด ข้อมูลในนั้นไม่ถูกย้ายมา

ลบ variable ทิ้งก็กลับไปใช้ test DB ได้ ยังไม่มี job สำหรับ restore backup คำสั่ง restore อยู่ใน
comment ของ step 3 ใน `.gitlab-ci.yml` ต้องทำเป็น job ก่อนใช้

migration ครั้งแรกบน `soc-db` จะ mark `0_init` (โครงสร้างเดิมของ FastAPI) ว่า apply แล้ว แล้วเพิ่มเฉพาะ
column ใหม่ ไม่ลบอะไร ([README](../README.md#schema-changes))

---

## 4. สร้าง agent ใน Agent-Server

deploy ของ Agent-Server สร้างตาราง, ลงทะเบียน model และสร้าง admin คนแรกให้แล้ว
(user `AGENT_ADMIN_USERNAME` default `admin` รหัส `AGENT_ADMIN_PASSWORD`) แต่**ไม่ได้สร้าง agent**

> ⚠️ Agent-Server เก็บรหัสเป็น plain text อย่าใช้รหัสที่ใช้ที่อื่น ถ้าเข้าไม่ได้ ใช้ job
> `check_admin_login` ใน pipeline ของ Agent-Server ดูว่ามี user อะไรบ้างและรหัสถูกไหม

Backend เรียก agent 3 ตัว **ถ้าขาดตัวไหน job จะ fail หรือได้ผลไม่ครบ** ทั้งหมดไม่มี tool และไม่ต่อ MCP server ตัวไหน:

| agent | ตั้งชื่อด้วย | ทำอะไร |
| --- | --- | --- |
| `soc-suggest` | `LLM_SUGGEST_AGENT` | อ่าน alert + ข้อมูลที่ Backend เตรียมไว้ (ThreatQ, playbook) เขียน suggestion — ขาดตัวนี้ job fail |
| `soc-requirements` | `LLM_REQUIREMENTS_AGENT` | อ่านเหมือนกัน (alert + ThreatQ + playbook) พร้อม suggestion แล้วเขียนว่าอยากถาม Splunk อะไร พร้อมรายละเอียดจาก alert ใต้แต่ละคำถาม — ขาดหรือพัง: ใช้แผนที่ Backend ได้จากตัวโค้ดแทน |
| `soc-conclude` | `LLM_CONCLUDE_AGENT` | หลังค้น Splunk เสร็จ อ่านผลค้นคู่กับ suggestion เขียนบทวิเคราะห์ — ขาดหรือพัง: ผลค้นยังอยู่ครบ ไม่มีบทวิเคราะห์ |
| `soc-spl-writer` (built-in ของ DALL-M ชื่อ fix, สร้างเองอัตโนมัติ ลบ/เปลี่ยนชื่อ/ปิดไม่ได้) | — | เขียน SPL ของแต่ละ requirement จาก prompt ที่ connector เตรียมให้ (`splunk_prompt`) แล้ว connector ตรวจ read-only และรันเอง — agent พัง หรือ SPL ถูกปฏิเสธ: connector เขียน SPL เองเหมือนเดิม. ไม่ใช้กับ search ของ playbook (filters/summarise) และ alert frequency |

การค้น Splunk ไม่ผ่าน agent: Backend ส่งแต่ละ requirement เป็นข้อความไป Text-to-SPL ของ Splunk
ผ่าน MCP (`saia_generate_spl`) ตรวจ SPL ที่ได้ แล้วสั่งรัน (`splunk_run_query`)

### สร้างที่หน้า admin

เปิด `http://10.40.35.18:7100` ล็อกอินด้วย admin ข้างบน แล้วสร้าง agent 3 ตัวตาม slug ในตาราง
Model เลือก `Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M` จาก dropdown (deploy ลงทะเบียนไว้ให้)
แล้วใส่ system prompt

หรือทาง API (ต้อง login เอา JWT ก่อน และต้องรู้ `owner_id`/`model_id` เป็น UUID):

```bash
AGENT=http://10.40.35.18:8001
TOKEN=$(curl -s -X POST $AGENT/restful/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<AGENT_ADMIN_PASSWORD>"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

curl -s -X POST $AGENT/restful/agents -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "slug":"soc-suggest","name":"soc-suggest","owner_id":"<user uuid>",
    "model_id":"<model uuid>","system_prompt":"<system prompt>"}'
```

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

Backend ไม่จำกัด index เอง index ที่ค้นได้คุมด้วย role ของ token ใน Splunk (`srchIndexesAllowed`)
ดู [splunk-mcp.md](splunk-mcp.md) หัวข้อ 2

---

## 5. User ของ dashboard

seed สร้างแค่ roles ไม่สร้าง user และไม่มีโค้ดหรือ CI job ไหนสร้าง user จาก environment
(`DEFAULT_ADMIN_*` ใน `.env.example` สงวนไว้ ไม่มีอะไรอ่าน)

- **DB จริง (`soc-db`)**: user เดิมของระบบ FastAPI ล็อกอินได้ด้วยรหัสเดิม (bcrypt ใช้ร่วมกันได้)
- **test DB**: ไม่มี user เลย และ**ยังไม่มี job สร้าง admin คนแรก** จึงล็อกอิน dashboard
  และออก API key ไม่ได้จนกว่าจะเพิ่ม job นั้น หรือย้ายไปใช้ DB จริง

user คนถัดไปให้ admin สร้างที่หน้า **Users** ของ dashboard

---

## 6. ตรวจว่าขึ้นครบ

| ดูที่ | ผลที่ต้องได้ |
| --- | --- |
| Agent-Server deploy step 5 | `API answers`, `llama.cpp answers`, `Admin UI answers` |
| หน้า **Resources** ของ admin UI Agent-Server | LLM พร้อม และ model ที่ใช้ตอบ |
| AI-Service deploy step Address | `answers on soc-network` และ `Agent-Server ... answers` |
| Backend deploy step 6 | `answers {"status":"ok",...,"ai_service":"up"}` |
| Backend `check_splunk` | ✓ (ถ้า ⚠ ดู log [splunk-mcp.md ข้อ 5](splunk-mcp.md#5-ตรวจว่าใช้ได้-job-check_splunk)) |
| Frontend | เปิด `http://10.40.35.18:3002` ได้ |

`soc-ai` **ไม่ยอมขึ้น**ถ้าไม่มี `AI_SERVICE_AUTH_TOKEN` (deploy ของ AI-Service fail พร้อม log)
ตั้งใจให้เป็นแบบนั้น ดีกว่าขึ้นมาแล้วเปิดให้ทุกอย่างใน `soc-network` สั่ง agent ได้ ส่วน Backend ขึ้นได้
แม้ยังไม่ได้ตั้ง Splunk, ThreatQ หรือ Confluence แต่ละ call ที่ต้องใช้จะ fail พร้อมข้อความที่บอกว่าขาดอะไร

### Playbook จาก Confluence

worker อ่าน playbook ทั้ง space จาก Confluence REST API ทุก `PLAYBOOK_SYNC_MINUTES` แล้วส่งให้
`soc-ai` ซึ่ง extract field, embed แล้วเก็บ vector ลง Qdrant (embed เฉพาะ field ที่ข้อความเปลี่ยน)
ส่วนตัว playbook เก็บเป็นไฟล์ JSON ใน volume `playbook-index` แต่ละ alert จะ match กับ index นั้น
(use case id → ชื่อตรง → สะกดใกล้ → ความหมาย) และจะไม่ match ไปหา playbook ที่ use case id ไม่ตรงกับ
alert ดูผลได้ที่ส่วน playbook ของ job แรก ถ้าขึ้นว่ายังไม่มีอะไร index แปลว่า `CONFLUENCE_*` ยังไม่ครบ
หรือ sync รอบแรกยังไม่เสร็จ

ดูสถานะและสั่ง sync ทันทีได้โดยไม่ต้องรอรอบถัดไป (เช่น หลังแก้ playbook ใน Confluence):

| ทางไหน | ทำอะไร |
| --- | --- |
| Dashboard → การ์ด **Playbook Index** | แสดงจำนวน playbook, vector ใน Qdrant, เวลาที่ index ล่าสุด และ `CONFLUENCE_*` ที่ยังขาด; admin กด **Sync from Confluence** ได้ |
| `GET /admin/playbooks` | สถานะเดียวกันเป็น JSON; `confluence.missing` บอกตัวแปรที่ยังว่างใน `Backend/.env` |
| `POST /admin/playbooks/sync` (admin) | อ่าน Confluence ทั้ง space แล้ว index/embed ทันที ตอบจำนวนหน้า, playbook, field ที่ embed; 400 ถ้า `CONFLUENCE_*` ไม่ครบ, 409 ถ้ามี sync ค้างอยู่, 502 ถ้า Confluence หรือ soc-ai fail (index เดิมยังอยู่) |

บน VPS (`deploy/vps-demo.sh`) ส่ง `CONFLUENCE_*` เป็น environment ตอนรันสคริปต์ได้ ค่าจะถูกเขียนลง
`Backend/.env` แม้ไฟล์มีอยู่แล้ว

playbook ที่ match ได้จะถูกส่งให้ model เป็นท่อนๆ ที่มี tag (`[PB:true]`, `[PB:false]`, `[PB:step 2]`)
พร้อมกฎว่าให้ตอบจาก playbook เท่านั้น และให้ cite tag ทุกครั้ง worker จะตรวจคำตอบ (verdict ต้อง cite
`[PB:true]`/`[PB:false]`, step ต้องมีจริง, ข้อความที่ quote ต้องอยู่ใน playbook) ถ้าไม่ผ่านจะถาม model ใหม่
1 ครั้ง (`LLM_GROUNDING_RETRY`) ผลตรวจเก็บไว้ที่ `evidence.grounding` ของ job

---

## 7. ยิง alert แรก

ออก API key ที่หน้า **API Keys** ของ dashboard (แสดงครั้งเดียว) หรือทาง API ([tokens.md ข้อ 4](tokens.md))
แล้วส่ง alert จากเครื่องที่เรียก `10.40.35.18:8082` ได้:

```bash
API=http://10.40.35.18:8082
KEY=<API key>

curl -s -X POST $API/v1/analyze -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{
    "alert_id":"FIRST-001","alert_name":"test",
    "raw_log":"srcip=10.1.100.11 dstip=45.83.122.9 action=\"blocked\""}'
```

ไม่มี field `prompt` — agent บน Agent-Server ถือ system prompt ของตัวเอง
playbook เก่าที่ยังส่งมาไม่ error เฉยๆ ถูกตัดทิ้งที่ validation pipe

ได้ `job_id` แล้ว poll:

```bash
curl -s $API/v1/results/<job_id> -H "X-API-Key: $KEY"
```

หรือเปิดดูที่หน้า job ใน dashboard

---

## ระบบภายนอก

### Splunk

Splunk อยู่นอก stack นี้ Backend (`soc-core-worker`) คุยกับ **Splunk MCP Server app** บน search head
ตรง ขั้นตอนทั้งหมด (ติดตั้งแอป, role, token, network, CA และการตรวจ) อยู่ใน [splunk-mcp.md](splunk-mcp.md)

```
SPLUNK_MCP_URL=https://<search-head>:8089/services/mcp
SPLUNK_MCP_TOKEN=<encrypted token จากแอป Splunk MCP Server>
NODE_EXTRA_CA_CERTS=/app/certs/<ca>.pem    # ถ้า 8089 ใช้ cert ภายใน: commit ไฟล์ไว้ใน certs/
```

ต่อได้แล้ว **ดึง catalog ก่อนใช้งาน** ไม่งั้น Text-to-SPL จะเดาชื่อ field ผิดแล้วรายงานว่า
"ไม่พบอะไร" อย่างมั่นใจ: [splunk-catalog.md](splunk-catalog.md)

### ThreatQ

Backend เรียก ThreatQ REST API ตรง (อ่านอย่างเดียว) ตั้งเป็น CI variable ของ project Backend:

```
THREATQ_BASE_URL=https://threatq.example.com
THREATQ_AUTH_MODE=oauth
THREATQ_CLIENT_ID=
THREATQ_EMAIL=
THREATQ_PASSWORD=
```

รายละเอียดและแบบ bearer token: [tokens.md ข้อ 3](tokens.md) ถ้าเว้น `THREATQ_BASE_URL` ว่าง
enrichment จะปิด และ summary จะบอกว่า ThreatQ NOT CHECKED แทนที่จะดูเหมือนว่าสะอาด

### Confluence

worker อ่าน space playbook ตรงจาก REST API: `CONFLUENCE_BASE_URL`, `CONFLUENCE_SPACE_KEY`,
`CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN` สำหรับ Cloud deploy ให้ worker ออกผ่าน proxy ของ office เอง
— [tokens.md ข้อ 3.1](tokens.md) ตรวจด้วย job `check_confluence`

ถ้า ThreatQ หรือ Confluence ใช้ cert ที่ออกโดย CA ภายใน ใช้ `NODE_EXTRA_CA_CERTS` ตัวเดียวกับ Splunk
(รวมหลาย CA ไว้ในไฟล์เดียวได้)

### FortiSOAR

playbook ยิง `POST http://10.40.35.18:8082/v1/analyze` พร้อม header `X-API-Key` แล้ว poll
`GET /v1/results/{job_id}` — [tokens.md ข้อ 4](tokens.md)

---

## ก่อนเปิดใช้จริง

| เรื่อง | ทำอะไร |
| --- | --- |
| รหัส admin ของ dashboard | เปลี่ยนที่หน้า Users |
| `JWT_SECRET_KEY` | ต้องเป็น CI variable ค่าสุ่ม ไม่ใช่ค่าใน `.env.example` |
| `SPLUNK_MCP_TOKEN` / `SPLUNK_TOKEN` | role **search-only** ไม่มี `delete_by_keyword`, `run_collect`, `run_mcollect`, `run_dump`, `run_sendalert`, `output_file`, `run_custom_command` — ดู [splunk-mcp.md](splunk-mcp.md) หัวข้อ 2 |
| ข้อมูล alert ที่ส่งไป Splunk AI Assistant | ให้ผู้รับผิดชอบเรื่องข้อมูลอนุมัติก่อนเปิด stage 2 ([splunk-mcp.md](splunk-mcp.md) หัวข้อภาพรวม) |
| ThreatQ / Confluence account | อ่านอย่างเดียว Confluence เห็นเฉพาะ space playbook |
| Agent-Server | API เรียก agent **ไม่มี auth** (ดู readme ของ Agent-Server หัวข้อ Known limitations) และ publish port 8001, 8080 (llama.cpp) และ 5497 (Postgres ของมัน) ไว้ทุก interface ต้องให้ firewall ปิดจากภายนอก ส่วน 7100 เปิดเฉพาะ admin |
| Firewall | เปิด 3002 และ 8082 ให้เฉพาะ IP ที่อนุญาต (SOAR, analyst) |
| `env_file: .env` | `soc-core-api` และ `soc-core-worker` ได้ `.env` ทั้งไฟล์ API จึงถือ token ของ ThreatQ, Confluence และ Splunk ด้วยทั้งที่ worker เป็นคนใช้ |

สองข้อหลังยังไม่ได้แก้ firewall ต้องให้ผู้ดูแลเครื่องทำ ส่วน `env_file` บันทึกไว้ใน
[restructure.md](restructure.md)
