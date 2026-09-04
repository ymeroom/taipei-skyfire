#!/usr/bin/env python3
"""
analyze_sky_ground_truth.py - Phase 2: 天空光學色彩直方圖分析與真實出景強度量化器
利用 CIELAB / HSV 色彩空間對實況截圖進行天空分割、色相積分與漫射覆蓋率量化
"""

import sys
import os
import json
import math
import subprocess
import datetime

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")
TAIPEI_TZ = datetime.timezone(datetime.timedelta(hours=8))

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

def get_twilight_window(date_str, session):
    """透過 js/solar-calc.js (單一事實來源) 取得暮光窗口邊界。

    火燒雲物理上只可能出現在「日出前民用曙光起 ~ 日出後黃金時刻結束」或
    「日落前黃金時刻起 ~ 日落後民用暮光結束」這段窗口內；窗口外看到的暖色調
    高飽和度像素只可能是路燈、船燈、燈籠等人工光源，不是真的燒天。
    回傳 (window_start_utc, window_end_utc)，皆為 tz-aware datetime。
    """
    node_script = (
        "const SolarCalc = require('./js/solar-calc.js');"
        "const t = SolarCalc.getTimes(new Date(process.argv[1] + 'T12:00:00+08:00'));"
        "console.log(JSON.stringify({"
        "civilDawn: t.civilDawn, sunriseGoldenEnd: t.sunriseGoldenEnd,"
        "sunsetGoldenStart: t.sunsetGoldenStart, civilDusk: t.civilDusk"
        "}));"
    )
    r = subprocess.run(
        ["node", "-e", node_script, date_str],
        cwd=REPO_ROOT, capture_output=True, text=True, timeout=30
    )
    if r.returncode != 0:
        raise RuntimeError(f"SolarCalc 呼叫失敗: {r.stderr.strip()}")
    times = json.loads(r.stdout)

    def parse(iso):
        return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))

    if session == "sunrise":
        return parse(times["civilDawn"]), parse(times["sunriseGoldenEnd"])
    return parse(times["sunsetGoldenStart"]), parse(times["civilDusk"])


def apply_night_gate(result, capture_time=None, twilight_window=None):
    """暗夜閘門：暮光窗口外一律強制低分，避免人工光源被誤判為火燒雲。

    capture_time: tz-aware UTC datetime，代表影格畫面實際所屬的時刻
                  (不是程式執行時刻)。未提供則不套用閘門 (向後相容)。
    twilight_window: 可選的 (start, end) tuple，避免重複呼叫 node/SolarCalc
                      (例如同一場次多張影格共用同一個窗口時)。
    """
    result["nightGate"] = {"applied": False, "reason": "no capture_time provided"}
    if capture_time is None:
        return result

    try:
        if twilight_window is not None:
            window_start, window_end = twilight_window
        else:
            local = capture_time.astimezone(TAIPEI_TZ)
            session = "sunrise" if local.hour < 12 else "sunset"
            date_str = local.strftime("%Y-%m-%d")
            window_start, window_end = get_twilight_window(date_str, session)

        if window_start <= capture_time <= window_end:
            result["nightGate"] = {
                "applied": False,
                "reason": "within twilight window",
                "windowStart": window_start.isoformat(),
                "windowEnd": window_end.isoformat()
            }
            return result

        raw_score = result.get("score", 0)
        gated_score = min(raw_score, 12)
        result["nightGate"] = {
            "applied": True,
            "reason": "capture time falls outside the twilight window — "
                      "warm/saturated pixels here are almost certainly artificial "
                      "light (street lamps, boat lights, lanterns), not afterglow",
            "rawScoreBeforeGate": raw_score,
            "rawLevelBeforeGate": result.get("level"),
            "windowStart": window_start.isoformat(),
            "windowEnd": window_end.isoformat()
        }
        result["score"] = gated_score
        result["level"] = "OVERCAST"
        result["badge"] = "暮光窗外 (人工光源判定)"
    except Exception as e:
        result["nightGate"] = {"applied": False, "reason": f"gate check failed, fail-open: {e}"}
        print(f"⚠️ 暗夜閘門檢查失敗，本次不套用: {e}", file=sys.stderr)

    return result


def analyze_image_optics(image_path, capture_time=None, twilight_window=None):
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

        result = {
            "score": final_score,
            "level": level,
            "badge": badge,
            "chromatic_purity": round(avg_warm_saturation * 100, 1),
            "sky_coverage_pct": round(warm_coverage_pct, 1),
            "vivid_coverage_pct": round(vivid_coverage_pct, 1),
            "avg_brightness_pct": round(avg_warm_brightness * 100, 1),
            "is_simulated": False
        }
        return apply_night_gate(result, capture_time, twilight_window)

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
        print("Usage: python analyze_sky_ground_truth.py <snapshot_path> [captured_at_iso_utc]")
        sys.exit(1)

    img_path = sys.argv[1]
    cap_time = None
    if len(sys.argv) > 2:
        try:
            cap_time = datetime.datetime.fromisoformat(sys.argv[2].replace("Z", "+00:00"))
        except Exception as e:
            print(f"⚠️ 無法解析 captured_at 參數 '{sys.argv[2]}'，暗夜閘門將不套用: {e}", file=sys.stderr)

    result = analyze_image_optics(img_path, capture_time=cap_time)
    print(json.dumps(result, ensure_ascii=False, indent=2))
