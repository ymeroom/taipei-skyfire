import urllib.request
import re
import subprocess
import sys
import json
import os
import datetime

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

STATIONS = [
    {
        "id": "hongludi",
        "name": "新北中和烘爐地 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=xxMRjVwCQ3o",
        "output": "data/snapshots/2026-08-26-sunset-hongludi.jpg",
        "time": "18:22:00"
    },
    {
        "id": "waimushan",
        "name": "基隆外木山濱海 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=A9pluEagLD4",
        "output": "data/snapshots/2026-08-26-sunset-waimushan.jpg",
        "time": "18:22:00"
    },
    {
        "id": "xiangshan",
        "name": "台北象山看 101 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=z_fY1pj1VBw",
        "output": "data/snapshots/2026-08-26-sunset-xiangshan.jpg",
        "time": "18:22:00"
    },
    {
        "id": "dadaocheng",
        "name": "台北大稻埕碼頭 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=Ndo_8RuefH4",
        "output": "data/snapshots/2026-08-26-sunset-dadaocheng.jpg",
        "time": "18:22:00"
    },
    {
        "id": "alishan",
        "name": "嘉義阿里山奮起湖 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=B6eki-0-w0g",
        "output": "data/snapshots/2026-08-26-sunset-alishan.jpg",
        "time": "18:22:00"
    }
]

def capture_dvr_at_time(watch_url, target_time_str, output_file):
    print(f"Connecting to {watch_url}...")
    cmd = [sys.executable, "-m", "yt_dlp", "-J", watch_url]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0:
        print(f"Failed to fetch metadata: {res.stderr[:80]}")
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
        print("No m3u8 playlist found.")
        return False
        
    try:
        req = urllib.request.Request(m3u8_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as resp:
            content = resp.read().decode('utf-8')
            lines = [l for l in content.strip().split('\n') if l.startswith('http')]
            if not lines:
                print("No segments found in m3u8.")
                return False
            
            # Compute seconds from now to target time today
            now = datetime.datetime.now()
            h, mi, s = map(int, target_time_str.split(':'))
            target_dt = now.replace(hour=h, minute=mi, second=s, microsecond=0)
            seconds_ago = max(0, int((now - target_dt).total_seconds()))
            
            # Use direct line indexing for robustness
            dur_m = re.search(r'/dur/([\d\.]+)/', lines[-1])
            dur = float(dur_m.group(1)) if dur_m else 5.0
            
            total_secs = len(lines) * dur
            secs_from_start = max(0, total_secs - seconds_ago)
            target_idx = int(secs_from_start / dur)
            target_idx = max(0, min(len(lines)-1, target_idx))
            
            target_url = lines[target_idx]
            print(f"Targeting {target_time_str} ({seconds_ago}s ago, idx {target_idx}/{len(lines)})...")
            
            temp_ts = output_file.replace('.jpg', '.ts')
            os.makedirs(os.path.dirname(output_file), exist_ok=True)
            urllib.request.urlretrieve(target_url, temp_ts)
            
            subprocess.run(["ffmpeg", "-y", "-i", temp_ts, "-vframes", "1", "-q:v", "2", output_file], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if os.path.exists(temp_ts):
                os.remove(temp_ts)
            if os.path.exists(output_file) and os.path.getsize(output_file) > 10000:
                print(f"Success: {output_file} (Size: {os.path.getsize(output_file)} bytes)")
                return True
            else:
                print(f"Extraction failed for {output_file}")
                return False
    except Exception as e:
        print(f"DVR seek error: {e}")
        return False

print("=== 啟動 2026-08-26 今日傍晚日落 (18:22) 實況影格 DVR 回溯擷取 ===")
for s in STATIONS:
    capture_dvr_at_time(s["url"], s["time"], s["output"])
