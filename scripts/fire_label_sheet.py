#!/usr/bin/env python3
"""
fire_label_sheet.py - 每場次自動產生「火燒雲人工標註表」，累積 v3 評分器需要的標註

背景 (2026-10-16)：v2 (只算紅橘色面積) 在樣本外失敗 —— 整片粉色罩被打高分、
金黃色的局部燒被打低分。使用者確認判斷依據是「雲有沒有被打出亮邊／亮紋」，
但目前只有約 8 張「有燒」的標註，不夠誠實地設計 v3。這支工具讓每場次自動
排出一張有編號的表，使用者只要列出「有燒」的編號，累積到 25-30 張正例再定 v3。

挑圖刻意用「寬鬆」條件 (暖色面積，含金黃)，不用 v2 分數 —— v2 會漏掉 v2 只給
5 分的局部燒 (10/10 八里 +10)，用它挑圖等於讓待驗證的評分器決定要驗證什麼。
表上不印任何分數，避免影響使用者判斷。

用法:
  python scripts/fire_label_sheet.py build <sunrise|sunset> [YYYY-MM-DD]   (日期省略 = 台北今天)
  python scripts/fire_label_sheet.py pending
  python scripts/fire_label_sheet.py label <YYYY-MM-DD>-<session> [--partial 3 5] [--full 2]
      (表上沒列到的編號一律記為「不算」)

環境變數:
  SKYFIRE_TIMELAPSE_DIR  縮時影格來源 (同 capture_timelapse_multi_station.py)
  SKYFIRE_LABEL_DIR      標註表、影格備份、labels.json 的存放處 (必填；放在
                         checkout 之外，理由同 SKYFIRE_TIMELAPSE_DIR)
"""

import argparse
import datetime
import json
import os
import re
import shutil
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import capture_timelapse_multi_station as tl  # noqa: E402
from analyze_sky_ground_truth import FIRE_CLOUD_DEFAULT_ROI_BOTTOM  # noqa: E402

# 已標註的 9 張有燒影格，寬鬆暖色面積最低 9.5% → 取一半當門檻留餘裕。
# 10/2~10/16 的 26 個場次平均每場只會選出約 3 站。
WARM_PCT_MIN = 5.0
# 預報有機會燒的站，就算畫面不暖也要放進表 —— 「預報高、實際沒燒」也是要的負例。
FORECAST_MIN = 30
# 入表的站放「會燒的時段」整段 + 最暖那張。已標註有燒的 9 張：日落 8 張落在
# 0~+30 (另 1 張 -30 是太陽本身)、日出 2 張在 -20/-10。只放最暖或最紅的單張都
# 會錯過 (10/16 淡水：最暖 +10、最紅 +40、使用者標有燒的是 +20)；暖色影格全放
# 則平均每場 14.5 張、最多 48 張，太累。
BURN_WINDOW = {"sunset": (0, 10, 20, 30), "sunrise": (-30, -20, -10, 0)}
TILE_WIDTH = 400


def label_dir():
    d = os.environ.get("SKYFIRE_LABEL_DIR", "").strip()
    if not d:
        sys.exit("請設定 SKYFIRE_LABEL_DIR (標註表與 labels.json 的存放處)")
    return d


def warm_pct(img, roi_bottom):
    """天空範圍內的寬鬆暖色面積 % (色相 ≤50° 或 ≥300°，含金黃)，只拿來挑圖。"""
    w, h = img.size
    sky = img.crop((0, 0, w, max(1, int(h * (roi_bottom or FIRE_CLOUD_DEFAULT_ROI_BOTTOM)))))
    hsv = np.asarray(sky.convert("HSV"), dtype=np.float32) / 255.0
    hue = hsv[..., 0] * 360
    mask = ((hue <= 50) | (hue >= 300)) & (hsv[..., 1] >= 0.30) & (hsv[..., 2] >= 0.30)
    return float(mask.mean() * 100)


