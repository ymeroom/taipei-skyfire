import urllib.request
import re
import subprocess
import sys
import json
import os
import datetime

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# Target: 18:22:00 on 2026-08-27 (sunset time)
# Now is approx 2026-08-28 00:52:00 (approx 6h 30m = 23400s ago)
now = datetime.datetime.now()
target_dt = datetime.datetime.strptime("2026-08-27 18:22:00", "%Y-%m-%d %H:%M:%S")
seconds_ago = int((now - target_dt).total_seconds())
print(f"Targeting 18:22:00 on 8/27 ({seconds_ago} seconds ago = {seconds_ago/3600:.2f} hours ago)...")

def test_stream_sq_rewind(watch_url, station_name, output_jpg):
    print(f"\n--- Testing {station_name} ---")
    cmd = [sys.executable, "-m", "yt_dlp", "-J", watch_url]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0:
        print("yt-dlp error:", res.stderr[:80])
        return False
    data = json.loads(res.stdout)
    
    m3u8_url = None
    for f in data.get("formats", []):
        if f.get("format_id") in ["95", "96", "94", "93"] and f.get("url"):
            m3u8_url = f.get("url")
            break
    if not m3u8_url:
        m3u8_url = data.get("manifest_url")
        
    req = urllib.request.Request(m3u8_url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req) as resp:
        content = resp.read().decode('utf-8')
        lines = [l for l in content.strip().split('\n') if l.startswith('http')]
        latest_url = lines[-1]
        
        m_sq = re.search(r'/sq/(\d+)/', latest_url)
        m_dur = re.search(r'/dur/([\d\.]+)/', latest_url)
        if not m_sq:
            print("No SQ in url")
            return False
            
        latest_sq = int(m_sq.group(1))
        dur = float(m_dur.group(1)) if m_dur else 5.0
        
        segments_back = int(seconds_ago / dur)
        target_sq = latest_sq - segments_back
        print(f"Latest SQ: {latest_sq}, Segments back: {segments_back}, Target SQ: {target_sq}")
        
        target_url = re.sub(r'/sq/\d+/', f'/sq/{target_sq}/', latest_url)
        temp_ts = f"temp_{target_sq}.ts"
        
        try:
            urllib.request.urlretrieve(target_url, temp_ts)
            ts_size = os.path.getsize(temp_ts)
            print(f"✅ Downloaded segment {target_sq}! Size: {ts_size} bytes")
            
            subprocess.run(["ffmpeg", "-y", "-i", temp_ts, "-vframes", "1", "-q:v", "2", output_jpg], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if os.path.exists(temp_ts):
                os.remove(temp_ts)
            if os.path.exists(output_jpg) and os.path.getsize(output_jpg) > 10000:
                print(f"🎉 Extracted 18:22 sunset JPEG! Size: {os.path.getsize(output_jpg)} bytes")
                return True
        except Exception as e:
            print(f"❌ Failed to fetch SQ {target_sq}: {e}")
            return False

# Test Xiangshan and Hongludi and Waimushan
test_stream_sq_rewind("https://www.youtube.com/watch?v=z_fY1pj1VBw", "台北象山看 101", "data/snapshots/2026-08-27-sunset-1822-xiangshan.jpg")
test_stream_sq_rewind("https://www.youtube.com/watch?v=xxMRjVwCQ3o", "新北中和烘爐地", "data/snapshots/2026-08-27-sunset-1822-hongludi.jpg")
test_stream_sq_rewind("https://www.youtube.com/watch?v=A9pluEagLD4", "基隆外木山", "data/snapshots/2026-08-27-sunset-1822-waimushan.jpg")
test_stream_sq_rewind("https://www.youtube.com/watch?v=B6eki-0-w0g", "嘉義阿里山奮起湖", "data/snapshots/2026-08-27-sunset-1822-alishan.jpg")
