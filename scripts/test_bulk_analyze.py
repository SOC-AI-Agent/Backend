import requests
import time
import json
import os
import sys

# ตั้งค่าแสดงผลภาษาไทย/UTF-8 สำหรับ Windows
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# --- CONFIGURATION ---
API_KEY = os.environ.get("SOC_API_KEY", "")
if not API_KEY:
    sys.exit("set SOC_API_KEY — issue one on the API Keys page, or with "
             "POST /admin/api-keys using an admin JWT")
BASE_URL = os.environ.get("SOC_BASE_URL", "http://localhost:8000")
ANALYZE_URL = f"{BASE_URL}/v1/analyze"
RESULTS_URL = f"{BASE_URL}/v1/results"
PAYLOAD_FILE = "test_payloads.json"

HEADERS = {
    "X-API-Key": API_KEY,
    "Content-Type": "application/json"
}

def run_bulk_test():
    if not os.path.exists(PAYLOAD_FILE):
        print(f"[!] Error: {PAYLOAD_FILE} not found.")
        return

    with open(PAYLOAD_FILE, "r", encoding="utf-8") as f:
        payloads = json.load(f)

    active_jobs = []
    
    print(f"[*] Starting Bulk Test with {len(payloads)} payloads...")
    
    # 1. Submit all jobs
    for p in payloads:
        try:
            resp = requests.post(ANALYZE_URL, headers=HEADERS, json=p)
            resp.raise_for_status()
            job_id = resp.json().get("job_id")
            active_jobs.append({"job_id": job_id, "alert_name": p["alert_name"], "status": "pending", "result": None})
            print(f"    [+] Queued: {p['alert_name']} (Job: {job_id[:8]}...)")
        except Exception as e:
            print(f"    [!] Failed to queue {p['alert_name']}: {e}")

    # 2. Quiet Polling
    print("\n[*] Processing jobs... Please wait.")
    start_time = time.time()
    
    while True:
        completed_count = 0
        for job in active_jobs:
            if job["status"] in ["completed", "failed"]:
                completed_count += 1
                continue
            
            try:
                res_resp = requests.get(f"{RESULTS_URL}/{job['job_id']}", headers=HEADERS)
                if res_resp.status_code == 200:
                    data = res_resp.json()
                    job["status"] = data.get("status")
                    if job["status"] == "completed":
                        job["result"] = data
                    elif job["status"] == "failed":
                        job["error"] = data.get("error_message")
            except:
                pass

        # Update progress on same line
        elapsed = int(time.time() - start_time)
        sys.stdout.write(f"\r    > Progress: {completed_count}/{len(active_jobs)} finished | Elapsed: {elapsed}s | Status: {'Running...' if completed_count < len(active_jobs) else 'Done!'}")
        sys.stdout.flush()

        if completed_count == len(active_jobs):
            break
        
        time.sleep(3) # ถามทุก 3 วินาที

    # 3. Final Summary Output
    print("\n\n" + "="*80)
    print("      FINAL SOC AI BULK ANALYSIS SUMMARY")
    print("="*80)

    for job in active_jobs:
        print(f"\n[{job['alert_name']}]")
        if job["status"] == "completed":
            res = job["result"]
            ai_text = res.get("ai_response", "")
            
            # Try to parse JSON from AI response
            try:
                json_start = ai_text.find('{')
                json_end = ai_text.rfind('}') + 1
                ai_json = json.loads(ai_text[json_start:json_end])
                
                sev = ai_json.get("severity", "N/A").upper()
                print(f"  🔥 SEVERITY: {sev}")
                print(f"  📝 SUMMARY : {ai_json.get('analysis_summary')}")
                print(f"  📢 TIER 1  : {', '.join(ai_json.get('tier1_steps', []))[:100]}...")
                print(f"  💡 RECOMM  : {ai_json.get('recommendation')}")
                print(f"  ⏱  TIME    : {res.get('processing_time_ms')}ms")
            except:
                # If not JSON, print snippet of raw text
                print(f"  📄 RAW AI  : {ai_text[:200].replace('\n', ' ')}...")
        else:
            print(f"  ❌ FAILED  : {job.get('error', 'Unknown Error')}")
        
        print("-" * 40)

    print(f"\n[*] Bulk Test Completed. Total time: {int(time.time() - start_time)}s")

if __name__ == "__main__":
    run_bulk_test()