def pick_tiles(stations, forecasts, session, already=frozenset()):
    """stations: {station: [(offsetMin, warmPct, imagePath), ...]}；forecasts: {station: 預報分}；
    already: 已標註過的 {(station, offsetMin)}，不再放進表。
    站內最暖的一張夠暖、或預報夠高，該站才入表；入表的站放 BURN_WINDOW 時段
    的影格加上最暖那張，依時間排序。"""
    tiles = []
    for st in sorted(stations):
        frames = stations[st]
        if not frames:
            continue
        warmest = max(frames, key=lambda f: f[1])
        if warmest[1] < WARM_PCT_MIN and (forecasts.get(st) or 0) < FORECAST_MIN:
            continue
        chosen = {f for f in frames if f[0] in BURN_WINDOW[session]} | {warmest}
        for off, warm, path in sorted(f for f in chosen if (st, f[0]) not in already):
            tiles.append({"station": st, "off": off, "warmPct": round(warm, 1), "file": os.path.basename(path)})
    for i, t in enumerate(tiles, 1):
        t["n"] = i
    return tiles


def best_bundle(base, date, session):
    """同場次可能有 07:40/09:00 (19:45/21:00) 兩份，取成功影格最多的那份。"""
    best, best_ok = None, -1
    for name in os.listdir(base):
        if not re.fullmatch(re.escape(f"{date}-{session}-") + r"\d{4}", name):
            continue
        rep = os.path.join(base, name, f"{date}-{session}.json")
        if not os.path.exists(rep):
            continue
        with open(rep, encoding="utf-8") as f:
            ok = sum(fr.get("ok", False) for s in json.load(f)["stations"] for fr in s["frames"])
        if ok > best_ok:
            best, best_ok = name, ok
    return best


def load_labels(ldir):
    path = os.path.join(ldir, "labels.json")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_forecasts(date, session):
    path = os.path.join(tl.REPO_ROOT, "data", "verification-records.json")
    with open(path, encoding="utf-8") as f:
        recs = json.load(f)
    out = {}
    for r in recs:
        if r.get("date") == date and r.get("session") == session:
            fc = (r.get("verification") or {}).get("fireCloud") or {}
            out[r.get("station")] = fc.get("predicted", (r.get("prediction") or {}).get("score"))
    return out


def sheet_paths(ldir, key):
    d = os.path.join(ldir, "sheets")
    return os.path.join(d, f"{key}.jpg"), os.path.join(d, f"{key}.json")


def cmd_build(date, session):
    ldir = label_dir()
    key = f"{date}-{session}"
    jpg, meta_path = sheet_paths(ldir, key)
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as f:
            if json.load(f).get("labeled"):
                print(f"{key} 已標註過，不重做")
                return
    base = tl.output_base_dir()
    bundle = best_bundle(base, date, session)
    if bundle is None:
        print(f"{key} 找不到縮時影格 ({base})")
        return
    src = os.path.join(base, bundle)
    with open(os.path.join(src, f"{key}.json"), encoding="utf-8") as f:
        report = json.load(f)
    stations = {}
    for s in report["stations"]:
        frames = []
        for fr in s["frames"]:
            if fr.get("ok") and fr.get("imagePath"):
                img = Image.open(os.path.join(src, fr["imagePath"])).convert("RGB")
                frames.append((fr["offsetMin"], warm_pct(img, tl.SKY_ROI_BOTTOMS.get(s["id"])), fr["imagePath"]))
        stations[s["id"]] = frames
    already = {(r["station"], r["off"]) for r in load_labels(ldir) if r["bundle"].rsplit("-", 1)[0] == key}
    tiles = pick_tiles(stations, load_forecasts(date, session), session, already)

    # 影格備份到標註資料夾：SKYFIRE_TIMELAPSE_DIR 在隨身碟上 (會掉線)，
    # GitHub artifact 14 天就過期，標註過的影格是日後重算 v3 的唯一依據。
    archive = os.path.join(ldir, "bundles", bundle)
    if not os.path.exists(archive):
        shutil.copytree(src, archive)
    os.makedirs(os.path.dirname(jpg), exist_ok=True)
    meta = {"key": key, "bundle": bundle, "labeled": False, "tiles": tiles}
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    if not tiles:
        print(f"{key}: 沒有夠暖或預報夠高的站，不出表")
        return

    try:
        font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 20)
    except OSError:
        font = ImageFont.load_default()
    # 一站一列，看得到同一站前後的變化 (燒不燒常要跟前後幾張比才看得出來)
    rows = []
    for t in tiles:
        img = Image.open(os.path.join(archive, t["file"])).convert("RGB")
        img = img.resize((TILE_WIDTH, int(img.height * TILE_WIDTH / img.width)))
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, TILE_WIDTH, 28], fill=(0, 0, 0))
        d.text((6, 3), f"#{t['n']}  {t['station']} {t['off']:+d}min", fill=(255, 255, 0), font=font)
        if not rows or rows[-1][0] != t["station"]:
            rows.append((t["station"], []))
        rows[-1][1].append(img)
    th = max(img.height for _, row in rows for img in row)
    cols = max(len(row) for _, row in rows)
    sheet = Image.new("RGB", (TILE_WIDTH * cols, th * len(rows)), (30, 30, 30))
    for y, (_, row) in enumerate(rows):
        for x, img in enumerate(row):
            sheet.paste(img, (x * TILE_WIDTH, y * th))
    sheet.save(jpg, quality=90)
    print(f"{key}: {len(tiles)} 張 → {jpg}")


