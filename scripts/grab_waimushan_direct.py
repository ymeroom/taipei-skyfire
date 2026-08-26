import urllib.request
import re
import subprocess
import sys
import json
import os
import datetime

url = "https://www.youtube.com/watch?v=A9pluEagLD4" # Waimushan
output_file = "data/snapshots/2026-08-26-sunrise-waimushan.jpg"

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
    
    # 05:30 sunrise target
    now = datetime.datetime.now()
    target_dt = now.replace(hour=5, minute=30, second=0, microsecond=0)
    seconds_ago = (now - target_dt).total_seconds()
    
    # Total duration covered by lines: len(lines) * 5.133
    total_secs = len(lines) * 5.133
    secs_from_start = max(0, total_secs - seconds_ago)
    target_idx = int(secs_from_start / 5.133)
    target_idx = max(0, min(len(lines)-1, target_idx))
    
    seg_url = lines[target_idx]
    print(f"Targeting Waimushan 05:30 (idx {target_idx}/{len(lines)}):")
    print(seg_url[:120])
    
    temp_ts = "waimushan_temp.ts"
    urllib.request.urlretrieve(seg_url, temp_ts)
    subprocess.run(["ffmpeg", "-y", "-i", temp_ts, "-vframes", "1", "-q:v", "2", output_file], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if os.path.exists(temp_ts):
        os.remove(temp_ts)
    if os.path.exists(output_file):
        print(f"✅ Success Waimushan sunrise frame: {os.path.getsize(output_file)} bytes")
