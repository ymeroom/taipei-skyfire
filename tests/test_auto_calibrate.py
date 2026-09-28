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

# 3. 真實紀錄跑完整校準不崩潰 (週排程 9/13、9/20、9/27 都死在這裡)
tmp = tempfile.mkdtemp()
try:
    tmp_params = os.path.join(tmp, "params.json")
    shutil.copy(PARAMS, tmp_params)
    ac.run_calibration(RECORDS, tmp_params)
finally:
    shutil.rmtree(tmp)
print("✅ 真實 verification-records.json 完整校準跑完")