def cmd_pending():
    d = os.path.join(label_dir(), "sheets")
    if not os.path.isdir(d):
        print("還沒有任何標註表")
        return
    for name in sorted(os.listdir(d)):
        if name.endswith(".json"):
            with open(os.path.join(d, name), encoding="utf-8") as f:
                meta = json.load(f)
            if not meta.get("labeled") and meta.get("tiles"):
                print(f"{meta['key']}: {len(meta['tiles'])} 張  {os.path.join(d, meta['key'] + '.jpg')}")


def apply_labels(meta, partial, full):
    """回傳要加進 labels.json 的列；表上沒列到的編號一律是「不算」(0)。"""
    known = {t["n"] for t in meta["tiles"]}
    bad = (set(partial) | set(full)) - known
    if bad:
        raise ValueError(f"表上沒有這些編號: {sorted(bad)}")
    if set(partial) & set(full):
        raise ValueError(f"同一張不能同時是局部燒和整片燒: {sorted(set(partial) & set(full))}")
    rows = []
    for t in meta["tiles"]:
        y = 2 if t["n"] in full else 1 if t["n"] in partial else 0
        rows.append({"bundle": meta["bundle"], "station": t["station"], "off": t["off"], "y": y,
                     "split": "dev", "src": f"auto:{meta['key']}#{t['n']}", "file": t["file"]})
    return rows


def cmd_label(key, partial, full):
    ldir = label_dir()
    _, meta_path = sheet_paths(ldir, key)
    with open(meta_path, encoding="utf-8") as f:
        meta = json.load(f)
    if meta.get("labeled"):
        sys.exit(f"{key} 已標註過")
    try:
        rows = apply_labels(meta, partial, full)
    except ValueError as e:
        sys.exit(f"{key}: {e}")
    for r in rows:
        r["path"] = os.path.join(ldir, "bundles", meta["bundle"], r.pop("file"))
    existing = load_labels(ldir)
    with open(os.path.join(ldir, "labels.json"), "w", encoding="utf-8") as f:
        json.dump(existing + rows, f, ensure_ascii=False, indent=1)
    meta["labeled"] = True
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    total_pos = sum(r["y"] > 0 for r in existing + rows)
    print(f"{key}: 記下 {len(rows)} 張 (有燒 {sum(r['y'] > 0 for r in rows)})；累計有燒 {total_pos} 張")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("session", choices=["sunrise", "sunset"])
    # 預設日期自己用 UTC+8 算：自架 runner 的 Git Bash 把 TZ=Asia/Taipei 當成 UTC，
    # workflow 裡用 `date +%F` 的話 07:40 日出那輪會拿到前一天。
    b.add_argument("date", nargs="?", default=None)
    sub.add_parser("pending")
    lb = sub.add_parser("label")
    lb.add_argument("key")
    lb.add_argument("--partial", type=int, nargs="*", default=[])
    lb.add_argument("--full", type=int, nargs="*", default=[])
    a = ap.parse_args()
    if a.cmd == "build":
        date = a.date or datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d")
        cmd_build(date, a.session)
    elif a.cmd == "pending":
        cmd_pending()
    else:
        cmd_label(a.key, a.partial, a.full)


if __name__ == "__main__":
    main()
