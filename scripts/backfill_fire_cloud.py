#!/usr/bin/env python3
"""
backfill_fire_cloud.py - 用磁碟上留存的縮時影格，替既有驗證紀錄補上火燒雲分。

只新增 verification.fireCloud (標記 backfilledFrom)，既有的美感分 (avgScore /
peakScore) 與舊判定一律不動。對應規則：紀錄的 verifiedAt 就是寫入它的那次擷取，
所以取「執行時刻 (資料夾名稱的 HHMM) ≤ verifiedAt」的最後一個資料夾。找不到
資料夾 (超過 14 天保留期已被修剪) 的紀錄維持沒有 fireCloud，不猜。

用法: python scripts/backfill_fire_cloud.py [--dry-run]
"""

import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from PIL import Image  # noqa: E402

from analyze_sky_ground_truth import analyze_fire_cloud  # noqa: E402
import capture_timelapse_multi_station as tl  # noqa: E402
import generate_daily_briefing as briefing  # noqa: E402

TAIPEI = datetime.timezone(datetime.timedelta(hours=8))
NIGHT_GATE_CAP = 12


def find_bundle(base_dir, record):
    verified = record.get("verification", {}).get("verifiedAt")
    if not verified:
        return None
    local = datetime.datetime.fromisoformat(verified).astimezone(TAIPEI)
    prefix = f"{record['date']}-{record['session']}-"
    candidates = []
    for name in os.listdir(base_dir):
        m = re.fullmatch(re.escape(prefix) + r"(\d{4})", name)
        if m and m.group(1) <= local.strftime("%H%M"):
            candidates.append(name)
    return os.path.join(base_dir, max(candidates)) if candidates else None


def rescore_frames(bundle_dir, record, roi_bottoms):
    report_path = os.path.join(bundle_dir, f"{record['date']}-{record['session']}.json")
    with open(report_path, "r", encoding="utf-8") as f:
        report = json.load(f)
    station = next((s for s in report["stations"] if s["id"] == record["station"]), None)
    if station is None:
        return None
    frames = []
    for fr in station["frames"]:
        fr = dict(fr)
        if fr.get("ok") and fr.get("imagePath"):
            img = Image.open(os.path.join(bundle_dir, fr["imagePath"])).convert("RGB")
            score = analyze_fire_cloud(img, roi_bottoms.get(record["station"]))["score"]
            if score is not None and (fr.get("nightGate") or {}).get("applied"):
                score = min(score, NIGHT_GATE_CAP)
            fr["fireCloudScore"] = score
        frames.append(fr)
    return frames


def backfill(records, base_dir, roi_bottoms):
    updated = []
    for rec in records:
        if rec.get("capture", {}).get("kind") != "timelapse-multi-frame":
            continue
        bundle = find_bundle(base_dir, rec)
        if bundle is None:
            continue
        frames = rescore_frames(bundle, rec, roi_bottoms)
        if frames is None:
            continue
        tl.add_dual_score_verdicts(rec, tl.aggregate_fire_cloud_scores(frames, rec["session"]))
        rec["verification"]["fireCloud"]["backfilledFrom"] = os.path.basename(bundle)
        updated.append(rec)
    return updated


def backfill_reports(reports, records):
    """既有日報只「加」雙分數欄位 (groundTruth / 每站列 / 模型表現句)，
    發布時間、預報摘要等其餘內容原樣保留。"""
    touched = 0
    for rep in reports:
        recs = briefing._sort_primary_first(
            [r for r in records if briefing._matches(r, rep["session"], rep["date"])], rep["session"])
        dual = briefing.build_dual_scores(recs[0]) if recs else None
        if not dual:
            continue
        rep["groundTruth"].update(dual)
        rep["prediction"]["beautyScore"] = dual["beauty"]["predicted"]
        by_name = {row.get("name"): row for row in rep.get("stations") or []}
        for r in recs:
            row = by_name.get(briefing.STATIONS_META.get(r.get("station"), {}).get("name"))
            station_dual = briefing.build_dual_scores(r)
            if row is not None and station_dual:
                row.update(station_dual)
        rep["summaryAnalysis"]["modelPerformance"] = (
            briefing._dual_sentence("🔥 火燒雲", dual["fireCloud"])
            + briefing._dual_sentence("🌅 天空美感", dual["beauty"]))
        touched += 1
    return touched


def main():
    dry_run = "--dry-run" in sys.argv
    data_dir = os.path.join(tl.REPO_ROOT, "data")
    records_path = os.path.join(data_dir, "verification-records.json")
    reports_path = os.path.join(data_dir, "daily-reports.json")
    with open(records_path, "r", encoding="utf-8") as f:
        records = json.load(f)
    updated = backfill(records, tl.output_base_dir(), tl.SKY_ROI_BOTTOMS)
    for r in updated:
        fc = r["verification"]["fireCloud"]
        print(f"{r['id']}: 火燒雲 平均 {fc['avgScore']}・峰值 {fc['peakScore']} "
              f"(預報 {fc.get('predicted')}, {fc.get('verdictPeak', '—')}) ← {fc['backfilledFrom']}")
    with open(reports_path, "r", encoding="utf-8") as f:
        reports = json.load(f)
    touched = backfill_reports(reports, records)
    print(f"共 {len(updated)} 筆紀錄補上火燒雲分、{touched} 篇日報補上雙分數"
          f"{'（dry run，未寫入）' if dry_run else ''}")
    if not dry_run:
        with open(records_path, "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False, indent=2)
        with open(reports_path, "w", encoding="utf-8") as f:
            json.dump(reports, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
