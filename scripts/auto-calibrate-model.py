#!/usr/bin/env python3
"""
auto-calibrate-model.py - Phase 4: 物理演算法參數自適應進化與閉環微調器
利用歷史 4K 直播實況觀測數據 (Ground Truth)，自動微調 SkyFireEngine 物理係數並降低 MAE 誤差
"""

import json
import math
import os
import sys
import copy

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

def _get(params, key, default):
    """dict.get 只在鍵不存在時給預設值；紀錄裡存成 null 的欄位 (如 9/11 的 totalCloud) 也要給。"""
    v = params.get(key)
    return default if v is None else v


def calculate_score(params, weights):
    """js/skyfire-engine.js calculate() 的火燒雲分數，逐項照搬。
    tests/test_auto_calibrate.py 會逐點比對兩邊，引擎改了這裡要跟著改。"""
    high = _get(params, 'highCloud', 0)
    mid = _get(params, 'midCloud', 0)
    low = _get(params, 'lowCloud', 0)
    total = _get(params, 'totalCloud', 0)
    aqi = _get(params, 'aqi', 45)
    vis = _get(params, 'visibilityKm', 20.0)
    # 2026-09-29 前起霧的 380 公尺被存成 visibilityKm: 380；超過 100 公里的是公尺原值
    if vis > 100:
        vis = vis / 1000.0
    humidity = _get(params, 'humidity', 65)
    precip = _get(params, 'precipProb', 0)

    # 1. 高雲
    if high >= 25 and high <= 75:
        high_score = weights['highCloudMax'] - abs(high - weights['highCloudOpt']) * 0.3
    elif high > 75:
        high_score = max(8.0, weights['highCloudMax'] - (high - 75) * 0.6)
    else:
        high_score = high * (weights['highCloudMax'] / 35.0)

    # 2. 中雲
    if mid >= 20 and mid <= 65:
        mid_score = weights['midCloudMax'] - abs(mid - weights['midCloudOpt']) * 0.35
    elif mid > 65:
        mid_score = max(5.0, weights['midCloudMax'] - (mid - 65) * 0.5)
    else:
        mid_score = mid * (weights['midCloudMax'] / 33.0)

    # 協同
    synergy = weights['synergyBonus'] if (high >= 30 and mid >= 20 and low < 40) else 0.0
    cloud_base = min(45.0, high_score + mid_score + synergy)

    # 3. 低雲懲罰
    slope = weights['lowCloudSlope']
    if low <= 20:
        low_penalty = 0.0
    elif low <= 40:
        low_penalty = (low - 20) * 0.45 * slope
    elif low <= 65:
        low_penalty = 10.0 + (low - 40) * 0.95 * slope
    else:
        low_penalty = 35.0 + (low - 65) * 0.6 * slope

    # 4. 透光窗
    horizon = _get(params, 'horizonClearance', max(0, 100 - (low * 1.1 + max(0, total - 60) * 0.5)))
    horizon_score = (horizon / 100.0) * weights['horizonMax']

    # 5. 能見度
    if vis >= 25:
        vis_score = weights['visMax']
    elif vis >= 15:
        vis_score = (weights['visMax'] * 0.73) + (vis - 15) * 0.4
    elif vis >= 8:
        vis_score = (weights['visMax'] * 0.4) + (vis - 8) * 0.7
    else:
        vis_score = max(0.0, vis * 0.7)

    # 6. 濕度水氣
    if precip > 50:
        moisture = -min(25.0, (precip - 50) * 0.6)
    elif precip > 25:
        moisture = -5.0
    else:
        moisture = weights['moistureMax'] if (50 <= humidity <= 82) else (weights['moistureMax'] * 0.5)

    # AQI：鎖定預報時沒有傳 aqi，引擎用預設 45 (+2)
    if 30 <= aqi <= 75:
        aqi_modifier = 2.0
    elif aqi > 110:
        aqi_modifier = -min(10.0, (aqi - 110) * 0.2)
    else:
        aqi_modifier = 0.0

    raw = cloud_base - low_penalty + horizon_score + vis_score + aqi_modifier + moisture

    if low > 85:
        raw = min(raw, 15.0)
    # 高中空幾乎無雲 = 沒有可被染紅的雲 (引擎 2026-09-26 起上限 10)
    if high < 6 and mid < 6:
        raw = min(raw, 10.0)

    # JS Math.round：.5 一律進位 (Python round 是銀行家捨入)
    return max(5, min(100, math.floor(raw + 0.5)))

