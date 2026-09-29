#!/usr/bin/env python3
"""
test_beauty_score.py - 天空美感分評分器 (analyze_image_optics 的 score) 的迴歸測試

執行：python tests/test_beauty_score.py
  - 粉紅／洋紅暮光 (300-345°) 算暖色：v1 只認橘紅，整片粉紅天空會被判成 0% 暖色
  - 藍紫色藍調時刻 (260-300°) 不算
  - 在鮮豔橘紅晚霞上加一片淡粉紅，分數不能變低
  - 真實影格：2026-09-29 烘爐地日出前 20 分鐘的粉紫色霾 (v1 只給 15 分)
"""

import colorsys
import importlib.util
import os
import tempfile

import numpy as np
from PIL import Image

HERE = os.path.dirname(__file__)
spec = importlib.util.spec_from_file_location(
    "analyze_sky_ground_truth", os.path.join(HERE, "..", "scripts", "analyze_sky_ground_truth.py"))
gt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gt)

print("--- 🧪 Python 測試: 天空美感分評分器 ---")

W, H = 640, 360


def hsv_rgb(hue, sat, val):
    return [c * 255 for c in colorsys.hsv_to_rgb(hue / 360, sat, val)]


def sky(color_top, band=None):
    """整片天空一個顏色，下方 35% 是暗色城市；band=(顏色, 列起, 列迄) 疊一條色帶。"""
    img = np.ones((H, W, 3), dtype=np.float32) * np.array(color_top, dtype=np.float32)
    if band:
        color, y0, y1 = band
        img[y0:y1] = color
    img[int(H * 0.65):] = [20, 20, 25]
    return img


def score(arr):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "frame.png")
        Image.fromarray(arr.astype(np.uint8)).save(p)
        return gt.analyze_image_optics(p)


pink = score(sky(hsv_rgb(325, 0.30, 0.75)))
assert pink["score"] >= 50, pink
assert pink["pink_coverage_pct"] > 90, pink
assert pink["beautyScorerVersion"] == gt.BEAUTY_SCORER_VERSION == 2
print(f"✅ 整片粉紅暮光 (325°) → {pink['score']} 分 (粉紅 {pink['pink_coverage_pct']}%)")

blue_hour = score(sky(hsv_rgb(275, 0.30, 0.60)))
assert blue_hour["score"] == 5 and blue_hour["pink_coverage_pct"] == 0, blue_hour
print(f"✅ 藍紫色藍調時刻 (275°) 不算暖色 → {blue_hour['score']} 分")

gray_haze = score(sky(hsv_rgb(320, 0.10, 0.60)))
assert gray_haze["score"] == 5, gray_haze
print(f"✅ 幾乎沒有顏色的灰霾 (飽和度 0.10) 不算 → {gray_haze['score']} 分")

# 橘色只占上半部、飽和度中等，分數不會頂到 100；淡粉紅 (0.20) 若拉進飽和度平均就會降分
orange_only = score(sky([20, 20, 25], band=(hsv_rgb(25, 0.55, 0.85), 0, 120)))
orange_with_pink = score(sky(hsv_rgb(330, 0.20, 0.80), band=(hsv_rgb(25, 0.55, 0.85), 0, 120)))
assert 30 < orange_only["score"] < 100, orange_only
assert orange_with_pink["score"] >= orange_only["score"], (orange_only, orange_with_pink)
assert orange_with_pink["chromatic_purity"] == orange_only["chromatic_purity"], "飽和度能量取橘紅本身，不被淡粉紅稀釋"
print(f"✅ 橘紅晚霞加一片淡粉紅不降分: {orange_only['score']} → {orange_with_pink['score']}")

real = gt.analyze_image_optics(os.path.join(HERE, "fixtures", "2026-09-29-hongludi-t-20.jpg"))
assert real["score"] >= 40, real
assert real["pink_coverage_pct"] >= 30, real
print(f"✅ 2026-09-29 烘爐地粉紫色霾 → {real['score']} 分 (v1 為 15 分，粉紅 {real['pink_coverage_pct']}%)")

print("🎉 天空美感分評分器測試全數 PASS!\n")
