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

輸出:
  data/timelapse/<date>-<session>/<station>-t±NN.jpg   (原始影格，本機用，不進 git)
  data/timelapse/<date>-<session>.json                 (結構化評分資料)
  data/timelapse/<date>-<session>-report.html          (單檔 HTML 報告，圖片皆內嵌 base64)

用法:
  python scripts/capture_timelapse_multi_station.py sunrise [YYYY-MM-DD]
  python scripts/capture_timelapse_multi_station.py sunset  [YYYY-MM-DD]
"""

import base64
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.request

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.dirname(__file__))
from analyze_sky_ground_truth import analyze_image_optics, get_twilight_window  # noqa: E402

OFFSETS_MIN = [-40, -30, -20, -10, 0, 10, 20, 30, 40]

# 站點沿用 capture_standard_stations.py 已驗證可直播的頻道 ID，
# 僅保留使用者指定的 7 站 (排除該檔案裡多出的「八里左岸」)。
SUNRISE_STATIONS = [
    {"id": "waimushan", "name": "外木山", "url": "https://www.youtube.com/watch?v=A9pluEagLD4"},
    {"id": "hongludi", "name": "烘爐地", "url": "https://www.youtube.com/watch?v=xxMRjVwCQ3o"},
]

SUNSET_STATIONS = [
    {"id": "xiangshan", "name": "101大樓", "url": "https://www.youtube.com/watch?v=z_fY1pj1VBw"},
    {"id": "dadaocheng", "name": "大稻埕", "url": "https://www.youtube.com/watch?v=Ndo_8RuefH4"},
    {"id": "tamsui", "name": "淡水漁人碼頭", "url": "https://www.youtube.com/watch?v=xwAWSh35uuw"},
    {"id": "jiufen", "name": "九份", "url": "https://www.youtube.com/watch?v=XSD5ptYisw8"},
    {"id": "maokong", "name": "貓空", "url": "https://www.youtube.com/watch?v=215ahZ_0rTg"},
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


def capture_frame_at(latest_url, latest_sq, dur, seconds_ago, output_jpg):
    target_sq = max(0, latest_sq - int(seconds_ago / dur))
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
            optics = analyze_image_optics(out_jpg, capture_time=target_dt, twilight_window=twilight_window)
            gated = optics.get("nightGate", {}).get("applied")
            tag = " 🌙 暗夜閘門已套用" if gated else ""
            print(f"    ✅ {label}: score={optics['score']} ({optics.get('level')}){tag}")
            frames.append({
                "offsetMin": offset_min,
                "ok": True,
                "capturedAtUtc": target_dt.isoformat(),
                "imagePath": os.path.relpath(out_jpg, REPO_ROOT).replace("\\", "/"),
                **optics
            })
        except Exception as e:
            print(f"    ❌ {label}: {e}")
            frames.append({"offsetMin": offset_min, "ok": False, "error": str(e)})

    return frames


def build_html_report(report, html_path):
    def img_data_uri(rel_path):
        abs_path = os.path.join(REPO_ROOT, rel_path)
        try:
            with open(abs_path, "rb") as f:
                return "data:image/jpeg;base64," + base64.b64encode(f.read()).decode("ascii")
        except Exception:
            return ""

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
                gate = fr.get("nightGate") or {}
                gated = gate.get("applied")
                chart_pts.append(score if score is not None else 0)
                gate_note = (
                    f'<div class="cell-gate" title="原始分數 {gate.get("rawScoreBeforeGate")}">🌙 暗夜閘門 (原 {gate.get("rawScoreBeforeGate")})</div>'
                    if gated else ""
                )
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

    out_dir = os.path.join(REPO_ROOT, "data", "timelapse", f"{date_str}-{session}")
    os.makedirs(out_dir, exist_ok=True)

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

    reports_dir = os.path.join(REPO_ROOT, "data", "timelapse")
    json_path = os.path.join(reports_dir, f"{date_str}-{session}.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    html_path = os.path.join(reports_dir, f"{date_str}-{session}-report.html")
    build_html_report(report, html_path)

    total = sum(len(s["frames"]) for s in report["stations"])
    ok = sum(1 for s in report["stations"] for fr in s["frames"] if fr.get("ok"))
    print(f"=== ✅ 完成 {ok}/{total} 張。報告: {html_path} ===")
    return report


if __name__ == "__main__":
    sess = sys.argv[1] if len(sys.argv) > 1 else "sunset"
    d_str = sys.argv[2] if len(sys.argv) > 2 else None
    run(sess, d_str)