def has_usable_cloud_inputs(prediction):
    """判斷一筆紀錄的雲量輸入是否足以重算 sim_pred。

    calculate_score() 完全靠 high/mid/low 雲量三頻驅動；若三頻缺失或剛好
    全為 0，多半是擷取管線的欄位擷取 bug (舊版誤讀 diagnostics 陣列，
    `|| 0` 讓每筆鎖定路徑紀錄雲量全 0)，而非真實通透晴空。拿這種紀錄調參
    等於對噪音最佳化，必須排除。
    """
    bands = [prediction.get(k) for k in ('highCloud', 'midCloud', 'lowCloud')]
    if any(b is None for b in bands):
        return False
    # 新格式紀錄一定帶 humidity (來自結構化 weather 區塊)；舊「|| 0」bug 紀錄沒有。
    # 三頻剛好全 0 且無此標記 → 幾乎確定是欄位擷取 bug，不是真的通透晴空。
    if all((b or 0) == 0 for b in bands) and prediction.get('humidity') is None:
        return False
    return True


def expand_to_calibration_samples(records):
    """每筆紀錄取 0~1 個校準樣本：火燒雲實測峰值 verification.fireCloud.peakScore。

    引擎分數是火燒雲分 (雲有沒有被染紅)，實測就要用同一個定義。
    avgScore / peakScore / groundTruthScore 是攝影機暖色分 (天空美感分，晴空暮光
    也給高分)，拿來調火燒雲權重會把引擎往美感分拉；沒有 fireCloud 的舊紀錄
    直接排除，不拿暖色分頂替。只用峰值：日報判定看峰值，而 2026-09-29 之前的
    fireCloud.avgScore 把日落前被照亮的雲也算進去了，定義跟現在不同。
    """
    samples = []
    for r in records:
        fire = (r.get('verification') or {}).get('fireCloud') or {}
        if fire.get('peakScore') is None:
            continue
        samples.append({'date': r.get('date'), 'prediction': r.get('prediction') or {},
                        'verification': {'groundTruthScore': fire['peakScore']}})
    return samples


def evaluate_mae(dataset, weights):
    """計算指定權重在觀測數據集上的平均絕對誤差 (MAE)。

    dataset 已在呼叫端過濾為「雲量輸入可用」的紀錄。
    """
    errors = []
    for item in dataset:
        p = item['prediction']
        gt = item['verification']['groundTruthScore']
        if gt is None:
            continue
        sim_pred = calculate_score(p, weights)
        errors.append(abs(sim_pred - gt))

    if not errors:
        return 0.0
    return sum(errors) / len(errors)

