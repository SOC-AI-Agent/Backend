# ทดสอบด้วยมือ — Splunk

เอกสารนี้สำหรับตอนผลค้น Splunk ดูผิด แล้วต้องหาว่าผิดตรงไหน

Splunk ไม่ผ่าน MCP และไม่ผ่าน model แล้ว — Backend วางแผนการค้นจาก catalogue
แล้วยิง connector (`soc-mcp-splunk`) ตรงๆ ผ่าน HTTP ดังนั้นคำถามแรกคือ
**"connector คืนค่าตรงที่เราคิดไหม"** ซึ่งตอบได้โดยไม่ต้องใช้ model เลย

---

## 3 ชั้นที่แยกทดสอบได้

```
ชั้น 3   ขั้น Splunk ของ Backend   Backend วางแผน แล้วยิง connector  -> ตอบ "ทั้งระบบทำงานไหม"
ชั้น 2   เรียก connector เอง       เราเลือก parameter เอง            -> ตอบ "route แปลงเป็น SPL ถูกไหม"
ชั้น 1   ยิง Splunk ตรงๆ           เราเขียน SPL เอง                  -> ตอบ "SPL ที่ถูกคืออะไร"
```

ไล่จากล่างขึ้นบน เจอความต่างระหว่างชั้นไหน ปัญหาอยู่ชั้นนั้น

| อาการ | แปลว่า |
| --- | --- |
| ชั้น 1 ได้ข้อมูล, ชั้น 2 ไม่ได้ | route แปลง parameter เป็น SPL ผิด, index ไม่อยู่ใน allowlist, หรือ field ที่ส่งไปไม่ใช่ field ที่ข้อมูลใช้จริง |
| ชั้น 2 ได้ข้อมูล, ชั้น 3 ไม่ได้ | Backend วางแผนผิด — ดู `index`, `sourcetype`, `fields` และ `spl` ใน `lookup_result` (ปัญหาอยู่ที่ catalogue หรือตารางคำถาม) |
| ทั้งสามได้ข้อมูล แต่ analyst อ่านผิด | การ render คำตอบหรือ prompt ฝั่ง Backend ไม่ใช่ Splunk |
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

**ไม่มี route ไหนรับ SPL ดิบ** ทุก route สร้าง SPL เองจาก parameter ผ่าน
[`spl.py`](../../MCP-Server/Splunk/spl.py) นี่คือ safety boundary ทั้งหมดของ connector

connector ไม่ publish port ออกนอก จึงต้องยิงจากใน network:

```bash
export MCP_AUTH_TOKEN='<ค่าใน MCP-Server/.env>'

splunk() {   # splunk <path> '<json>'
  docker run --rm --network soc-network curlimages/curl -s -X POST \
    "http://soc-mcp-splunk:8200$1" \
    -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$2"
}
```

**`/search` — indicator หนึ่งตัวใน field ที่เก็บมัน** (สิ่งที่ Backend ยิงจริง)

```bash
splunk /search '{"indicator":"10.1.100.11","indicator_type":"ip",
                 "fields":["srcip","dstip"],"index":"main"}' | python3 -m json.tool
```

ได้ SPL ที่สร้างจริงกลับมาด้วย:

```
"spl": "search index=\"main\" (srcip=\"10.1.100.11\" OR dstip=\"10.1.100.11\") | head 20"
```

ผลมี `count`, `capped` (ถึงเพดานแล้วหรือยัง), `fields_searched`, `events[].matched_on`
(event นี้ match ด้วย field ไหน — บอกว่าเป็นขาออกหรือขาเข้า) และ `spl`

**`/summarise` — นับ/จัดกลุ่มแทนการลิสต์**

```bash
splunk /summarise '{"index":"main","filters":{"srcip":"10.1.100.11"},
                    "group_by":["dstip"],"metrics":[{"fn":"count"}],"sort":"-count"}'
```

**`/frequency` — alert นี้ยิงบ่อยแค่ไหน**

```bash
splunk /frequency '{"alert_name":"<ชื่อ alert ตามที่ Splunk เก็บ>","days":7}'
```

`SPLUNK_ALERT_INDEX` (default `notable`) ต้องอยู่ใน `SPLUNK_ALLOWED_INDEXES` ด้วย ไม่งั้นได้ 400

**`/catalog` — index/sourcetype/field ที่ token นี้เห็นจริง** (ใช้ตอนเขียน catalogue)

```bash
docker run --rm --network soc-network curlimages/curl -s "http://soc-mcp-splunk:8200/catalog" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN"
```

**ต่อ Splunk ได้ไหม** — `docker compose exec -T soc-mcp-splunk python check_connection.py`
บอกว่าตกที่ขั้นไหน (`reach` / `auth` / `search`) ดู [Splunk/README.md](../../MCP-Server/Splunk/README.md)

**อ่านสถานะจาก HTTP code:** `400` = request ของเราผิด (`error` บอกว่าค่าไหน),
`502` = Splunk มีปัญหา (`error` คือเหตุผลของ Splunk: ต่อไม่ได้ / token ถูกปฏิเสธ / ไม่มีสิทธิ์ค้น),
`401` = token ของ connector ผิด

