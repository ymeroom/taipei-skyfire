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


def _load_stations():
    """data/stations.json → {id: {...}}。缺檔時回空 dict (下游會退回 record 的 source)。"""
    data = _load_json(os.path.join(DATA_DIR, "stations.json"), {})
    rows = data.get("stations") if isinstance(data, dict) else data
    return {s["id"]: s for s in (rows or []) if isinstance(s, dict) and s.get("id")}


STATIONS_META = _load_stations()


def _primary_station_id(session):
    for s in STATIONS_META.values():
        if s.get("session") == session and s.get("isPrimary"):
            return s["id"]
    return None


def _sort_primary_first(recs, session):
    pid = _primary_station_id(session)
    return sorted(recs, key=lambda r: (r.get("station") != pid,))


def _matches(rec, session, date_str):
    if rec.get("session") != session or rec.get("date") != date_str:
        return False
    rid = rec.get("id", "")
    return rid == f"rec-{date_str}-{session}" or rid.startswith(f"rec-{date_str}-{session}-")


def resolve_target_records(records, session, today_str):
    """該時段當日全部測站紀錄；當日沒有才退回「昨天」(排程跨午夜延遲)，更舊不退回。

    擷取整場失敗時，今日就是「尚無實測」，不該拿前天的報告掛今天時間戳假裝有做。
    回傳依主測站優先排序的 list。
    """
    try:
        yesterday = (datetime.date.fromisoformat(today_str) - datetime.timedelta(days=1)).isoformat()
    except ValueError:
        yesterday = None
    for d in (today_str, yesterday):
        if d is None:
            continue
        recs = [r for r in records if _matches(r, session, d)]
        if recs:
            return _sort_primary_first(recs, session)
    return []


def resolve_target_record(records, session, today_str):
    """resolve_target_records 的單筆版：回傳主測站紀錄 (或 None)。"""
    recs = resolve_target_records(records, session, today_str)
    return recs[0] if recs else None


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
    """實測現在是「平均分」+「峰值分」兩個數字 (見 capture_timelapse_multi_station.py
    的 aggregate_station_scores)，不是單一 groundTruthScore。峰值判定當作代表判定 ——
    拍照最在意的是有沒有拍到最佳時刻；平均判定反映整場 80 分鐘的穩定度，兩者都完整
    帶出、互不取代，不硬併成一個數字。
    """
    v = (record or {}).get("verification") or {}
    has_score = v.get("avgScore") is not None or v.get("peakScore") is not None
    if v.get("status") == "verified_completed" and has_score:
        verdict = v.get("verdictPeak") or v.get("verdictAvg") or "MISMATCH"
        badge_core = v.get("verdictPeakBadge") or v.get("verdictAvgBadge") or verdict
        parts = []
        if v.get("peakScore") is not None:
            parts.append(f"峰值 {v['peakScore']} 分")
        if v.get("avgScore") is not None:
            parts.append(f"平均 {v['avgScore']} 分")
        detail = "（" + "／".join(parts) + "）" if parts else ""
        return {
            "score": v.get("peakScore") if v.get("peakScore") is not None else v.get("avgScore"),
            "avgScore": v.get("avgScore"),
            "peakScore": v.get("peakScore"),
            "peakOffsetMin": v.get("peakOffsetMin"),
            "verdict": verdict,
            "verdictAvg": v.get("verdictAvg"),
            "verdictPeak": v.get("verdictPeak"),
            "verdictBadge": f"{badge_core}{detail}",
            "color": VERDICT_COLORS.get(verdict, "#F87171"),
        }
    return {**PENDING_GROUND_TRUTH, "captureStatus": v.get("status") or "no_record"}


def is_verified(ground_truth):
    return ground_truth.get("verdict") not in (None, "PENDING")


