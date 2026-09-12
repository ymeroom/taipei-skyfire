#!/usr/bin/env python3
"""
test_daily_briefing.py - 日報產生器與校準守門邏輯的迴歸測試

執行：python tests/test_daily_briefing.py
涵蓋：
  - generate_daily_briefing: 有實測 → 帶 verdict；無實測 → 待驗證且無「命中」字樣
  - generate_daily_briefing: 排程跨午夜時退回最近一筆同時段紀錄
  - clean_cloud_bands: 區分「欄位擷取 bug 的全 0」與「真實通透晴空的全 0」
  - auto-calibrate has_usable_cloud_inputs: 同上，壞紀錄不進校準樣本
"""

import importlib.util
import os
import sys

HERE = os.path.dirname(__file__)
SCRIPTS = os.path.join(HERE, "..", "scripts")


def _load(mod_name, file_name):
    spec = importlib.util.spec_from_file_location(mod_name, os.path.join(SCRIPTS, file_name))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


briefing = _load("generate_daily_briefing", "generate_daily_briefing.py")
calib = _load("auto_calibrate_model", "auto-calibrate-model.py")

print("--- 🧪 Python 測試: 日報產生器 + 校準守門 ---")

# --- resolve_target_record ---
records = [
    {"id": "rec-2026-09-07-sunrise", "session": "sunrise", "date": "2026-09-07"},
    {"id": "rec-2026-09-06-sunset", "session": "sunset", "date": "2026-09-06"},
    {"id": "rec-2026-09-05-sunset", "session": "sunset", "date": "2026-09-05"},
]
assert briefing.resolve_target_record(records, "sunrise", "2026-09-07")["date"] == "2026-09-07"
# 今日尚無 sunset 紀錄 → 只接受「昨天」的 (跨午夜排程延遲)
assert briefing.resolve_target_record(records, "sunset", "2026-09-07")["date"] == "2026-09-06"
# 今日與昨日都沒有 → None (不退回前天，今天就是「尚無實測」)
assert briefing.resolve_target_record(records, "sunset", "2026-09-08") is None
assert briefing.resolve_target_record([], "sunrise", "2026-09-07") is None
print("✅ resolve_target_record：優先當日、其次僅接受昨日、更舊不退回")

# --- generate_briefing_obj: 每站列 + stationSummary + 頂層主測站 ---
# 實測現在是縮時多影格聚合出的「平均分」+「峰值分」兩個數字 (見
# capture_timelapse_multi_station.py 的 aggregate_station_scores)，不是單一
# groundTruthScore —— 每站都要能同時看到兩個數字，各自有自己的誤差/判定。
station_records = [
    {"id": "rec-2026-09-10-sunset-dadaocheng", "station": "dadaocheng", "date": "2026-09-10", "session": "sunset",
     "prediction": {"score": 44, "lowCloud": 5, "highCloud": 0, "midCloud": 2, "humidity": 80},
     "capture": {"kind": "timelapse-multi-frame", "frameCount": 9, "okFrameCount": 9},
     "verification": {"status": "verified_completed", "avgScore": 15, "peakScore": 40, "peakOffsetMin": 10,
                      "verdictAvg": "MISMATCH", "verdictAvgBadge": "⚠️ 出現偏差需校準", "errorAvgAbsolute": 29,
                      "verdictPeak": "SLIGHT_DEVIATION", "verdictPeakBadge": "⚡ 輕微偏差 (誤差 ≤ 18分)", "errorPeakAbsolute": 4}},
    {"id": "rec-2026-09-10-sunset-tamsui", "station": "tamsui", "date": "2026-09-10", "session": "sunset",
     "prediction": {"score": 51, "lowCloud": 8},
     "verification": {"status": "capture_unavailable", "avgScore": None, "peakScore": None}},
]
report = briefing.generate_briefing_obj(station_records, {}, "sunset", "2026-09-10", published_at="2026-09-10T21:00:00")
assert len(report["stations"]) == 2, "兩站兩列"
assert report["stations"][0]["name"].endswith("大稻埕碼頭"), "主測站列在最前、名稱取自 stations.json"
assert report["stations"][0]["phasePrep"] == "—" and report["stations"][0]["phasePost"] == "—", "不含手寫敘述"
assert "平均 15 分" in report["stations"][0]["phasePeak"] and "峰值 40 分" in report["stations"][0]["phasePeak"]
assert report["stations"][0]["forecast"] == "44 分（低雲 5%）"
assert report["stations"][1]["verdict"].startswith("⏳"), "capture_unavailable → 待驗證，不是命中"
assert report["stationSummary"]["verified"] == 1
assert report["stationSummary"]["pending"] == 1
assert report["stationSummary"]["bestStation"] == "dadaocheng"
assert report["prediction"]["score"] == 44, "頂層 prediction = 主測站"
assert report["groundTruth"]["avgScore"] == 15 and report["groundTruth"]["peakScore"] == 40
assert report["groundTruth"]["score"] == 40, "頂層代表分數優先用峰值 (拍照最在意有沒有拍到最佳時刻)"
assert report["groundTruth"]["verdict"] == "SLIGHT_DEVIATION", "頂層判定也優先採峰值判定"
print("✅ generate_briefing_obj：每站同時列出平均分+峰值分、stationSummary、頂層鏡射主測站、無手寫敘述")

