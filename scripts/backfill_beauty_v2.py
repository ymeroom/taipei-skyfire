#!/usr/bin/env python3
"""
backfill_beauty_v2.py - 用留存的縮時影格，以美感分評分器 v2 (粉紅／洋紅暮光也算暖色)
重算既有驗證紀錄的天空美感實測。

只改美感分：verification.avgScore / peakScore / peakOffsetMin、舊版判定
(verdictAvg / verdictPeak) 與 verification.beauty。火燒雲分 (verification.fireCloud)
與鎖定預報一律不動。原本的 v1 數字存進 verification.beautyV1 備查。

影格來源是 GitHub Actions 的 timelapse-* artifact (保留 14 天) 下載後的資料夾，
每個資料夾內有 <date>-<session>.json 與影格 jpg。對應規則：紀錄的 verifiedAt 就是
寫入它的那次擷取，取 generatedAt (台北時間) ≤ verifiedAt 的最後一份報告。
先用報告裡存下的 v1 影格分數重算一次聚合，要與紀錄完全一致才改寫 (確認對到同一批
影格)；對不上或找不到影格的紀錄維持 v1，不猜。

暗夜閘門、雨天閘門沿用影格當時存下的判定 (不重新查天氣)；雨天閘門用現行規則
(只排除機位天空範圍以下的暖色，見 apply_rain_gate)，所以也用來把 2026-10-03 前
「下雨一律封頂 30 分」的紀錄改成新規則。

可重複執行：重算結果與紀錄相同的不改寫。原始數字存在 verification.beautyV1
(原本是 v1 的紀錄) 或 verification.beautyOriginal (原本就是 v2、只因雨天閘門重算)。

用法: python scripts/backfill_beauty_v2.py <artifact 資料夾的上層目錄> [--dry-run]
"""

import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from analyze_sky_ground_truth import BEAUTY_SCORER_VERSION, analyze_image_optics, apply_rain_gate  # noqa: E402
import capture_timelapse_multi_station as tl  # noqa: E402
import generate_daily_briefing as briefing  # noqa: E402

TAIPEI = datetime.timezone(datetime.timedelta(hours=8))
NIGHT_GATE_CAP = 12


def load_reports(bundles_root):
    """{(date, session): [(generatedAt_local, bundle_dir, report), ...]}"""
    out = {}
    for name in sorted(os.listdir(bundles_root)):
        d = os.path.join(bundles_root, name)
        if not os.path.isdir(d):
            continue
        for f in os.listdir(d):
            if not f.endswith(".json"):
                continue
            with open(os.path.join(d, f), "r", encoding="utf-8") as fh:
                rep = json.load(fh)
            if not isinstance(rep, dict) or "stations" not in rep or "generatedAt" not in rep:
                continue
            gen = datetime.datetime.fromisoformat(rep["generatedAt"])
            if gen.tzinfo is None:
                gen = gen.replace(tzinfo=TAIPEI)
            out.setdefault((rep["date"], rep["session"]), []).append((gen, d, rep))
    return out


def find_station_frames(reports, record):
    verified = (record.get("verification") or {}).get("verifiedAt")
    if not verified:
        return None, None
    verified = datetime.datetime.fromisoformat(verified)
    candidates = [c for c in reports.get((record["date"], record["session"]), []) if c[0] <= verified]
    if not candidates:
        return None, None
    _, bundle_dir, rep = max(candidates, key=lambda c: c[0])
    stations = rep["stations"] if isinstance(rep["stations"], list) else list(rep["stations"].values())
    st = next((s for s in stations if s.get("id") == record["station"]), None)
    return (bundle_dir, st["frames"]) if st else (None, None)


def rescore_frame(bundle_dir, frame, sky_roi_bottom):
    fr = dict(frame)
    if not fr.get("ok") or not fr.get("imagePath"):
        return fr
    path = os.path.join(bundle_dir, fr["imagePath"])
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    result = analyze_image_optics(path, sky_roi_bottom=sky_roi_bottom)
    if (fr.get("nightGate") or {}).get("applied"):
        result["score"] = min(result["score"], NIGHT_GATE_CAP)
    if (fr.get("rainGate") or {}).get("isRaining"):
        result = apply_rain_gate(result, {"isRaining": True})
    fr["score"] = result["score"]
    return fr


BEAUTY_FIELDS = ("avgScore", "peakScore", "peakOffsetMin")


def _original_of(v):
    """擷取當下寫進紀錄的美感數字 (= artifact 裡影格分數的聚合)。"""
    return v.get("beautyV1") or v.get("beautyOriginal") or {k: v.get(k) for k in BEAUTY_FIELDS}


