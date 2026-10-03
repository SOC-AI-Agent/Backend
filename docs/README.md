# เอกสาร

| อ่านอันไหน | เมื่อ |
| --- | --- |
| **[setup.md](setup.md)** | ตั้งระบบตั้งแต่ศูนย์ |
| **[tokens.md](tokens.md)** | token แต่ละตัวมาจากไหน ใส่ตรงไหน เปลี่ยนยังไง |
| **[testing.md](testing.md)** | คำตอบของ agent ดูผิด ต้องหาว่าผิดตรงไหน |
| **[splunk-mcp.md](splunk-mcp.md)** | ต่อ Backend กับ Splunk ตัวจริงผ่าน MCP — ติดตั้งแอป, token, network/certificate, ตรวจ |
| **[splunk-catalog.md](splunk-catalog.md)** | เตรียม Splunk ก่อนใช้จริง — ดึง index/sourcetype/field มาให้ agent ค้นถูก |
| **[restructure.md](restructure.md)** | อะไรเปลี่ยนไปบ้าง และทำไม |

เอกสารของแต่ละ service อยู่ในโฟลเดอร์ของมันเอง:
[backend](../backend/README.md) ·
[ai-service](../ai-service/README.md) ·
[MCP Splunk (mock)](../../MCP-Server/Splunk/README.md) ·
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

**จะต่อ Splunk ตัวจริง** (lab หรือ production) → [splunk-mcp.md](splunk-mcp.md)

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
                       ┌────────────────────┤  stage 1 ก่อน model ทำงาน (โค้ดล้วน)
                       │  1. ดึง IOC จาก log
                       │  2. กรอง private/internal
                       │  3. ThreatQ lookup ─────────────► ThreatQ REST API (เรียกตรง)
                       │  4. match playbook ◄── soc-ai ◄── Confluence REST API (worker sync ตรง)
                       └────────────────────┤
                                            ▼
                            soc-ai ──► Agent-Server (suggestion, requirements)
                                            │
                       stage 2 (ปุ่ม / auto) ▼
                       requirement (ข้อความ) ──MCP──► saia_generate_spl ──► SPL
                                  spl-guard ตรวจ ──MCP──► splunk_run_query ──► Splunk
                       dev: soc-mcp-splunk (mock)   prod: Splunk MCP Server app
```

**สิ่งที่ deterministic อยู่ในโค้ด ไม่ใช่ใน model** — ดึง IOC, กรอง, lookup
ล้วนมีคำตอบเดียวที่ถูก ให้ model ทำคือเปิดโอกาสให้มันข้าม

**model ตัดสินใจเรื่องเดียว** — หลักฐานพอหรือยัง ต้องค้น log เพิ่มไหม

**model ของเราไม่เขียน query** — stage 2 ส่ง requirement เป็นข้อความให้ Text-to-SPL
ของ Splunk เขียน SPL แล้ว `spl-guard.ts` ตรวจก่อนรันทุกครั้ง (read-only — index ที่ค้นได้คุมด้วย role ของ token ใน Splunk)
เพราะ SPL เขียนและลบข้อมูลได้ และ alert text เป็นของที่ผู้โจมตีแต่งได้ — role ของ token
ใน Splunk ต้องเขียนไม่ได้อยู่ดี ดู [splunk-mcp.md](splunk-mcp.md) หัวข้อ 2

---

## `legacy-manual.md`

คู่มือชุดเดิมจากก่อนแยก backend — ยังอ้าง `soc-backend`, `soc-worker`,
`init_db.py` ซึ่ง**ไม่มีแล้ว** เก็บไว้อ้างอิงเท่านั้น ของที่ใช้ได้จริงอยู่ในไฟล์อื่น
