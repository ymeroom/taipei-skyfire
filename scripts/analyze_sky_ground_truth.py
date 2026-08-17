#!/usr/bin/env python3
"""
analyze_sky_ground_truth.py - Phase 2: 天空光學色彩直方圖分析與真實出景強度量化器
利用 CIELAB / HSV 色彩空間對實況截圖進行天空分割、色相積分與漫射覆蓋率量化
"""

import sys
import os
import json
import math

try:
    from PIL import Image
    import numpy as np
except ImportError:
    # 若無 PIL 則輸出模擬評分以利開發測試
    Image = None
    np = None

def rgb_to_hsv(r, g, b):
    """標準化 RGB (0-1) 轉 HSV"""
    max_c = max(r, g, b)
    min_c = min(r, g, b)
    diff = max_c - min_c

    # 計算 V
    v = max_c

    # 計算 S
    s = 0 if max_c == 0 else diff / max_c

    # 計算 H (0-360)
    if diff == 0:
        h = 0
    elif max_c == r:
        h = (60 * ((g - b) / diff) + 360) % 360
    elif max_c == g:
        h = (60 * ((b - r) / diff) + 120) % 360
    else:
        h = (60 * ((r - g) / diff) + 240) % 360

    return h, s, v

def analyze_image_optics(image_path):
    """分析天空區域的火燒雲光學特徵"""
    if not os.path.exists(image_path) or Image is None:
        return {
            "score": 0,
            "level": "OVERCAST",
            "chromatic_purity": 0,
            "sky_coverage_pct": 0,
            "warm_ratio": 0,
            "is_simulated": True
        }

    try:
        img = Image.open(image_path).convert('RGB')
        # 縮放至合適尺寸加速運算 (寬 640px)
        w, h = img.size
        target_w = 640
        target_h = int(h * (target_w / w))
        img = img.resize((target_w, target_h), Image.BILINEAR)

        # 擷取天空 ROI (畫面頂部 65%，去除下部前景地貌與建築)
        sky_height = int(target_h * 0.65)
        sky_crop = img.crop((0, 0, target_w, sky_height))

        # 轉換為 numpy 矩陣
        pixels = np.array(sky_crop, dtype=np.float32) / 255.0
        total_sky_pixels = sky_crop.width * sky_crop.height

        r = pixels[:, :, 0]
        g = pixels[:, :, 1]
        b = pixels[:, :, 2]

        # 向量化計算 HSV
        max_c = np.maximum(np.maximum(r, g), b)
        min_c = np.minimum(np.minimum(r, g), b)
        diff = max_c - min_c + 1e-7

        v = max_c
        s = np.where(max_c == 0, 0, diff / max_c)

        # 計算 Hue
        h_arr = np.zeros_like(r)
        r_mask = (max_c == r)
        g_mask = (max_c == g) & (~r_mask)
        b_mask = (~r_mask) & (~g_mask)

        h_arr[r_mask] = (60 * ((g[r_mask] - b[r_mask]) / diff[r_mask]) + 360) % 360
        h_arr[g_mask] = (60 * ((b[g_mask] - r[g_mask]) / diff[g_mask]) + 120) % 360
        h_arr[b_mask] = (60 * ((r[b_mask] - g[b_mask]) / diff[b_mask]) + 240) % 360

        # 火燒雲暖色光譜遮罩定義：
        # 色相角: 345° ~ 360° (深紅) 與 0° ~ 65° (紅/橘/金黃/琥珀色)
        # 飽和度 S >= 0.25 (避免灰白死雲)
        # 亮度 V >= 0.20 (避免夜間死黑)
        warm_mask = ((h_arr <= 65) | (h_arr >= 345)) & (s >= 0.22) & (v >= 0.20)
        
        # 強烈燃燒核心遮罩 (深橘紅、高飽和度 S >= 0.45)
        vivid_mask = ((h_arr <= 45) | (h_arr >= 350)) & (s >= 0.42) & (v >= 0.30)

        warm_pixels_count = np.sum(warm_mask)
        vivid_pixels_count = np.sum(vivid_mask)

        # 1. 天空漫射覆蓋率 (0 - 100%)
        warm_coverage_pct = (warm_pixels_count / total_sky_pixels) * 100
        vivid_coverage_pct = (vivid_pixels_count / total_sky_pixels) * 100

        # 2. 平均色彩純度與飽和度能量
        avg_warm_saturation = float(np.mean(s[warm_mask])) if warm_pixels_count > 0 else 0
        avg_warm_brightness = float(np.mean(v[warm_mask])) if warm_pixels_count > 0 else 0

        # 3. 綜合火燒雲出景強度公式 (0 - 100 分)
        # 覆蓋率 (最高 45分) + 飽和度能量 (最高 35分) + 鮮豔核心加成 (最高 20分)
        coverage_score = min(45, (warm_coverage_pct / 50.0) * 45)
        saturation_score = min(35, (avg_warm_saturation / 0.75) * 35)
        vivid_bonus = min(20, (vivid_coverage_pct / 20.0) * 20)

        raw_score = coverage_score + saturation_score + vivid_bonus
        final_score = int(np.clip(np.round(raw_score), 5, 100))

        # 評定等級
        if final_score >= 82:
            level = "EPIC"
            badge = "史詩級爆發"
        elif final_score >= 68:
            level = "GREAT"
            badge = "壯麗火燒雲"
        elif final_score >= 48:
            level = "MODERATE"
            badge = "局部微霞"
        elif final_score >= 30:
            level = "FAINT"
            badge = "平淡暮光"
        else:
            level = "OVERCAST"
            badge = "陰沉沉寂"

        return {
            "score": final_score,
            "level": level,
            "badge": badge,
            "chromatic_purity": round(avg_warm_saturation * 100, 1),
            "sky_coverage_pct": round(warm_coverage_pct, 1),
            "vivid_coverage_pct": round(vivid_coverage_pct, 1),
            "avg_brightness_pct": round(avg_warm_brightness * 100, 1),
            "is_simulated": False
        }

    except Exception as e:
        print(f"光學分析失敗: {e}", file=sys.stderr)
        return {
            "score": 10,
            "level": "OVERCAST",
            "badge": "分析異常",
            "error": str(e),
            "is_simulated": True
        }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze_sky_ground_truth.py <snapshot_path>")
        sys.exit(1)

    img_path = sys.argv[1]
    result = analyze_image_optics(img_path)
    print(json.dumps(result, ensure_ascii=False, indent=2))
