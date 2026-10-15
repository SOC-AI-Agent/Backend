# Splunk ผ่าน MCP

Stage 2 ถาม Splunk ผ่าน MCP โดยมี Backend (`soc-core-worker`) เป็น **MCP client** ตัวเดียว
ขั้นตอนคือส่งแต่ละ requirement เป็น**ข้อความ**ให้ Text-to-SPL ของ Splunk เขียน SPL, ตรวจ SPL ที่ได้,
แล้วสั่งให้ Splunk รัน ฝั่งเราไม่มี model ตัวไหนเขียน SPL

เอกสารนี้คือขั้นตอนต่อ Backend บน production เข้ากับ **Splunk MCP Server app** บน search head ของบริษัท

| ขั้น | ทำที่ | |
| --- | --- | --- |
| 1. ติดตั้ง Splunk MCP Server กับ Splunk AI Assistant และเปิด Agent Mode | Splunk | **activation code ใช้เวลาได้ถึง 3 วันทำการ ควรเริ่มก่อนขั้นอื่น** |
| 2. service account, role และ token | Splunk | |
| 3. network และ certificate | เครื่อง production, Splunk | |
| 4. CI variables | GitLab project Backend | |
| 5. ตรวจว่าใช้ได้ | job `check_splunk` | |

---

## ภาพรวม

```
requirement จาก stage 1 (ข้อความ + รายละเอียดจาก alert; index, sourcetype, ชื่อ field จาก catalogue; ช่วงเวลาของ alert)
   │
soc-core-worker ──MCP── saia_generate_spl ──► SPL           (Text-to-SPL: Splunk AI Assistant)
   │  spl-guard: อ่านอย่างเดียว, ใส่ช่วงเวลาของ alert
   └──────────MCP── splunk_run_query ──► แถว ──► คำตอบบน job (พร้อม SPL ที่รัน) ──► soc-conclude
```

**ใครเป็นอะไร** Backend (`soc-core-worker`) คือ **MCP client** ที่เรียก tool ทั้งสองตัวเอง ส่วน
Splunk MCP Server app คือ **MCP server** ที่เก็บ tool ไว้ และ Text-to-SPL ทำงานในฝั่ง Splunk
(Splunk AI Assistant) ไม่ใช่ฝั่งเรา `saia_generate_spl` มีหน้าที่แค่*เขียน* SPL แล้วส่งกลับมา ไม่ได้รันเอง
การรันเป็น call ที่สอง SPL จึงต้องผ่าน Backend ก่อน และ `spl-guard` ตรวจตรงนั้นก่อนสั่งรัน
ไม่มีอะไรคั่นระหว่าง Backend กับ Splunk

| | ค่า |
| --- | --- |
| MCP server | Splunk MCP Server app บน search head |
| `SPLUNK_MCP_URL` | `https://<search-head>:8089/services/mcp` |
| `SPLUNK_MCP_TOKEN` | encrypted token จากแอป (CI variable) |
| `NODE_EXTRA_CA_CERTS` | `/app/certs/<ca>.pem` CA ของบริษัท (ดูหัวข้อ 3.2) |
| Text-to-SPL | Splunk AI Assistant (cloud-connected, Agent Mode) |

### สิ่งที่ส่งให้ Text-to-SPL

ตัวอย่างข้อความที่ส่งไป `saia_generate_spl` สำหรับ requirement หนึ่งข้อ
(สร้างโดย `promptFor` ใน [splunk-mcp.service.ts](../src/modules/enrichment/splunk-mcp.service.ts)):

```
What else did 45.83.122.9 touch in the 24 hours around the alert.
Details from the alert:
- source: 45.83.122.9
- device: FGT-01
- type: event
- user_agent: FortiClient/7.2
Search index=main sourcetype=fortigate
Field names in this data: 45.83.122.9 is in srcip or dstip; FGT-01 is in devname. Use these field names.
Time range: earliest=1790834543 latest=1790924543
```

