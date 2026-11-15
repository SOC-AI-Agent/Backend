# ไล่ปัญหา — ผลค้น Splunk

เอกสารนี้สำหรับตอนผลค้น Splunk บน production ดูผิด แล้วต้องหาว่าผิดตรงไหน

Stage 2 คุยกับ Splunk ผ่าน MCP: Backend ส่ง requirement ไปที่ `splunk_lookup` ของ connector
(`soc-mcp-splunk`, repo MCP-Server) connector สร้าง prompt ให้ Text-to-SPL เขียน SPL ตรวจด้วย
[`spl.check_readonly`](../../MCP-Server/Splunk/spl.py) แล้วรันบน Splunk ดังนั้นคำถามแรกคือ
**"Splunk เขียน SPL อะไร และรันได้ผลตรงที่เราคิดไหม"** ซึ่งตอบได้โดยไม่ต้องใช้ model ของเราเลย

---

## 3 ชั้นที่แยกทดสอบได้

```
ชั้น 3   job ของ Backend          ทั้ง job: alert -> requirement -> SPL -> ผล   -> ตอบ "ทั้งระบบทำงานไหม"
ชั้น 2   job check_splunk         ส่ง requirement ข้อความเดียว                -> ตอบ "Text-to-SPL เขียนอะไร รันได้อะไร"
ชั้น 1   Splunk Web               เราเขียน SPL เอง                             -> ตอบ "SPL ที่ถูกคืออะไร"
```

ไล่จากล่างขึ้นบน เจอความต่างระหว่างชั้นไหน ปัญหาอยู่ชั้นนั้น

| อาการ | แปลว่า |
| --- | --- |
| ชั้น 1 ได้ข้อมูล, ชั้น 2 ไม่ได้ | Text-to-SPL ใช้ชื่อ field หรือ index ที่ข้อมูลไม่ได้ใช้, role ของ service account อ่าน index นั้นไม่ได้, หรือ `spl.check_readonly` ของ connector ปฏิเสธ SPL (ดู `error`) |
| ชั้น 2 ได้ข้อมูล, ชั้น 3 ไม่ได้ | requirement ที่ agent เขียน หรือ index/sourcetype/field ที่ catalogue แนบไปผิด — ดู `prompt`, `index`, `sourcetype` ใน `lookup_result` |
| ทั้งสามได้ข้อมูล แต่ analyst อ่านผิด | การ render คำตอบ หรือ agent วิเคราะห์ (`soc-conclude`) — ไม่ใช่ Splunk |
| ชั้น 1 ก็ไม่ได้ | SPL ผิด หรือไม่มีข้อมูลจริง |

**ผลว่างไม่ได้แปลว่าไม่มีข้อมูล** — field ที่ใช้ผิดชื่อก็ได้ผลว่างเหมือนกัน
ดู `spl` ในผลทุกครั้งก่อนสรุป

---

## ชั้น 1 — Splunk Web

ใช้ตอนอยากรู้ว่า **SPL ที่ถูกต้องหน้าตายังไง** เปิด **Search & Reporting** บน search head แล้วรันเอง
ตั้งช่วงเวลาให้ครอบเวลาของ alert

```
index=main srcip=10.1.100.11 | stats count by action
```

ดูว่า sourcetype นั้นใช้ field ชื่ออะไรจริงๆ:

```
index=main sourcetype=fortigate | head 200 | fieldsummary maxvals=3 | table field values
```

account ของคนอาจเห็น index มากกว่า service account ของ Backend ถ้าชั้น 1 เจอแต่ชั้น 2 ไม่เจอ
ให้เทียบ index กับ `srchIndexesAllowed` ของ role ที่ service account ใช้ก่อน

---

## ชั้น 2 — job `check_splunk`

job นี้รันใน `soc-core-worker` ตัวที่ deploy อยู่ ใช้ config, network และ CA เดียวกับ lookup จริง
รันเองหลังทุก deploy บน `main` อยู่แล้ว (ตรวจแค่ว่าต่อได้และมี tool ครบ) ถ้าจะลอง requirement
หนึ่งข้อผ่านเส้นทางจริงทั้งหมด (generate → ตรวจ → รัน):

