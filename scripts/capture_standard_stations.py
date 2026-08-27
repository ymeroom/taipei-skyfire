import urllib.request
import re
import subprocess
import sys
import json
import os
import datetime

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

SUNRISE_STATIONS = [
    {
        "id": "waimushan",
        "name": "1. 基隆外木山濱海",
        "url": "https://www.youtube.com/watch?v=A9pluEagLD4"
    },
    {
        "id": "hongludi",
        "name": "2. 新北中和烘爐地",
        "url": "https://www.youtube.com/watch?v=xxMRjVwCQ3o"
    }
]

SUNSET_STATIONS = [
    {
        "id": "dadaocheng",
        "name": "1. 台北大稻埕碼頭",
        "url": "https://www.youtube.com/watch?v=Ndo_8RuefH4"
    },
    {
        "id": "xiangshan",
        "name": "2. 台北象山看 101",
        "url": "https://www.youtube.com/watch?v=z_fY1pj1VBw"
    },
    {
        "id": "tamsui",
        "name": "3. 新北淡水漁人碼頭",
        "url": "https://www.youtube.com/watch?v=xwAWSh35uuw"
    },
    {
        "id": "bali",
        "name": "4. 新北八里左岸",
        "url": "https://www.youtube.com/watch?v=di-4DCblWq4"
    },
    {
        "id": "maokong",
        "name": "5. 台北貓空指南宮",
        "url": "https://www.youtube.com/watch?v=215ahZ_0rTg"
    },
    {
        "id": "jiufen",
        "name": "6. 新北九份即時影像",
        "url": "https://www.youtube.com/watch?v=XSD5ptYisw8"
    }
]

def capture_stream_frame(watch_url, target_dt, output_file):
    now = datetime.datetime.now()
    seconds_ago = max(0, int((now - target_dt).total_seconds()))
    
    cmd = [sys.executable, "-m", "yt_dlp", "-J", watch_url]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0:
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
            if not m_sq:
                return False
                
            latest_sq = int(m_sq.group(1))
            dur = float(m_dur.group(1)) if m_dur else 5.0
            
            target_sq = latest_sq - int(seconds_ago / dur)
            target_url = re.sub(r'/sq/\d+/', f'/sq/{target_sq}/', latest_url)
            
            temp_ts = output_file.replace('.jpg', '.ts')
            os.makedirs(os.path.dirname(output_file), exist_ok=True)
            urllib.request.urlretrieve(target_url, temp_ts)
            
            subprocess.run(["ffmpeg", "-y", "-i", temp_ts, "-vframes", "1", "-q:v", "2", output_file], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if os.path.exists(temp_ts):
                os.remove(temp_ts)
            return os.path.exists(output_file) and os.path.getsize(output_file) > 10000
    except Exception:
        return False

def run_session(session_type, date_str=None):
    if not date_str:
        date_str = datetime.datetime.now().strftime("%Y-%m-%d")
        
    if session_type == "sunrise":
        print(f"🌅 執行 [{date_str}] 日出 2 大觀測站擷取 (05:32)")
        target_dt = datetime.datetime.strptime(f"{date_str} 05:32:00", "%Y-%m-%d %H:%M:%S")
        for s in SUNRISE_STATIONS:
            out = f"data/snapshots/{date_str}-sunrise-{s['id']}.jpg"
            ok = capture_stream_frame(s["url"], target_dt, out)
            print(f"  [{s['name']}] -> {'✅ 成功' if ok else '❌ 失敗'}")
    else:
        print(f"🌇 執行 [{date_str}] 日落 6 大觀測站擷取 (18:45 暮光巔峰)")
        target_dt = datetime.datetime.strptime(f"{date_str} 18:45:00", "%Y-%m-%d %H:%M:%S")
        for s in SUNSET_STATIONS:
            out = f"data/snapshots/{date_str}-sunset-{s['id']}.jpg"
            ok = capture_stream_frame(s["url"], target_dt, out)
            print(f"  [{s['name']}] -> {'✅ 成功' if ok else '❌ 失敗'}")

if __name__ == "__main__":
    sess = sys.argv[1] if len(sys.argv) > 1 else "sunset"
    d_str = sys.argv[2] if len(sys.argv) > 2 else None
    run_session(sess, d_str)
