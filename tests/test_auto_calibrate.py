#!/usr/bin/env python3
"""
test_auto_calibrate.py - 每週物理權重校準 (auto-calibrate-model.py) 的迴歸測試

執行：python tests/test_auto_calibrate.py
  - 紀錄欄位存成 null (9/11 的 totalCloud) 要跟缺鍵一樣給預設值，不能讓整週校準崩潰
  - 舊紀錄把起霧的 380 公尺存成 visibilityKm: 380，要當 0.38 公里
  - 用真實 verification-records.json 跑完整校準 (寫到暫存檔，不動 data/)
"""

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile

HERE = os.path.dirname(__file__)
spec = importlib.util.spec_from_file_location(
    "auto_calibrate_model", os.path.join(HERE, "..", "scripts", "auto-calibrate-model.py"))
ac = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ac)

PARAMS = os.path.join(HERE, "..", "data", "model-calibration-params.json")
RECORDS = os.path.join(HERE, "..", "data", "verification-records.json")

with open(PARAMS, encoding="utf-8") as f:
    weights = json.load(f)["weights"]

base = {"highCloud": 40, "midCloud": 30, "lowCloud": 10, "humidity": 70, "precipProb": 0, "visibilityKm": 20}

# 1. null 等同缺鍵
assert ac.calculate_score({**base, "totalCloud": None}, weights) == ac.calculate_score(base, weights), \
    "totalCloud: null 應與缺鍵同樣使用預設值"
assert ac.calculate_score({**base, "humidity": None, "horizonClearance": None}, weights) == \
    ac.calculate_score({k: v for k, v in base.items() if k != "humidity"}, weights), \
    "humidity / horizonClearance: null 應與缺鍵相同"
print("✅ 存成 null 的欄位與缺鍵同樣給預設值")

# 2. 舊紀錄的公尺原值
fog = {**base, "highCloud": 0, "midCloud": 0, "lowCloud": 44}
assert ac.calculate_score({**fog, "visibilityKm": 380}, weights) == \
    ac.calculate_score({**fog, "visibilityKm": 0.38}, weights), "visibilityKm: 380 是 380 公尺"
print("✅ 舊紀錄 visibilityKm > 100 當公尺換算")

# 3. Python 複製版與 js/skyfire-engine.js 逐點一致。9/26 引擎晴空上限 35→10，
#    這份複製版沒跟著改，校準一直在對一個已經不存在的模型調權重
grid = []
for high in (0, 3, 10, 30, 50, 80):
    for mid in (0, 5, 25, 45, 70):
        for low in (0, 15, 35, 55, 90):
            for extra in ({"humidity": 70, "precipProb": 0, "visibilityKm": 20},
                          {"humidity": 90, "precipProb": 60, "visibilityKm": 6, "horizonClearance": 40},
                          {"humidity": 55, "precipProb": 30, "visibilityKm": 30, "totalCloud": 95}):
                grid.append({"highCloud": high, "midCloud": mid, "lowCloud": low, **extra})
js = """
const E = require('./js/skyfire-engine.js');
const {grid, weights} = JSON.parse(require('fs').readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(grid.map(p => E.calculate({
  highCloud: p.highCloud, midCloud: p.midCloud, lowCloud: p.lowCloud, totalCloud: p.totalCloud,
  humidity: p.humidity, precipProb: p.precipProb, horizonClearance: p.horizonClearance,
  visibility: p.visibilityKm * 1000, customWeights: weights,
}).score)));
"""
js_scores = json.loads(subprocess.run(
    ["node", "-e", js], input=json.dumps({"grid": grid, "weights": weights}),
    capture_output=True, text=True, encoding="utf-8", check=True, cwd=os.path.join(HERE, "..")).stdout)
mismatch = [(p, py, j) for p, j in zip(grid, js_scores) if (py := ac.calculate_score(p, weights)) != j]
assert not mismatch, f"{len(mismatch)}/{len(grid)} 點與 JS 引擎不一致，例如 {mismatch[:3]}"
print(f"✅ calculate_score 與 JS 引擎在 {len(grid)} 個輸入點上完全一致")

# 4. 校準目標是火燒雲實測峰值，不是美感分 (暖色峰值)
rec_dual = {"date": "2026-09-28", "prediction": base, "verification": {
    "avgScore": 65.4, "peakScore": 100, "fireCloud": {"avgScore": 5.6, "peakScore": 5}}}
rec_old = {"date": "2026-09-20", "prediction": base, "verification": {"avgScore": 80, "peakScore": 95}}
rec_legacy = {"date": "2026-09-05", "prediction": base, "verification": {"groundTruthScore": 90}}
rec_nofire = {"date": "2026-09-28", "prediction": base, "verification": {
    "avgScore": None, "peakScore": None, "fireCloud": {"avgScore": None, "peakScore": None}}}
samples = ac.expand_to_calibration_samples([rec_dual, rec_old, rec_legacy, rec_nofire])
assert [s["verification"]["groundTruthScore"] for s in samples] == [5], \
    "只用 fireCloud.peakScore；沒有火燒雲實測的紀錄 (舊版暖色分) 不能拿美感分頂替"
assert samples[0]["date"] == "2026-09-28", "樣本要帶日期，寫入校準歷史時用得到"
print("✅ 校準樣本只取火燒雲實測峰值，舊版暖色分紀錄排除")

# 5. 真的有改進時也要能寫檔 (樣本曾經沒帶 date，一改進就 KeyError)
tmp = tempfile.mkdtemp()
try:
    tmp_params = os.path.join(tmp, "params.json")
    tmp_records = os.path.join(tmp, "records.json")
    shutil.copy(PARAMS, tmp_params)
    cloudy = {"highCloud": 45, "midCloud": 35, "lowCloud": 50, "humidity": 70, "precipProb": 0, "visibilityKm": 20}
    target = ac.calculate_score(cloudy, {**weights, "lowCloudSlope": max(0.5, weights["lowCloudSlope"] - 0.15)})
    synthetic = [{"date": f"2026-09-{d:02d}", "prediction": cloudy,
                  "verification": {"fireCloud": {"avgScore": target, "peakScore": target}}} for d in (1, 2, 3)]
    with open(tmp_records, "w", encoding="utf-8") as f:
        json.dump(synthetic, f)
    ac.run_calibration(tmp_records, tmp_params)
    with open(tmp_params, encoding="utf-8") as f:
        written = json.load(f)
    assert written["weights"]["lowCloudSlope"] < weights["lowCloudSlope"], "應該朝較低的低雲斜率改進"
    assert written["history"][0]["date"] == "2026-09-01"
finally:
    shutil.rmtree(tmp)
print("✅ 校準有改進時正確寫入權重與歷史")

# 6. 真實紀錄跑完整校準不崩潰 (週排程 9/13、9/20、9/27 都死在這裡)
tmp = tempfile.mkdtemp()
try:
    tmp_params = os.path.join(tmp, "params.json")
    shutil.copy(PARAMS, tmp_params)
    ac.run_calibration(RECORDS, tmp_params)
finally:
    shutil.rmtree(tmp)
print("✅ 真實 verification-records.json 完整校準跑完")