คำถามและรายละเอียดมาจาก agent `soc-requirements` ซึ่งอ่าน alert, ThreatQ และ playbook
รายละเอียดที่ค่าไม่ปรากฏในสิ่งที่ agent อ่านจะถูกตัดทิ้ง ส่วน index, sourcetype และชื่อ field มาจาก
catalogue ([splunk-catalog.md](splunk-catalog.md)) และช่วงเวลามาจากเวลาของ alert

> ⚠️ **prompt มีข้อมูลจาก alert ติดไปด้วย** (IP, user, host) Splunk AI Assistant บน Splunk Enterprise
> ประมวลผลบน Splunk Cloud [5] และ Agent Mode ซึ่ง `saia_generate_spl` ต้องใช้ บังคับให้ยอมให้ Splunk
> เลือก model เอง ซึ่ง "may include models hosted outside Splunk Cloud Platform" [4]
> **ต้องให้ผู้รับผิดชอบเรื่องการจัดการข้อมูลอนุมัติก่อน**เปิด stage 2 กับข้อมูลจริง

---

## 1. ติดตั้งแอปบน Splunk

ต้องติดตั้งสองแอปบน search head:

| แอป | Splunkbase | ใช้ทำอะไร |
| --- | --- | --- |
| **Splunk MCP Server** | [7931][sb-mcp] เวอร์ชัน 2.0.0 (3 ก.ย. 2026) | เปิด endpoint `/services/mcp` และให้ tool `splunk_run_query` |
| **Splunk AI Assistant** (ชื่อเดิม AI Assistant for SPL) | [7245][sb-saia] เวอร์ชัน 2.3.3 (22 ก.ย. 2026) | Text-to-SPL ถ้าไม่มีแอปนี้ MCP server จะ**ไม่มี `saia_generate_spl`** |

ทั้งสองแอปรองรับ Splunk Enterprise และ Splunk Cloud เวอร์ชัน 9.3 ถึง 10.6 แต่ tool กลุ่ม `saia_*`
จะโผล่ก็ต่อเมื่อเปิด **Agent Mode** แล้ว และ Agent Mode ต้องใช้ **10.1 ขึ้นไป** [3]

ก่อนเริ่มต้องมี:

- search head ที่ออก HTTPS 443 ไป `*.scs.splunk.com` ได้ (จะผ่าน proxy ก็ได้ ตั้งตอน onboarding) [5]
- account ของ splunk.com สำหรับดาวน์โหลดแอปจาก Splunkbase
- อีเมลที่ทำงาน สำหรับรับ activation code

### 1.1 ติดตั้งผ่าน Splunk Web

1. เปิด Splunk Web ของ search head ด้วย account admin แล้วไปที่ **Apps → Find More Apps**
2. ค้น `MCP Server` → **Install** → ล็อกอินด้วย account ของ splunk.com → ยอมรับ license
3. ทำแบบเดียวกันกับ `Splunk AI Assistant`
4. ถ้า Splunk ขอให้ restart ให้กด restart (หรือไปที่ **Settings → Server controls → Restart Splunk**)
5. เช็กที่ **Apps → Manage Apps** ว่าทั้งสองแอปขึ้นสถานะ Enabled

ถ้า search head ออกเน็ตไป Splunkbase ไม่ได้ ดาวน์โหลดไฟล์ `.tgz` ของทั้งสองแอปจาก Splunkbase
แล้วติดตั้งที่ **Apps → Manage Apps → Install app from file** ทีละไฟล์

### 1.2 เปิดใช้ Splunk AI Assistant (cloud-connected)

ติดตั้งแอปแล้วยังใช้งานไม่ได้จนกว่าจะ onboard เสร็จ ระหว่างนั้น Splunk ต้องออก activation code ให้ก่อน [2]

1. เปิดแอป Splunk AI Assistant → **Continue to app setup page** → **Begin setup**
2. **Create tenant code**: กรอกชื่อบริษัท, **region ของ Splunk Cloud**, อีเมลที่ทำงาน และชื่อ tenant
   > ⚠️ region เปลี่ยนทีหลังไม่ได้ และ Agent Mode ใช้ได้เฉพาะใน AWS region ที่รองรับ
   > ให้เลือก region ที่อยู่ในรายการของหน้า [Agent Mode][saia-agent]
