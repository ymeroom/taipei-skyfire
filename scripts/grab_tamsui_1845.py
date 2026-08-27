import urllib.request
import re
import subprocess
import sys
import json
import os
import datetime

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

now = datetime.datetime.now()
target_dt = datetime.datetime.strptime("2026-08-27 18:45:00", "%Y-%m-%d %H:%M:%S")
seconds_ago = int((now - target_dt).total_seconds())

watch_url = "https://www.youtube.com/watch?v=xwAWSh35uuw" # Tamsui
output_jpg = "data/snapshots/2026-08-27-peak-1845-tamsui.jpg"

cmd = [sys.executable, "-m", "yt_dlp", "-J", watch_url]
res = subprocess.run(cmd, stdout=subprocess.PIPE, text=True)
if res.returncode == 0:
    data = json.loads(res.stdout)
    m3u8_url = data.get("manifest_url")
    for f in data.get("formats", []):
        if f.get("format_id") in ["95", "96", "94", "93"] and f.get("url"):
            m3u8_url = f.get("url")
            break
    if m3u8_url:
        req = urllib.request.Request(m3u8_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as resp:
            lines = [l for l in resp.read().decode('utf-8').strip().split('\n') if l.startswith('http')]
            latest_url = lines[-1]
            m_sq = re.search(r'/sq/(\d+)/', latest_url)
            m_dur = re.search(r'/dur/([\d\.]+)/', latest_url)
            latest_sq = int(m_sq.group(1))
            dur = float(m_dur.group(1)) if m_dur else 5.0
            segments_back = int(seconds_ago / dur)
            target_sq = latest_sq - segments_back
            print(f"Tamsui SQ: {target_sq}")
            target_url = re.sub(r'/sq/\d+/', f'/sq/{target_sq}/', latest_url)
            temp_ts = "temp_tamsui.ts"
            try:
                urllib.request.urlretrieve(target_url, temp_ts)
                subprocess.run(["ffmpeg", "-y", "-i", temp_ts, "-vframes", "1", "-q:v", "2", output_jpg], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                if os.path.exists(temp_ts): os.remove(temp_ts)
                print("✅ Tamsui 18:45 captured! Size:", os.path.getsize(output_jpg))
            except Exception as e:
                print("Tamsui error:", e)
