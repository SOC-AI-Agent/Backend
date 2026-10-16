# Splunk data catalogue — ดึงจาก Splunk, ตรวจ, commit

stage 1 ใช้ catalogue เพื่อบอกว่า requirement แต่ละข้อควรค้นที่ **index / sourcetype ไหน
และ field ไหนเก็บค่าอะไร** — ทั้งหมดถูกส่งไปใน prompt ของ Text-to-SPL (stage 2) และใช้ตรวจว่า
playbook ยังค้น index ที่มีอยู่จริงไหม `roles` ยังแปลงรายละเอียดที่ agent เขียนใต้คำถามเป็นชื่อ field
ด้วย เช่น `device: FGT-01` → role `host` → `FGT-01 is in devname`

ถ้าชื่อ field ผิด การค้นจะ "สำเร็จ" แต่ได้ 0 แถว แล้วถูกอ่านว่า "ไม่เกิดอะไรขึ้น"
อย่างมั่นใจ ทั้งที่ข้อมูลมีอยู่ — อันตรายกว่า error เพราะไม่มีอะไรฟ้อง

---

## ไฟล์อยู่ที่ไหน

| ไฟล์ | คืออะไร |
| --- | --- |
| [`catalog/splunk-catalog.json`](../catalog/splunk-catalog.json) | **คนเขียน** — index → sourcetype → `purpose`, `roles` (ความหมาย → ชื่อ field ใน sourcetype นั้น), `notes` |
| [`catalog/lookup-plans.json`](../catalog/lookup-plans.json) | ถามอะไรเมื่อ alert มี indicator แต่ละชนิด |

**ถูก build เข้า image** ที่ `/catalog` ([Dockerfile](../Dockerfile)) — ไม่ได้ mount จาก repo อื่นแล้ว
แก้ catalogue = commit แล้ว deploy ตามปกติ ตำแหน่งที่ service อ่านคือ `SPLUNK_CATALOG_FILE`
และ `LOOKUP_PLANS_FILE` (default `/catalog/...`)

ถ้าไม่มี catalogue ระบบไม่พัง — worker log `no catalog at …` requirement จะไม่มี index hint
(Text-to-SPL เดาเอง — ค้นได้เฉพาะ index ที่ role ของ token เห็น) และข้ามการตรวจ playbook

---

## ขั้นตอน

```
Splunk ──export_catalog (CI, กด ▶)──► artifact catalog/table/ ──คนตรวจ──► commit catalog/splunk-catalog.json ──deploy──► /catalog ใน image
```

### 1. ตั้ง CI variables ใน project Backend (ครั้งเดียว)

| ชื่อ | ค่า | |
| --- | --- | --- |
| `SPLUNK_URL` | `https://<search-head>:8089` | management port ไม่ใช่ web 8000 |
| `SPLUNK_TOKEN` | Splunk authentication token | **protected + masked** |
| `SSL_CERT_FILE` | `certs/<ca>.pem` | เฉพาะเมื่อ cert ของ 8089 ออกโดย CA ภายใน (ใส่ไฟล์ CA ใน `certs/`) |

`SPLUNK_TOKEN` เป็น **token ธรรมดา** (Splunk Web → Settings → Tokens) ของ service account
ตัวเดียวกับที่ใช้กับ MCP — search-only, เห็นเฉพาะ index ที่ SOC ใช้ จะได้ catalogue ที่ตรงกับ
สิ่งที่ Backend ค้นได้จริง **encrypted token ของ MCP ใช้ตรงนี้ไม่ได้** (ใช้ได้เฉพาะใน MCP)

job ตรวจ cert เสมอ (`SPLUNK_INSECURE=0` ฝังไว้ใน job) ไม่มีทางปิด

### 2. รัน job

GitLab → CI/CD → Pipelines → pipeline ของ branch ที่ protected (เช่น `main`) → ▶ **`export_catalog`**

- ไม่รันเองอัตโนมัติ: ยิง search หนึ่งครั้งต่อ sourcetype บน search head production
  และ catalogue เปลี่ยนเมื่อ estate เปลี่ยน ไม่ใช่ทุก commit
- อยู่ใน stage `verify` คู่กับ job ตรวจ Splunk อีกสองตัว ไม่ขวาง pipeline (`allow_failure: true`)
  และไม่ต้องรอ job อื่น (`needs: []`) กดได้ทันทีที่ pipeline เริ่ม
- ใช้ environment `production` (`action: access`) คนที่ deploy production ได้เท่านั้นที่กดได้
- export ลง staging ก่อน ตรวจด้วย `verify_catalog_export.py` แล้วค่อยย้ายเข้าที่ —
  export ที่ตายกลางทาง (เช่นได้ 3 จาก 200 sourcetype) จะ fail ไม่ใช่ได้ catalogue ครึ่งใบ
- หน้า **Run job** (หลังกด ▶) ใส่ variable ปรับการดึงได้: `WINDOW` (ช่วงเวลา default `-30d`) และ
  `SAMPLE` (จำนวน event ต่อ sourcetype default `200`)

### 3. ตรวจ artifact

ดาวน์โหลด artifact `catalog/table/` (เก็บ 7 วัน):

