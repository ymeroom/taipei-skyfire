import urllib.request
import re
import subprocess
import sys
import json
import os
import datetime

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

SUNRISE_TARGETS = [
    {
        "id": "waimushan",
        "name": "基隆外木山濱海 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=A9pluEagLD4",
        "output": "data/snapshots/2026-08-28-sunrise-waimushan.jpg"
    },
    {
        "id": "hongludi",
        "name": "新北中和烘爐地 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=xxMRjVwCQ3o",
        "output": "data/snapshots/2026-08-28-sunrise-hongludi.jpg"
    },
    {
        "id": "xiangshan",
        "name": "台北象山看 101 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=z_fY1pj1VBw",
        "output": "data/snapshots/2026-08-28-sunrise-xiangshan.jpg"
    },
    {
        "id": "dadaocheng",
        "name": "台北大稻埕碼頭 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=Ndo_8RuefH4",
        "output": "data/snapshots/2026-08-28-sunrise-dadaocheng.jpg"
    }
]

# Target sunrise: 2026-08-28 05:32:00
now = datetime.datetime.now()
target_dt = datetime.datetime.strptime("2026-08-28 05:32:00", "%Y-%m-%d %H:%M:%S")
seconds_ago = int((now - target_dt).total_seconds())

print(f"=== 🌅 啟動 2026-08-28 今日清晨日出 (05:32:00) 影格 DVR 回溯 ({seconds_ago}s / {seconds_ago/3600:.2f}h ago) ===")

def capture_dvr(watch_url, station_name, output_jpg, sec_ago):
    print(f"\n📡 連接 [{station_name}]...")
    cmd = [sys.executable, "-m", "yt_dlp", "-J", watch_url]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0:
        print(f"  ❌ yt-dlp error: {res.stderr[:80]}")
        return False
    data = json.loads(res.stdout)
    
    m3u8_url = None
    for f in data.get("formats", []):
        if f.get("format_id") in ["95", "96", "94", "93"] and f.get("url"):
            m3u8_url = f.get("url")
            break
    if not m3u8_url:
        m3u8_url = data.get("manifest_url")
    if not m3u8_url:
        print("  ❌ No m3u8 playlist")
        return False
        
    try:
        req = urllib.request.Request(m3u8_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as resp:
            lines = [l for l in resp.read().decode('utf-8').strip().split('\n') if l.startswith('http')]
            if not lines:
                return False
            latest_url = lines[-1]
            
            m_sq = re.search(r'/sq/(\d+)/', latest_url)
            m_dur = re.search(r'/dur/([\d\.]+)/', latest_url)
            latest_sq = int(m_sq.group(1))
            dur = float(m_dur.group(1)) if m_dur else 5.0
            
            target_sq = latest_sq - int(sec_ago / dur)
            target_url = re.sub(r'/sq/\d+/', f'/sq/{target_sq}/', latest_url)
            temp_ts = f"temp_sr_{target_sq}.ts"
            
            os.makedirs(os.path.dirname(output_jpg), exist_ok=True)
            urllib.request.urlretrieve(target_url, temp_ts)
            subprocess.run(["ffmpeg", "-y", "-i", temp_ts, "-vframes", "1", "-q:v", "2", output_jpg], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if os.path.exists(temp_ts):
                os.remove(temp_ts)
                
            if os.path.exists(output_jpg) and os.path.getsize(output_jpg) > 10000:
                print(f"  🎉 成功擷取 05:32 影格！大小: {os.path.getsize(output_jpg)} bytes -> {output_jpg}")
                return True
            else:
                print("  ⚠️ 擷取失敗")
                return False
    except Exception as e:
        print(f"  ❌ 錯誤: {e}")
        return False

for s in SUNRISE_TARGETS:
    capture_dvr(s["url"], s["name"], s["output"], seconds_ago)