def build_station_rows(station_records):
    """每站一列，全部欄位取自該站的真實 verification 紀錄。

    phasePrep / phasePost 永遠 "—"：手寫測站敘述正是當初「日報造假」的載體，
    絕不重新引入。
    """
    rows = []
    for r in station_records:
        sid = r.get("station")
        meta = STATIONS_META.get(sid, {})
        v = r.get("verification") or {}
        status = v.get("status")
        has_score = v.get("avgScore") is not None or v.get("peakScore") is not None

        if status == "verified_completed" and has_score:
            offset = v.get("peakOffsetMin")
            offset_label = f"T{offset:+d}" if offset is not None else "T"
            avg_txt = f"平均 {v['avgScore']} 分" if v.get("avgScore") is not None else "平均 —"
            peak_txt = f"峰值 {v['peakScore']} 分（{offset_label}）" if v.get("peakScore") is not None else "峰值 —"
            peak = f"{avg_txt}・{peak_txt}"
            verdict_val = v.get("verdictPeak") or v.get("verdictAvg") or "MISMATCH"
            verdict = v.get("verdictPeakBadge") or v.get("verdictAvgBadge") or verdict_val
            color = VERDICT_COLORS.get(verdict_val, "#94A3B8")
        elif status == "capture_unavailable":
            peak, verdict, color = "9 張縮時影格全數擷取失敗，本場無實測資料", "⏳ 實測待驗證", "#94A3B8"
        elif status == "no_locked_prediction":
            avg_txt = f"平均 {v['avgScore']} 分" if v.get("avgScore") is not None else "平均 —"
            peak_txt = f"峰值 {v['peakScore']} 分" if v.get("peakScore") is not None else "峰值 —"
            peak = f"{avg_txt}・{peak_txt}（找不到鎖定預測，無法算誤差）"
            verdict, color = "⏳ 實測待驗證", "#94A3B8"
        elif status == "skipped_out_of_window":
            peak, verdict, color = "影格不在暮光窗口內，未評分", "⏳ 實測待驗證", "#94A3B8"
        else:
            peak, verdict, color = "影格已擷取，光學評分尚未完成", "⏳ 實測待驗證", "#94A3B8"

        pred = r.get("prediction") or {}
        forecast = "—"
        if pred.get("score") is not None:
            forecast = f"{pred['score']} 分"
            if pred.get("lowCloud") is not None:
                forecast += f"（低雲 {pred['lowCloud']}%）"

        rows.append({
            "name": meta.get("name") or r.get("source") or sid or "官方直播影格",
            "icon": meta.get("icon") or "📹",
            "tag": meta.get("tag") or "官方 4K 直播・DVR 回溯精確影格",
            "phasePrep": "—",
            "phasePeak": peak,
            "phasePost": "—",
            "forecast": forecast,
            "verdict": verdict,
            "verdictColor": color,
        })
    return rows


def _rank_score(record):
    """排名/篩選用的代表分數 —— 優先用峰值 (拍照最在意有沒有拍到最佳時刻)，
    峰值那一側沒抓到才退回平均分。"""
    v = record["verification"]
    return v.get("peakScore") if v.get("peakScore") is not None else v.get("avgScore")


def build_station_summary(station_records):
    verified = [r for r in station_records if _rank_score(r) is not None]
    out = {
        "verified": len(verified),
        "pending": len(station_records) - len(verified),
        "bestStation": None,
        "bestScore": None,
        "worstError": None,
        "meanError": None,
    }
    if verified:
        best = max(verified, key=_rank_score)
        out["bestStation"] = best.get("station")
        out["bestScore"] = _rank_score(best)
        errs = []
        for r in verified:
            v = r["verification"]
            err = v.get("errorPeakAbsolute") if v.get("errorPeakAbsolute") is not None else v.get("errorAvgAbsolute")
            if err is not None:
                errs.append(err)
        if errs:
            out["worstError"] = max(errs)
            out["meanError"] = round(sum(errs) / len(errs), 1)
    return out


