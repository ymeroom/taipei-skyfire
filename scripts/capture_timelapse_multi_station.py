#!/usr/bin/env python3
"""
capture_timelapse_multi_station.py

日出/日落前後 40 分鐘、每 10 分鐘一張的多機位縮時光學評分。

  日出 (T = 日出時刻)：外木山、烘爐地              → 2 站 × 9 張 = 18 張
  日落 (T = 日落時刻)：101大樓、大稻埕、淡水漁人碼頭、
                        九份、貓空                  → 5 站 × 9 張 = 45 張

時間點: T-40, T-30, T-20, T-10, T, T+10, T+20, T+30, T+40 (共 9 個)。

作法是「事後 DVR 回溯」而非即時等待 —— 在事件發生 40 分鐘後（或任何時間，只要
在直播 DVR 緩衝範圍內）執行一次，靠 yt-dlp 抓到的 m3u8 用 /sq/<n>/ 序號往回抓
9 個不同時間點的切片，一次 yt-dlp -J 呼叫打完 9 張，不必真的等 80 分鐘。

輸出 (單一資料夾，可整包搬移 / 上傳成 CI artifact):
  <base>/<date>-<session>/<station>-t±NN.jpg            (原始影格)
  <base>/<date>-<session>/<date>-<session>.json         (結構化評分資料)
  <base>/<date>-<session>/<date>-<session>-report.html  (單檔 HTML 報告，圖片皆內嵌 base64)

  <base> 預設 = data/timelapse/ (本機檢視用、不進 git)。CI 以環境變數
  SKYFIRE_TIMELAPSE_DIR 覆寫成 checkout 目錄「之外」的位置，否則下一個在同一台
  自架 runner 上跑的 workflow 其 actions/checkout `git clean -ffdx` 會把產出清掉。

用法:
  python scripts/capture_timelapse_multi_station.py sunrise [YYYY-MM-DD]
  python scripts/capture_timelapse_multi_station.py sunset  [YYYY-MM-DD]
"""

import base64
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from analyze_sky_ground_truth import (  # noqa: E402
    analyze_image_optics,
    get_twilight_window,
    fetch_hourly_weather_series,
)

OFFSETS_MIN = [-40, -30, -20, -10, 0, 10, 20, 30, 40]

# 縮時產出根目錄。預設寫進 repo 內的 data/timelapse/（本機手動檢視、已 .gitignore）；
# CI 用 SKYFIRE_TIMELAPSE_DIR 覆寫成 checkout 目錄外的路徑。詳見檔頭 docstring。
BUNDLE_RETENTION_DAYS = 14


def output_base_dir():
    env_dir = os.environ.get("SKYFIRE_TIMELAPSE_DIR", "").strip()
    return os.path.abspath(env_dir) if env_dir else os.path.join(REPO_ROOT, "data", "timelapse")


def prune_old_bundles(base_dir, keep_days=BUNDLE_RETENTION_DAYS):
    """刪除 base_dir 下超過 keep_days 天沒更新的 <date>-<session> 資料夾。

    產出搬到 checkout 之外後就沒有 actions/checkout 的 `git clean` 幫忙回收，
    改由本函式自行修剪，避免自架 runner 磁碟被歷史報告（base64 內嵌，單檔可達
    1-2 MB）長期堆積。
    """
    cutoff = time.time() - keep_days * 86400
    try:
        names = os.listdir(base_dir)
    except FileNotFoundError:
        return
    removed = 0
    for name in names:
        path = os.path.join(base_dir, name)
        if not os.path.isdir(path):
            continue
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}-(sunrise|sunset)", name):
            continue
        if os.path.getmtime(path) < cutoff:
            shutil.rmtree(path, ignore_errors=True)
            removed += 1
    if removed:
        print(f"    🧹 已清除 {removed} 個超過 {keep_days} 天的舊縮時資料夾")

