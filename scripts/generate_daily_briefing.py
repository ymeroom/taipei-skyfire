#!/usr/bin/env python3
"""
generate_daily_briefing.py - 每日實況驗證日報產生器

從 data/verification-records.json 讀取「當日該時段」實際擷取與光學評分結果，
組成 data/daily-reports.json 的一筆日報。

設計原則：日報只轉述真實資料。
  - 有 verified_completed 的紀錄 → 帶入實測分數與 verdict。
  - 擷取失敗 / 尚未評分 → 明確標成「待實測驗證」，不給任何「命中」字樣。
舊版此腳本整份硬編 (每天都寫「5 分 / 100% 命中陰天」加固定測站敘述)，
與實際 verification-records.json 完全脫鉤，是假資料來源。
"""

import os
import sys
import json
import datetime

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")

VERDICT_COLORS = {
    "EXACT_MATCH": "#4ADE80",
    "SLIGHT_DEVIATION": "#FBBF24",
    "MISMATCH": "#F87171",
}
PENDING_GROUND_TRUTH = {
    "score": None,
    "rating": None,
    "verdict": "PENDING",
    "verdictBadge": "⏳ 實測待驗證",
    "color": "#94A3B8",
}


def _load_json(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"⚠️ 讀取 {os.path.basename(path)} 失敗，改用預設值: {e}")
        return default


def resolve_target_record(records, session, today_str):
    """優先取今日該時段紀錄；沒有的話只接受「昨天」的同時段紀錄 (排程跨午夜延遲)。

    刻意不退回更舊的紀錄：擷取整個失敗時 (window miss / capture step error)，
    今日就是「尚無實測」，不該拿前天的報告重新掛上今天的時間戳假裝有做。
    verification-records.json 依慣例新→舊排列 (capture-validation.js 用 unshift)。
    """
    exact = next((r for r in records if r.get("id") == f"rec-{today_str}-{session}"), None)
    if exact:
        return exact
    try:
        yesterday = (datetime.date.fromisoformat(today_str) - datetime.timedelta(days=1)).isoformat()
    except ValueError:
        yesterday = None
    return next(
        (r for r in records
         if r.get("session") == session and r.get("date") in (today_str, yesterday)),
        None,
    )


def clean_cloud_bands(high, mid, low, has_structured_inputs):
    """把「三頻皆缺，或疑似欄位擷取 bug 造成的全 0」視為未知 (None)。

    2026-09 之前走鎖定路徑的 verification 紀錄因欄位擷取 bug 雲量一律 0/0/0
    (詳見 capture-validation.js buildPredictionFromLock)。真正的通透晴空也可能
    三頻全 0，兩者靠「有無結構化 weather 輸入 (humidity 等)」區分。
    """
    bands = [high, mid, low]
    if any(b is None for b in bands):
        return None, None, None
    if all((b or 0) == 0 for b in bands) and not has_structured_inputs:
        return None, None, None
    return high, mid, low


def build_prediction(record, locked):
    src = (record or {}).get("prediction") or {}
    skyfire = (locked or {}).get("skyfire") or {}

    if not src and skyfire:
        w = (locked or {}).get("weather") or {}
        src = {
            "score": skyfire.get("score"),
            "rating": (skyfire.get("rating") or {}).get("badge"),
            "color": (skyfire.get("rating") or {}).get("color"),
            "highCloud": w.get("cloudHigh"),
            "midCloud": w.get("cloudMid"),
            "lowCloud": w.get("cloudLow"),
            "totalCloud": w.get("cloudTotal"),
            "humidity": w.get("humidity"),
        }

    has_structured_inputs = src.get("humidity") is not None or src.get("totalCloud") is not None
    high, mid, low = clean_cloud_bands(
        src.get("highCloud"), src.get("midCloud"), src.get("lowCloud"), has_structured_inputs
    )
    return {
        "score": src.get("score"),
        "rating": src.get("rating"),
        "color": src.get("color") or "#E5A50A",
        "highCloud": high,
        "midCloud": mid,
        "lowCloud": low,
        "summary": (skyfire.get("rating") or {}).get("summary") or "",
    }


def build_ground_truth(record):
    v = (record or {}).get("verification") or {}
    if v.get("status") == "verified_completed" and v.get("groundTruthScore") is not None:
        verdict = v.get("verdict") or "MISMATCH"
        return {
            "score": v.get("groundTruthScore"),
            "rating": v.get("groundTruthBadge"),
            "verdict": verdict,
            "verdictBadge": v.get("verdictBadge") or verdict,
            "color": VERDICT_COLORS.get(verdict, "#F87171"),
            "chromaticPurity": v.get("chromaticPurity"),
        }
    return {**PENDING_GROUND_TRUTH, "captureStatus": v.get("status") or "no_record"}


def is_verified(ground_truth):
    return ground_truth.get("verdict") not in (None, "PENDING")