3. คัดลอก tenant code ไปส่งที่ <https://www.splunk.com/en_us/form/tenantcodesubmit.html>
4. รอ activation code ทางอีเมล (Splunk ระบุว่าใช้เวลาได้ถึง 3 วันทำการ)
5. กลับมาที่แอป → หน้า **Connect to cloud** → ใส่ activation code → กด **Connect to cloud**
6. ไปที่ **Settings → General** ของแอป แล้วทำสองอย่าง [4]
   - opt-in ตัวเลือก **"Let Splunk determine the best model to deliver the outcome based on your prompt
     (this may include models hosted outside Splunk Cloud Platform)"** (Agent Mode บังคับให้เลือกข้อนี้ ดูคำเตือนในหัวข้อภาพรวม)
   - เปิด **Enable Agent Mode**

ระหว่าง onboarding ให้ดูด้วยว่าเลือกแชร์ข้อมูลระดับไหน (minimal / training / context data) [2]
ข้อมูล alert ไม่ควรถูกส่งไปใช้ training

ถ้าไม่เปิด Agent Mode จะไม่มี `saia_generate_spl` และทุก lookup จะ fail ด้วยข้อความ
`Splunk's MCP server has no saia_generate_spl`

---

## 2. Service account, role และ token

สร้าง **service account** ให้ Backend ใช้โดยเฉพาะ (ไม่ใช้ account ของคน) และสร้าง role ให้มันเอง
(**Settings → Roles → New Role** แล้วตามด้วย **Settings → Users → New User**)

- **ค้นได้อย่างเดียว** และเข้าได้เฉพาะ index ที่ SOC อ่านได้ (`srchIndexesAllowed`) [9]
  **นี่คือการคุม index เพียงชั้นเดียว** เพราะ Backend ไม่จำกัด index เอง search ที่ Text-to-SPL
  เขียนจะอ่านได้ทุก index ที่ role นี้อ่านได้ ให้ตั้ง `srchIndexesDefault` เป็นชุดเดียวกันด้วย
  เพราะ search ที่ไม่ระบุ index จะไปอ่านจากชุดนี้
- **ไม่มี** capability สำหรับเขียนหรือ admin โดยเฉพาะ `delete_by_keyword` (`delete`), `run_collect` (`collect`),
  `run_mcollect` (`mcollect`, `meventcollect`), `run_dump` (`dump`), `run_sendalert` (`sendalert`),
  `output_file` (`outputcsv`, `outputlookup`) และ `run_custom_command` [9], [12] และตั้ง search quota ไว้ต่ำ
- มี **`mcp_tool_execute`** เพื่อให้ role นี้เรียก MCP tool ได้ [1]
- **ให้ใช้ได้แค่สอง tool** ในแท็บ **Tools** ของแอป MCP Server ซึ่งใช้ map role กับ tool [1]
  ให้ role นี้ได้แค่ `saia_generate_spl` กับ `splunk_run_query` ไม่ต้องให้ user list, KV store
  หรือ saved search

แล้วออก token:

- token authentication ต้องเปิดอยู่ (**Settings → Tokens → Enable Token Authentication** ไม่ต้อง restart) [13]
- ออก token ใน**แอป Splunk MCP Server** → generate encrypted token ให้ service account → ตั้งวันหมดอายุ
  → **คัดลอกทันที เพราะแสดงแค่ครั้งเดียว** token แบบนี้ใช้กับ MCP ได้อย่างเดียว เอาไปเรียก REST API ตรงไม่ได้ [6]
- คนที่ออก token ให้ account อื่นต้องมี `edit_tokens_all` และ `mcp_tool_admin` (ถ้าออกให้ตัวเองใช้
  `edit_tokens_own` และ `mcp_tool_admin`) [6] ส่วน service account เองใช้แค่ `mcp_tool_execute`
- จดวันหมดอายุไว้ในปฏิทินของทีม เพราะเมื่อหมดอายุ ทุก lookup จะ fail ด้วย 401 ตอน connect
  หน้า job จะแสดงข้อความนี้ และ `check_splunk` หลัง deploy ถัดไปจะขึ้น ⚠