| ไฟล์ | ใช้ทำอะไร |
| --- | --- |
| `splunk-catalog.json` | **catalogue ปัจจุบันที่ merge ผล export แล้ว** — ตัวที่ต้องตรวจ |
| `catalog.md` | ตาราง field ต่อ sourcetype พร้อมค่าตัวอย่าง 3 ค่า ไว้อ่านประกอบ |
| `indexes.json`, `fields__<index>__<sourcetype>.json`, `datamodels.json` | ผล export ดิบ |
| `field-map.json` | การเดาจากชื่อ field แบบหยาบ — ไม่ต้องใช้แล้ว (`roles` ใน `splunk-catalog.json` ดีกว่า) |

ใน `splunk-catalog.json` ที่ merge แล้ว:

- **ของที่คนเขียนไว้ไม่ถูกทับ** — `purpose`, `roles`, `notes`, `_comment` เดิมอยู่ครบ
- sourcetype ใหม่ได้ `purpose: "TODO"` — เขียนหนึ่งบรรทัดว่าเก็บอะไร
- `_review_roles` — role ที่**เดาจากชื่อ field** ต้องดูทีละตัว ชื่อที่ดูถูกมักผิด:
  เช่น `host` ใน syslog ที่ forward มาคือ **forwarder** ไม่ใช่เครื่องต้นทาง
  (`catalog.md` ช่วยได้ — ค่าตัวอย่าง `192.168.65.1` ซ้ำทุกแถวบอกได้ทันที)
- `fields` ถูก refresh จาก export (เป็นข้อเท็จจริง ไม่ใช่ข้อความที่คนเขียน)

### 4. commit

คัดลอกส่วนที่ตรวจแล้วลง `catalog/splunk-catalog.json` แล้ว commit — deploy รอบถัดไป
build เข้า image เอง

> ⚠️ **ห้าม commit `catalog/table/`** (อยู่ใน `.gitignore` และ `.dockerignore` แล้ว)
> มันมีค่าตัวอย่างจาก event จริง (IP, user) ถ้าเข้า git history แล้วเอาออกไม่ได้
> สิ่งที่ commit คือ `splunk-catalog.json` ซึ่งมีแค่ชื่อ field ไม่มีค่า

---

## 4 ขั้นที่ `export_splunk_catalog.py` ทำ

1. **estate เป็น CIM หรือยัง** — `| rest /services/data/models | table title`
   มี data model นอกจาก `internal_*` = normalize แล้ว ถ้าไม่มี role ที่เดาคือ mapping เดียวที่มี ต้องอ่านทุกตัว
2. **index + sourcetype** — `| tstats count where index=* by index, sourcetype`
   อ่าน tsidx ไม่สแกน event เร็วแม้ estate ใหญ่ ได้เฉพาะ index ที่ token เห็น
3. **field ของแต่ละ sourcetype** — `search index="X" sourcetype="Y" | head 200 | fieldsummary maxvals=3`
   (`| walklex` ใช้ไม่ได้: เห็นแต่ indexed field ส่วน log `key=value` เช่น FortiGate เป็น search-time extraction)
4. **สรุป** — `catalog.md` + `field-map.json`

ถ้าเรียก Splunk ไม่สำเร็จ script หยุดทันทีและบอกเหตุผล (token ถูกปฏิเสธ, ต่อไม่ติด, cert ตรวจไม่ผ่าน)
— แทนที่จะจบสวยๆ พร้อม catalogue ที่บอกว่า estate นี้ไม่มี index เลย

## ข้อควรระวัง

- **sampling ไม่เห็นทุก field** — `head 200` เห็นเฉพาะ field ใน 200 event แรก event ชนิดที่มีน้อย
  (เช่น FortiGate `type=utm`) อาจหลุด เพิ่ม `SAMPLE` ถ้าสงสัย
- **ช่วงเวลามีผล** — `WINDOW=-30d` ไม่เห็น sourcetype ที่หยุดส่งไปแล้วหรือเพิ่งเริ่ม
- **สิทธิ์จำกัดผลลัพธ์** — ได้เฉพาะ index ที่ token เห็น ซึ่ง**เป็นเรื่องดี** ถ้าใช้ service account
  เดียวกับ MCP: catalogue จะตรงกับสิ่งที่ stage 2 ค้นได้จริง
- **ต้นทุนบน estate ใหญ่** — ขั้น 3 ยิงหนึ่ง search ต่อ sourcetype 200 sourcetype = 200 search
  แจ้ง Splunk admin ก่อนกด

---

## ตรวจว่าใช้ได้จริง

หลัง deploy ถาม Splunk ผ่านทางเดียวกับ stage 2 แล้วดูว่า SPL ที่ได้ใช้ index และ field ที่ถูก:
กด ▶ ที่ job **`check_splunk_requirement`** แล้วใส่ `SPLUNK_CHECK_REQUIREMENT` เช่น
`Which destinations did 10.1.100.11 talk to` ([splunk-mcp.md ข้อ 5](splunk-mcp.md#5-ตรวจว่าใช้ได้-job-check_splunk))

ได้แถวกลับมา = ถูก ได้ 0 แถวทั้งที่รู้ว่ามีข้อมูล = field หรือ index ยังผิด — ดู [testing.md](testing.md)
