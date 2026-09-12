#!/usr/bin/env python3
"""
test_timelapse_aggregation.py - 縮時多影格聚合出「平均分」+「峰值分」的迴歸測試

執行：python tests/test_timelapse_aggregation.py
涵蓋：
  - compute_target_sq: DVR 回溯超出範圍時拒絕擷取 (不冒充錯誤時刻的畫面)
  - aggregate_station_scores: 平均用全部 9 張、峰值只在對應側 (日出前/日落後) 搜尋
  - verdict_for_error: 與 live-capture-core.js 同門檻
  - build_station_verification_record / write_verification_records:
    無鎖定預測、全數擷取失敗、正常兩則分數三種情境的紀錄形狀
"""

import copy
import importlib.util
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(__file__)
SCRIPTS = os.path.join(HERE, "..", "scripts")


def _load(mod_name, file_name):
    spec = importlib.util.spec_from_file_location(mod_name, os.path.join(SCRIPTS, file_name))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


tl = _load("capture_timelapse_multi_station", "capture_timelapse_multi_station.py")

print("--- 🧪 Python 測試: 縮時多影格聚合 (平均分 + 峰值分) ---")

# --- compute_target_sq ---
assert tl.compute_target_sq(latest_sq=1000, dur=5.0, seconds_ago=100) == 980
try:
    tl.compute_target_sq(latest_sq=10, dur=5.0, seconds_ago=1000)
    assert False, "應該要拒絕超出 DVR 回溯範圍的請求"
except RuntimeError as e:
    assert "DVR" in str(e)
print("✅ compute_target_sq：DVR 回溯超出範圍時拒絕擷取，不悄悄夾到 sq=0")

# --- verdict_for_error ---
assert tl.verdict_for_error(8) == ("EXACT_MATCH", "🎯 極致精準 (誤差 ≤ 8分)")
assert tl.verdict_for_error(18)[0] == "SLIGHT_DEVIATION"
assert tl.verdict_for_error(19)[0] == "MISMATCH"
print("✅ verdict_for_error：門檻與 live-capture-core.js 一致 (≤8 / ≤18 / 其餘)")

# --- bundle_folder_name：同一天同時段兩次執行不互相覆蓋 ---
run1 = tl.datetime.datetime.fromisoformat("2026-09-12T11:00:00+00:00")  # 台北 19:00
run2 = tl.datetime.datetime.fromisoformat("2026-09-12T13:00:00+00:00")  # 台北 21:00
name1 = tl.bundle_folder_name("2026-09-12", "sunset", run1)
name2 = tl.bundle_folder_name("2026-09-12", "sunset", run2)
assert name1 == "2026-09-12-sunset-1900"
assert name2 == "2026-09-12-sunset-2100"
assert name1 != name2, "同一天兩次擷取要落在不同資料夾，第二次不能蓋掉第一次"
print("✅ bundle_folder_name：資料夾名稱帶執行時刻，同日兩次擷取各自獨立")

# --- prune_old_bundles：新舊兩種資料夾命名格式都要被辨識 (不能因為改格式而
# 從此再也修剪不到，導致自架 runner 磁碟被歷史報告無限堆積) ---
prune_dir = tempfile.mkdtemp(prefix="skyfire-prune-")
try:
    old_format = os.path.join(prune_dir, "2026-08-01-sunset")       # 併入時間標記前的舊格式
    new_format = os.path.join(prune_dir, "2026-08-01-sunset-1900")  # 現在的新格式
    unrelated = os.path.join(prune_dir, "not-a-bundle-folder")
    for d in (old_format, new_format, unrelated):
        os.makedirs(d)
    old_time = tl.time.time() - (tl.BUNDLE_RETENTION_DAYS + 1) * 86400
    for d in (old_format, new_format, unrelated):
        os.utime(d, (old_time, old_time))

    tl.prune_old_bundles(prune_dir)

    remaining = set(os.listdir(prune_dir))
    assert old_format.split(os.sep)[-1] not in remaining, "舊格式資料夾也要能被修剪"
    assert new_format.split(os.sep)[-1] not in remaining, "新格式 (帶時刻) 資料夾要能被修剪"
    assert "not-a-bundle-folder" in remaining, "不符合命名規則的目錄不該被誤刪"
    print("✅ prune_old_bundles：新舊資料夾命名格式都能被正確修剪，不誤刪無關目錄")
finally:
    shutil.rmtree(prune_dir, ignore_errors=True)


