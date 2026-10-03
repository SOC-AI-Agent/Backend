# Splunk ผ่าน MCP

Stage 2 ถาม Splunk ผ่าน MCP โดยมี Backend (`soc-core-worker`) เป็น **MCP client** ตัวเดียว
ขั้นตอนคือส่งแต่ละ requirement เป็น**ข้อความ**ให้ Text-to-SPL ของ Splunk เขียน SPL, ตรวจ SPL ที่ได้,
แล้วสั่งให้ Splunk รัน ฝั่งเราไม่มี model ตัวไหนเขียน SPL

เอกสารนี้คือขั้นตอนต่อ Backend เข้ากับ **Splunk MCP Server app** ของจริง ใช้ได้ทั้งกับ Splunk ใน lab
(container `splunk` ของ Offensive-Detection-Lab) และ production ส่วน mock สำหรับพัฒนา
(`soc-mcp-splunk`) อยู่ที่ [MCP-Server/Splunk/README.md](../../MCP-Server/Splunk/README.md)

| ขั้น | ทำที่ | |
| --- | --- | --- |
| 1. ติดตั้ง Splunk MCP Server กับ Splunk AI Assistant และเปิด Agent Mode | Splunk | **activation code ใช้เวลาได้ถึง 3 วันทำการ ควรเริ่มก่อนขั้นอื่น** |
| 2. service account, role และ token | Splunk | |
| 3. network และ certificate | Docker, Splunk | |
| 4. ค่าใน `Backend/.env` | Backend | |
| 5. ตรวจว่าใช้ได้ | Backend | |

> Git Bash บน Windows จะแปลง path ที่ขึ้นต้นด้วย `/opt/...` เป็น path ของ Windows ทำให้
> `docker exec` หาไฟล์ไม่เจอ ให้รัน `export MSYS_NO_PATHCONV=1` ก่อนทำตามคำสั่งในเอกสารนี้

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
ใน production ไม่มีอะไรคั่นระหว่าง Backend กับ Splunk

ชื่อ tool ทั้งสอง, argument และ path `/services/mcp` เป็นของ Splunk MCP Server app เอง และ mock
ก็ใช้ชื่อเดียวกัน เวลาสลับระหว่าง dev, lab และ production จึงแก้แค่ `.env` ไม่ต้องแก้โค้ด

| | mock (dev) | Splunk ใน lab | production |
| --- | --- | --- | --- |
| MCP server | `soc-mcp-splunk` (`SPLUNK_MODE=mock`) | MCP Server app ใน container `splunk` | MCP Server app บน search head |
| `SPLUNK_MCP_URL` | `http://soc-mcp-splunk:8200/services/mcp` | `https://splunk:8089/services/mcp` | `https://<search-head>:8089/services/mcp` |
| `SPLUNK_MCP_TOKEN` | ว่าง (ใช้ `MCP_AUTH_TOKEN`) | encrypted token จากแอป | encrypted token จากแอป (CI variable) |
| `NODE_EXTRA_CA_CERTS` | ไม่ต้องตั้ง | `/certs/splunk-lab-ca.pem` (ดูหัวข้อ 3.2) | CA ของบริษัท |
| Text-to-SPL | template ที่เติม IP, hash และ `user=` | Splunk AI Assistant (cloud-connected) | Splunk AI Assistant |
| ข้อมูล | event ปลอม 22 รายการ | index ใน lab | index จริง |

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

ต้องติดตั้งสองแอปบน search head (ใน lab คือ container `splunk`):

| แอป | Splunkbase | ใช้ทำอะไร |
| --- | --- | --- |
| **Splunk MCP Server** | [7931][sb-mcp] เวอร์ชัน 2.0.0 (3 ก.ย. 2026) | เปิด endpoint `/services/mcp` และให้ tool `splunk_run_query` |
| **Splunk AI Assistant** (ชื่อเดิม AI Assistant for SPL) | [7245][sb-saia] เวอร์ชัน 2.3.3 (22 ก.ย. 2026) | Text-to-SPL ถ้าไม่มีแอปนี้ MCP server จะ**ไม่มี `saia_generate_spl`** |