- ถ้า token หลุด หน้า settings ของแอปมีปุ่ม **Invalidate Keys** ที่ยกเลิก MCP token ทุกตัวพร้อมกัน [6]

เอา token ไปใส่ที่ CI variable `SPLUNK_MCP_TOKEN` ของ project Backend (Protected และ Masked) ห้าม commit

ถ้า tool ตอบว่าไม่มีสิทธิ์ตอนตรวจในหัวข้อ 5 ให้เพิ่ม capability ทีละตัวตามที่ข้อความบอก
แทนการ inherit role `user` หรือ `power` ทั้งก้อน

---

## 3. Network และ certificate

### 3.1 Network

- **เส้นทาง:** `soc-core-worker` บนเครื่อง `10.40.35.18` → search head **TCP 8089** worker เป็น container
  เดียวที่เรียก Splunk และเรียกตรง ไม่ผ่าน proxy ของ office ฝั่ง Splunk และ firewall ระหว่างทางจะเห็น
  IP ต้นทางเป็น `10.40.35.18` ต้องเปิดเส้นทางนี้ให้
- **DNS:** ชื่อใน `SPLUNK_MCP_URL` ต้อง resolve ได้จากใน container (container ใช้ DNS ของเครื่อง)
- **Splunk Cloud:** endpoint อยู่บน management port จึงต้องเพิ่ม egress IP ของเครื่อง production
  ใน IP allow list ชื่อ `search-api` (port 8089 ถูกปิดไว้เป็นค่าเริ่มต้น) [8]

ผลข้อ 1 ของ `check_splunk` บอกได้ว่าเส้นทางนี้ใช้ได้ไหม (หัวข้อ 5)

### 3.2 Certificate

Node ตรวจทั้ง CA และชื่อ: ชื่อใน `SPLUNK_MCP_URL` ต้องอยู่ใน SAN ของ cert ที่ 8089 ใช้
และ CA ที่เซ็น cert นั้นต้องอยู่ใน `NODE_EXTRA_CA_CERTS` ซึ่ง*เพิ่ม*เข้าไปในรายการ CA ของ Node
(ไม่ได้แทนที่) และถูกอ่านแค่ตอน process เริ่ม [11]

- **ห้ามใช้** `NODE_TLS_REJECT_UNAUTHORIZED=0` ถึงเอกสารของ Splunk จะแนะนำไว้สำหรับทดสอบ client [6]
  เพราะใน Backend มันจะปิดการตรวจ cert ของ ThreatQ และ Confluence ไปด้วย
- **ห้ามใส่** `cacert.pem` ของ Splunk (`SplunkCommonCA`) ใน `NODE_EXTRA_CA_CERTS` เพราะ CA ตัวนี้
  และ private key ของมัน (`ca.pem`) มากับตัวติดตั้ง Splunk ทุกเครื่อง ใครก็เซ็น cert ที่ worker
  จะเชื่อได้ และ `NODE_EXTRA_CA_CERTS` มีผลกับทุกการเชื่อมต่อของ worker ไม่ใช่แค่ Splunk
- ใน `mcp.conf` ของแอปมี `ssl_verify` (ค่า default `true`) ให้ปล่อยไว้แบบนั้น [6]

ขอ CA ที่เซ็น cert ของ port 8089 จากทีม Splunk ถ้าทีม Splunk ยังใช้ cert default อยู่
(`CN=SplunkServerDefaultCert` ไม่มี SAN) [10] ต้องขอให้เปลี่ยนเป็น cert ที่มีชื่อ search head อยู่ใน SAN ก่อน
แล้วทำสองอย่าง:

1. **commit** ไฟล์ (PEM) ไว้ที่ `certs/<file>.pem` ใน repo Backend ไฟล์นี้เป็น cert สาธารณะ ไม่มี key
   ตอน deploy ไฟล์นี้ถูก build เข้า image ที่ `/app/certs/`
2. ตั้ง CI variable `NODE_EXTRA_CA_CERTS=/app/certs/<file>.pem`

