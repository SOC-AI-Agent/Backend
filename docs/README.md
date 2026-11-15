# เอกสาร

เอกสารชุดนี้เขียนสำหรับ **production** คือเครื่อง `10.40.35.18` ที่ deploy ผ่าน GitLab CI
ทุกขั้นตอนทำผ่าน CI variable และ job ในหน้า pipeline เท่านั้น ไม่มีขั้นตอนไหนต้องเข้า shell
ของเครื่อง

| อ่านอันไหน | เมื่อ |
| --- | --- |
| **[setup.md](setup.md)** | ขึ้นระบบบน production ตั้งแต่ศูนย์: ลำดับ deploy, CI variable, agent, alert แรก |
| **[tokens.md](tokens.md)** | token แต่ละตัวมาจากไหน ตั้งเป็น CI variable ชื่ออะไร เปลี่ยนยังไง |
| **[splunk-mcp.md](splunk-mcp.md)** | ต่อ stage 2 กับ Splunk: แอป, service account, network, certificate, job `check_splunk` |
| **[splunk-catalog.md](splunk-catalog.md)** | ดึง index/sourcetype/field จาก Splunk ด้วย job `export_catalog` ให้ agent ค้นถูกที่ |
| **[testing.md](testing.md)** | ผลค้น Splunk ดูผิด ต้องไล่ว่าผิดที่ชั้นไหน |
| [restructure.md](restructure.md) | บันทึกการปรับโครงสร้างครั้งก่อน ๆ ว่าเปลี่ยนอะไรและทำไม |
| [legacy-manual.md](legacy-manual.md) | คู่มือของระบบ FastAPI เดิม เก็บไว้อ้างอิงเท่านั้น |

repo อื่นของระบบอยู่ในกลุ่มเดียวกันบน GitLab และมี README ของตัวเอง ได้แก่ **AI-Service**,
**Agent-Server** และ **Frontend**

---

## เริ่มจากตรงไหน

**ขึ้นระบบครั้งแรก** → [setup.md](setup.md)

**ระบบขึ้นแล้วแต่ job วิเคราะห์ fail** → เช็กว่าใน Agent-Server มี agent ชื่อตรงกับ
`LLM_SUGGEST_AGENT` แล้วหรือยัง ([setup.md ข้อ 4](setup.md#4-สร้าง-agent-ใน-agent-server))
นี่คือสาเหตุที่พบบ่อยที่สุด

**job `check_splunk` ขึ้น ⚠** → อ่าน log ของ job แล้วเทียบกับตารางใน
[splunk-mcp.md ข้อ 5](splunk-mcp.md#5-ตรวจว่าใช้ได้-job-check_splunk)

**agent ตอบว่า "ไม่พบอะไร" ทั้งที่รู้ว่ามีข้อมูล** → ชื่อ field ผิด ดู
[splunk-catalog.md](splunk-catalog.md) แล้วไล่ตรวจทีละชั้นด้วย [testing.md](testing.md)

**จะเปิดใช้กับข้อมูลจริง** → [setup.md หัวข้อก่อนเปิดใช้จริง](setup.md#ก่อนเปิดใช้จริง)
และ [tokens.md หัวข้อสิทธิ์ของ token](tokens.md)

---

## ระบบทำงานยังไง

```
FortiSOAR ──► soc-core-api ──► BullMQ ──► soc-core-worker
                                            │
                       ┌────────────────────┤  stage 1 ก่อน model ทำงาน (โค้ดล้วน)
                       │  1. ดึง IOC จาก log
                       │  2. กรอง private/internal
                       │  3. ThreatQ lookup ─────────────► ThreatQ REST API (เรียกตรง)
                       │  4. match playbook ◄── soc-ai ◄── Confluence REST API (worker sync ตรง)
                       └────────────────────┤
                                            ▼
                    soc-ai ──► Agent-Server: soc-suggest (suggestion), soc-requirements (คำถามถึง Splunk)
                                            │
                       stage 2 (ปุ่ม / auto) ▼
                       requirement ──MCP──► splunk_lookup (connector soc-mcp-splunk, repo MCP-Server)
                                            │   connector: prompt ──► Text-to-SPL ──► ตรวจ ──► รันบน Splunk
                                            │   (Splunk container, หรือ Splunk ของบริษัท)
                                            ▼
                    soc-ai ──► Agent-Server: soc-conclude (บทวิเคราะห์จากผลค้น)
```

**สิ่งที่ deterministic อยู่ในโค้ด ไม่ใช่ใน model** — ดึง IOC, กรอง, lookup
ล้วนมีคำตอบเดียวที่ถูก ให้ model ทำคือเปิดโอกาสให้มันข้าม

**model ตัดสินใจเรื่องเดียว** — หลักฐานพอหรือยัง ต้องค้น log เพิ่มไหม

**model ของเราไม่เขียน query** — stage 2 ส่ง requirement เป็นข้อความให้ Text-to-SPL
ของ Splunk เขียน SPL แล้ว `spl.check_readonly` ของ connector ตรวจก่อนรันทุกครั้ง (อ่านอย่างเดียว) เพราะ SPL เขียน
และลบข้อมูลได้ และ alert text เป็นของที่ผู้โจมตีแต่งได้ index ที่ค้นได้คุมด้วย role ของ token
ใน Splunk ซึ่งต้องเขียนข้อมูลไม่ได้อยู่ดี ดู [splunk-mcp.md](splunk-mcp.md) หัวข้อ 2

**agent ทั้งสามไม่มี tool** — อ่านได้เฉพาะสิ่งที่ Backend ส่งให้ และไม่ต่อ MCP server ตัวไหน