ทั้งสองแอปรองรับ Splunk Enterprise และ Splunk Cloud เวอร์ชัน 9.3 ถึง 10.6 แต่ tool กลุ่ม `saia_*`
จะโผล่ก็ต่อเมื่อเปิด **Agent Mode** แล้ว และ Agent Mode ต้องใช้ **10.1 ขึ้นไป** [3]
(Splunk ใน lab คือ 10.6.0.5 จึงใช้ได้)

ก่อนเริ่มต้องมี:

- search head ที่ออก HTTPS 443 ไป `*.scs.splunk.com` ได้ (จะผ่าน proxy ก็ได้ ตั้งตอน onboarding) [5]
- account ของ splunk.com สำหรับดาวน์โหลดแอปจาก Splunkbase
- อีเมลที่ทำงาน สำหรับรับ activation code

### 1.1 ติดตั้งผ่าน Splunk Web (วิธีที่ง่ายที่สุด)

1. เปิด Splunk Web (lab: `http://localhost:8000` ใช้ user `admin` และรหัสจาก `SPLUNK_PASSWORD`
   ใน compose ของ lab) แล้วไปที่ **Apps → Find More Apps**
2. ค้น `MCP Server` → **Install** → ล็อกอินด้วย account ของ splunk.com → ยอมรับ license
3. ทำแบบเดียวกันกับ `Splunk AI Assistant`
4. ถ้า Splunk ขอให้ restart ให้กด restart (หรือไปที่ **Settings → Server controls → Restart Splunk**)
5. เช็กที่ **Apps → Manage Apps** ว่าทั้งสองแอปขึ้นสถานะ Enabled

### 1.2 ติดตั้งจากไฟล์ (กรณี Splunk ออกเน็ตไป Splunkbase ไม่ได้)

ดาวน์โหลดไฟล์ `.tgz` ของทั้งสองแอปจาก Splunkbase แล้วติดตั้งทีละไฟล์:

```bash
docker cp <ไฟล์แอป>.tgz splunk:/tmp/
docker exec -it -u splunk splunk /opt/splunk/bin/splunk install app /tmp/<ไฟล์แอป>.tgz   # ถาม user และรหัส admin
docker exec -u splunk splunk /opt/splunk/bin/splunk restart
```

ถ้าใช้ Git Bash แล้วเจอ `the input device is not a TTY` ให้เติม `winpty` หน้าคำสั่งที่มี `-it`

### 1.3 เปิดใช้ Splunk AI Assistant (cloud-connected)

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
  lab นี้เปิดไว้แล้ว และ token มีอายุ default `+30d`
- ออก token ใน**แอป Splunk MCP Server** → generate encrypted token ให้ service account → ตั้งวันหมดอายุ
  → **คัดลอกทันที เพราะแสดงแค่ครั้งเดียว** token แบบนี้ใช้กับ MCP ได้อย่างเดียว เอาไปเรียก REST API ตรงไม่ได้ [6]
- คนที่ออก token ให้ account อื่นต้องมี `edit_tokens_all` และ `mcp_tool_admin` (ถ้าออกให้ตัวเองใช้
  `edit_tokens_own` และ `mcp_tool_admin`) [6] ส่วน service account เองใช้แค่ `mcp_tool_execute`
- จดวันหมดอายุไว้ในปฏิทินของทีม เพราะเมื่อหมดอายุ ทุก lookup จะ fail ด้วย 401 ตอน connect
  และหน้า job จะแสดงข้อความนี้
- ถ้า token หลุด หน้า settings ของแอปมีปุ่ม **Invalidate Keys** ที่ยกเลิก MCP token ทุกตัวพร้อมกัน [6]

เอา token ไปใส่ที่:

- lab: `SPLUNK_MCP_TOKEN=<token>` ใน `Backend/.env`
- production: CI variable `SPLUNK_MCP_TOKEN` ของ project Backend (masked และ protected)
  ห้าม commit และห้ามใส่ใน `MCP-Server/.env`

ถ้า tool ตอบว่าไม่มีสิทธิ์ตอนตรวจในหัวข้อ 5 ให้เพิ่ม capability ทีละตัวตามที่ข้อความบอก
แทนการ inherit role `user` หรือ `power` ทั้งก้อน

