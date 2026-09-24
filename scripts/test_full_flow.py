import os
import requests
import time
import json
import sys

# ตั้งค่าการแสดงผลให้รองรับ UTF-8 (สำหรับ Windows Terminal)
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# --- CONFIGURATION ---
API_KEY = os.environ.get("SOC_API_KEY", "")
if not API_KEY:
    sys.exit("set SOC_API_KEY — issue one on the API Keys page, or with "
             "POST /admin/api-keys using an admin JWT")
BASE_URL = os.environ.get("SOC_BASE_URL", "http://localhost:8081")
ANALYZE_URL = f"{BASE_URL}/v1/analyze"
RESULTS_URL = f"{BASE_URL}/v1/results"

HEADERS = {
    "X-API-Key": API_KEY,
    "Content-Type": "application/json"
}

# --- RAW LOG ---
RAW_LOG = 'date=2019-05-10 time=11:37:47 logid="0000000013" type="traffic" subtype="forward" level="notice" vd="vdom1" eventtime=1557513467369913239 srcip=10.1.100.11 srcport=58012 srcintf="port12" srcintfrole="undefined" dstip=23.59.154.35 dstport=80 dstintf="port11" dstintfrole="undefined" srcuuid="ae28f494-5735-51e9-f247-d1d2ce663f4b" dstuuid="ae28f494-5735-51e9-f247-d1d2ce663f4b" poluuid="ccb269e0-5735-51e9-a218-a397dd08b7eb" sessionid=105048 proto=6 action="close" policyid=1 policytype="policy" service="HTTP" dstcountry="Canada" srccountry="Reserved" trandisp="snat" transip=172.16.200.2 transport=58012 appid=34050 app="HTTP.BROWSER_Firefox" appcat="Web.Client" apprisk="elevated" applist="g-default" duration=116 sentbyte=1188 rcvdbyte=1224 sentpkt=17 rcvdpkt=16 utmaction="allow" countapp=1 osname="Ubuntu" mastersrcmac="a2:e9:00:ec:40:01" srcmac="a2:e9:00:ec:40:01" srcserver=0 utmref=65500-742'

# --- NEW JSON PROMPT ---
# เราสั่งให้ AI ตอบเป็น JSON และระบุหัวข้อที่ Tier 1 ต้องรู้
SYSTEM_INSTRUCTION = """
Analyze the security log provided. Your response must be in valid JSON format only.
Include the following fields:
- is_threat: (boolean)
- severity: (Low, Medium, High, Critical)
- analysis_summary: (Short summary of what happened)
- tier1_steps: (List of 3-5 specific actionable steps for a Tier 1 analyst)
- recommendation: (Final decision: e.g. Close, Escalate, Block)
"""

PAYLOAD = {
    "alert_id": "TEST-JSON-OUT-001",
    "alert_name": "Tier 1 Guidance Test",
    "raw_log": RAW_LOG,
    "prompt": SYSTEM_INSTRUCTION
}

def run_test():
    # 1. ส่งคำขอวิเคราะห์
    print(f"[*] Sending JSON-Mode request for Alert: {PAYLOAD['alert_id']}...")
    try:
        resp = requests.post(ANALYZE_URL, headers=HEADERS, json=PAYLOAD)
        resp.raise_for_status()
        job_id = resp.json().get("job_id")
        print(f"[+] Request Sent! Job ID: {job_id}")
    except Exception as e:
        print(f"[!] Error: {e}")
        return

    # 2. Polling รับผล
    print("[*] Waiting for JSON output...")
    max_retries = 60
    attempts = 0
    
    while attempts < max_retries:
        try:
            res_resp = requests.get(f"{RESULTS_URL}/{job_id}", headers=HEADERS)
            res_resp.raise_for_status()
            result = res_resp.json()
            
            if result.get("status") == "completed":
                # พยายาม Parse JSON จาก AI
                ai_text = result.get('ai_response', '')
                
                print("\n" + "="*60)
                print("✅ AI ANALYSIS COMPLETED (JSON MODE)")
                print("="*60)
                
                try:
                    # AI บางทีอาจจะมีตัวอักษรอื่นปนมา เราจะพยายามดึงเฉพาะก้อน JSON
                    json_start = ai_text.find('{')
                    json_end = ai_text.rfind('}') + 1
                    ai_json = json.loads(ai_text[json_start:json_end])
                    
                    print(f"🔥 Severity: {ai_json.get('severity')}")
                    print(f"📝 Summary: {ai_json.get('analysis_summary')}")
                    print(f"\n📢 Tier 1 Instructions:")
                    for idx, step in enumerate(ai_json.get('tier1_steps', []), 1):
                        print(f"   {idx}. {step}")
                    
                    print(f"\n💡 Recommendation: {ai_json.get('recommendation')}")
                    
                except Exception as json_err:
                    print(f"[!] Error parsing AI JSON: {json_err}")
                    print(f"Raw Output: {ai_text}")

                print("="*60)
                break
                
            elif result.get("status") == "failed":
                print(f"[!] Failed: {result.get('error_message')}")
                break
                
        except Exception as e:
            print(f"[!] Polling Error: {e}")
            break
            
        attempts += 1
        time.sleep(2)

if __name__ == "__main__":
    run_test()
