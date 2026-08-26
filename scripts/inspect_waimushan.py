import urllib.request
import re
import subprocess
import sys
import json
import os

url = "https://www.youtube.com/watch?v=A9pluEagLD4" # Waimushan

cmd = [sys.executable, "-m", "yt_dlp", "-J", url]
res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
data = json.loads(res.stdout)

m3u8_url = data.get("manifest_url")
for f in data.get("formats", []):
    if f.get("format_id") in ["95", "96", "94", "93"] and f.get("url"):
        m3u8_url = f.get("url")
        break

print("Waimushan m3u8 URL:", m3u8_url[:100])
req = urllib.request.Request(m3u8_url, headers={'User-Agent': 'Mozilla/5.0'})
with urllib.request.urlopen(req) as resp:
    content = resp.read().decode('utf-8')
    lines = [l for l in content.strip().split('\n') if l.startswith('http')]
    print(f"Total segments in m3u8: {len(lines)}")
    first_url = lines[0]
    last_url = lines[-1]
    
    m_first = re.search(r'/sq/(\d+)/', first_url)
    m_last = re.search(r'/sq/(\d+)/', last_url)
    first_sq = int(m_first.group(1)) if m_first else None
    last_sq = int(m_last.group(1)) if m_last else None
    print(f"First SQ: {first_sq}, Last SQ: {last_sq}")
    print("First URL:", first_url)
