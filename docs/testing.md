# ทดสอบด้วยมือ — Splunk, MCP, Agent

เอกสารนี้สำหรับตอนคำตอบของ agent ดูผิด แล้วต้องหาว่าผิดตรงไหน

คำถามแรกไม่ใช่ "model คิดผิดหรือเปล่า" แต่คือ **"tool คืนค่าตรงที่เราคิดไหม"**
ซึ่งตอบได้โดยไม่ต้องใช้ model เลย

---

## 3 ชั้นที่แยกทดสอบได้

```
ชั้น 3   agent run            model เลือก tool เอง       -> ตอบ "ทั้งระบบทำงานไหม"
ชั้น 2   เรียก tool เอง       เราเลือก argument เอง      -> ตอบ "MCP แปลงถูกไหม"
ชั้น 1   ยิง Splunk ตรงๆ      เราเขียน SPL เอง           -> ตอบ "SPL ที่ถูกคืออะไร"
```

ไล่จากล่างขึ้นบน เจอความต่างระหว่างชั้นไหน ปัญหาอยู่ชั้นนั้น

| อาการ | แปลว่า |
| --- | --- |
| ชั้น 1 ได้ข้อมูล, ชั้น 2 ไม่ได้ | tool แปลง parameter เป็น SPL ผิด หรือ index ไม่อยู่ใน allowlist |
| ชั้น 2 ได้ข้อมูล, ชั้น 3 ไม่ได้ | model เรียก tool ด้วย argument ที่ผิด — ดู trace |
| ทั้งสามได้ข้อมูล แต่คำตอบผิด | model ตีความผิด — ปัญหาที่ system prompt |
| ชั้น 1 ก็ไม่ได้ | SPL ผิด หรือไม่มีข้อมูลจริง |

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

## ชั้น 2 — เรียก tool เองผ่าน MCP ไม่ใช้ model

**ไม่มี tool ไหนรับ SPL ดิบ** ทั้ง 4 ตัวสร้าง SPL เองจาก parameter ผ่าน
[`spl.py`](../mcp-server/Splunk/spl.py) นี่คือ safety boundary ทั้งหมดของ connector —
ถ้ามี tool รับ search string เมื่อไหร่ model ก็เรียกได้ด้วย แล้ว `| delete`
ก็กลับมาอยู่ในมือ model

สิ่งที่ทำได้คือเลือก tool และ argument เอง แล้วดู SPL ที่มันสร้าง

### แบบที่ 1 — ผ่าน HTTP (ง่ายสุด)

```bash
curl -s -X POST localhost:8400/mcp-servers/call \
  -H 'Content-Type: application/json' \
  -d '{"server":"splunk","tool":"search_events",
       "arguments":{"index":"main","earliest":"-24h",
                    "filters":{"action":"blocked"},"max_count":3}}' \
  | python3 -m json.tool
```

ได้ SPL ที่สร้างจริงกลับมาด้วย:

```json
{"is_error": false, "duration_ms": 677,
 "result": {"count": 3, "spl": "search index=\"main\" action=\"blocked\" | head 3",
            "events": [...]}}
```

ใน Swagger `/docs` ก็กด **Try it out** ได้เหมือนกัน

ดูว่า server publish tool อะไร พร้อม schema:

```bash
curl -s localhost:8400/mcp-servers/splunk/tools | python3 -m json.tool
```

### แบบที่ 2 — ยิง MCP ตรงๆ ด้วย curl

ไม่ต้องมี `llm-server` เลย ใช้ตอนสงสัยว่า `llm-server` เองเป็นตัวที่แปลงผิด

MCP server ของเราเป็น **stateless** (`stateless_http=True`) จึงยิง JSON-RPC
ก้อนเดียวได้เลย ไม่ต้อง `initialize` ก่อน

connector ไม่ publish port ออกนอก จึงต้องยิงจากใน network:

```bash
export MCP_AUTH_TOKEN='<ค่าใน .env>'

mcp() {
  docker run --rm --network soc-ai_soc-network curlimages/curl -s -X POST \
    http://soc-mcp-splunk:8200/mcp \
    -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "$1"
}
```

**ดูว่ามี tool อะไร พร้อม schema ที่ model เห็น**