# 站點沿用 capture_standard_stations.py 已驗證可直播的頻道 ID，
# ⚠️ 機位清單須與 js/stations.js 同步（tests/test-stations.js 會比對 videoId）。
# lat/lng 取自 js/stations.js 同名機位，供雨天閘門查詢當地降雨用。
SUNRISE_STATIONS = [
    {"id": "waimushan", "name": "外木山", "url": "https://www.youtube.com/watch?v=A9pluEagLD4",
     "lat": 25.17594381403899, "lng": 121.70593771941236},
    {"id": "hongludi", "name": "烘爐地", "url": "https://www.youtube.com/watch?v=xxMRjVwCQ3o",
     "lat": 24.972013872318254, "lng": 121.4976771944775},
]

SUNSET_STATIONS = [
    {"id": "xiangshan", "name": "101大樓", "url": "https://www.youtube.com/watch?v=z_fY1pj1VBw",
     "lat": 25.029049882166394, "lng": 121.57276615548665},
    {"id": "dadaocheng", "name": "大稻埕", "url": "https://www.youtube.com/watch?v=Ndo_8RuefH4",
     "lat": 25.057045046459375, "lng": 121.50771810454582},
    {"id": "tamsui", "name": "淡水漁人碼頭", "url": "https://www.youtube.com/watch?v=xwAWSh35uuw",
     "lat": 25.18325188330396, "lng": 121.41209767613158},
    {"id": "bali", "name": "八里左岸", "url": "https://www.youtube.com/watch?v=di-4DCblWq4",
     "lat": 25.15470, "lng": 121.41030},
    {"id": "jiufen", "name": "九份", "url": "https://www.youtube.com/watch?v=XSD5ptYisw8",
     "lat": 25.110048954642046, "lng": 121.83829071730524},
    {"id": "maokong", "name": "貓空", "url": "https://www.youtube.com/watch?v=215ahZ_0rTg",
     "lat": 24.98421427814147, "lng": 121.58655991120213},
]


def get_anchor_time_utc(session, date_str):
    """透過 js/solar-calc.js (SolarCalc, 單一事實來源) 取得台北當日日出/日落時刻。

    回傳 tz-aware UTC datetime。刻意不在 Python 重寫天文公式，避免跟網站本身的
    計算結果分歧。以台北時間中午為錨點日期，避免 UTC 換日造成抓錯一天。
    """
    node_script = (
        "const SolarCalc = require('./js/solar-calc.js');"
        "const t = SolarCalc.getTimes(new Date(process.argv[1] + 'T12:00:00+08:00'));"
        "console.log(JSON.stringify({sunrise: t.sunrise, sunset: t.sunset}));"
    )
    r = subprocess.run(
        ["node", "-e", node_script, date_str],
        cwd=REPO_ROOT, capture_output=True, text=True, timeout=30
    )
    if r.returncode != 0:
        raise RuntimeError(f"SolarCalc 呼叫失敗: {r.stderr.strip()}")
    times = json.loads(r.stdout)
    key = "sunrise" if session == "sunrise" else "sunset"
    iso = times[key]
    return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))


def fetch_stream_manifest(watch_url):
    """呼叫一次 yt-dlp -J，回傳 (latest_sq, dur, latest_url_template) 供多次 sq 位移套用。"""
    r = subprocess.run(
        [sys.executable, "-m", "yt_dlp", "-J", watch_url],
        capture_output=True, text=True, timeout=60
    )
    if r.returncode != 0:
        raise RuntimeError(f"yt-dlp 失敗: {r.stderr.strip()[:300]}")
    data = json.loads(r.stdout)
    if not data.get("is_live"):
        raise RuntimeError("直播目前非 is_live 狀態")

    m3u8_url = None
    for f in data.get("formats", []):
        if f.get("format_id") in ["95", "96", "94", "93"] and f.get("url"):
            m3u8_url = f["url"]
            break
    if not m3u8_url:
        m3u8_url = data.get("manifest_url")
    if not m3u8_url:
        raise RuntimeError("找不到可用的 m3u8 manifest")

    req = urllib.request.Request(m3u8_url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=20) as resp:
        lines = [l for l in resp.read().decode('utf-8').strip().split('\n') if l.startswith('http')]
    if not lines:
        raise RuntimeError("m3u8 播放清單為空")

    latest_url = lines[-1]
    m_sq = re.search(r'/sq/(\d+)/', latest_url)
    m_dur = re.search(r'/dur/([\d.]+)/', latest_url)
    if not m_sq:
        raise RuntimeError("無法從 manifest 解析 sq 序號")

    latest_sq = int(m_sq.group(1))
    dur = float(m_dur.group(1)) if m_dur else 5.0
    return latest_sq, dur, latest_url