> ใช้ path `/app/certs/...` เท่านั้น `./certs` ใน `docker-compose.yml` เป็น bind mount ซึ่ง Docker
> บนเครื่อง production หา path ไม่เจอ (checkout ของ job ไม่ได้อยู่บนเครื่องนั้น) จึง mount
> โฟลเดอร์ว่างที่ `/certs` แทน Node จะข้ามไฟล์ที่หาไม่เจอ แล้วทุกการต่อจะ fail ด้วย error เรื่อง certificate

ถ้า ThreatQ หรือ Confluence ใช้ CA อื่น ต่อไฟล์ PEM หลายใบเป็นไฟล์เดียวแล้วชี้ไปที่ไฟล์นั้น

---

## 4. CI variables

ทั้งหมดเป็น CI variable ของ project Backend แก้แล้วต้อง deploy ใหม่ (**Run pipeline** บน `main`)
เพราะ container อ่าน `.env` ตอนถูกสร้างเท่านั้น

| ตัวแปร | ค่า | หมายเหตุ |
| --- | --- | --- |
| `SPLUNK_MCP_URL` | `https://<search-head>:8089/services/mcp` | **ต้องตั้ง** ค่า default ใน `.env.example` ชี้ไปที่ตัวที่ไม่มีบน production ถ้าใส่แค่ base URL เช่น `https://<search-head>:8089` ระบบจะเติม `/services/mcp` ให้ |
| `SPLUNK_MCP_TOKEN` | encrypted token จากหัวข้อ 2 | Protected + Masked ถ้าเว้นว่าง Splunk จะตอบ 401 |
| `NODE_EXTRA_CA_CERTS` | `/app/certs/<ca>.pem` | ดูหัวข้อ 3.2 |
| `SPLUNK_SEARCH_TIMEOUT` | `120` (default) | วินาทีต่อ MCP call หนึ่งครั้ง Text-to-SPL ใช้เวลาหลายสิบวินาที และ Splunk หยุด search ที่ 1 นาทีอยู่แล้ว [3] |
| `SPLUNK_MAX_COUNT` | `200` (default) | จำนวนแถวที่เก็บต่อ requirement (Splunk คืนได้ไม่เกิน 1000 event) [3] |
| `SPLUNK_LOOKUP_MODE` | `manual` (default) | `manual` คือรอ analyst กดปุ่ม, `auto` คือรันทุก alert, `off` คือปิด stage 2 (ใช้ระหว่างที่ Splunk ยังไม่พร้อม) |
| `SPLUNK_MCP_GENERATE_ARG` | เว้นว่าง | ชื่อ argument ที่ `saia_generate_spl` ใช้รับข้อความ Splunk ไม่ได้บอกไว้ Backend จึงอ่านจาก schema ของ tool เอง ให้ตั้งค่านี้เฉพาะเมื่ออ่านไม่ได้ |
| `SPLUNK_MCP_GENERATE_TOOL` / `SPLUNK_MCP_QUERY_TOOL` | เว้นว่าง (ใช้ค่า default) | ตั้งเฉพาะเมื่อ Splunk เปลี่ยนชื่อ tool |

**catalogue** job `export_catalog` เรียก REST API ของ Splunk โดยตรง (ไม่ผ่าน MCP) จึงต้องตั้ง
CI variable `SPLUNK_URL` และ `SPLUNK_TOKEN` แยก โดย `SPLUNK_TOKEN` เป็น token **ธรรมดา**
ของ service account เดียวกัน เพราะ encrypted token ของ MCP ใช้ได้กับ MCP เท่านั้น [6]
รายละเอียดอยู่ใน [splunk-catalog.md](splunk-catalog.md)

---

## 5. ตรวจว่าใช้ได้: job `check_splunk`

ไม่มีใครรัน docker บนเครื่อง production ได้ การตรวจจึงอยู่ใน pipeline ของ Backend สอง job ที่รันใน
`soc-core-worker` ตัวที่ deploy อยู่ (config, network และ CA เดียวกับ lookup จริง) อ่านอย่างเดียว
และไม่พิมพ์ token:

| job | รันเมื่อ | ทำอะไร |
| --- | --- | --- |
| `check_splunk` | **เองทุกครั้งหลัง `deploy_production` บน `main`** | ข้อ 1 และ 2 ด้านล่าง |
| `check_splunk_requirement` | กด ▶ แล้วใส่ `SPLUNK_CHECK_REQUIREMENT` ในหน้า Run job | ข้อ 1, 2 และ 3 |

