import urllib.request
import re
import subprocess
import sys
import json
import os

url = "https://www.youtube.com/watch?v=A9pluEagLD4" # Waimushan
output_file = "data/snapshots/2026-08-26-sunrise-waimushan-peak.jpg"

cmd = [sys.executable, "-m", "yt_dlp", "-J", url]
res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
data = json.loads(res.stdout)

m3u8_url = data.get("manifest_url")
for f in data.get("formats", []):
    if f.get("format_id") in ["95", "96", "94", "93"] and f.get("url"):
        m3u8_url = f.get("url")
        break

req = urllib.request.Request(m3u8_url, headers={'User-Agent': 'Mozilla/5.0'})
with urllib.request.urlopen(req) as resp:
    content = resp.read().decode('utf-8')
    lines = [l for l in content.strip().split('\n') if l.startswith('http')]
    
    # Grab idx 790 (approx 05:32:30 peak sunrise)
    target_idx = 790
    seg_url = lines[target_idx]
    
    temp_ts = "waimushan_peak.ts"
    urllib.request.urlretrieve(seg_url, temp_ts)
    subprocess.run(["ffmpeg", "-y", "-i", temp_ts, "-vframes", "1", "-q:v", "2", output_file], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if os.path.exists(temp_ts):
        os.remove(temp_ts)
    print("Waimushan peak frame generated.")
