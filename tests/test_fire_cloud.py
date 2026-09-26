#!/usr/bin/env python3
"""
test_fire_cloud.py - 火燒雲分評分器 (analyze_fire_cloud) 的迴歸測試

執行：python tests/test_fire_cloud.py
用合成影像，不依賴磁碟上的真實縮時影格：
  - 平滑的橘色暮光漸層 (晴空) → 最低分：這正是舊的暖色面積評分會給高分的情境
  - 漸層上疊一排被照亮的暖色雲 → 高分
  - 同樣的雲但是暗灰剪影 (沒被照亮) → 低分
  - 雲只出現在天空範圍 (skyRoiBottom) 以下 → 不計分
  - 黑白夜視畫面 → score None，不給 0 分冒充「沒有火燒雲」
"""

import importlib.util
import os

import numpy as np
from PIL import Image

HERE = os.path.dirname(__file__)
spec = importlib.util.spec_from_file_location(
    "analyze_sky_ground_truth", os.path.join(HERE, "..", "scripts", "analyze_sky_ground_truth.py"))
gt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gt)

print("--- 🧪 Python 測試: 火燒雲分評分器 ---")

W, H = 640, 360


def twilight_gradient():
    """上藍下橘的平滑晴空暮光，下方 30% 是暗色地面。"""
    rows = np.linspace(0.0, 1.0, H)[:, None]
    top = np.array([40, 70, 150], dtype=np.float32)
    bottom = np.array([250, 120, 30], dtype=np.float32)
    img = (top * (1 - rows[..., None]) + bottom * rows[..., None]) * np.ones((H, W, 1), dtype=np.float32)
    img[int(H * 0.7):] = [15, 15, 20]
    return img


def add_clouds(img, color, y0, y1):
    out = img.copy()
    for x0 in range(20, W - 60, 90):
        out[y0:y1, x0:x0 + 55] = color
    return out


def score(arr, roi=0.65):
    return gt.analyze_fire_cloud(Image.fromarray(arr.astype(np.uint8)), roi)


clear = score(twilight_gradient())
assert clear["readable"] and clear["score"] == 5, clear
print(f"✅ 平滑晴空暮光漸層 → {clear['score']} 分 (染紅雲 {clear['litCloudPct']}%)")

lit = score(add_clouds(twilight_gradient(), [255, 90, 60], 60, 150))
assert lit["score"] >= 60, lit
print(f"✅ 被照亮的暖色雲 → {lit['score']} 分 (染紅雲 {lit['litCloudPct']}%)")

dark = score(add_clouds(twilight_gradient(), [35, 30, 40], 60, 150))
assert dark["score"] <= 15, dark
print(f"✅ 暗灰雲剪影 (沒被照亮) → {dark['score']} 分")

below = score(add_clouds(twilight_gradient(), [255, 90, 60], 200, 240), roi=0.5)
assert below["score"] == 5, below
print("✅ skyRoiBottom 以下的暖色紋理 (海面、燈光) 不計分")

gray = twilight_gradient().mean(axis=-1, keepdims=True).repeat(3, axis=-1)
mono = score(add_clouds(gray, [200, 200, 200], 60, 150))
assert mono["score"] is None and mono["readable"] is False and mono["reason"], mono
print("✅ 黑白夜視畫面 → 無法判讀 (score=None)，不冒充 0 分")

default_roi = gt.analyze_fire_cloud(Image.fromarray(twilight_gradient().astype(np.uint8)), None)
assert default_roi["skyRoiBottom"] == gt.FIRE_CLOUD_DEFAULT_ROI_BOTTOM
print("✅ 未設定 skyRoiBottom 時退回預設天空範圍")

print("🎉 火燒雲分評分器測試全數 PASS!\n")