def build_station_rows(record, prediction, ground_truth):
    """單列：直接對應本場唯一一個官方直播機位的真實擷取結果。

    舊版此處是 2~6 個手寫測站段落，與當天實況無關，且逐日一字不差 ——
    正是那份靜態文字讓「日報造假」長期沒被發現。
    """
    if not record:
        return []

    if is_verified(ground_truth):
        peak = f"光學觀測判定 {ground_truth['score']} 分（{ground_truth.get('rating') or '—'}）"
    elif (record.get("verification") or {}).get("status") == "capture_unavailable":
        peak = "出景窗口外或擷取失敗，本場無實測影格"
    else:
        peak = "影格已擷取，光學評分尚未完成"

    forecast = "—"
    if prediction.get("score") is not None:
        low = prediction.get("lowCloud")
        forecast = f"{prediction['score']} 分"
        if low is not None:
            forecast += f"（低雲 {low}%）"

    return [{
        "name": record.get("source") or "官方直播影格",
        "icon": "📸",
        "tag": "官方 4K 直播・DVR 回溯精確影格",
        "phasePrep": "—",
        "phasePeak": peak,
        "phasePost": "—",
        "forecast": forecast,
        "verdict": ground_truth.get("verdictBadge") or "⏳ 待驗證",
        "verdictColor": ground_truth.get("color") or "#94A3B8",
    }]


def build_summary_analysis(prediction, ground_truth):
    h, m, low = prediction.get("highCloud"), prediction.get("midCloud"), prediction.get("lowCloud")
    if None not in (h, m, low):
        atmospheric = f"預報雲量：高空 {h}% ／ 中空 {m}% ／ 低空 {low}%。"
    else:
        atmospheric = "本場預報雲量細項未隨鎖定檔存下。"

    if is_verified(ground_truth):
        err = abs((prediction.get("score") or 0) - (ground_truth.get("score") or 0))
        performance = (
            f"模型預報 {prediction.get('score')} 分，實況光學觀測 {ground_truth.get('score')} 分，"
            f"絕對誤差 {err} 分（{ground_truth.get('verdict')}）。"
        )
    else:
        performance = "本場實測影格擷取失敗或光學評分尚未完成，暫無模型誤差判定。"

    return {"atmosphericReason": atmospheric, "modelPerformance": performance}


def generate_briefing(session_override=None):
    now = datetime.datetime.now()  # workflow 已設 TZ=Asia/Taipei
    today_str = now.strftime("%Y-%m-%d")
    session = session_override or ("sunrise" if now.hour < 15 else "sunset")
    session_label = "清晨日出" if session == "sunrise" else "傍晚日落"
    publish_time_label = "09:00 定時發布" if session == "sunrise" else "21:00 定時發布"

    records = _load_json(os.path.join(DATA_DIR, "verification-records.json"), [])
    if not isinstance(records, list):
        records = []
    locked = _load_json(os.path.join(DATA_DIR, f"locked-{session}-forecast.json"), {})
    if not isinstance(locked, dict):
        locked = {}

    record = resolve_target_record(records, session, today_str)
    date_str = (record or {}).get("date") or today_str

    # 鎖定檔對不上目標日期就別拿它的 summary / 回退預測
    if locked.get("date") and locked.get("date") != date_str:
        locked = {}

    report_id = f"report-{date_str}-{session}"
    prediction = build_prediction(record, locked)
    ground_truth = build_ground_truth(record)

    print(f"=== 📰 產生每日實況日報: {date_str} {session_label} ({publish_time_label}) ===")
    if record is None:
        print("⚠️ 找不到對應的 verification 紀錄 —— 產出「待實測驗證」佔位日報")
    elif is_verified(ground_truth):
        print(f"✅ 實測命中判定: {ground_truth['verdictBadge']} "
              f"(預報 {prediction['score']} / 實測 {ground_truth['score']})")
    else:
        print(f"⏳ 尚無實測結果 (capture status: {ground_truth.get('captureStatus')}) —— 標記為待驗證")

    report_obj = {
        "id": report_id,
        "date": date_str,
        "session": session,
        "sessionLabel": session_label,
        "publishedAt": now.isoformat(),
        "publishTimeLabel": publish_time_label,
        "title": f"{date_str} {session_label}實況觀測 vs. 模型預報總結",
        "prediction": prediction,
        "groundTruth": ground_truth,
        "stations": build_station_rows(record, prediction, ground_truth),
        "summaryAnalysis": build_summary_analysis(prediction, ground_truth),
    }

    reports_path = os.path.join(DATA_DIR, "daily-reports.json")
    reports = _load_json(reports_path, [])
    if not isinstance(reports, list):
        reports = []

    idx = next((i for i, r in enumerate(reports) if r.get("id") == report_id), None)
    if idx is not None:
        # 沿用原始發布時間：重跑多半只是回溯補算 (Phase 2 稍晚才評分完)，
        # 不是一次新的發布，不該把它的時間戳往後推。
        prev_published = reports[idx].get("publishedAt")
        if prev_published:
            report_obj["publishedAt"] = prev_published
        reports[idx] = report_obj
    else:
        reports.insert(0, report_obj)

    with open(reports_path, "w", encoding="utf-8") as f:
        json.dump(reports, f, ensure_ascii=False, indent=2)

    print(f"✅ 已寫入日報！總歸檔筆數: {len(reports)} 篇")


if __name__ == "__main__":
    sess = sys.argv[1] if len(sys.argv) > 1 else None
    generate_briefing(sess)
