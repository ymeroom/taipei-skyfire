import urllib.request
import re
import subprocess
import sys
import json
import os
import datetime

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

SUNRISE_STATIONS = [
    {"id": "waimushan", "name": "外木山", "url": "https://www.youtube.com/watch?v=A9pluEagLD4"},
    {"id": "hongludi", "name": "烘爐地", "url": "https://www.youtube.com/watch?v=xxMRjVwCQ3o"}
]

SUNSET_STATIONS = [
    {"id": "dadaocheng", "name": "大稻埕", "url": "https://www.youtube.com/watch?v=Ndo_8RuefH4"},
    {"id": "xiangshan", "name": "象山", "url": "https://www.youtube.com/watch?v=z_fY1pj1VBw"},
    {"id": "tamsui", "name": "淡水", "url": "https://www.youtube.com/watch?v=xwAWSh35uuw"},
    {"id": "bali", "name": "八里", "url": "https://www.youtube.com/watch?v=di-4DCblWq4"},
    {"id": "maokong", "name": "貓空", "url": "https://www.youtube.com/watch?v=215ahZ_0rTg"},
    {"id": "jiufen", "name": "九份", "url": "https://www.youtube.com/watch?v=XSD5ptYisw8"}
]

# 11 個取樣點：-25 到 +25 分鐘，每 5 分鐘一次
OFFSETS_MINUTES = [-25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25]

def get_station_stream_info(watch_url):
    cmd = [sys.executable, "-m", "yt_dlp", "-J", watch_url]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0:
        return None
    data = json.loads(res.stdout)
    m3u8_url = None
    for f in data.get("formats", []):
        if f.get("format_id") in ["95", "96", "94", "93"] and f.get("url"):
            m3u8_url = f.get("url")
            break
    if not m3u8_url:
        m3u8_url = data.get("manifest_url")
    if not m3u8_url:
        return None
        
    try:
        req = urllib.request.Request(m3u8_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as resp:
            lines = [l for l in resp.read().decode('utf-8').strip().split('\n') if l.startswith('http')]
            if not lines:
                return None
            latest_url = lines[-1]
            m_sq = re.search(r'/sq/(\d+)/', latest_url)
            m_dur = re.search(r'/dur/([\d\.]+)/', latest_url)
            if not m_sq:
                return None
            latest_sq = int(m_sq.group(1))
            dur = float(m_dur.group(1)) if m_dur else 5.0
            return {
                "latest_url": latest_url,
                "latest_sq": latest_sq,
                "dur": dur,
                "fetch_time": datetime.datetime.now()
            }
    except Exception:
        return None

def capture_series(session_type, date_str, base_time_str, target_stations=None):
    base_dt = datetime.datetime.strptime(f"{date_str} {base_time_str}", "%Y-%m-%d %H:%M:%S")
    stations = SUNRISE_STATIONS if session_type == "sunrise" else SUNSET_STATIONS
    if target_stations:
        stations = [s for s in stations if s["id"] in target_stations]
        
    print(f"====================================================")
    print(f"🎬 啟動 50 分鐘 11 次連續時序縮時擷取管線 [{session_type}]")
    print(f"📅 基準事件時刻: {base_dt.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"⏱️ 採樣偏移 (分): {OFFSETS_MINUTES}")
    print(f"📍 機位數量: {len(stations)} 站 | 預計產出: {len(stations) * len(OFFSETS_MINUTES)} 張影格")
    print(f"====================================================")
    
    for s in stations:
        print(f"\n📡 正在連線解析 [{s['name']}] DVR 串流資訊...")
        stream_info = get_station_stream_info(s["url"])
        if not stream_info:
            print(f"  ❌ 無法取得 [{s['name']}] 串流資訊")
            continue
            
        latest_url = stream_info["latest_url"]
        latest_sq = stream_info["latest_sq"]
        dur = stream_info["dur"]
        fetch_time = stream_info["fetch_time"]
        
        station_dir = f"data/snapshots/{date_str}/{session_type}/{s['id']}"
        os.makedirs(station_dir, exist_ok=True)
        
        success_count = 0
        for offset in OFFSETS_MINUTES:
            target_dt = base_dt + datetime.timedelta(minutes=offset)
            time_tag = target_dt.strftime("%H%M")
            sign = "p" if offset >= 0 else "m"
            offset_tag = f"{sign}{abs(offset):02d}"
            
            output_jpg = f"{station_dir}/{time_tag}_{offset_tag}.jpg"
            sec_ago = int((fetch_time - target_dt).total_seconds())
            
            if sec_ago < 0:
                print(f"  ⏳ 偏移時刻 {time_tag} 尚在未來，略過")
                continue
                
            target_sq = latest_sq - int(sec_ago / dur)
            target_url = re.sub(r'/sq/\d+/', f'/sq/{target_sq}/', latest_url)
            temp_ts = f"temp_{s['id']}_{target_sq}.ts"
            
            try:
                urllib.request.urlretrieve(target_url, temp_ts)
                subprocess.run(["ffmpeg", "-y", "-i", temp_ts, "-vframes", "1", "-q:v", "2", output_jpg], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                if os.path.exists(temp_ts):
                    os.remove(temp_ts)
                    
                if os.path.exists(output_jpg) and os.path.getsize(output_jpg) > 8000:
                    success_count += 1
                    print(f"  [{target_dt.strftime('%H:%M')} ({offset:+03d}m)] -> ✅ {os.path.basename(output_jpg)} ({os.path.getsize(output_jpg)} B)")
                else:
                    print(f"  [{target_dt.strftime('%H:%M')} ({offset:+03d}m)] -> ⚠️ 擷取失敗")
            except Exception as e:
                print(f"  [{target_dt.strftime('%H:%M')} ({offset:+03d}m)] -> ❌ 錯誤: {e}")
                
        print(f"  📊 [{s['name']}] 完成: {success_count}/{len(OFFSETS_MINUTES)} 張影格")

if __name__ == "__main__":
    sess = sys.argv[1] if len(sys.argv) > 1 else "sunset"
    d_str = sys.argv[2] if len(sys.argv) > 2 else "2026-08-27"
    b_time = sys.argv[3] if len(sys.argv) > 3 else "18:22:00"
    target = sys.argv[4].split(",") if len(sys.argv) > 4 else ["tamsui", "bali", "dadaocheng"]
    capture_series(sess, d_str, b_time, target)