```bash
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

ตอบกลับเป็น SSE บรรทัดเดียว — ตัด `data: ` ออกแล้วอ่านง่ายขึ้น:

```bash
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | sed -n 's/^data: //p' \
  | python3 -c "
import json,sys
for t in json.load(sys.stdin)['result']['tools']:
    schema = t['inputSchema']
    req = set(schema.get('required', []))
    args = ', '.join(f'{p}*' if p in req else p for p in schema.get('properties', {}))
    print(f\"{t['name']}({args})\")
print()
print('* = required')"
```

```
list_indexes()
search_events(index*, earliest, latest, sourcetype, host, filters, max_count)
alert_frequency(alert_name*, days)
related_events(indicator*, indicator_type*, earliest, latest, max_count)

* = required
```

**เรียก tool**

```bash
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
       "name":"search_events",
       "arguments":{"index":"main","earliest":"-24h",
                    "filters":{"action":"blocked"},"max_count":2}}}'
```

ผลลัพธ์ห่อสองชั้น (SSE แล้วก็ JSON-RPC) แกะออกมาดู SPL กับจำนวน:

```bash
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
       "name":"search_events",
       "arguments":{"index":"main","filters":{"action":"blocked"},"max_count":2}}}' \
  | sed -n 's/^data: //p' \
  | python3 -c "
import json,sys
r = json.load(sys.stdin)['result']
if r.get('isError'):
    print('TOOL ERROR:', r['content'][0]['text']); raise SystemExit(1)
payload = json.loads(r['content'][0]['text'])
print('SPL:', payload.get('spl'))
print('count:', payload.get('count'))
print(json.dumps(payload, indent=2, ensure_ascii=False)[:800])"
```

```
SPL: search index="main" action="blocked" | head 2
count: 2
```

> `sed -n 's/^data: //p'` คือส่วนที่แกะ SSE — คำตอบมาเป็น `event: message` ตามด้วย
> `data: {json}` ถ้าอยากเห็นดิบๆ ตัด pipe ท้ายออก

---

## ชั้น 3 — รัน agent เต็ม พร้อม trace

```bash
curl -s -X POST localhost:8400/agents/soc-triage/run \
  -H 'Content-Type: application/json' \
  -d '{"input":"Alert: srcip=10.1.100.11 action=blocked. Check index main.","save":false}' \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['status'], d['steps_used'], 'steps,', d['duration_ms'], 'ms')
for s in d['trace']:
    print(' ', s['step'], s['kind'], s.get('tool') or '', json.dumps(s.get('arguments') or {}))
print(); print(d['output'])"
```

**trace คือของสำคัญ** — บอกว่า model เรียก tool อะไร ด้วย argument อะไร
ได้กลับมากี่ตัวอักษร โดนตัดไหม

`"truncated": true` มักเป็นคำอธิบายของคำตอบที่ดูขาดๆ

ผ่าน `ai-service` (เหมือนที่ worker เรียกจริง):

```bash
curl -s -X POST localhost:8100/analyze \
  -H 'Content-Type: application/json' \
  -d '{"rendered_prompt":"Alert: … . Check index main."}'