def apply_beauty(record, agg):
    """把新的美感聚合寫回紀錄，判定規則同 build_station_verification_record。"""
    v = record["verification"]
    if "beautyV1" not in v and "beautyOriginal" not in v:
        current = {k: v.get(k) for k in BEAUTY_FIELDS}
        if v.get("beautyScorerVersion", 1) == 1:
            v["beautyV1"] = current
        else:
            v["beautyOriginal"] = {**current, "scorerVersion": v["beautyScorerVersion"]}
    v["avgScore"], v["peakScore"], v["peakOffsetMin"] = agg["avgScore"], agg["peakScore"], agg["peakOffsetMin"]
    pred = record.get("prediction") or {}
    if v.get("status") == "verified_completed" and pred.get("score") is not None:
        for key, val in (("Avg", agg["avgScore"]), ("Peak", agg["peakScore"])):
            if val is None:
                continue
            err = abs(pred["score"] - val)
            verdict, badge = tl.verdict_for_error(err)
            v[f"error{key}Absolute"], v[f"verdict{key}"], v[f"verdict{key}Badge"] = err, verdict, badge
    beauty = tl.peak_verdict(pred.get("beautyScore"), agg["peakScore"])
    if beauty:
        v["beauty"] = beauty
    v["beautyScorerVersion"] = BEAUTY_SCORER_VERSION


def backfill(records, reports, roi_bottoms):
    updated, skipped = [], []
    for rec in records:
        if (rec.get("capture") or {}).get("kind") != "timelapse-multi-frame":
            continue
        v = rec.get("verification") or {}
        if v.get("avgScore") is None and v.get("peakScore") is None:
            continue
        bundle_dir, frames = find_station_frames(reports, rec)
        if frames is None:
            skipped.append((rec["id"], "找不到影格"))
            continue
        # 用報告存下的 v1 影格分數重算，必須與紀錄的 v1 一致，才確定是同一批影格
        orig = _original_of(v)
        replay = tl.aggregate_station_scores(frames, rec["session"])
        if (replay["avgScore"], replay["peakScore"]) != (orig["avgScore"], orig["peakScore"]):
            skipped.append((rec["id"], f"影格對不上 (重算 {replay['avgScore']}/{replay['peakScore']}，"
                                       f"紀錄 {orig['avgScore']}/{orig['peakScore']})"))
            continue
        try:
            new_frames = [rescore_frame(bundle_dir, f, roi_bottoms.get(rec["station"])) for f in frames]
        except FileNotFoundError as e:
            skipped.append((rec["id"], f"影格檔缺失 {e}"))
            continue
        agg = tl.aggregate_station_scores(new_frames, rec["session"])
        if (v.get("beautyScorerVersion") == BEAUTY_SCORER_VERSION
                and all(agg[k] == v.get(k) for k in BEAUTY_FIELDS)):
            continue  # 已是現行規則的結果，不改寫
        apply_beauty(rec, agg)
        rec["verification"]["beautyRescoredFrom"] = os.path.basename(bundle_dir)
        updated.append(rec)
    return updated, skipped


def refresh_reports(reports, records, touched_keys):
    """只重建日報裡由實測推導的欄位 (groundTruth / 每站列 / 站別摘要 / 模型表現句)；
    發布時間、標題、預報區塊原樣保留。"""
    n = 0
    for rep in reports:
        if (rep.get("date"), rep.get("session")) not in touched_keys:
            continue
        recs = briefing._sort_primary_first(
            [r for r in records if briefing._matches(r, rep["session"], rep["date"])], rep["session"])
        if not recs:
            continue
        gt = briefing.build_ground_truth(recs[0])
        dual = briefing.build_dual_scores(recs[0])
        if dual:
            gt.update(dual)
        rep["groundTruth"] = gt
        rep["stations"] = briefing.build_station_rows(recs)
        rep["stationSummary"] = briefing.build_station_summary(recs)
        rep["summaryAnalysis"]["modelPerformance"] = briefing.build_summary_analysis(
            rep.get("prediction") or {}, gt)["modelPerformance"]
        n += 1
    return n


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        sys.exit(1)
    dry_run = "--dry-run" in sys.argv
    data_dir = os.path.join(tl.REPO_ROOT, "data")
    records_path = os.path.join(data_dir, "verification-records.json")
    reports_path = os.path.join(data_dir, "daily-reports.json")
    with open(records_path, "r", encoding="utf-8") as f:
        records = json.load(f)

    updated, skipped = backfill(records, load_reports(args[0]), tl.SKY_ROI_BOTTOMS)
    for r in sorted(updated, key=lambda r: r["id"]):
        v, v1 = r["verification"], _original_of(r["verification"])
        print(f"{r['id']}: 美感峰值 {v1['peakScore']} → {v['peakScore']}・平均 {v1['avgScore']} → {v['avgScore']}"
              f"  (預報 {(v.get('beauty') or {}).get('predicted', '—')})")
    for rid, why in skipped:
        print(f"略過 {rid}: {why}")

    with open(reports_path, "r", encoding="utf-8") as f:
        reports = json.load(f)
    touched = refresh_reports(reports, records, {(r["date"], r["session"]) for r in updated})
    print(f"共 {len(updated)} 筆紀錄改寫 (美感分 v{BEAUTY_SCORER_VERSION} + 現行雨天閘門)、略過 {len(skipped)} 筆、"
          f"{touched} 篇日報更新{'（dry run，未寫入）' if dry_run else ''}")
    if not dry_run:
        with open(records_path, "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False, indent=2)
        with open(reports_path, "w", encoding="utf-8") as f:
            json.dump(reports, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