def mk_frame(offset_min, score, ok=True):
    return {"offsetMin": offset_min, "ok": ok, "score": score, "level": "x"}


# --- aggregate_station_scores: 日出只看 T<=0 那一側找峰值 ---
sunrise_frames = [
    mk_frame(-40, 10), mk_frame(-30, 20), mk_frame(-20, 55), mk_frame(-10, 40), mk_frame(0, 30),
    mk_frame(10, 90), mk_frame(20, 5), mk_frame(30, 5), mk_frame(40, 5),
]
agg = tl.aggregate_station_scores(sunrise_frames, "sunrise")
assert agg["peakScore"] == 55, "日出峰值只能來自 offsetMin<=0 那一側 (90 分那張在日出後，不算)"
assert agg["peakOffsetMin"] == -20
assert agg["peakSide"] == "pre-sunrise"
assert agg["avgScore"] == round(sum(f["score"] for f in sunrise_frames) / 9, 1), "平均要用全部 9 張"
assert agg["okFrameCount"] == 9 and agg["frameCount"] == 9
print("✅ aggregate_station_scores：日出峰值只在 T<=0 (日出前) 那一側搜尋，平均用全部 9 張")

# --- aggregate_station_scores: 日落只看 T>=0 那一側找峰值 ---
sunset_frames = [
    mk_frame(-40, 90), mk_frame(-30, 5), mk_frame(-20, 5), mk_frame(-10, 5), mk_frame(0, 30),
    mk_frame(10, 60), mk_frame(20, 22), mk_frame(30, 8), mk_frame(40, 8),
]
agg2 = tl.aggregate_station_scores(sunset_frames, "sunset")
assert agg2["peakScore"] == 60, "日落峰值只能來自 offsetMin>=0 那一側 (90 分那張在日落前，不算)"
assert agg2["peakOffsetMin"] == 10
assert agg2["peakSide"] == "post-sunset"
print("✅ aggregate_station_scores：日落峰值只在 T>=0 (日落後) 那一側搜尋")

# --- aggregate_station_scores: 全數擷取失敗 → 兩個分數都是 None，不捏造 ---
failed_frames = [mk_frame(o, None, ok=False) for o in tl.OFFSETS_MIN]
agg3 = tl.aggregate_station_scores(failed_frames, "sunset")
assert agg3["avgScore"] is None and agg3["peakScore"] is None
assert agg3["okFrameCount"] == 0 and agg3["frameCount"] == 9
print("✅ aggregate_station_scores：全數擷取失敗時兩個分數皆為 None，不捏造")

# --- aggregate_station_scores: 只有另一側有資料 → 峰值仍誠實回傳 None ---
only_wrong_side = [mk_frame(-40, 77, ok=True)] + [mk_frame(o, None, ok=False) for o in tl.OFFSETS_MIN[1:]]
agg4 = tl.aggregate_station_scores(only_wrong_side, "sunset")  # sunset 峰值只看 offsetMin>=0
assert agg4["peakScore"] is None, "唯一成功的影格在錯誤的那一側，峰值不能硬拿平均側的分數頂替"
assert agg4["avgScore"] == 77.0, "平均仍照樣涵蓋全部成功影格 (不分側)"
print("✅ aggregate_station_scores：峰值那一側全軍覆沒時峰值誠實留 None，平均不受側別限制")

