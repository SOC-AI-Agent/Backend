# เอกสาร

| อ่านอันไหน | เมื่อ |
| --- | --- |
| **[setup.md](setup.md)** | ตั้งระบบตั้งแต่ศูนย์ |
| **[tokens.md](tokens.md)** | token แต่ละตัวมาจากไหน ใส่ตรงไหน เปลี่ยนยังไง |
| **[testing.md](testing.md)** | คำตอบของ agent ดูผิด ต้องหาว่าผิดตรงไหน |
| **[splunk-catalog.md](splunk-catalog.md)** | เตรียม Splunk ก่อนใช้จริง — ดึง index/sourcetype/field มาให้ agent ค้นถูก |
| **[restructure.md](restructure.md)** | อะไรเปลี่ยนไปบ้าง และทำไม |

เอกสารของแต่ละ service อยู่ในโฟลเดอร์ของมันเอง:
[backend](../backend/README.md) ·
[ai-service](../ai-service/README.md) ·
[MCP Splunk](../mcp-server/Splunk/README.md) ·
[MCP ThreatQ](../mcp-server/Threatq/README.md) ·
[Agent-Server](../../Agent-Server/readme.md) (agent platform — repo แยก คนละ network, ดู `ai-service/README.md` หัวข้อ "Agent-Server")

---

## เริ่มจากตรงไหน

**เพิ่งมาใหม่** → [setup.md](setup.md) แล้วยิง alert แรกตามข้อ 7

**ระบบขึ้นแล้วแต่ job fail** → เช็กว่ามี agent ชื่อตรงกับ `LLM_DEFAULT_AGENT`
หรือยัง ([setup.md ข้อ 5](setup.md)) นี่คือสาเหตุที่พบบ่อยที่สุด

**agent ตอบว่า "ไม่พบอะไร" ทั้งที่รู้ว่ามีข้อมูล** → ชื่อ field ผิด
[splunk-catalog.md](splunk-catalog.md) แล้วไล่ตรวจทีละชั้นด้วย
[testing.md](testing.md)

**จะเอาขึ้น production** → [setup.md ท้ายไฟล์](setup.md) กับ
[tokens.md หัวข้อสิทธิ์](tokens.md)

---

## ระบบทำงานยังไง

> ⚠️ **ไดอะแกรมนี้เก่ากว่า restructure.md รอบล่าสุด** — วาดไว้ตอน agent ยังเรียก
> MCP tool ค้น Splunk เองผ่าน `LLM Server`/Ollama ปัจจุบัน Splunk ไม่ผ่าน MCP
> แล้ว (Backend เขียน SPL เอง ส่งตรงไป connector) agent มี 3 ตัวไม่มี tool เลย
> และ agent platform คือ `Agent-Server` (repo แยก ไม่ใช่ `LLM Server`/Ollama) —
> ดู [[soc-flow-design]] ในความจำ หรือ `restructure.md` รอบล่าสุดสำหรับของจริง

```
FortiSOAR ──► soc-core-api ──► BullMQ ──► worker
                                            │
                       ┌────────────────────┤  ก่อน model ทำงาน (โค้ดล้วน)
                       │  1. ดึง IOC จาก log
                       │  2. กรอง private/internal
                       │  3. ThreatQ lookup
                       └────────────────────┤
                                            ▼
                            soc-ai ══SSE══► LLM Server
                                               │        │
                                     /api/chat │        │ MCP
                                               ▼        ▼
                                         soc-ollama   soc-mcp-splunk ──► Splunk
                                                      soc-mcp-threatq ─► ThreatQ
```

**สิ่งที่ deterministic อยู่ในโค้ด ไม่ใช่ใน model** — ดึง IOC, กรอง, lookup
ล้วนมีคำตอบเดียวที่ถูก ให้ model ทำคือเปิดโอกาสให้มันข้าม

**model ตัดสินใจเรื่องเดียว** — หลักฐานพอหรือยัง ต้องค้น log เพิ่มไหม

**model ไม่เคยเขียน query** — tool รับ parameter แบบ structured แล้ว `spl.py`
ประกอบ SPL เอง SPL เขียนและลบข้อมูลได้ และ alert text เป็นของที่ผู้โจมตีแต่งได้

---

## `legacy-manual.md`

คู่มือชุดเดิมจากก่อนแยก backend — ยังอ้าง `soc-backend`, `soc-worker`,
`init_db.py` ซึ่ง**ไม่มีแล้ว** เก็บไว้อ้างอิงเท่านั้น ของที่ใช้ได้จริงอยู่ในไฟล์อื่น
