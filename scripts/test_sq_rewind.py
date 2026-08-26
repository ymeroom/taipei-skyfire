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
        req = urllib.request.Request(m3u8_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as resp:
            content = resp.read().decode('utf-8')
            lines = [l for l in content.strip().split('\n') if l.startswith('http')]
            latest_url = lines[-1]
            print("Latest Segment URL:")
            print(latest_url[:100] + "...")
            
            # Find sequence number in url: /sq/(\d+)/
            m = re.search(r'/sq/(\d+)/', latest_url)
            if m:
                latest_sq = int(m.group(1))
                print(f"Latest SQ: {latest_sq} (at 20:30)")
                
                # Test 1: Sunset 18:22 (approx 2h 8m = 7680s = 1536 segments ago)
                sunset_sq = latest_sq - int(7680 / 5)
                sunset_url = re.sub(r'/sq/\d+/', f'/sq/{sunset_sq}/', latest_url)
                print(f"Sunset SQ: {sunset_sq}")
                
                # Download sunset segment
                sunset_ts = "sunset_1822.ts"
                sunset_jpg = "sunset_1822.jpg"
                try:
                    urllib.request.urlretrieve(sunset_url, sunset_ts)
                    print(f"Sunset .ts downloaded: {os.path.getsize(sunset_ts)} bytes")
                    # extract frame with ffmpeg
                    subprocess.run(["ffmpeg", "-y", "-i", sunset_ts, "-vframes", "1", "-q:v", "2", sunset_jpg], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    print(f"Sunset JPG extracted: {os.path.getsize(sunset_jpg)} bytes")
                except Exception as e:
                    print("Sunset error:", e)

                # Test 2: Morning 08:42 (approx 11h 48m = 42480s = 8496 segments ago)
                morning_sq = latest_sq - int(42480 / 5)
                morning_url = re.sub(r'/sq/\d+/', f'/sq/{morning_sq}/', latest_url)
                print(f"Morning SQ: {morning_sq}")
                
                morning_ts = "morning_0842.ts"
                morning_jpg = "morning_0842.jpg"
                try:
                    urllib.request.urlretrieve(morning_url, morning_ts)
                    print(f"Morning .ts downloaded: {os.path.getsize(morning_ts)} bytes")
                    subprocess.run(["ffmpeg", "-y", "-i", morning_ts, "-vframes", "1", "-q:v", "2", morning_jpg], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    print(f"Morning JPG extracted: {os.path.getsize(morning_jpg)} bytes")
                except Exception as e:
                    print("Morning error:", e)
        break
