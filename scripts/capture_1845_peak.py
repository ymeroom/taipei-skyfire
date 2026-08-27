import urllib.request
import re
import subprocess
import sys
import json
import os
import datetime

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

SUNSET_STATIONS = [
    {
        "id": "xiangshan",
        "name": "2. 象山看台北 101",
        "url": "https://www.youtube.com/watch?v=z_fY1pj1VBw",
        "output": "data/snapshots/2026-08-27-peak-1845-xiangshan.jpg"
    },
    {
        "id": "hongludi",
        "name": "烘爐地南山福德宮",
        "url": "https://www.youtube.com/watch?v=xxMRjVwCQ3o",
        "output": "data/snapshots/2026-08-27-peak-1845-hongludi.jpg"
    },
    {
        "id": "maokong",
        "name": "5. 貓空指南宮",
        "url": "https://www.youtube.com/watch?v=215ahZ_0rTg",
        "output": "data/snapshots/2026-08-27-peak-1845-maokong.jpg"
    },
    {
        "id": "jiufen",
        "name": "6. 九份即時影像",
        "url": "https://www.youtube.com/watch?v=XSD5ptYisw8",
        "output": "data/snapshots/2026-08-27-peak-1845-jiufen.jpg"
    },
    {
        "id": "bali",
        "name": "4. 八里左岸",
        "url": "https://www.youtube.com/watch?v=di-4DCblWq4",
        "output": "data/snapshots/2026-08-27-peak-1845-bali.jpg"
    },
    {
        "id": "dadaocheng",
        "name": "1. 大稻埕碼頭",
        "url": "https://www.youtube.com/watch?v=Ndo_8RuefH4",
        "output": "data/snapshots/2026-08-27-peak-1845-dadaocheng.jpg"
    }
]

# Target: 2026-08-27 18:45:00
now = datetime.datetime.now()
target_dt = datetime.datetime.strptime("2026-08-27 18:45:00", "%Y-%m-%d %H:%M:%S")
seconds_ago = int((now - target_dt).total_seconds())
print(f"=== 🎯 啟動 8/27 傍晚火燒雲巔峰時刻 (18:45:00) 影格長距回溯 ({seconds_ago}s / {seconds_ago/3600:.2f}h ago) ===")

def capture_stream_at_seconds_ago(watch_url, station_name, output_jpg, sec_ago):
    print(f"\n🎥 連接 [{station_name}]...")
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
        print("  ❌ No m3u8 URL found.")
        return False
        
    try:
        req = urllib.request.Request(m3u8_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as resp:
            content = resp.read().decode('utf-8')
            lines = [l for l in content.strip().split('\n') if l.startswith('http')]
            if not lines:
                print("  ❌ Empty m3u8 playlist.")
                return False
            latest_url = lines[-1]
            
            m_sq = re.search(r'/sq/(\d+)/', latest_url)
            m_dur = re.search(r'/dur/([\d\.]+)/', latest_url)
            if not m_sq:
                print("  ❌ No sequence number in URL.")
                return False
            
            latest_sq = int(m_sq.group(1))
            dur = float(m_dur.group(1)) if m_dur else 5.0
            
            segments_back = int(sec_ago / dur)
            target_sq = latest_sq - segments_back
            print(f"  📊 最新 SQ: {latest_sq} | 回溯分段: {segments_back} | 目標 SQ: {target_sq}")
            
            target_url = re.sub(r'/sq/\d+/', f'/sq/{target_sq}/', latest_url)
            temp_ts = f"temp_peak_{target_sq}.ts"
            
            urllib.request.urlretrieve(target_url, temp_ts)
            ts_size = os.path.getsize(temp_ts)
            
            os.makedirs(os.path.dirname(output_jpg), exist_ok=True)
            subprocess.run(["ffmpeg", "-y", "-i", temp_ts, "-vframes", "1", "-q:v", "2", output_jpg], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if os.path.exists(temp_ts):
                os.remove(temp_ts)
            if os.path.exists(output_jpg) and os.path.getsize(output_jpg) > 10000:
                print(f"  🎉 成功擷取 18:45:00 影格！大小: {os.path.getsize(output_jpg)} bytes -> {output_jpg}")
                return True
            else:
                print(f"  ⚠️ 影像解析失敗或檔案過小")
                return False
    except Exception as e:
        print(f"  ❌ 回溯擷取失敗: {e}")
        return False

for s in SUNSET_STATIONS:
    capture_stream_at_seconds_ago(s["url"], s["name"], s["output"], seconds_ago)