---

## 3. Network และ certificate

### 3.1 Network

- **เส้นทาง:** `soc-core-worker` → Splunk **TCP 8089** worker เป็น container เดียวที่เรียก Splunk
  (ถ้า Splunk อยู่นอก Docker อย่างใน production Splunk จะเห็น IP ของเครื่อง Docker host)
- **DNS:** ชื่อใน `SPLUNK_MCP_URL` ต้อง resolve ได้จากใน container
- **Splunk Cloud:** endpoint อยู่บน management port จึงต้องเพิ่ม egress IP ของเครื่อง Backend
  ใน IP allow list ชื่อ `search-api` (port 8089 ถูกปิดไว้เป็นค่าเริ่มต้น) [8]

**lab:** container `splunk` อยู่ใน network `purple_lab` ของ Offensive-Detection-Lab
ต้องต่อเข้า `soc-network` ด้วย worker จึงจะเรียกชื่อ `splunk` ได้

```bash
docker network create soc-network 2>/dev/null || true
docker network connect soc-network splunk
```

การต่อนี้ผูกกับ container ถ้าสั่ง `restart`, `stop` หรือ `start` ยังอยู่ แต่ถ้า container
ถูกสร้างใหม่ (เช่น `down` แล้ว `up` หรือ `up` หลังแก้ compose) ต้องต่อใหม่ ส่วน port 8089
ไม่ได้ publish ออกมาที่ host และไม่จำเป็นต้อง publish

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

**production:** ขอ CA ที่เซ็น cert ของ port 8089 จากทีม Splunk เอาไฟล์ (PEM) ไปไว้ใน `Backend/certs/`
แล้วตั้ง `NODE_EXTRA_CA_CERTS=/certs/<file>.pem` ใน `Backend/.env` ถ้าทีม Splunk ยังใช้ cert
default อยู่ [10] ต้องขอให้เปลี่ยนเป็น cert ที่มีชื่อ search head อยู่ใน SAN ก่อน

**lab:** cert ที่ Splunk สร้างเองบน 8089 คือ `CN=SplunkServerDefaultCert` ไม่มี SAN และเซ็นด้วย
`SplunkCommonCA` ถ้าเรียกด้วยชื่อ `splunk` จะได้ error นี้

```
certificate subject name 'SplunkServerDefaultCert' does not match target hostname 'splunk'
```

ทางแก้คือออก cert ใหม่ให้ splunkd ที่มี SAN `splunk` แล้วเซ็นด้วย CA ที่สร้างไว้ใช้เฉพาะ lab นี้
และลบ private key ของ CA ทิ้งทันทีหลังเซ็น CA นี้จึงรับรองได้แค่ cert ใบเดียว
ส่วน KV store ให้ใช้ cert เดิมต่อไป (KV store ใช้ `serverCert` ตัวเดียวทั้งฝั่ง server และ client
และตรวจกับ `cacert.pem` เดิม ถ้าย้ายไปใช้ cert ใหม่จะต่อกันไม่ได้)

