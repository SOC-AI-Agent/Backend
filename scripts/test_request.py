import os
import sys

import requests
import json

API_KEY = os.environ.get("SOC_API_KEY", "")
if not API_KEY:
    sys.exit("set SOC_API_KEY — issue one on the API Keys page, or with "
             "POST /admin/api-keys using an admin JWT")

url = os.environ.get("SOC_BASE_URL", "http://localhost:8081") + "/v1/analyze"
headers = {
    "X-API-Key": API_KEY,
    "Content-Type": "application/json"
}
payload = {
    "alert_id": "TEST-SUCCESS-001",
    "alert_name": "Test Successful Job",
    "raw_log": 'date=2019-05-10 time=11:37:47 logid="0000000013" type="traffic" subtype="forward" level="notice" vd="vdom1" eventtime=1557513467369913239 srcip=10.1.100.11 srcport=58012 srcintf="port12" srcintfrole="undefined" dstip=23.59.154.35 dstport=80 dstintf="port11" dstintfrole="undefined" srcuuid="ae28f494-5735-51e9-f247-d1d2ce663f4b" dstuuid="ae28f494-5735-51e9-f247-d1d2ce663f4b" poluuid="ccb269e0-5735-51e9-a218-a397dd08b7eb" sessionid=105048 proto=6 action="close" policyid=1 policytype="policy" service="HTTP" dstcountry="Canada" srccountry="Reserved" trandisp="snat" transip=172.16.200.2 transport=58012 appid=34050 app="HTTP.BROWSER_Firefox" appcat="Web.Client" apprisk="elevated" applist="g-default" duration=116 sentbyte=1188 rcvdbyte=1224 sentpkt=17 rcvdpkt=16 utmaction="allow" countapp=1 osname="Ubuntu" mastersrcmac="a2:e9:00:ec:40:01" srcmac="a2:e9:00:ec:40:01" srcserver=0 utmref=65500-742',
    "prompt": "Analyze if this is malicious. Provide a brief summary and suggest the next steps."
}

try:
    response = requests.post(url, headers=headers, json=payload)
    print(f"Status Code: {response.status_code}")
    print(f"Response: {response.text}")
except Exception as e:
    print(f"Error: {e}")