def compute_target_sq(latest_sq, dur, seconds_ago):
    """算出往回 seconds_ago 秒對應的 sq 序號。

    誠實性防呆：若目標時刻早於這條直播 DVR 緩衝的可回溯範圍，結果會是
    負數 —— 過去在其他擷取路徑 (live-frame-capture.js) 犯過的錯誤是這種
    情況被 `max(0, ...)` 悄悄夾在 sq=0 (該直播最早可用的切片，可能是完全
    不同、更早的時刻)，卻仍標記成「已擷取到目標時刻」。這裡改成直接拋出
    例外，讓呼叫端記錄失敗原因，絕不能讓 sq=0 冒充 t±NN 的畫面進平均/
    峰值計算。
    """
    target_sq = latest_sq - int(seconds_ago / dur)
    if target_sq < 0:
        raise RuntimeError(
            f"目標時刻早於此直播的 DVR 可回溯範圍 (需要往回 {seconds_ago/60:.1f} 分鐘，"
            f"但只能回溯到 sq=0)，拒絕擷取以避免用錯誤時刻的畫面冒充"
        )
    return target_sq


def capture_frame_at(latest_url, latest_sq, dur, seconds_ago, output_jpg):
    target_sq = compute_target_sq(latest_sq, dur, seconds_ago)
    target_url = re.sub(r'/sq/\d+/', f'/sq/{target_sq}/', latest_url)
    temp_ts = output_jpg.replace('.jpg', '.ts')
    os.makedirs(os.path.dirname(output_jpg), exist_ok=True)
    urllib.request.urlretrieve(target_url, temp_ts)
    subprocess.run(
        ["ffmpeg", "-y", "-i", temp_ts, "-vframes", "1", "-q:v", "2", output_jpg],
        capture_output=True, timeout=30
    )
    if os.path.exists(temp_ts):
        os.remove(temp_ts)
    if not (os.path.exists(output_jpg) and os.path.getsize(output_jpg) > 10000):
        raise RuntimeError("擷取的影格檔案過小或不存在")


def offset_label(offset_min):
    return f"t{'+' if offset_min >= 0 else ''}{offset_min:02d}"


def run_station(station, anchor_utc, now_utc, out_dir, twilight_window):
    print(f"  📡 {station['name']} ({station['id']})")
    frames = []

    rain_series = None
    if "lat" in station and "lng" in station:
        rain_series = fetch_hourly_weather_series(station["lat"], station["lng"])

    try:
        latest_sq, dur, latest_url = fetch_stream_manifest(station["url"])
    except Exception as e:
        print(f"    ❌ 無法取得直播 manifest: {e}")
        for offset_min in OFFSETS_MIN:
            frames.append({
                "offsetMin": offset_min,
                "ok": False,
                "error": f"manifest 取得失敗: {e}"
            })
        return frames

    for offset_min in OFFSETS_MIN:
        target_dt = anchor_utc + datetime.timedelta(minutes=offset_min)
        seconds_ago = (now_utc - target_dt).total_seconds()
        label = offset_label(offset_min)
        out_jpg = os.path.join(out_dir, f"{station['id']}-{label}.jpg")

        if seconds_ago < 0:
            print(f"    ⏭️  {label}: 時間點尚未發生 (在未來 {-seconds_ago/60:.1f} 分鐘)，略過")
            frames.append({"offsetMin": offset_min, "ok": False, "error": "目標時間尚未發生"})
            continue

        try:
            capture_frame_at(latest_url, latest_sq, dur, seconds_ago, out_jpg)
            optics = analyze_image_optics(
                out_jpg,
                capture_time=target_dt,
                twilight_window=twilight_window,
                rain_series=rain_series,
                station_coords={"lat": station["lat"], "lng": station["lng"]} if "lat" in station else None
            )
            night_gated = optics.get("nightGate", {}).get("applied")
            rain_gated = optics.get("rainGate", {}).get("applied")
            tag = ""
            if night_gated:
                tag += " 🌙 暗夜閘門已套用"
            if rain_gated:
                tag += " 🌧️ 雨天閘門已套用"
            print(f"    ✅ {label}: score={optics['score']} ({optics.get('level')}){tag}")
            frames.append({
                "offsetMin": offset_min,
                "ok": True,
                "capturedAtUtc": target_dt.isoformat(),
                "imagePath": os.path.relpath(out_jpg, out_dir).replace("\\", "/"),
                **optics
            })
        except Exception as e:
            print(f"    ❌ {label}: {e}")
            frames.append({"offsetMin": offset_min, "ok": False, "error": str(e)})

    return frames