# 全 pending 佔位：無紀錄時仍產出合法報告
empty_report = briefing.generate_briefing_obj([], {}, "sunset", "2026-09-10", published_at="x")
assert empty_report["stations"] == []
assert empty_report["stationSummary"]["verified"] == 0
assert empty_report["groundTruth"]["verdict"] == "PENDING"
print("✅ generate_briefing_obj：無紀錄時產出待驗證佔位")

# --- build_ground_truth: verified (平均分 + 峰值分兩個數字) ---
gt = briefing.build_ground_truth({
    "verification": {
        "status": "verified_completed", "avgScore": 17, "peakScore": 25, "peakOffsetMin": -10,
        "verdictAvg": "MISMATCH", "verdictAvgBadge": "⚠️ 出現偏差需校準",
        "verdictPeak": "MISMATCH", "verdictPeakBadge": "⚠️ 出現偏差需校準",
    }
})
assert gt["avgScore"] == 17 and gt["peakScore"] == 25
assert gt["score"] == 25, "代表分數優先用峰值"
assert gt["verdict"] == "MISMATCH"
assert gt["color"] == "#F87171"
assert "峰值 25 分" in gt["verdictBadge"] and "平均 17 分" in gt["verdictBadge"]
assert briefing.is_verified(gt) is True
print("✅ build_ground_truth：有實測時同時帶入平均分+峰值分與 verdict 顏色")

# --- build_ground_truth: 只有平均分那一側成功 (峰值那一側全數擷取失敗) ---
gt_avg_only = briefing.build_ground_truth({
    "verification": {
        "status": "verified_completed", "avgScore": 12, "peakScore": None,
        "verdictAvg": "MISMATCH", "verdictAvgBadge": "⚠️ 出現偏差需校準",
    }
})
assert gt_avg_only["score"] == 12, "峰值缺席時代表分數退回平均分"
assert gt_avg_only["verdict"] == "MISMATCH"
print("✅ build_ground_truth：峰值那一側沒抓到時，代表分數與判定誠實退回平均分")

# --- build_ground_truth: pending / capture_unavailable ---
for status in ("capture_unavailable", "captured_ready_for_scoring", None):
    rec = {"verification": {"status": status}} if status else {}
    g = briefing.build_ground_truth(rec)
    assert g["verdict"] == "PENDING", status
    assert g["score"] is None, status
    assert "命中" not in g["verdictBadge"] and "🎯" not in g["verdictBadge"], status
    assert briefing.is_verified(g) is False, status
print("✅ build_ground_truth：無實測時為 PENDING，絕無「命中／🎯」字樣")

# --- clean_cloud_bands ---
assert briefing.clean_cloud_bands(20, 15, 25, False) == (20, 15, 25)
# 全 0 + 無結構化輸入 (舊 || 0 bug) → 未知
assert briefing.clean_cloud_bands(0, 0, 0, False) == (None, None, None)
# 全 0 + 有結構化輸入 (真實晴空) → 保留 0
assert briefing.clean_cloud_bands(0, 0, 0, True) == (0, 0, 0)
assert briefing.clean_cloud_bands(None, 5, 5, True) == (None, None, None)
print("✅ clean_cloud_bands：區分 bug 全 0 與真實晴空全 0")

# --- has_usable_cloud_inputs (校準守門) ---
assert calib.has_usable_cloud_inputs({"highCloud": 20, "midCloud": 15, "lowCloud": 25}) is True
assert calib.has_usable_cloud_inputs({"highCloud": 0, "midCloud": 0, "lowCloud": 0}) is False
assert calib.has_usable_cloud_inputs(
    {"highCloud": 0, "midCloud": 0, "lowCloud": 0, "humidity": 73}
) is True
assert calib.has_usable_cloud_inputs({"highCloud": None, "midCloud": 0, "lowCloud": 0}) is False
print("✅ has_usable_cloud_inputs：舊 bug 全 0 紀錄不進校準樣本")

# --- expand_to_calibration_samples：平均分+峰值分各自算一個等權重樣本 ---
mixed_records = [
    # 新版：平均分+峰值分都有 → 展開成 2 個樣本
    {"prediction": {"highCloud": 10}, "verification": {"avgScore": 20, "peakScore": 35}},
    # 新版：只有平均分那一側成功 (峰值那一側全數擷取失敗) → 只展開 1 個樣本
    {"prediction": {"highCloud": 15}, "verification": {"avgScore": 12, "peakScore": None}},
    # 舊版單一 groundTruthScore (切換過渡期間仍會存在) → 相容成 1 個樣本
    {"prediction": {"highCloud": 20}, "verification": {"groundTruthScore": 18}},
    # 完全沒實測 (capture_unavailable) → 0 個樣本
    {"prediction": {"highCloud": 25}, "verification": {"avgScore": None, "peakScore": None}},
]
samples = calib.expand_to_calibration_samples(mixed_records)
assert len(samples) == 4, "2 (新版兩個都有) + 1 (只有平均) + 1 (舊版相容) + 0 (無實測) = 4"
scores = sorted(s["verification"]["groundTruthScore"] for s in samples)
assert scores == [12, 18, 20, 35], "平均分與峰值分都各自成為獨立樣本，全部平等餵進校準"
print("✅ expand_to_calibration_samples：平均分/峰值分各自等權重展開，舊版單一分數相容")

print("🎉 Python 測試全數 PASS!\n")
