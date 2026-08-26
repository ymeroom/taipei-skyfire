import urllib.request
import re
import subprocess
import sys
import json
import os

url = "https://www.youtube.com/watch?v=z_fY1pj1VBw" # Xiangshan

cmd = [sys.executable, "-m", "yt_dlp", "-J", url]
res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
data = json.loads(res.stdout)

# Find format 95 or 96 (720p or 1080p)
for f in data.get("formats", []):
    if f.get("format_id") == "95":
        m3u8_url = f.get("url")
        print("Format 95 m3u8 URL found:")
        print(m3u8_url[:120] + "...")
        
        # Download m3u8 playlist content
        req = urllib.request.Request(m3u8_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as resp:
            content = resp.read().decode('utf-8')
            lines = content.strip().split('\n')
            print(f"Total lines in m3u8: {len(lines)}")
            # print first 20 lines and last 20 lines
            print("--- First 15 lines ---")
            for l in lines[:15]:
                print(l)
            print("--- Last 15 lines ---")
            for l in lines[-15:]:
                print(l)