def build_html_report(report, html_path):
    report_dir = os.path.dirname(os.path.abspath(html_path))

    def img_data_uri(rel_path):
        # 影格與報告同一資料夾；讀不到就讓它炸，不要默默產出一堆空 <img>
        abs_path = os.path.join(report_dir, rel_path)
        with open(abs_path, "rb") as f:
            return "data:image/jpeg;base64," + base64.b64encode(f.read()).decode("ascii")

    session_label = "日出" if report["session"] == "sunrise" else "日落"
    accent = "#f0b93d" if report["session"] == "sunrise" else "#e0592c"

    def score_color(score):
        if score is None:
            return "#5a6275"
        if score >= 82: return "#FF3366"
        if score >= 68: return "#FF6B00"
        if score >= 48: return "#E5A50A"
        if score >= 30: return "#7B88A8"
        return "#5A6275"

    rows_html = []
    for st in report["stations"]:
        cells = []
        chart_pts = []
        for i, fr in enumerate(st["frames"]):
            sign = "+" if fr["offsetMin"] >= 0 else ""
            label = f"T{sign}{fr['offsetMin']}"
            if fr.get("ok"):
                uri = img_data_uri(fr["imagePath"])
                score = fr.get("score")
                night_gate = fr.get("nightGate") or {}
                rain_gate = fr.get("rainGate") or {}
                night_gated = night_gate.get("applied")
                rain_gated = rain_gate.get("applied")
                gated = night_gated or rain_gated
                chart_pts.append(score if score is not None else 0)
                gate_notes = []
                if night_gated:
                    gate_notes.append(f'<div class="cell-gate" title="原始分數 {night_gate.get("rawScoreBeforeGate")}">🌙 暗夜閘門 (原 {night_gate.get("rawScoreBeforeGate")})</div>')
                if rain_gated:
                    gate_notes.append(f'<div class="cell-gate" title="降雨量 {rain_gate.get("precipitationMm")}mm">🌧️ 雨天閘門 (原 {rain_gate.get("rawScoreBeforeGate")})</div>')
                gate_note = "".join(gate_notes)
                cells.append(f'''
                <div class="cell{' cell-gated' if gated else ''}">
                  <div class="thumb"><img src="{uri}" loading="lazy" alt="{st['name']} {label}"></div>
                  <div class="cell-label">{label}</div>
                  <div class="cell-score" style="color:{score_color(score)}">{score if score is not None else '—'}</div>
                  <div class="cell-level">{fr.get('level','—')}</div>
                  {gate_note}
                </div>''')
            else:
                chart_pts.append(None)
                cells.append(f'''
                <div class="cell cell-fail">
                  <div class="thumb thumb-fail">⚠️</div>
                  <div class="cell-label">{label}</div>
                  <div class="cell-error">{fr.get('error','擷取失敗')}</div>
                </div>''')

        valid_scores = [f.get("score") for f in st["frames"] if f.get("ok") and f.get("score") is not None]
        peak = max(valid_scores) if valid_scores else None
        avg = round(sum(valid_scores) / len(valid_scores), 1) if valid_scores else None

        # 迷你折線圖 (純 SVG, 無函式庫)
        w, h, pad = 460, 70, 8
        n = len(chart_pts)
        step = (w - pad * 2) / (n - 1) if n > 1 else 0
        pts_str = []
        for i, v in enumerate(chart_pts):
            if v is None:
                continue
            x = pad + i * step
            y = h - pad - (v / 100) * (h - pad * 2)
            pts_str.append(f"{x:.1f},{y:.1f}")
        polyline = " ".join(pts_str)
        dots = "".join(
            f'<circle cx="{p.split(",")[0]}" cy="{p.split(",")[1]}" r="3" fill="{accent}"/>'
            for p in pts_str
        )

        rows_html.append(f'''
        <section class="station">
          <div class="station-head">
            <h2>{st['name']}</h2>
            <div class="station-stats">
              <span>峰值 <b style="color:{score_color(peak)}">{peak if peak is not None else '—'}</b></span>
              <span>平均 <b>{avg if avg is not None else '—'}</b></span>
            </div>
          </div>
          <svg class="trend" viewBox="0 0 {w} {h}" preserveAspectRatio="none">
            <line x1="{pad}" y1="{h-pad}" x2="{w-pad}" y2="{h-pad}" stroke="var(--rule)" stroke-width="1"/>
            <polyline points="{polyline}" fill="none" stroke="{accent}" stroke-width="2"/>
            {dots}
          </svg>
          <div class="grid">{''.join(cells)}</div>
        </section>''')

    generated_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    html = f'''<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<title>{report['date']} {session_label}縮時光學評分</title>
<style>
:root {{
  --ink:#161c30; --paper:#f8f9fb; --paper-raised:#ffffff; --rule:#d7dce6; --ink-soft:#5a6275;
}}
@media (prefers-color-scheme: dark) {{
  :root {{ --ink:#eef1f6; --paper:#0c0f1a; --paper-raised:#181c2b; --rule:#2a3049; --ink-soft:#aab3cc; }}
}}
* {{ box-sizing:border-box }}
body {{ margin:0; background:var(--paper); color:var(--ink); font-family:'Segoe UI',system-ui,sans-serif; }}
header {{ padding:32px 28px; background:linear-gradient(135deg,{accent}22,transparent); border-bottom:1px solid var(--rule); }}
header h1 {{ margin:0 0 6px; font-size:26px; }}
header p {{ margin:0; color:var(--ink-soft); font-size:13px; }}
main {{ max-width:1040px; margin:0 auto; padding:20px 28px 80px; }}
.station {{ padding:28px 0; border-bottom:1px solid var(--rule); }}
.station:last-child {{ border-bottom:none; }}
.station-head {{ display:flex; justify-content:space-between; align-items:baseline; margin-bottom:10px; }}
.station-head h2 {{ margin:0; font-size:20px; }}
.station-stats {{ font-size:13px; color:var(--ink-soft); display:flex; gap:16px; }}
.station-stats b {{ color:var(--ink); }}
.trend {{ width:100%; height:70px; display:block; margin-bottom:14px; }}
.grid {{ display:grid; grid-template-columns:repeat(9,1fr); gap:8px; }}
.cell {{ background:var(--paper-raised); border:1px solid var(--rule); border-radius:8px; padding:6px; text-align:center; }}
.thumb {{ width:100%; aspect-ratio:4/3; border-radius:5px; overflow:hidden; background:#000; }}
.thumb img {{ width:100%; height:100%; object-fit:cover; display:block; }}
.thumb-fail {{ display:flex; align-items:center; justify-content:center; font-size:22px; background:var(--paper); }}
.cell-label {{ font-family:monospace; font-size:11px; color:var(--ink-soft); margin-top:5px; }}
.cell-score {{ font-weight:700; font-size:15px; }}
.cell-level {{ font-size:10.5px; color:var(--ink-soft); }}
.cell-error {{ font-size:9.5px; color:var(--ink-soft); line-height:1.3; margin-top:4px; }}
.cell-gated {{ opacity:.72; }}
.cell-gate {{ font-size:9px; color:var(--ink-soft); margin-top:3px; }}
@media (max-width:900px) {{ .grid {{ grid-template-columns:repeat(3,1fr); }} }}
</style>
</head>
<body>
<header>
  <h1>{report['date']} {session_label}縮時光學評分</h1>
  <p>錨點時刻 (T) = {report['anchorLocalLabel']} · T-40 ~ T+40，每 10 分鐘一張 · 產生於 {generated_at}</p>
  <p>🌙 暗夜閘門窗口 = {report['twilightWindowLocalLabel']}（台北時間）—— 窗外的暖色像素強制視為人工光源，分數上限 12 分</p>
</header>
<main>
  {''.join(rows_html)}
</main>
</body>
</html>'''

    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)