1. curl ไปที่ `SPLUNK_MCP_URL` ด้วย CA ชุดเดียวกับ worker โดยไม่ส่ง token ถ้าได้ **`HTTP 401`** แปลว่า
   network และ certificate ผ่าน ถ้าได้อย่างอื่น curl จะบอกสาเหตุชัดกว่า `fetch failed` ของ Node
   เช่น `Could not resolve host` (DNS), `Connection timed out` (firewall),
   `SSL certificate problem` (CA หรือชื่อใน cert)
2. เช็ก token, ไฟล์ CA ที่ตั้งไว้มีอยู่จริงไหม และ MCP server มีทั้งสอง tool ไหม
3. ส่ง requirement ข้อนั้น (เช่น `Failed VPN logins in the last hour`) ผ่านเส้นทางจริงทั้งหมด
   (generate → ตรวจ → รัน) แล้วพิมพ์ prompt ที่ส่ง, SPL ที่รัน และแถวที่ได้

**Splunk ล่มต้องไม่ทำให้ระบบล่มตาม** ทั้งสอง job ตั้ง `allow_failure` ไว้ ถ้า fail จะขึ้น ⚠ พร้อมเหตุผลใน log
แต่ pipeline และ deploy ก่อนหน้ายังผ่าน ส่วนอื่นของระบบ (stage 1) ทำงานได้โดยไม่ต้องมี Splunk

ผลที่ต้องได้:

```
== 1. Network and certificate (no token sent: HTTP 401 means both are fine) ==
HTTP 401
== 2. MCP: token, CA and tools ==
endpoint       https://<search-head>:8089/services/mcp
token          set (… chars)
tools          saia_generate_spl, splunk_run_query
extra CA       /app/certs/<ca>.pem (found)
connected      yes — both tools found; Text-to-SPL takes the request in "<arg>"
```

| ถ้าเจอ | สาเหตุที่พบบ่อย |
| --- | --- |
| `cannot connect … fetch failed` | ต่อไม่ถึงหรือ TLS ไม่ผ่าน fetch ของ Node รายงานทุกกรณีด้วยข้อความเดียวกัน ดูผลข้อ 1 ซึ่งบอกสาเหตุได้ชัดกว่า |
| `ECONNREFUSED` / `ETIMEDOUT` / `ENOTFOUND` / `Connection timed out` / `Could not resolve host` | route, firewall ระหว่าง `10.40.35.18` กับ search head, DNS หรือ IP allow list ของ Splunk Cloud (หัวข้อ 3.1) |
| `self-signed certificate` / `unable to verify the first certificate` / `unable to get local issuer certificate` / `SSL certificate problem` | ไม่ได้ตั้ง `NODE_EXTRA_CA_CERTS` หรือตั้งเป็น CA ผิดตัว |
| `extra CA … (MISSING …)` / `NODE_EXTRA_CA_CERTS=… is not in the container` | ไฟล์ที่ `NODE_EXTRA_CA_CERTS` ชี้ไม่มีใน image ต้องเป็น `/app/certs/...` และ commit ไฟล์ไว้ใน `certs/` แล้ว (หัวข้อ 3.2) |
| `does not match target hostname` / `Hostname/IP does not match certificate's altnames` | ชื่อใน `SPLUNK_MCP_URL` ไม่อยู่ใน SAN ของ cert (หัวข้อ 3.2) |
| `SPLUNK_MCP_URL is not set` หรือ endpoint เป็น `soc-mcp-splunk` | ยังไม่ได้ตั้ง CI variable `SPLUNK_MCP_URL` |
| `cannot connect … 401` | token ผิด หมดอายุ หรือไม่ได้ออกจากแอป MCP Server หรือ `SPLUNK_MCP_TOKEN` ยังว่าง |
| `has no saia_generate_spl` | ยังไม่ได้ติดตั้งหรือ activate Splunk AI Assistant, Agent Mode ยังปิด หรือยังไม่ได้ map role กับ tool ในแท็บ Tools |
| `returned no SPL` | Text-to-SPL ตอบในรูปแบบที่ Backend อ่านไม่ออก ดูหัวข้อ 6 |
| `the generated SPL uses 'delete'` (หรือคำสั่งเขียน/ส่งข้อมูลออกตัวอื่น) | Text-to-SPL เขียน search ที่เขียน ลบ หรือส่งข้อมูลออก และถูกปฏิเสธก่อนรัน |
| ได้ 0 แถวจาก index ที่ควรมีข้อมูล | role อ่าน index นั้นไม่ได้ (`srchIndexesAllowed`) หรือ search ไม่ได้ระบุ index และ `srchIndexesDefault` ไม่มี index นั้น |
| `No such container: soc-core-worker` | Backend ยังไม่ได้ deploy หรือ deploy ล่าสุด fail ก่อน step Start |