1. CI/CD → Pipelines → pipeline ล่าสุดของ `main` → job **`check_splunk`**
2. กด ▶ (หรือ Retry) แล้วในหน้า **Run job** ใส่ variable
   `SPLUNK_CHECK_REQUIREMENT` = `Which destinations did 10.1.100.11 talk to`
3. log จะพิมพ์ prompt ที่ส่งให้ Text-to-SPL, SPL ที่รันจริง และแถวที่ได้

อ่านอย่างเดียว ไม่พิมพ์ token ข้อความที่เจอบ่อยและความหมาย อยู่ใน
[splunk-mcp.md ข้อ 5](splunk-mcp.md#5-ตรวจว่าใช้ได้-job-check_splunk)

**index/sourcetype/field ที่ token เห็นจริง** (ใช้ตอนเขียน catalogue) — กด job `export_catalog`
ดู [splunk-catalog.md](splunk-catalog.md)

---

## ชั้น 3 — ขั้น Splunk ของ Backend

ขั้นแรกใช้ agent สองตัวต่อกัน (ไม่มีตัวไหนมี tool): `soc-suggest` เขียน suggestion แล้ว `soc-requirements`
อ่าน suggestion กับ alert และเขียนว่าอยากถาม Splunk อะไร (ค่าละหนึ่งบรรทัด) Backend แนบ index/sourcetype
ที่ catalogue บอกและช่วงเวลาของ alert ไว้ ขั้นที่สองรันเมื่อ analyst กดปุ่ม (หรืออัตโนมัติถ้า
`SPLUNK_LOOKUP_MODE=auto`): แต่ละ requirement ถูกส่งเป็นข้อความไป Text-to-SPL ของ Splunk ผ่าน MCP
แล้ว agent ตัวที่สาม `soc-conclude` อ่านผลค้นคู่กับ suggestion เขียนบทวิเคราะห์ (`SPLUNK_LOOKUP_ANALYSE=true`)

หน้า **Evidence** ของ job ใน dashboard แสดงข้อมูลชุดนี้ทั้งหมด ถ้าต้องการดูทาง API:

```bash
API=http://10.40.35.18:8082

# 1. ดู splunk_requirements ของ job ที่ขั้นแรกเสร็จแล้ว (API key)
curl -s $API/v1/results/<job_id> -H "X-API-Key: $KEY" | python3 -m json.tool

# 2. รันขั้น Splunk แล้วอ่านผล (JWT ของ user — ดู tokens.md ข้อ 4)
curl -s -X POST $API/v1/jobs/<job_id>/lookup -H "Authorization: Bearer $JWT"
curl -s $API/v1/jobs/<job_id> -H "Authorization: Bearer $JWT" \
  | python3 -c "
import json,sys
j=json.load(sys.stdin)
print(j['lookup_status'], j['lookup_time_ms'], 'ms')
for i, a in enumerate(j['lookup_result'] or [], 1):
    print(f'[{i}]', a['requirement'][:70])
    print('   prompt:', (a.get('prompt') or '').replace(chr(10), ' / '))
    print('   spl:', a.get('spl'), '| count:', a.get('count'), '| error:', a.get('error'))
    print('   where:', a.get('index'), a.get('sourcetype'), a.get('fields'))
fa = j.get('final_analysis')
if fa: print(); print('analysis:', fa['status'], fa.get('error') or fa.get('reason') or ''); print(fa.get('text', ''))"
```

ใน `splunk_requirements` ของแต่ละข้อ ดู:

- `context` — รายละเอียดจาก alert ที่ agent เขียนใต้คำถาม (device, source, user, user_agent, …) ส่งไป Text-to-SPL
- `droppedContext` — ค่าที่ agent เขียนแต่**ไม่มีอยู่ใน alert** ถูกตัดทิ้ง ถ้ามีบ่อย = model กำลังแต่งค่า ปรับ system prompt
- `fieldHints` — ชื่อ field จาก catalogue ที่แนบไป (`FGT-01` → `devname`) ว่างทั้งหมด = catalogue ยังไม่มี role ของ sourcetype นี้

ใน `lookup_result` ของแต่ละ requirement ดู:

- `prompt` — ข้อความที่ส่งให้ Text-to-SPL: requirement, รายละเอียดจาก alert (`Details from the alert`),
  index/sourcetype, ชื่อ field จาก catalogue (`Field names in this data`) และช่วงเวลา
- `spl` — คำสั่งที่ Splunk เขียนและรันจริง (หลังเติมช่วงเวลา) เอาไปรันต่อใน Splunk Web ได้เลย (ชั้น 1)
  ถ้า field ผิด (เช่นใช้ชื่อ CIM ที่ log ดิบไม่มี) ผลจะว่าง ซึ่ง**ไม่ได้แปลว่าไม่มีเหตุการณ์**
- `index` / `sourcetype` — hint ที่ Backend ได้จาก catalogue ถ้าผิดที่นี่ ให้แก้ catalogue
- `error` — ค้นไม่สำเร็จ เช่น `the generated SPL uses 'delete'…` (Text-to-SPL เขียนคำสั่งที่เขียน/ลบข้อมูล —
  ถูกปฏิเสธก่อนรัน), `cannot connect to Splunk's MCP server …` (network/CA/token ดูผลของ `check_splunk`)
- ได้ 0 แถวจาก index ที่น่าจะมีข้อมูล — role ของ token ใน Splunk อาจไม่เห็น index นั้น (`srchIndexesAllowed`)

`final_analysis` (จาก `soc-conclude`):

- `status` เป็น `running` ตอนกำลังอ่านผล, `completed` มี `text`, `failed` มี `error` (ผลค้นยังอยู่ครบ), หรือ `skipped`
  พร้อม `reason` (ไม่มีการค้นที่สำเร็จเลย จึงไม่มีอะไรให้วิเคราะห์)
- `text` อ้างผลด้วย `[splunk N]` ตรงกับเลข `[N]` ในหน้า job — ไล่กลับไปหา search ที่มาของข้อความนั้นได้
- agent ตัวนี้ไม่มี tool ค้นเองไม่ได้ อ่านได้เฉพาะสิ่งที่ Backend ส่งให้ (alert, suggestion, ผลค้นที่ตัดแล้วไม่เกิน ~7000 ตัวอักษร)
- ถ้า worker ตายระหว่างวิเคราะห์ ค้างที่ `running` ไม่ได้: API จะรายงานเป็น `failed` เมื่อ lookup ไม่ได้ทำงานอยู่แล้ว

---

## Guardrail

SPL ทุกอันผ่านสามชั้นก่อนถึงข้อมูล:

1. `spl.check_readonly` ใน connector (MCP-Server/Splunk) ปฏิเสธคำสั่งที่เขียน ลบ หรือส่งข้อมูลออก (`delete`, `collect`, `outputlookup`, …)
   ก่อนรัน และเติมช่วงเวลาของ alert ถ้า SPL ยังไม่มี
2. guardrail ของ Splunk MCP Server เอง: คำสั่งที่ไม่ปลอดภัยไม่ถูกรัน, search หยุดที่ 1 นาที, ไม่เกิน 1000 event
3. role ของ service account ใน Splunk: ไม่มี capability สำหรับเขียน และอ่านได้เฉพาะ index ที่อนุญาต

ชั้นที่ 3 คือชั้นที่ขาดไม่ได้ ([splunk-mcp.md](splunk-mcp.md) หัวข้อ 2) อย่าทดสอบ guardrail ด้วยการส่งคำสั่ง
ลบข้อมูลไปที่ Splunk ของ production

---

## เช็กสถานะเร็วๆ

| ต้องการรู้ | ดูที่ |
| --- | --- |
| API ขึ้นไหม, ต่อ `soc-ai` ได้ไหม | `http://10.40.35.18:8082/health` → `ai_service: "up"` |
| `soc-ai` ต่อ Agent-Server ได้ไหม | step Address ใน `deploy_production` ล่าสุดของ AI-Service |
| model พร้อมไหม, ใช้ตัวไหน, RAM/disk เหลือเท่าไร | หน้า **Resources** ใน admin UI ของ Agent-Server (`http://10.40.35.18:7100`) |
| ต่อ Splunk ได้ไหม | job `check_splunk` ล่าสุดของ Backend |
| container ไหนขึ้นอยู่, ใครถือ port ไหน | job `inspect_ports` |
| DB เป็นยังไง, migration ครบไหม | job `inspect_db_schema` |