def run_calibration(records_path, params_path):
    print("====================================================")
    print("🤖 啟動 Phase 4: SkyFire 物理模型參數自適應進化閉環")
    print("====================================================\n")

    if not os.path.exists(records_path):
        print(f"⚠️ 找不到歷史觀測紀錄: {records_path}")
        return

    with open(records_path, 'r', encoding='utf-8') as f:
        records = json.load(f)

    # 每筆紀錄取火燒雲實測峰值當校準樣本 (見 expand_to_calibration_samples)。
    ground_truthed = expand_to_calibration_samples(records)

    # 再排除雲量輸入不可用者 —— calculate_score 全靠雲量三頻驅動，
    # 輸入是壞的就無法重算候選權重的 sim_pred (見 has_usable_cloud_inputs)。
    verified_records = [r for r in ground_truthed if has_usable_cloud_inputs(r.get('prediction', {}))]
    n_samples = len(verified_records)
    n_excluded = len(ground_truthed) - n_samples

    print(f"📊 火燒雲實測樣本: {len(ground_truthed)} 筆；雲量輸入可用: {n_samples} 筆", end="")
    print(f"（排除 {n_excluded} 筆雲量輸入缺失／全 0）" if n_excluded else "")

    if n_samples < 2:
        print("ℹ️ 可用樣本不足 2 場，維持當前基礎權重。")
        return

    # 載入當前參數
    if os.path.exists(params_path):
        with open(params_path, 'r', encoding='utf-8') as f:
            params_data = json.load(f)
    else:
        params_data = {
            "version": "2.5.0",
            "weights": {
                "highCloudMax": 25.0, "highCloudOpt": 50.0,
                "midCloudMax": 20.0, "midCloudOpt": 42.0,
                "synergyBonus": 5.0, "lowCloudSlope": 0.85,
                "horizonMax": 30.0, "visMax": 15.0, "moistureMax": 8.0
            },
            "history": []
        }

    current_weights = params_data['weights']
    baseline_mae = evaluate_mae(verified_records, current_weights)
    print(f"🎯 校準前模型基準 MAE: {baseline_mae:.2f} 分")

    # 網格座標微調搜尋 (Coordinate Grid Optimization)
    best_weights = copy.deepcopy(current_weights)
    best_mae = baseline_mae
    improved = False

    # 探索低雲斜率與高雲天幕的最佳微調區間
    for slope_delta in [-0.15, -0.10, -0.05, 0.0, 0.05, 0.10, 0.15]:
        for high_max_delta in [-2.0, -1.0, 0.0, 1.0, 2.0]:
            for mid_max_delta in [-2.0, -1.0, 0.0, 1.0, 2.0]:
                cand = copy.deepcopy(current_weights)
                cand['lowCloudSlope'] = max(0.5, min(1.2, cand['lowCloudSlope'] + slope_delta))
                cand['highCloudMax'] = max(20.0, min(30.0, cand['highCloudMax'] + high_max_delta))
                cand['midCloudMax'] = max(15.0, min(25.0, cand['midCloudMax'] + mid_max_delta))

                cand_mae = evaluate_mae(verified_records, cand)
                if cand_mae < best_mae - 0.05:
                    best_mae = cand_mae
                    best_weights = cand
                    improved = True

    print(f"✨ 最佳化後模型 MAE: {best_mae:.2f} 分 (降低 {(baseline_mae - best_mae):.2f} 分)")

    if improved:
        improvement_pct = ((baseline_mae - best_mae) / baseline_mae) * 100
        print(f"🚀 成功進化！預測精度提升: {improvement_pct:.1f}%")
        print(f"- 新低雲懲罰斜率: {best_weights['lowCloudSlope']:.2f}")
        print(f"- 新高雲天幕權重: {best_weights['highCloudMax']:.1f}")
        print(f"- 新中雲立體權重: {best_weights['midCloudMax']:.1f}")

        params_data['calibrationCount'] = params_data.get('calibrationCount', 0) + 1
        params_data['sampleSize'] = n_samples
        params_data['metrics'] = {
            "initialMAE": round(baseline_mae, 2),
            "calibratedMAE": round(best_mae, 2),
            "improvementPct": round(improvement_pct, 1)
        }
        params_data['weights'] = best_weights
        params_data['history'].insert(0, {
            "date": verified_records[0]['date'],
            "maeBefore": round(baseline_mae, 2),
            "maeAfter": round(best_mae, 2),
            "adjustment": f"基於 {n_samples} 場觀測紀錄微調高低雲光學權重，MAE 降低 {(baseline_mae - best_mae):.2f} 分"
        })
        if len(params_data['history']) > 20:
            params_data['history'] = params_data['history'][:20]

        with open(params_path, 'w', encoding='utf-8') as f:
            json.dump(params_data, f, ensure_ascii=False, indent=2)
        print(f"💾 已將最新校準參數寫入: {params_path}")
    else:
        print("✅ 當前物理參數已處於全域最優解，無需更新。")

    print("====================================================\n")

if __name__ == "__main__":
    records_file = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '../data/verification-records.json')
    params_file = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '../data/model-calibration-params.json')
    run_calibration(records_file, params_file)
