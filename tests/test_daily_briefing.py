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

# --- build_ground_truth: verified ---
gt = briefing.build_ground_truth({
    "verification": {
        "status": "verified_completed", "groundTruthScore": 17,
        "groundTruthBadge": "陰沉沉寂", "verdict": "MISMATCH",
        "verdictBadge": "⚠️ 出現偏差需校準",
    }
})
assert gt["score"] == 17 and gt["verdict"] == "MISMATCH"
assert gt["color"] == "#F87171"
assert briefing.is_verified(gt) is True
print("✅ build_ground_truth：有實測時帶入分數與 verdict 顏色")

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

print("🎉 Python 測試全數 PASS!\n")
