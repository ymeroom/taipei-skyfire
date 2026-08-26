import subprocess
import sys
import os

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# Test seeking 2 hours back (18:22 sunset time) on Dadaocheng Wharf stream
watch_url = "https://www.youtube.com/watch?v=Ndo_8RuefH4"

cmd = [sys.executable, "-m", "yt_dlp", "-g", "--format", "best", watch_url]
res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
if res.returncode == 0:
    hls_url = res.stdout.strip().split('\n')[0]
    print("HLS URL fetched successfully")
    
    # Try capturing 7200 seconds ago (approx 18:20 sunset time)
    output_file = "test_sunset_1820.jpg"
    # In ffmpeg, for DVR m3u8, we can seek
    cmd_ffmpeg = [
        "ffmpeg", "-y",
        "-sseof", "-7200",
        "-i", hls_url,
        "-vframes", "1",
        "-q:v", "2",
        output_file
    ]
    res_ff = subprocess.run(cmd_ffmpeg, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if os.path.exists(output_file) and os.path.getsize(output_file) > 10000:
        print(f"✅ Successfully captured 2 hours ago frame (18:22 Sunset)! Size: {os.path.getsize(output_file)} bytes")
    else:
        print("⚠️ Direct -sseof failed, testing alternate offset...")
