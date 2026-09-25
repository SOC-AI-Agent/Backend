# ทดสอบด้วยมือ — Splunk

เอกสารนี้สำหรับตอนผลค้น Splunk ดูผิด แล้วต้องหาว่าผิดตรงไหน

Splunk ไม่ผ่าน MCP และ model ไม่ได้เขียนการค้น — Backend วางแผนจาก catalogue เขียน SPL เอง
แล้วยิง connector (`soc-mcp-splunk`) ผ่าน HTTP ดังนั้นคำถามแรกคือ
**"connector คืนค่าตรงที่เราคิดไหม"** ซึ่งตอบได้โดยไม่ต้องใช้ model เลย

---

## 3 ชั้นที่แยกทดสอบได้

```
ชั้น 3   ขั้น Splunk ของ Backend   Backend วางแผน แล้วยิง connector  -> ตอบ "ทั้งระบบทำงานไหม"
ชั้น 2   เรียก connector เอง       เราส่ง SPL เอง                    -> ตอบ "connector รันถูกไหม"
ชั้น 1   ยิง Splunk ตรงๆ           เราเขียน SPL เอง                  -> ตอบ "SPL ที่ถูกคืออะไร"
```

ไล่จากล่างขึ้นบน เจอความต่างระหว่างชั้นไหน ปัญหาอยู่ชั้นนั้น

| อาการ | แปลว่า |
| --- | --- |
| ชั้น 1 ได้ข้อมูล, ชั้น 2 ไม่ได้ | connector ปฏิเสธ SPL (ดู `error`), index ไม่อยู่ใน allowlist, หรือ field ที่ใช้ไม่ใช่ field ที่ข้อมูลใช้จริง |
| ชั้น 2 ได้ข้อมูล, ชั้น 3 ไม่ได้ | Backend วางแผนหรือเขียน SPL ผิด — ดู `index`, `sourcetype`, `fields` และ `spl` ใน `lookup_result` (ปัญหาอยู่ที่ catalogue หรือตารางคำถาม) |
| ทั้งสามได้ข้อมูล แต่ analyst อ่านผิด | การ render คำตอบ หรือ agent วิเคราะห์ (`soc-conclude`) — ไม่ใช่ Splunk |
| ชั้น 1 ก็ไม่ได้ | SPL ผิด หรือไม่มีข้อมูลจริง |

**ผลว่างไม่ได้แปลว่าไม่มีข้อมูล** — field ที่ส่งไปผิดชื่อก็ได้ผลว่างเหมือนกัน
ดู `fields_searched` และ `spl` ในผลทุกครั้งก่อนสรุป

---

## ชั้น 1 — ยิง Splunk ตรงๆ

ใช้ตอนอยากรู้ว่า **SPL ที่ถูกต้องหน้าตายังไง** ก่อนไปปรับ tool

```bash
export SPLUNK=https://localhost:8089
export SPLUNK_ADMIN=admin
export SPLUNK_PW='<รหัส>'

curl -sk -u "$SPLUNK_ADMIN:$SPLUNK_PW" -X POST "$SPLUNK/services/search/jobs" \
  --data-urlencode 'search=search index=main srcip=10.1.100.11 | stats count by action' \
  --data-urlencode 'exec_mode=oneshot' \
  --data-urlencode 'earliest_time=-24h' \
  --data-urlencode 'latest_time=now' \
  --data-urlencode 'output_mode=json' \
  | python3 -m json.tool
```

ดูว่า field ชื่ออะไรจริงๆ:

```bash
curl -sk -u "$SPLUNK_ADMIN:$SPLUNK_PW" -X POST "$SPLUNK/services/search/jobs" \
  --data-urlencode 'search=search index=main | head 1 | fieldsummary | table field' \
  --data-urlencode 'exec_mode=oneshot' --data-urlencode 'output_mode=json' \
  | python3 -c "import json,sys; print([r['field'] for r in json.load(sys.stdin)['results']])"
```

> ⚠️ **เวลาของ event ต้องเป็นอดีต** เทียบกับนาฬิกาของ Splunk
> (`docker exec soc-splunk date -u`) event ที่ timestamp อยู่ในอนาคตจะเข้า index
> แต่ไม่โผล่ในหน้าต่าง `-24h..now` — หาไม่เจอทั้งที่มีอยู่

---

## ชั้น 2 — เรียก connector เอง ไม่ใช้ Backend

