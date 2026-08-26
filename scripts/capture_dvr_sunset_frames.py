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
        "id": "xiangshan",
        "name": "台北象山看 101 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=z_fY1pj1VBw",
        "output": "data/snapshots/xiangshan-sunset-1822.jpg"
    },
    {
        "id": "dadaocheng",
        "name": "台北大稻埕碼頭 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=Ndo_8RuefH4",
        "output": "data/snapshots/dadaocheng-sunset-1822.jpg"
    },
    {
        "id": "tamsui",
        "name": "新北淡水漁人碼頭 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=4skHYsV3PVI",
        "output": "data/snapshots/tamsui-sunset-1822.jpg"
    },
    {
        "id": "alishan",
        "name": "嘉義阿里山國家風景區 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=kY31FqHlT0U",
        "output": "data/snapshots/alishan-sunset-1822.jpg"
    },
    {
        "id": "sunmoonlake",
        "name": "南投日月潭國家風景區 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=L2o0w_t_X2E",
        "output": "data/snapshots/sunmoonlake-sunset-1822.jpg"
    },
    {
        "id": "sanxiantai",
        "name": "台東東部海岸三仙台 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=b8L3Z3zZz9w", # East Coast live
        "output": "data/snapshots/sanxiantai-sunset-1822.jpg"
    }
]

def capture_dvr_frame_at_offset(watch_url, seconds_ago, output_file):
    print(f"Connecting to {watch_url}...")
    cmd = [sys.executable, "-m", "yt_dlp", "-J", watch_url]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0:
        print(f"Failed to fetch metadata: {res.stderr[:80]}")
        return False
    data = json.loads(res.stdout)
    
    # Preferred format 95 (720p) or best m3u8
    m3u8_url = None
    for f in data.get("formats", []):
        if f.get("format_id") in ["95", "96", "94"] and f.get("url"):
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
            latest_url = lines[-1]
            m = re.search(r'/sq/(\d+)/', latest_url)
            if not m:
                print("No sequence number in segment URL.")
                return False
            latest_sq = int(m.group(1))
            
            # Target SQ
            dur_m = re.search(r'/dur/([\d\.]+)/', latest_url)
            dur = float(dur_m.group(1)) if dur_m else 5.0
            segments_back = int(seconds_ago / dur)
            target_sq = latest_sq - segments_back
            
            target_url = re.sub(r'/sq/\d+/', f'/sq/{target_sq}/', latest_url)
            temp_ts = output_file.replace('.jpg', '.ts')
            os.makedirs(os.path.dirname(output_file), exist_ok=True)
            urllib.request.urlretrieve(target_url, temp_ts)
            
            subprocess.run(["ffmpeg", "-y", "-i", temp_ts, "-vframes", "1", "-q:v", "2", output_file], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if os.path.exists(temp_ts):
                os.remove(temp_ts)
            if os.path.exists(output_file) and os.path.getsize(output_file) > 10000:
                print(f"✅ Success: {output_file} (Size: {os.path.getsize(output_file)} bytes)")
                return True
            else:
                print(f"Extraction failed for {output_file}")
                return False
    except Exception as e:
        print(f"DVR seek error: {e}")
        return False

# Sunset at 18:22, current time approx 20:30 (offset = 7700 seconds)
now = datetime.datetime.now()
target_time = now.replace(hour=18, minute=22, second=0, microsecond=0)
seconds_ago = max(0, int((now - target_time).total_seconds()))
print(f"Targeting Today Sunset 18:22 ({seconds_ago} seconds ago)...")

for s in STATIONS[:4]:
    capture_dvr_frame_at_offset(s["url"], seconds_ago, s["output"])