```

หรือ `POST localhost:8100/llm-probe` ถ้าอยากเห็น raw SSE ที่ LLM Server ส่งมาด้วย

---

## ตัวอย่างจริง — หาสาเหตุที่ agent บอก "ไม่พบอะไร"

agent ตอบว่า *"No other events for host 10.1.100.11 in the last 24 hours"*

**ชั้น 3** ดู trace:
```
step 1  tool_call  search_events {"index":"main","host":"10.1.100.11","earliest":"-24h"}
```
model ใช้ parameter `host`

**ชั้น 2** ลองเอง:
```bash
… call search_events '{"index":"main","host":"10.1.100.11"}'
SPL: search index="main" host="10.1.100.11" | head 20
{"count": 0}
```
ได้ 0 เหมือนกัน แปลว่าไม่ใช่ model แต่งเรื่อง

**ชั้น 1** ถาม Splunk ว่า `host` คืออะไรจริงๆ:
```
host = 192.168.65.1        <- เครื่องที่ส่ง log เข้ามา
srcip = 10.1.100.11        <- IP ที่เราหมายถึง
```

**สรุป:** log FortiGate ดิบไม่ได้ normalize เป็น CIM — `host` ใน Splunk คือ forwarder
ไม่ใช่เครื่องต้นทาง ที่ถูกคือ `filters={"srcip":"10.1.100.11"}`

ปัญหาเดียวกันอยู่ใน `related_events` ซึ่ง hardcode ชื่อ CIM ไว้:
```
(src_ip="…" OR dest_ip="…" OR src="…" OR dest="…")
```

**แก้ที่ไหน:** field map ใน [`mcp-server/Splunk/server.py`](../mcp-server/Splunk/server.py)
ให้ตรงกับ sourcetype จริงขององค์กร

> นี่คือความผิดพลาดประเภทที่อันตรายที่สุด — ไม่มี error ให้เห็น agent รายงานว่า
> "ไม่พบอะไร" อย่างมั่นใจ แล้ว Tier 1 อ่านแล้วเชื่อ

---

## ทดสอบ guardrail — ของที่ต้อง "พัง"

ใช้ฟังก์ชัน `mcp` จากหัวข้อชั้น 2 ควรได้ error ทุกข้อ ถ้าข้อไหนผ่านแปลว่ามีช่องโหว่

ตัวช่วยอ่านผล:

```bash
check() { sed -n 's/^data: //p' | python3 -c "
import json,sys
r = json.load(sys.stdin)['result']
print('isError:', bool(r.get('isError')))
t = r['content'][0]['text']
try:
    p = json.loads(t); print('SPL:', p.get('spl')); print('count:', p.get('count'))
except ValueError:
    print(t[:200])"; }
```

**index นอก allowlist**

```bash
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
       "name":"search_events","arguments":{"index":"_internal","max_count":1}}}' | check
```
```
isError: True
Error executing tool search_events: index '_internal' is not allowed; permitted: main
```

**SPL injection** — ยัดคำสั่งลงใน value

```bash
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
       "name":"search_events","arguments":{"index":"main",
       "filters":{"action":"blocked\" | delete | head 1"},"max_count":2}}}' | check
```
```
isError: False
SPL: search index="main" action="blocked\" | delete | head 1" | head 2
count: 0
```

`"` ถูก escape เป็น `\"` ทั้งก้อนยังอยู่ในเครื่องหมายคำพูด `| delete` จึงเป็น
ข้อความที่ไม่ match อะไร ไม่ใช่คำสั่ง — **ดู `SPL:` ที่คืนมาเพื่อยืนยัน** ไม่ใช่ดูแค่
`count: 0`

**เพดานจำนวนแถว**

```bash
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
       "name":"search_events","arguments":{"index":"main","max_count":9999}}}' | check
```
```
SPL: search index="main" | head 200      <- capped ที่ SPLUNK_MAX_COUNT
```

**ช่วงเวลาเกินขอบ**

```bash
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
       "name":"alert_frequency","arguments":{"alert_name":"x","days":999}}}' | check
```
```
isError: True
Error executing tool alert_frequency: days must be between 1 and 90
```

**auth** — token ผิดต้องไม่ผ่าน

```bash
docker run --rm --network soc-ai_soc-network curlimages/curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://soc-mcp-splunk:8200/mcp \
  -H 'Authorization: Bearer wrong-token' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
```
401
```

log ฝั่ง connector ควรมี:
```
{"logger":"auth","msg":"rejected unauthenticated request from …"}
```

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
curl -s localhost:8000/health    # core API  -> ai_service: up
curl -s localhost:8100/health    # ai-service -> llm_server: true
curl -s localhost:8400/health    # llm-server -> ollama, agents, mcp_servers
docker compose exec soc-mcp-splunk python -c \
  "import urllib.request; print(urllib.request.urlopen('http://localhost:8200/health').read())"
                                 # connector  -> splunk: true

docker compose exec soc-ollama ollama ps     # model ค้างใน memory ไหม
docker compose logs -f soc-mcp-splunk        # SPL ทุกอันที่ยิงจริงถูก log ไว้
```

log ของ connector บันทึก SPL ทุกครั้งที่ค้น — ตรวจย้อนได้ว่า agent สั่งอะไรไป:

```
{"logger":"splunk","msg":"splunk search spl=search index=\"main\" | head 200 earliest=-24h latest=now"}
```