# ----------------------------------------------------------------
# build_station_verification_record / write_verification_records
# ----------------------------------------------------------------
dir_ = tempfile.mkdtemp(prefix="skyfire-timelapse-agg-")
try:
    data_dir = os.path.join(dir_, "data")
    os.makedirs(data_dir, exist_ok=True)

    # 形狀跟 lock-forecast.js 實際寫出的一致：雲量/濕度巢狀在 weather 底下，
    # 不是頂層欄位 —— 這是 2026-09-12 抓到的真實 bug 的迴歸測試案例
    # (load_locked_prediction 曾直接回傳這個巢狀物件，未攤平成扁平形狀，
    # 導致 clean_cloud_bands 誤判雲量缺失，日報顯示「未隨鎖定檔存下」)。
    locked = {
        "date": "2026-09-12", "session": "sunset", "lockedAt": "2026-09-12T07:30:00.000Z",
        "stations": {
            "dadaocheng": {
                "score": 50, "rating": "x", "color": "#7B88A8",
                "weather": {"cloudHigh": 10, "cloudMid": 20, "cloudLow": 5, "cloudTotal": 30,
                            "humidity": 70, "precipProb": 12, "visibilityKm": 17},
                "metrics": {"horizonClearance": 40, "visKm": 17}
            }
        }
    }
    with open(os.path.join(data_dir, "locked-sunset-forecast.json"), "w", encoding="utf-8") as f:
        json.dump(locked, f)

    station = {"id": "dadaocheng", "name": "台北大稻埕碼頭"}
    anchor_utc = tl.datetime.datetime.fromisoformat("2026-09-12T10:00:00+00:00")

    # 情境 1：正常兩則分數都能算
    rec = tl.build_station_verification_record(
        station, sunset_frames, "sunset", "2026-09-12", anchor_utc, data_dir
    )
    assert rec["id"] == "rec-2026-09-12-sunset-dadaocheng"
    assert rec["verification"]["status"] == "verified_completed"
    assert rec["verification"]["avgScore"] == agg2["avgScore"]
    assert rec["verification"]["peakScore"] == 60
    assert rec["verification"]["errorAvgAbsolute"] == abs(50 - agg2["avgScore"])
    assert rec["verification"]["errorPeakAbsolute"] == abs(50 - 60)
    assert rec["verification"]["verdictPeak"] == "SLIGHT_DEVIATION"
    print("✅ build_station_verification_record：正常情境同時算出 errorAvg/errorPeak 與各自判定")

    # --- load_locked_prediction / flatten_station_lock：雲量攤平不遺失 ---
    pred = rec["prediction"]
    assert pred["highCloud"] == 10 and pred["midCloud"] == 20 and pred["lowCloud"] == 5, (
        "巢狀 weather.cloudHigh/cloudMid/cloudLow 必須被攤平成頂層 highCloud/midCloud/lowCloud，"
        "否則 generate_daily_briefing.py 的 clean_cloud_bands 會誤判雲量缺失"
    )
    assert pred["humidity"] == 70 and pred["visibilityKm"] == 17
    assert pred["horizonClearance"] == 40
    print("✅ load_locked_prediction：巢狀鎖定資料正確攤平，雲量細項不遺失")

    # 情境 2：找不到鎖定預測 —— 有實測但無法算誤差，不硬湊
    rec_nopred = tl.build_station_verification_record(
        {"id": "unknown-station", "name": "x"}, sunset_frames, "sunset", "2026-09-12", anchor_utc, data_dir
    )
    assert rec_nopred["verification"]["status"] == "no_locked_prediction"
    assert "errorAvgAbsolute" not in rec_nopred["verification"]
    assert rec_nopred["verification"]["avgScore"] is not None, "沒有預測不代表沒有實測，實測分數要保留"
    print("✅ build_station_verification_record：找不到鎖定預測時誠實標記，不硬湊誤差")

    # 情境 3：全數擷取失敗
    rec_fail = tl.build_station_verification_record(
        station, failed_frames, "sunset", "2026-09-12", anchor_utc, data_dir
    )
    assert rec_fail["verification"]["status"] == "capture_unavailable"
    assert rec_fail["verification"]["avgScore"] is None
    print("✅ build_station_verification_record：全數擷取失敗時標記 capture_unavailable")

    # --- write_verification_records: upsert 語意 (同 id 原地取代、新 id 插最前面) ---
    report = {
        "date": "2026-09-12", "session": "sunset",
        "anchorUtc": anchor_utc.isoformat(),
        "stations": [{"id": "dadaocheng", "name": "台北大稻埕碼頭", "frames": sunset_frames}]
    }
    records_v1 = tl.write_verification_records(report, data_dir=data_dir)
    assert len(records_v1) == 1
    assert records_v1[0]["verification"]["peakScore"] == 60

    # 同一天同一站再跑一次 (例如 09:00/21:00 補跑) → 原地覆蓋，不重複累積
    report2 = copy.deepcopy(report)
    report2["stations"][0]["frames"] = sunrise_frames  # 隨便換一組資料代表「重新擷取」
    records_v2 = tl.write_verification_records(report2, data_dir=data_dir)
    assert len(records_v2) == 1, "同 id 應該原地覆蓋，不是疊加成兩筆"
    on_disk = json.load(open(os.path.join(data_dir, "verification-records.json"), encoding="utf-8"))
    assert on_disk == records_v2
    print("✅ write_verification_records：同一天同站補跑時原地覆蓋，寫入內容與回傳一致")
finally:
    shutil.rmtree(dir_, ignore_errors=True)

print("🎉 縮時聚合測試全數 PASS!\n")