```bash
docker exec -i -u splunk splunk sh -s <<'SH'
set -eu
SPLUNK=/opt/splunk/bin/splunk
O="$SPLUNK cmd openssl"
D=/opt/splunk/etc/auth/soc
C=/opt/splunk/etc/system/local/server.conf

# key ใหม่ใช้รหัสเดียวกับ [sslConfig] sslPassword ที่ตั้งอยู่แล้ว จึงไม่ต้องแก้ค่านั้น
KEYPASS=$($SPLUNK show-decrypted --value "$(sed -n '/^\[sslConfig\]/,/^\[/s/^sslPassword *= *//p' "$C")")

mkdir -p "$D" && chmod 700 "$D"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; cd "$T"   # key ของ CA อยู่แค่ในโฟลเดอร์นี้ แล้วถูกลบตอนจบ

$O req -x509 -newkey rsa:3072 -noenc -keyout ca.key -out ca.pem -days 1825 -sha256 \
  -subj "/O=SOC lab/CN=SOC lab CA for splunk:8089" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign"
$O req -new -newkey rsa:2048 -keyout server.key -passout "pass:$KEYPASS" \
  -out server.csr -subj "/O=SOC lab/CN=splunk"
printf '%s\n' 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature,keyEncipherment' \
  'extendedKeyUsage=serverAuth,clientAuth' 'subjectAltName=DNS:splunk,DNS:localhost,IP:127.0.0.1' > ext.cnf
$O x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 825 -sha256 \
  -extfile ext.cnf -out server.crt

cat server.crt server.key ca.pem > "$D/splunkd.pem" && chmod 600 "$D/splunkd.pem"
cp ca.pem "$D/soc-lab-ca.pem"

cp "$C" "$C.bak-soc-$(date +%Y%m%d%H%M%S)"
grep -q '^serverCert *= *\$SPLUNK_HOME/etc/auth/soc/splunkd.pem' "$C" ||
  sed -i '/^\[sslConfig\]/a serverCert = $SPLUNK_HOME/etc/auth/soc/splunkd.pem' "$C"
grep -q '^\[kvstore\]' "$C" ||
  printf '\n[kvstore]\nserverCert = $SPLUNK_HOME/etc/auth/server.pem\n' >> "$C"
SH

docker exec -u splunk splunk /opt/splunk/bin/splunk restart
```

ตรวจหลัง restart (ให้รันจากโฟลเดอร์ `Backend`):

```bash
# 8089 ต้องใช้ cert ที่มีชื่อ splunk แล้ว
docker exec -u splunk splunk sh -c '/opt/splunk/bin/splunk cmd openssl s_client -connect 127.0.0.1:8089 </dev/null 2>/dev/null \
  | /opt/splunk/bin/splunk cmd openssl x509 -noout -subject -ext subjectAltName'

# KV store ต้องยัง ready (คำสั่งจะถาม user และรหัส admin)
docker exec -it -u splunk splunk /opt/splunk/bin/splunk show kvstore-status

# เอา CA (ไฟล์สาธารณะ ไม่มี key) ไปไว้ให้ Backend
docker exec -u splunk splunk cat /opt/splunk/etc/auth/soc/soc-lab-ca.pem > certs/splunk-lab-ca.pem

# จาก soc-network ถ้าได้ 401 แปลว่าชื่อและ CA ผ่านแล้ว (ที่ได้ 401 เพราะยังไม่ได้ส่ง token)
docker run --rm -i --network soc-network --entrypoint sh curlimages/curl -c \
  'cat > /tmp/ca.pem && curl -sS -o /dev/null -w "%{http_code}\n" --cacert /tmp/ca.pem https://splunk:8089/services/mcp' \
  < certs/splunk-lab-ca.pem
```

`certs/splunk-lab-ca.pem` เป็นไฟล์ของ lab นี้เท่านั้น ห้าม commit

ถ้าต้องการย้อนกลับ ให้คืน `server.conf` จากไฟล์ backup แล้ว restart:

```bash
docker exec -u splunk splunk sh -c 'cd /opt/splunk/etc/system/local && cp "$(ls -t server.conf.bak-soc-* | head -1)" server.conf'
docker exec -u splunk splunk /opt/splunk/bin/splunk restart
```

---

## 4. ค่าใน `Backend/.env`