---

## 6. ช่วงแรกที่เริ่มใช้

- **รูปแบบคำตอบของ Text-to-SPL ไม่มีเอกสาร** Backend ดึง SPL จาก field `spl`, `query` หรือ `search`,
  จาก code block, หรือจากบรรทัดแรกที่ขึ้นต้นด้วย `search`, `index=` หรือ `|` ถ้าคำตอบจริงมาในรูปอื่น
  lookup จะ fail ด้วย "returned no SPL" ให้แก้ที่ `splOf()` ใน
  [splunk-mcp.service.ts](../src/modules/enrichment/splunk-mcp.service.ts) ที่เดียว
- **Splunk เป็นคนเลือกชื่อ field** search ที่สร้างมาอาจใช้ชื่อตาม CIM ที่ log ดิบของเราไม่มี
  ผลจึงออกมาว่าง ซึ่งอ่านแล้วเหมือน "ไม่มีอะไรเกิดขึ้น" ทุกคำตอบเก็บ SPL ที่รันและ prompt ที่ใช้สร้างไว้
  และหน้า evidence แสดงทั้งสองอย่าง ช่วง alert แรก ๆ ให้เปิดดูทุกครั้ง
- **guardrail ของ Splunk ทำงานซ้อนกับของเรา** [3] คำสั่งที่ไม่ปลอดภัยหรือทำลายข้อมูลจะไม่ถูกรัน,
  search หยุดที่ 1 นาที และคืนได้ไม่เกิน 1000 event
- `splunk_run_query` ไม่รับช่วงเวลาเป็น argument ถ้า Text-to-SPL ไม่ได้ใส่ช่วงเวลามา Backend
  จะเขียนช่วงเวลาของ alert ลงใน SPL เป็น `earliest=`/`latest=` แบบ epoch ให้

ทั้ง `spl-guard.ts` และ guardrail ของ Splunk ไม่ใช่ตัวควบคุมหลัก
**role ของ token ต้องเขียนข้อมูลและอ่าน index อื่นไม่ได้อยู่ดี** (หัวข้อ 2)

---

## ไฟล์ที่เกี่ยวข้อง

| ไฟล์ | หน้าที่ |
| --- | --- |
| [`src/modules/enrichment/splunk-mcp.service.ts`](../src/modules/enrichment/splunk-mcp.service.ts) | MCP client: ต่อ, หา tool ทั้งสอง, สร้าง prompt แล้วทำ generate → ตรวจ → รัน |
| [`src/modules/enrichment/spl-guard.ts`](../src/modules/enrichment/spl-guard.ts) | ตรวจ SPL ระหว่างสอง call และใส่ช่วงเวลาของ alert ถ้า SPL ยังไม่มี |
| [`src/modules/queue/lookup.processor.ts`](../src/modules/queue/lookup.processor.ts) | stage 2: หนึ่ง MCP session ต่อ lookup และหนึ่งคำตอบต่อ requirement |
| [`src/scripts/splunk-mcp-check.ts`](../src/scripts/splunk-mcp-check.ts) | สคริปต์ที่ job ในหัวข้อ 5 รัน |
| [`.gitlab-ci.yml`](../.gitlab-ci.yml) (`check_splunk`, `check_splunk_requirement`) | job ตรวจในหัวข้อ 5 |
| [`src/config/configuration.ts`](../src/config/configuration.ts) (`splunk`) | ค่าในหัวข้อ 4 |
| [`catalog/`](../catalog) | catalogue และ lookup plans ดู [splunk-catalog.md](splunk-catalog.md) |