def build_summary_analysis(prediction, ground_truth):
    h, m, low = prediction.get("highCloud"), prediction.get("midCloud"), prediction.get("lowCloud")
    if None not in (h, m, low):
        atmospheric = f"預報雲量：高空 {h}% ／ 中空 {m}% ／ 低空 {low}%。"
    else:
        atmospheric = "本場預報雲量細項未隨鎖定檔存下。"

    if is_verified(ground_truth):
        pred_score = prediction.get("score") or 0
        bits = []
        if ground_truth.get("avgScore") is not None:
            bits.append(f"平均 {ground_truth['avgScore']} 分（誤差 {abs(pred_score - ground_truth['avgScore'])} 分）")
        if ground_truth.get("peakScore") is not None:
            offset = ground_truth.get("peakOffsetMin")
            offset_label = f"T{offset:+d}" if offset is not None else "T"
            bits.append(f"峰值 {ground_truth['peakScore']} 分（{offset_label}，誤差 {abs(pred_score - ground_truth['peakScore'])} 分）")
        detail = "、".join(bits) if bits else "—"
        performance = (
            f"模型預報 {prediction.get('score')} 分，實況縮時光學觀測：{detail}"
            f"（{ground_truth.get('verdict')}）。"
        )
    else:
        performance = "本場實測影格擷取失敗或找不到對應鎖定預測，暫無模型誤差判定。"

    return {"atmosphericReason": atmospheric, "modelPerformance": performance}


def generate_briefing_obj(records, locked, session, date_str, published_at=None):
    """純函式：由紀錄 + 鎖定檔組出一筆日報 dict (不碰檔案/時鐘)。"""
    session_label = "清晨日出" if session == "sunrise" else "傍晚日落"
    publish_time_label = "09:00 定時發布" if session == "sunrise" else "21:00 定時發布"

    recs = _sort_primary_first(
        [r for r in records if _matches(r, session, date_str)], session
    )
    primary = recs[0] if recs else None

    if isinstance(locked, dict) and locked.get("date") and locked.get("date") != date_str:
        locked = {}

    prediction = build_prediction(primary, locked)
    ground_truth = build_ground_truth(primary)

    return {
        "id": f"report-{date_str}-{session}",
        "date": date_str,
        "session": session,
        "sessionLabel": session_label,
        "publishedAt": published_at or datetime.datetime.now().isoformat(),
        "publishTimeLabel": publish_time_label,
        "title": f"{date_str} {session_label}實況觀測 vs. 模型預報總結",
        "prediction": prediction,
        "groundTruth": ground_truth,
        "stations": build_station_rows(recs),
        "stationSummary": build_station_summary(recs),
        "summaryAnalysis": build_summary_analysis(prediction, ground_truth),
    }


def generate_briefing(session_override=None):
    now = datetime.datetime.now()  # workflow 已設 TZ=Asia/Taipei
    today_str = now.strftime("%Y-%m-%d")
    session = session_override or ("sunrise" if now.hour < 15 else "sunset")

    records = _load_json(os.path.join(DATA_DIR, "verification-records.json"), [])
    if not isinstance(records, list):
        records = []
    locked = _load_json(os.path.join(DATA_DIR, f"locked-{session}-forecast.json"), {})
    if not isinstance(locked, dict):
        locked = {}

    resolved = resolve_target_records(records, session, today_str)
    date_str = resolved[0]["date"] if resolved else today_str

    report_obj = generate_briefing_obj(records, locked, session, date_str, published_at=now.isoformat())
    report_id = report_obj["id"]
    session_label = report_obj["sessionLabel"]

    summary = report_obj["stationSummary"]
    print(f"=== 📰 產生每日實況日報: {date_str} {session_label} ===")
    if not resolved:
        print("⚠️ 找不到對應的 verification 紀錄 —— 產出「待實測驗證」佔位日報")
    else:
        print(f"📊 測站: {summary['verified']} 驗證 / {summary['pending']} 待驗；"
              f"預報 {report_obj['prediction'].get('score')} / 實測 {report_obj['groundTruth'].get('score')}")

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
