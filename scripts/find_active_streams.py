import subprocess
import json
import sys

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

queries = [
    ("大稻埕", "台北旅遊網 大稻埕 4K live"),
    ("象山", "台北旅遊網 象山 4K live"),
    ("淡水", "新北旅客 淡水 4K live"),
    ("八里", "新北旅客 八里 4K live"),
    ("貓空", "台北旅遊網 貓空 指南宮 4K live"),
    ("九份", "新北旅客 九份 4K live"),
    ("烘爐地", "烘爐地 4K live"),
    ("外木山", "外木山 4K live")
]

for name, q in queries:
    cmd = [sys.executable, "-m", "yt_dlp", "--dump-json", f"ytsearch1:{q}"]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode == 0:
        data = json.loads(res.stdout)
        vid = data.get("id")
        title = data.get("title")
        is_live = data.get("is_live")
        print(f"[{name}] ID: {vid} | Live: {is_live} | Title: {title}")
    else:
        print(f"[{name}] Failed: {res.stderr[:80]}")