Backend เขียน SPL เอง ([`spl.ts`](../src/modules/enrichment/spl.ts)) แล้วส่งไป `POST /query` ของ
connector ซึ่ง **ตรวจซ้ำอีกรอบ** ([`check_query`](../../MCP-Server/Splunk/spl.py): อนุญาตเฉพาะ search ที่อ่านอย่างเดียว
บน index ที่อยู่ใน allowlist) แล้วค่อยรัน ชั้นนี้คือการส่ง SPL เองเข้าไป

connector ไม่ publish port ออกนอก จึงต้องยิงจากใน network:

```bash
export MCP_AUTH_TOKEN='<ค่าใน MCP-Server/.env>'

splunk() {   # splunk '<json>'
  docker run --rm --network soc-network curlimages/curl -s -X POST \
    http://soc-mcp-splunk:8200/query \
    -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$1"
}
```

**search แบบที่ Backend เขียน — indicator หนึ่งตัวใน field ที่เก็บมัน**

```bash
splunk '{"spl":"search index=\"main\" (srcip=\"10.1.100.11\" OR dstip=\"10.1.100.11\") | head 20"}'
```
```
{"results":[ ... ],"count":20,"earliest":"-24h","latest":"now","limit":20}
```

ผลคือแถวที่ Splunk คืนมาตามเดิม ไม่ตัด ไม่แปลความ — connector ไม่รู้ว่า field ไหนแปลว่าอะไร
(งานนั้นอยู่ที่ Backend) ใส่ `earliest`, `latest`, `count` ได้ (`count` ถูกจำกัดที่ `SPLUNK_MAX_COUNT`)

**ต่อ Splunk ได้ไหม** — `docker compose exec -T soc-mcp-splunk python check_connection.py`
บอกว่าตกที่ขั้นไหน (`reach` / `auth` / `search`) ดู [Splunk/README.md](../../MCP-Server/Splunk/README.md)

**index/sourcetype/field ที่ token นี้เห็นจริง** (ใช้ตอนเขียน catalogue)

```bash
docker run --rm --network soc-network curlimages/curl -s "http://soc-mcp-splunk:8200/catalog" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN"
```

**อ่านสถานะจาก HTTP code:** `400` = connector ปฏิเสธ SPL หรือ parameter (`error` บอกว่าเพราะอะไร),
`502` = Splunk มีปัญหา (`error` คือเหตุผลของ Splunk: ต่อไม่ได้ / token ถูกปฏิเสธ / ไม่มีสิทธิ์ค้น),
`401` = token ของ connector ผิด

---

## ชั้น 3 — ขั้น Splunk ของ Backend

ขั้นแรกใช้ agent สองตัวต่อกัน (ไม่มีตัวไหนมี tool): `soc-suggest` เขียน suggestion แล้ว `soc-requirements`
อ่าน suggestion กับ alert และเขียนว่าอยากถาม Splunk อะไร (ค่าละหนึ่งบรรทัด) จากนั้น Backend เอาแต่ละบรรทัดไป
เทียบ catalogue เขียน SPL เอง ขั้นที่สองรันเมื่อ analyst กดปุ่ม (หรืออัตโนมัติถ้า `SPLUNK_LOOKUP_MODE=auto`)
แล้ว agent ตัวที่สาม `soc-conclude` อ่านผลค้นคู่กับ suggestion เขียนบทวิเคราะห์ (`SPLUNK_LOOKUP_ANALYSE=true`)

```bash
# 1. ส่ง alert (API key) แล้วรอให้ขั้นแรกเสร็จ — ดู splunk_requirements ที่ job
curl -s localhost:8081/v1/results/<job_id> -H "X-API-Key: $KEY" | python3 -m json.tool

# 2. รันขั้น Splunk (JWT ของ user — ดู setup.md)
curl -s -X POST localhost:8081/v1/jobs/<job_id>/lookup -H "Authorization: Bearer $JWT"
curl -s localhost:8081/v1/jobs/<job_id> -H "Authorization: Bearer $JWT" \
  | python3 -c "
import json,sys
j=json.load(sys.stdin)
print(j['lookup_status'], j['lookup_time_ms'], 'ms')
for i, a in enumerate(j['lookup_result'] or [], 1):
    print(f'[{i}]', a['requirement'][:70])
    print('   spl:', a.get('spl'), '| count:', a.get('count'), '| error:', a.get('error'))
    print('   where:', a.get('index'), a.get('sourcetype'), a.get('fields'))
fa = j.get('final_analysis')
if fa: print(); print('analysis:', fa['status'], fa.get('error') or fa.get('reason') or ''); print(fa.get('text', ''))"
```