---

## แหล่งอ้างอิง

อ่านเมื่อตุลาคม 2026 แอปทั้งสองเปลี่ยนเร็ว ให้เทียบกับเวอร์ชันที่ติดตั้งจริงอีกครั้ง

1. [Set up the Splunk MCP Server (1.3)][mcp-setup]
2. [Install Splunk AI Assistant for Splunk Enterprise customers with Cloud Connected (2.2.0)][saia-install]
3. [MCP Server tools (2.0)][mcp-tools]
4. [Agent Mode in Splunk AI Assistant (2.2.0)][saia-agent]
5. [Splunk AI Assistant for SPL through a cloud-connected solution (Splunk blog)][saia-blog]
6. [Connecting to the MCP Server and settings][mcp-connect]
7. Splunkbase: [Splunk MCP Server][sb-mcp] · [Splunk AI Assistant][sb-saia]
8. [Configure IP allowlists for Splunk Cloud Platform (ACS)][acs-allowlist]
9. [authorize.conf: roles and capabilities (10.4)][authorize-conf]
10. [Configure TLS certificates for inter-Splunk communication (9.1)][tls-certs]
11. [Node.js `NODE_EXTRA_CA_CERTS`][node-ca]
12. [SPL safeguards for risky commands (9.2)][spl-safeguards]
13. [Enable or disable token authentication (10.4)][token-auth]

[sb-mcp]: https://splunkbase.splunk.com/app/7931
[sb-saia]: https://splunkbase.splunk.com/app/7245
[mcp-setup]: https://help.splunk.com/en/splunk-cloud-platform/mcp-server-for-splunk-platform/1.3/set-up-the-splunk-mcp-server
[mcp-tools]: https://help.splunk.com/en/splunk-enterprise/mcp-server-for-splunk-platform/2.0/mcp-server-tools
[mcp-connect]: https://help.splunk.com/en/splunk-enterprise/mcp-server-for-splunk-platform/connecting-to-the-mcp-server-and-settings
[saia-install]: https://help.splunk.com/en/splunk-enterprise/search/splunk-ai-assistant/2.2.0/install-and-configure-splunk-ai-assistant/install-splunk-ai-assistant-for-splunk-enterprise-customers-with-cloud-connected
[saia-agent]: https://help.splunk.com/en/splunk-enterprise/search/splunk-ai-assistant/2.2.0/use-splunk-ai-assistant/agent-mode-in-splunk-ai-assistant
[saia-blog]: https://www.splunk.com/en_us/blog/artificial-intelligence/introducing-splunk-ai-assistant-for-spl-through-a-cloud-connected-solution-on-prem-ai-without-the-gpu-hassle.html
[acs-allowlist]: https://help.splunk.com/en/splunk-cloud-platform/administer/admin-config-service-manual/10.5.2605/administer-splunk-cloud-platform-using-the-admin-config-service-acs-api/configure-ip-allowlists-for-splunk-cloud-platform
[authorize-conf]: https://help.splunk.com/en/data-management/splunk-enterprise-admin-manual/10.4/configuration-file-reference/10.4.0-configuration-file-reference/authorize.conf
[tls-certs]: https://help.splunk.com/en/splunk-enterprise/administer/manage-users-and-security/9.1/secure-splunk-platform-communications-with-transport-layer-security-certificates/configure-tls-certificates-for-inter-splunk-communication
[node-ca]: https://nodejs.org/api/cli.html#node_extra_ca_certsfile
[spl-safeguards]: https://help.splunk.com/en/splunk-enterprise/administer/manage-users-and-security/9.2/best-practices-for-splunk-platform-security/spl-safeguards-for-risky-commands
[token-auth]: https://help.splunk.com/en/splunk-enterprise/administer/manage-users-and-security/10.4/authenticate-into-the-splunk-platform-with-tokens/enable-or-disable-token-authentication