---

## ชั้น 3 — ขั้น Splunk ของ Backend

ขั้นแรก (agent `soc-suggest`) เขียน requirement เก็บไว้ที่ job; ขั้นที่สองรันมันเมื่อ analyst กดปุ่ม
(หรืออัตโนมัติถ้า `SPLUNK_LOOKUP_MODE=auto`) — ไม่มี agent ในขั้นนี้

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
for a in j['lookup_result'] or []:
    print('-', a['requirement'][:70])
    print('   spl:', a.get('spl'), '| count:', a.get('count'), '| error:', a.get('error'))
    print('   where:', a.get('index'), a.get('sourcetype'), a.get('fields'))"
```

ดูค่าเหล่านี้ในแต่ละ requirement:

- `spl` — คำสั่งที่ยิงจริง เอาไปรันต่อใน Splunk ได้เลย (ทางสืบเชิงลึกที่เหลืออยู่คือคนทำต่อจากตรงนี้)
- `index` / `sourcetype` / `fields` — สิ่งที่ Backend วางแผนจาก catalogue ถ้าผิดที่นี่ ให้แก้ catalogue
- ข้อความ **`Not searched.`** — ไม่มีแผนที่แปลงเป็นการค้นได้ (ไม่มี field ใน catalogue สำหรับ indicator ชนิดนี้
  หรือไม่มี index) ไม่ใช่ว่าค้นแล้วไม่เจอ เพิ่ม field ใน catalogue หรือรันเองใน Splunk
- `error` — ยิง connector ไม่สำเร็จ ไปดูชั้น 2 ด้วย HTTP code ข้างบน
- `ranBy` เป็น `backend` เสมอ (`agent` มีในงานเก่าที่เก็บไว้ก่อนเอา query agent ออก)

หน้า Evidence ของ job (dashboard) แสดงข้อมูลชุดเดียวกัน

---

## ทดสอบ guardrail — ของที่ต้อง "พัง"

ใช้ฟังก์ชัน `splunk` จากหัวข้อชั้น 2 ทุกข้อควรถูกปฏิเสธหรือถูก escape ถ้าข้อไหนผ่านแปลว่ามีช่องโหว่

**index นอก allowlist**

```bash
splunk /search '{"indicator":"10.1.100.11","indicator_type":"ip","fields":["srcip"],"index":"_internal"}'
```
```
{"error":"index '_internal' is not allowed; permitted: main, notable"}     # HTTP 400
```

**SPL injection** — ยัดคำสั่งลงใน value

```bash
splunk /summarise '{"index":"main","filters":{"action":"blocked\" | delete | head 1"},"metrics":[{"fn":"count"}]}'
```
```
"spl": "search index=\"main\" action=\"blocked\\\" | delete | head 1\" | stats count | head 50"
```

`"` ถูก escape เป็น `\"` ทั้งก้อนยังอยู่ในเครื่องหมายคำพูด `| delete` จึงเป็นข้อความ
ที่ไม่ match อะไร ไม่ใช่คำสั่ง — **ดู `spl` ที่คืนมาเพื่อยืนยัน** ไม่ใช่ดูแค่จำนวนผลลัพธ์

**เพดานจำนวนแถว**

```bash
splunk /summarise '{"index":"main","max_rows":9999}'
```
```
"limit": 200,  "spl": "search index=\"main\" | stats count | head 200"     <- capped ที่ SPLUNK_MAX_COUNT
```

**ช่วงเวลาเกินขอบ**

```bash
splunk /frequency '{"alert_name":"x","days":999}'
```
```
{"error":"days must be between 1 and 90"}                                  # HTTP 400
```

**auth** — token ผิดต้องไม่ผ่าน

```bash
docker run --rm --network soc-network curlimages/curl -s -w ' [%{http_code}]\n' \
  -X POST http://soc-mcp-splunk:8200/search -H 'Authorization: Bearer wrong-token' -d '{}'
```
```
{"detail":"unauthorized"} [401]
```

log ฝั่ง connector ควรมี:
```
{"logger":"auth","msg":"rejected unauthenticated request from …"}
```

ทุกข้อนี้มี test อัตโนมัติอยู่แล้วใน `MCP-Server/tests/` (`test_splunk_api.py`, `test_auth.py`) — คำสั่งด้านบนไว้ดูด้วยตา

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
curl -s localhost:8100/health    # ai-service -> llm_server: true
curl -s localhost:8400/health    # llm-server -> ollama, agents
docker compose exec soc-mcp-splunk python -c \
  "import urllib.request; print(urllib.request.urlopen('http://localhost:8200/health').read())"
                                 # connector  -> splunk: true

docker compose exec soc-ollama ollama ps     # model ค้างใน memory ไหม
docker compose logs -f soc-mcp-splunk        # SPL ทุกอันที่ยิงจริงถูก log ไว้
```

log ของ connector บันทึก SPL ทุกครั้งที่ค้น — ตรวจย้อนได้ว่า Backend สั่งอะไรไป:

```
{"logger":"splunk","msg":"splunk search spl=search index=\"main\" | head 200 earliest=-24h latest=now"}
```