ดูค่าเหล่านี้ในแต่ละ requirement:

- `spl` — คำสั่งที่ Backend เขียนและ connector รันจริง เอาไปรันต่อใน Splunk ได้เลย (ทางสืบเชิงลึกที่เหลืออยู่คือคนทำต่อจากตรงนี้)
- `index` / `sourcetype` / `fields` — สิ่งที่ Backend วางแผนจาก catalogue ถ้าผิดที่นี่ ให้แก้ catalogue
- ข้อความ **`Not searched.`** — ไม่มีแผนที่แปลงเป็นการค้นได้ (ไม่มี field ใน catalogue สำหรับ indicator ชนิดนี้
  หรือไม่มี index) ไม่ใช่ว่าค้นแล้วไม่เจอ เพิ่ม field ใน catalogue หรือรันเองใน Splunk
- `error` — ค้นไม่สำเร็จ ถ้าเป็น `SPLUNK_ALLOWED_INDEXES is not set` แปลว่า `Backend/.env` ยังไม่ได้ตั้ง allowlist
  (Backend เขียน SPL เอง และปฏิเสธทุกการค้นถ้ารายการว่าง) นอกนั้นไปดูชั้น 2 ด้วย HTTP code ข้างบน

`final_analysis` (จาก `soc-conclude`):

- `status` เป็น `running` ตอนกำลังอ่านผล, `completed` มี `text`, `failed` มี `error` (ผลค้นยังอยู่ครบ), หรือ `skipped`
  พร้อม `reason` (ไม่มีการค้นที่สำเร็จเลย จึงไม่มีอะไรให้วิเคราะห์)
- `text` อ้างผลด้วย `[splunk N]` ตรงกับเลข `[N]` ในหน้า job — ไล่กลับไปหา search ที่มาของข้อความนั้นได้
- agent ตัวนี้ไม่มี tool ค้นเองไม่ได้ อ่านได้เฉพาะสิ่งที่ Backend ส่งให้ (alert, suggestion, ผลค้นที่ตัดแล้วไม่เกิน ~7000 ตัวอักษร)
- ถ้า worker ตายระหว่างวิเคราะห์ ค้างที่ `running` ไม่ได้: API จะรายงานเป็น `failed` เมื่อ lookup ไม่ได้ทำงานอยู่แล้ว

หน้า Evidence ของ job (dashboard) แสดงข้อมูลชุดเดียวกัน

---

## ทดสอบ guardrail — ของที่ต้อง "พัง"

ใช้ฟังก์ชัน `splunk` จากหัวข้อชั้น 2 ทุกข้อควรถูกปฏิเสธหรือถูกมองเป็นแค่ค่า ถ้าข้อไหนผ่านแปลว่ามีช่องโหว่

**คำสั่งที่ไม่ใช่การอ่านอย่างเดียว**

```bash
splunk '{"spl":"search index=\"main\" | delete"}'
```
```
{"error":"command 'delete' is not allowed; permitted: bin, head, makeresults, search, sort, stats, tstats"}     # HTTP 400
```

รายการคำสั่งที่อนุญาตสั้นโดยตั้งใจ (allowlist ไม่ใช่ denylist) เพราะคำสั่งที่เขียนหรือออกไปข้างนอกได้มีเยอะและเพิ่มทุก release

**SPL injection** — ค่าที่พยายามปิดเครื่องหมายคำพูดแล้วต่อคำสั่ง

```bash
splunk '{"spl":"search index=\"main\" action=\"blocked\\\" | delete | head 1\" | stats count | head 50"}'
```
```
{"results":[ ... ],"count":1,...}                                                                              # HTTP 200
```

ได้ผลปกติ: `"` ถูก escape เป็น `\"` ทั้งก้อนยังอยู่ในเครื่องหมายคำพูด `| delete` จึงเป็นข้อความที่ไม่ match
อะไร ไม่ใช่คำสั่ง connector ตัด literal ในเครื่องหมายคำพูดออกก่อนตรวจ จึงไม่เข้าใจผิดว่าเป็นคำสั่ง และก็ไม่พลาด
`| delete` จริงที่อยู่นอกเครื่องหมายคำพูด (ข้อบน)

**index นอก allowlist**

```bash
splunk '{"spl":"search index=\"_internal\" | head 1"}'
```
```
{"error":"index '_internal' is not allowed; permitted: main, notable"}                                         # HTTP 400
```

**index ที่เขียนให้หลุด allowlist** — `index=*`, `index=main` (ไม่มีเครื่องหมายคำพูด), `index IN (...)`, `index!=`

