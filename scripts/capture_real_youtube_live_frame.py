import subprocess
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# Target scenic spots live streams
STREAMS = [
    {
        "id": "xiangshan",
        "name": "台北象山看 101 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=z_fY1pj1VBw",
        "file": "xiangshan-live.jpg"
    },
    {
        "id": "dadaocheng",
        "name": "台北大稻埕碼頭 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=Ndo_8RuefH4",
        "file": "dadaocheng-live.jpg"
    },
    {
        "id": "tamsui",
        "name": "新北淡水漁人碼頭 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=xwAWSh35uuw",
        "file": "tamsui-live.jpg"
    },
    {
        "id": "alishan",
        "name": "嘉義阿里山國家風景區 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=B6eki-0-w0g",
        "file": "alishan-live.jpg"
    },
    {
        "id": "sunmoonlake",
        "name": "南投日月潭國家風景區 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=WTnZQS367C8",
        "file": "sunmoonlake-live.jpg"
    },
    {
        "id": "sanxiantai",
        "name": "台東東部海岸三仙台 (4K 官方即時影像)",
        "url": "https://www.youtube.com/watch?v=X_fchztvqI0",
        "file": "sanxiantai-live.jpg"
    }
]

def get_hls_url(youtube_watch_url):
    """Use yt-dlp to extract the live .m3u8 stream URL"""
    try:
        cmd = [sys.executable, "-m", "yt_dlp", "-g", "--format", "best", youtube_watch_url]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=25)
        if res.returncode == 0:
            lines = res.stdout.strip().split('\n')
            for line in lines:
                if 'manifest.googlevideo.com' in line or '.m3u8' in line:
                    return line.strip()
            return lines[0].strip()
    except Exception as e:
        print(f"  ⚠️ yt-dlp extraction error for {youtube_watch_url}: {e}")
    return None

def capture_frame_from_hls(hls_url, output_path):
    """Use ffmpeg to capture 1 frame from the live HLS stream"""
    try:
        cmd = [
            "ffmpeg", "-y",
            "-ss", "00:00:02",
            "-i", hls_url,
            "-vframes", "1",
            "-q:v", "2",
            output_path
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=25)
        if res.returncode == 0 and os.path.exists(output_path) and os.path.getsize(output_path) > 10000:
            return True
    except Exception as e:
        print(f"  ⚠️ ffmpeg frame capture error: {e}")
    return False

def capture_all_streams(target_dirs):
    print("====================================================")
    print("📸 啟動 YouTube 4K Live Stream 真實影片影格即時擷取")
    print("====================================================\n")
    
    for d in target_dirs:
        os.makedirs(d, exist_ok=True)
    
    results = {}
    for s in STREAMS:
        print(f"🎥 正在連接 [{s['name']}] 即時串流...")
        hls_url = get_hls_url(s["url"])
        if not hls_url:
            print(f"  ❌ 無法取得 HLS 串流網址: {s['url']}")
            continue
        
        print(f"  🔗 取得 HLS 串流: {hls_url[:60]}...")
        
        # Capture to temporary file first
        temp_file = f"temp_{s['id']}.jpg"
        success = capture_frame_from_hls(hls_url, temp_file)
        
        if success:
            file_size = os.path.getsize(temp_file)
            print(f"  🎉 成功擷取真實直播影片影格！大小: {file_size} bytes")
            
            # Copy to target directories
            for d in target_dirs:
                target_file = os.path.join(d, s["file"])
                with open(temp_file, "rb") as f_in, open(target_file, "wb") as f_out:
                    f_out.write(f_in.read())
                print(f"     -> 已同步儲存至: {target_file}")
            
            results[s["id"]] = {
                "status": "success",
                "file": s["file"],
                "size": file_size,
                "url": s["url"]
            }
            try:
                os.remove(temp_file)
            except Exception:
                pass
        else:
            print(f"  ❌ ffmpeg 擷取影格失敗: {s['name']}")
    
    print("\n====================================================")
    print(f"✅ 實況影格擷取完成！成功: {len(results)} / {len(STREAMS)}")
    print("====================================================")
    return results

if __name__ == "__main__":
    target_dirs = [
        r"C:\Users\ymero\taipei-skyfire\data\snapshots",
        r"C:\Users\ymero\skyfire-gps\data\snapshots"
    ]
    capture_all_streams(target_dirs)