| ตัวแปร | ค่า | หมายเหตุ |
| --- | --- | --- |
| `SPLUNK_MCP_URL` | lab: `https://splunk:8089/services/mcp`<br>production: `https://<search-head>:8089/services/mcp` | ถ้าใส่แค่ base URL เช่น `https://splunk:8089` ระบบจะเติม `/services/mcp` ให้ |
| `SPLUNK_MCP_TOKEN` | encrypted token จากหัวข้อ 2 | ถ้าเว้นว่าง ระบบจะส่ง `MCP_AUTH_TOKEN` (ของ mock) แทน แล้ว Splunk จะตอบ 401 |
| `NODE_EXTRA_CA_CERTS` | lab: `/certs/splunk-lab-ca.pem`<br>production: `/certs/<ca>.pem` | ดูหัวข้อ 3.2 |
| `SPLUNK_SEARCH_TIMEOUT` | `120` | วินาทีต่อ MCP call หนึ่งครั้ง Text-to-SPL ใช้เวลาหลายสิบวินาที และ Splunk หยุด search ที่ 1 นาทีอยู่แล้ว [3] |
| `SPLUNK_MAX_COUNT` | `200` | จำนวนแถวที่เก็บต่อ requirement (Splunk คืนได้ไม่เกิน 1000 event) [3] |
| `SPLUNK_LOOKUP_MODE` | `manual` | `manual` คือรอ analyst กดปุ่ม, `auto` คือรันทุก alert, `off` คือปิด stage 2 |
| `SPLUNK_MCP_GENERATE_ARG` | เว้นว่าง | ชื่อ argument ที่ `saia_generate_spl` ใช้รับข้อความ Splunk ไม่ได้บอกไว้ Backend จึงอ่านจาก schema ของ tool เอง ให้ตั้งค่านี้เฉพาะเมื่ออ่านไม่ได้ |
| `SPLUNK_MCP_GENERATE_TOOL` / `SPLUNK_MCP_QUERY_TOOL` | เว้นว่าง (ใช้ค่า default) | ตั้งเฉพาะเมื่อ Splunk เปลี่ยนชื่อ tool |

production ไม่ใช้ `MCP_AUTH_TOKEN`

container อ่าน `.env` ตอนถูกสร้างเท่านั้น แก้แล้วต้องสร้าง worker ใหม่ด้วย compose file ที่ใช้อยู่
เช่น `docker compose up -d soc-core-worker` (คำสั่ง `restart` จะไม่อ่าน `.env` ใหม่)

**catalogue** job `export_catalog` ใน CI เรียก REST API ของ Splunk โดยตรง (ไม่ผ่าน MCP) จึงต้องตั้ง
CI variable `SPLUNK_URL` และ `SPLUNK_TOKEN` แยก โดย `SPLUNK_TOKEN` เป็น token **ธรรมดา**
ของ service account เดียวกัน เพราะ encrypted token ของ MCP ใช้ได้กับ MCP เท่านั้น [6]
รายละเอียดอยู่ใน [splunk-catalog.md](splunk-catalog.md)

---

## 5. ตรวจว่าใช้ได้

รันจาก container ที่จะเรียก Splunk จริง ด้วยค่าจริง:

```bash
docker exec soc-core-worker node dist/scripts/splunk-mcp-check.js
```

```
endpoint       https://splunk:8089/services/mcp
token          set (… chars)
tools          saia_generate_spl, splunk_run_query
extra CA       /certs/splunk-lab-ca.pem
connected      yes — both tools found; Text-to-SPL takes the request in "<arg>"
```

จากนั้นลองส่ง requirement หนึ่งข้อผ่านเส้นทางเดียวกับ lookup จริง (generate → ตรวจ → รัน)
คำสั่งนี้อ่านอย่างเดียว:

```bash
docker exec soc-core-worker node dist/scripts/splunk-mcp-check.js "Failed VPN logins in the last hour"
```

| ถ้าเจอ | สาเหตุที่พบบ่อย |
| --- | --- |
| `cannot connect … fetch failed` | ต่อไม่ถึงหรือ TLS ไม่ผ่าน fetch ของ Node รายงานทุกกรณีด้วยข้อความเดียวกัน ให้ใช้คำสั่ง curl ในหัวข้อ 3.2 ซึ่งบอกสาเหตุได้ชัดกว่า |
| `ECONNREFUSED` / `ETIMEDOUT` / `ENOTFOUND` | route, firewall, DNS หรือ IP allow list ของ Splunk Cloud ถ้าเป็น lab อาจยังไม่ได้ `docker network connect` |
| `self-signed certificate` / `unable to verify the first certificate` / `unable to get local issuer certificate` | ไม่ได้ตั้ง `NODE_EXTRA_CA_CERTS` หรือตั้งเป็น CA ผิดตัว |
| `does not match target hostname` / `Hostname/IP does not match certificate's altnames` | ชื่อใน `SPLUNK_MCP_URL` ไม่อยู่ใน SAN ของ cert ถ้าเป็น lab แปลว่ายังไม่ได้ทำหัวข้อ 3.2 |
| `cannot connect … 401` | token ผิด หมดอายุ หรือไม่ได้ออกจากแอป MCP Server หรือ `SPLUNK_MCP_TOKEN` ยังว่าง |
| `has no saia_generate_spl` | ยังไม่ได้ติดตั้งหรือ activate Splunk AI Assistant, Agent Mode ยังปิด หรือยังไม่ได้ map role กับ tool ในแท็บ Tools |
| `returned no SPL` | Text-to-SPL ตอบในรูปแบบที่ Backend อ่านไม่ออก ดูหัวข้อ 6 |
| `the generated SPL uses 'delete'` (หรือคำสั่งเขียน/ส่งข้อมูลออกตัวอื่น) | Text-to-SPL เขียน search ที่เขียน ลบ หรือส่งข้อมูลออก และถูกปฏิเสธก่อนรัน |
| ได้ 0 แถวจาก index ที่ควรมีข้อมูล | role อ่าน index นั้นไม่ได้ (`srchIndexesAllowed`) หรือ search ไม่ได้ระบุ index และ `srchIndexesDefault` ไม่มี index นั้น |

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