def run(session, date_str=None):
    if date_str is None:
        date_str = datetime.datetime.now().strftime("%Y-%m-%d")

    stations = SUNRISE_STATIONS if session == "sunrise" else SUNSET_STATIONS
    session_label = "日出" if session == "sunrise" else "日落"

    anchor_utc = get_anchor_time_utc(session, date_str)
    anchor_local = anchor_utc.astimezone(datetime.timezone(datetime.timedelta(hours=8)))
    now_utc = datetime.datetime.now(datetime.timezone.utc)

    twilight_window = get_twilight_window(date_str, session)
    window_start_local = twilight_window[0].astimezone(datetime.timezone(datetime.timedelta(hours=8)))
    window_end_local = twilight_window[1].astimezone(datetime.timezone(datetime.timedelta(hours=8)))

    print(f"=== 🎞️  {date_str} {session_label} 縮時擷取 ({len(stations)} 站 × 9 張) ===")
    print(f"    錨點 T = {anchor_local.strftime('%Y-%m-%d %H:%M:%S')} (台北時間)")
    print(f"    暗夜閘門窗口 = {window_start_local.strftime('%H:%M:%S')} ~ {window_end_local.strftime('%H:%M:%S')} (台北時間)，窗外強制低分")

    base_dir = output_base_dir()
    out_dir = os.path.join(base_dir, f"{date_str}-{session}")
    os.makedirs(out_dir, exist_ok=True)
    print(f"    產出目錄 = {out_dir}")

    report = {
        "date": date_str,
        "session": session,
        "anchorUtc": anchor_utc.isoformat(),
        "anchorLocalLabel": anchor_local.strftime("%H:%M:%S (台北時間)"),
        "twilightWindowLocalLabel": f"{window_start_local.strftime('%H:%M:%S')} ~ {window_end_local.strftime('%H:%M:%S')}",
        "generatedAt": datetime.datetime.now().isoformat(),
        "stations": []
    }

    for station in stations:
        frames = run_station(station, anchor_utc, now_utc, out_dir, twilight_window)
        report["stations"].append({"id": station["id"], "name": station["name"], "frames": frames})

    json_path = os.path.join(out_dir, f"{date_str}-{session}.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    html_path = os.path.join(out_dir, f"{date_str}-{session}-report.html")
    build_html_report(report, html_path)

    prune_old_bundles(base_dir)

    total = sum(len(s["frames"]) for s in report["stations"])
    ok = sum(1 for s in report["stations"] for fr in s["frames"] if fr.get("ok"))
    print(f"=== ✅ 完成 {ok}/{total} 張。報告: {html_path} ===")

    records = write_verification_records(report)
    this_run_ids = {f"rec-{date_str}-{session}-{st['id']}" for st in stations}
    for r in records:
        if r["id"] in this_run_ids:
            v = r["verification"]
            print(f"    📝 {r['station']}: 平均 {v.get('avgScore')} 分・峰值 {v.get('peakScore')} 分 "
                  f"(T{'+' if (v.get('peakOffsetMin') or 0) >= 0 else ''}{v.get('peakOffsetMin')}) "
                  f"[{v.get('status')}]")

    # 供 CI 接手上傳 (auto_timelapse_multi_station.yml 的 upload-artifact 步驟)。
    # 用 GITHUB_OUTPUT 而非在 YAML 重算日期 —— 排程可能延遲數小時而跨越台北午夜。
    bundle_fwd = out_dir.replace("\\", "/")
    print(f"BUNDLE_DIR={bundle_fwd}")
    gh_output = os.environ.get("GITHUB_OUTPUT")
    if gh_output:
        with open(gh_output, "a", encoding="utf-8") as f:
            f.write(f"bundle_dir={bundle_fwd}\n")

    return report


def aggregate_station_scores(frames, session):
    """從 9 張影格算出兩個實測分數：整段平均、以及對應時段那一側的峰值。

    平均涵蓋 T-40~T+40 全段 (代表整場出景的整體水準)；峰值只在攝影經驗上
    最容易出現最佳火燒雲色彩的那一側搜尋 —— 日出前的晨曦 (offsetMin <= 0)
    或日落後的餘暉 (offsetMin >= 0)，另一側 (日出後的普通白晝 / 日落前的
    普通白晝) 不計入峰值候選，避免「峰值」被無關的那一半稀釋或誤導。

    ok_frames 用的是各影格已套用暗夜/雨天閘門後的 score —— 閘門封頂的分數
    (例如窗口外強制 ≤12) 誠實地反映該時刻本來就不該算出景，計入平均是對的；
    真正該排除在外的只有「根本沒抓到／抓到錯誤時刻」的影格 (ok=False)。
    """
    ok_frames = [f for f in frames if f.get("ok") and f.get("score") is not None]
    peak_side = "pre-sunrise" if session == "sunrise" else "post-sunset"

    if not ok_frames:
        return {
            "avgScore": None, "peakScore": None, "peakOffsetMin": None,
            "peakSide": peak_side, "okFrameCount": 0, "frameCount": len(frames)
        }

    avg_score = round(sum(f["score"] for f in ok_frames) / len(ok_frames), 1)

    if session == "sunrise":
        peak_candidates = [f for f in ok_frames if f["offsetMin"] <= 0]
    else:
        peak_candidates = [f for f in ok_frames if f["offsetMin"] >= 0]

    if peak_candidates:
        best = max(peak_candidates, key=lambda f: f["score"])
        peak_score, peak_offset = best["score"], best["offsetMin"]
    else:
        peak_score, peak_offset = None, None

    return {
        "avgScore": avg_score,
        "peakScore": peak_score,
        "peakOffsetMin": peak_offset,
        "peakSide": peak_side,
        "okFrameCount": len(ok_frames),
        "frameCount": len(frames)
    }


def verdict_for_error(error_absolute):
    """與 scripts/live-capture-core.js 的 verdictForError 同門檻，故意在此重複一份
    小常數 (而非跨語言呼叫 node) —— 純數字門檻，維護成本遠低於 Node/Python
    橋接的複雜度。改門檻時記得兩邊一起改。"""
    if error_absolute <= 8:
        return "EXACT_MATCH", "🎯 極致精準 (誤差 ≤ 8分)"
    if error_absolute <= 18:
        return "SLIGHT_DEVIATION", "⚡ 輕微偏差 (誤差 ≤ 18分)"
    return "MISMATCH", "⚠️ 出現偏差需校準"


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def flatten_station_lock(station_lock, locked_at):
    """把 lock-forecast.js 寫的巢狀形狀 ({score, weather:{cloudHigh,...},
    metrics:{...}}) 攤平成 generate_daily_briefing.py / clean_cloud_bands
    期待的扁平形狀 (highCloud/midCloud/lowCloud 等直接是頂層欄位)。

    與 scripts/capture-validation.js 的 buildPredictionFromStationLock 對應
    同一份鎖定檔、產出同一種扁平形狀 —— 兩條路徑都要能餵進同一個日報產生器。
    不攤平的話 clean_cloud_bands 會把巢狀底下的雲量誤判成「缺失」，日報就會
    顯示「本場預報雲量細項未隨鎖定檔存下」，明明鎖定檔裡其實完整存著。
    """
    w = station_lock.get("weather") or {}
    m = station_lock.get("metrics") or {}
    vis_km = _num(w.get("visibilityKm"))
    return {
        "score": station_lock.get("score"),
        "rating": station_lock.get("rating"),
        "color": station_lock.get("color"),
        "highCloud": _num(w.get("cloudHigh")),
        "midCloud": _num(w.get("cloudMid")),
        "lowCloud": _num(w.get("cloudLow")),
        "totalCloud": _num(w.get("cloudTotal")),
        "humidity": _num(w.get("humidity")),
        "precipProb": _num(w.get("precipProb")),
        "horizonClearance": _num(m.get("horizonClearance")),
        "visibilityKm": vis_km if vis_km is not None else _num(m.get("visKm")),
        "isSimulated": False,
        "lockedAt": locked_at
    }


def load_locked_prediction(data_dir, session, date_str, station_id):
    """讀該站的鎖定預測，攤平成日報產生器期待的扁平形狀。找不到鎖定檔或該站
    不在其中都回傳 None (不臨時現算一份頂替 —— 鎖定應該早在擷取之前就已
    完成，缺鎖定本身就是異常，誠實記錄成 no_locked_prediction 比假裝有
    預測更正確)。"""
    locked_path = os.path.join(data_dir, f"locked-{session}-forecast.json")
    if not os.path.exists(locked_path):
        return None
    try:
        with open(locked_path, "r", encoding="utf-8") as f:
            locked = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None
    if locked.get("date") != date_str:
        return None
    station_lock = (locked.get("stations") or {}).get(station_id)
    if station_lock is None:
        return None
    return flatten_station_lock(station_lock, locked.get("lockedAt"))


def build_station_verification_record(station, frames, session, date_str, anchor_utc, data_dir):
    """組出單一測站這場次的完整驗證紀錄 (供寫進 verification-records.json)。"""
    aggregate = aggregate_station_scores(frames, session)
    prediction = load_locked_prediction(data_dir, session, date_str, station["id"])

    record = {
        "id": f"rec-{date_str}-{session}-{station['id']}",
        "date": date_str,
        "session": session,
        "station": station["id"],
        "targetTime": anchor_utc.isoformat(),
        "source": f"{station['name']}（縮時多影格）",
        "prediction": prediction,
        "capture": {
            "kind": "timelapse-multi-frame",
            "frameCount": aggregate["frameCount"],
            "okFrameCount": aggregate["okFrameCount"],
            "offsetsMin": OFFSETS_MIN
        },
        "verification": {
            "avgScore": aggregate["avgScore"],
            "peakScore": aggregate["peakScore"],
            "peakOffsetMin": aggregate["peakOffsetMin"],
            "peakSide": aggregate["peakSide"],
            "verifiedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()
        }
    }

    v = record["verification"]
    if aggregate["okFrameCount"] == 0:
        v["status"] = "capture_unavailable"
        v["reason"] = "9 張影格全數擷取失敗，本場次無實測資料"
    elif prediction is None:
        v["status"] = "no_locked_prediction"
        v["reason"] = "找不到對應的鎖定預測，已有實測分數但無法計算誤差"
    else:
        v["status"] = "verified_completed"
        pred_score = prediction.get("score")
        if aggregate["avgScore"] is not None and pred_score is not None:
            err = abs(pred_score - aggregate["avgScore"])
            verdict, badge = verdict_for_error(err)
            v["errorAvgAbsolute"] = err
            v["verdictAvg"] = verdict
            v["verdictAvgBadge"] = badge
        if aggregate["peakScore"] is not None and pred_score is not None:
            err = abs(pred_score - aggregate["peakScore"])
            verdict, badge = verdict_for_error(err)
            v["errorPeakAbsolute"] = err
            v["verdictPeak"] = verdict
            v["verdictPeakBadge"] = badge

    return record


def write_verification_records(report, data_dir=None):
    """把這場次每站的聚合結果 upsert 進 data/verification-records.json。

    Upsert 規則與 capture-validation.js 的 writeRecord 一致：同 id 就地
    取代 (保留原本位置)，否則塞到陣列最前面；上限 720 筆 (8 站 × ~90 天)。
    """
    if data_dir is None:
        data_dir = os.path.join(REPO_ROOT, "data")
    records_path = os.path.join(data_dir, "verification-records.json")

    if os.path.exists(records_path):
        with open(records_path, "r", encoding="utf-8") as f:
            records = json.load(f)
    else:
        records = []

    anchor_utc = datetime.datetime.fromisoformat(report["anchorUtc"])
    by_id = {r.get("id"): i for i, r in enumerate(records)}

    for st in report["stations"]:
        record = build_station_verification_record(
            st, st["frames"], report["session"], report["date"], anchor_utc, data_dir
        )
        idx = by_id.get(record["id"])
        if idx is not None:
            records[idx] = record
        else:
            records.insert(0, record)
            by_id = {r.get("id"): i for i, r in enumerate(records)}

    records = records[:720]
    os.makedirs(data_dir, exist_ok=True)
    with open(records_path, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)

    return records


if __name__ == "__main__":
    sess = sys.argv[1] if len(sys.argv) > 1 else "sunset"
    d_str = sys.argv[2] if len(sys.argv) > 2 else None
    run(sess, d_str)