```bash
splunk '{"spl":"search index=* | head 1"}'
```
```
{"error":"an index must be written index=\"name\", quoted and exact"}                                          # HTTP 400
```

**subsearch / macro** — ซ่อน search ที่สองไว้ข้างใน

```bash
splunk '{"spl":"search index=\"main\" [search index=\"main\" | head 1]"}'
```
```
{"error":"subsearches and macros are not allowed"}                                                            # HTTP 400
```

**เพดานจำนวนแถว**

```bash
splunk '{"spl":"search index=\"main\" | head 9999","count":9999}'
```
```
{"results":[ ... ],"count":..., "limit":200}                       <- capped ที่ SPLUNK_MAX_COUNT
```

**auth** — token ผิดต้องไม่ผ่าน

```bash
docker run --rm --network soc-network curlimages/curl -s -w ' [%{http_code}]\n' \
  -X POST http://soc-mcp-splunk:8200/query -H 'Authorization: Bearer wrong-token' -d '{}'
```
```
{"detail":"unauthorized"} [401]
```

log ฝั่ง connector ควรมี:
```
{"logger":"auth","msg":"rejected unauthenticated request from …"}
```

ทุกข้อนี้มี test อัตโนมัติอยู่แล้วใน `MCP-Server/tests/` (`test_splunk_api.py`, `test_auth.py`) — คำสั่งด้านบนไว้ดูด้วยตา
ส่วนฝั่ง Backend การเขียน SPL (`spl.ts`) ถูกเทียบกับ `spl.py` เดิม 38 กรณี (ทั้ง SPL ที่ได้และข้อความที่ปฏิเสธ)
ตอนย้ายมา ให้ผลตรงกันทุกกรณี

---

## เตรียมข้อมูลทดสอบ

```bash
PW=$(cat <ที่เก็บรหัส>)
TS=$(docker exec soc-splunk date -u -d '-30 minutes' '+%Y-%m-%d %H:%M:%S')

curl -sk -u admin:"$PW" -X POST \
  "https://localhost:8089/services/receivers/simple?index=main&sourcetype=fortigate&source=manual-test" \
  --data-binary "date=${TS%% *} time=${TS##* } devname=\"FGT-01\" type=\"traffic\" level=\"alert\" srcip=10.1.100.11 dstip=45.83.122.9 dstport=443 action=\"blocked\" service=\"HTTPS\" user=\"jdoe\""
```

ตรวจว่าเข้าไปจริง:
```bash
curl -sk -u admin:"$PW" -X POST https://localhost:8089/services/search/jobs \
  --data-urlencode 'search=search index=main source=manual-test | eval t=strftime(_time,"%F %T") | table t srcip action' \
  --data-urlencode 'exec_mode=oneshot' --data-urlencode 'earliest_time=-7d' \
  --data-urlencode 'latest_time=+7d' --data-urlencode 'output_mode=json' \
  | python3 -c "import json,sys; [print(r) for r in json.load(sys.stdin)['results']]"
```

ใช้ `latest_time=+7d` ตอนตรวจ จะเห็น event ที่ timestamp เป็นอนาคตด้วย —
ถ้ามีโผล่มาแปลว่าเวลาที่ใส่ผิด

ตั้ง Splunk ทดสอบตั้งแต่ต้น: [`tokens.md`](tokens.md) หัวข้อ 6

---

## คำสั่งเช็กสถานะเร็วๆ

```bash
docker compose ps
curl -s localhost:8081/health    # core API  -> ai_service: up
docker exec soc-ai python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8100/health').read())"
                                 # ai-service -> llm_server: true (ไม่เปิด port แล้ว)
curl -s localhost:8000/          # Agent-Server (คนละ stack, publish port ตรง) -> {"status": "ok"}
docker compose exec soc-mcp-splunk python -c \
  "import urllib.request; print(urllib.request.urlopen('http://localhost:8200/health').read())"
                                 # connector  -> splunk: true

# ที่ Agent-Server เอง (ดู Agent-Server/readme.md):
#   docker compose logs -f dall-m-llamacpp   # model โหลด/ค้างใน memory ไหม
docker compose logs -f soc-mcp-splunk        # SPL ทุกอันที่ยิงจริงถูก log ไว้
```

log ของ connector บันทึก SPL ทุกครั้งที่ค้น — ตรวจย้อนได้ว่า Backend สั่งอะไรไป:

```
{"logger":"splunk","msg":"splunk search spl=search index=\"main\" | head 200 earliest=-24h latest=now"}
```