ทั้ง `spl-guard.ts`, guardrail ของ Splunk และ denylist ใน mock ไม่ใช่ตัวควบคุมหลัก
**role ของ token ต้องเขียนข้อมูลและอ่าน index อื่นไม่ได้อยู่ดี** (หัวข้อ 2)

---

## Splunk ใน lab: ข้อควรรู้

- image `splunk/splunk:latest` ตอนนี้คือ **10.6.0.5** ถ้า pull ใหม่อาจได้เวอร์ชันอื่น
  ถ้าต้องการล็อกเวอร์ชันให้เปลี่ยน compose ของ lab เป็น `splunk/splunk:10.6.0.5`
- license เป็น **Enterprise trial หมดอายุ 2 ธ.ค. 2026** หลังจากนั้น Splunk จะเปลี่ยนไปใช้ Free license
  ซึ่งไม่มีระบบ user และ role ทำให้ token และ MCP ใช้ไม่ได้ ต้องลง license ใหม่ก่อนวันนั้น
- `/opt/splunk/etc` และ `/opt/splunk/var` เป็น anonymous volume ถ้าสั่ง `docker compose down`
  แล้ว `up` จะได้ Splunk ใหม่ที่ว่างเปล่า แอป, token, cert และ onboarding หายหมด
  (ต้องรอ activation code ใหม่ด้วย) ให้ใช้ `stop`, `start` หรือ `restart` แทน
- Backend ไปถึง 8089 ผ่าน `soc-network` เท่านั้น (ดูหัวข้อ 3.1)

---

## ไฟล์ที่เกี่ยวข้อง

| ไฟล์ | หน้าที่ |
| --- | --- |
| [`src/modules/enrichment/splunk-mcp.service.ts`](../src/modules/enrichment/splunk-mcp.service.ts) | MCP client: ต่อ, หา tool ทั้งสอง, สร้าง prompt แล้วทำ generate → ตรวจ → รัน |
| [`src/modules/enrichment/spl-guard.ts`](../src/modules/enrichment/spl-guard.ts) | ตรวจ SPL ระหว่างสอง call และใส่ช่วงเวลาของ alert ถ้า SPL ยังไม่มี |
| [`src/modules/queue/lookup.processor.ts`](../src/modules/queue/lookup.processor.ts) | stage 2: หนึ่ง MCP session ต่อ lookup และหนึ่งคำตอบต่อ requirement |
| [`src/scripts/splunk-mcp-check.ts`](../src/scripts/splunk-mcp-check.ts) | สคริปต์ตรวจในหัวข้อ 5 |
| [`src/config/configuration.ts`](../src/config/configuration.ts) (`splunk`) | ค่าในหัวข้อ 4 |
| [`catalog/`](../catalog) | catalogue และ lookup plans ดู [splunk-catalog.md](splunk-catalog.md) |
| [`MCP-Server/Splunk`](../../MCP-Server/Splunk/README.md) | mock สำหรับ dev ใช้ denylist ชุดเดียวกับ `spl-guard.ts` (test ฝั่งนั้นจะ fail ถ้าสองรายการไม่ตรงกัน) |

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
