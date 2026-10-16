#!/usr/bin/env python3
"""
test_fire_label_sheet.py - 火燒雲人工標註表 (fire_label_sheet.py) 的挑圖與記標註邏輯

執行：python tests/test_fire_label_sheet.py
"""

import importlib.util
import os

HERE = os.path.dirname(__file__)
spec = importlib.util.spec_from_file_location(
    "fire_label_sheet", os.path.join(HERE, "..", "scripts", "fire_label_sheet.py"))
ls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ls)

print("--- 🧪 Python 測試: 火燒雲人工標註表 ---")

stations = {
    # 最暖在 -20 (時段外) → 補進來；+10/+20 在日落時段內；-40 不在時段也不是最暖 → 不放
    "tamsui": [(-40, 1.0, "tamsui-t-40.jpg"), (-20, 40.0, "tamsui-t-20.jpg"),
               (10, 25.0, "tamsui-t+10.jpg"), (20, 9.0, "tamsui-t+20.jpg")],
    "bali": [(10, 1.0, "bali-t+10.jpg")],          # 不暖、預報也低 → 不入表
    "xiangshan": [(0, 0.5, "xiangshan-t+00.jpg")],  # 不暖但預報高 → 入表 (要「預報高沒燒」的負例)
    "jiufen": [],                                    # 沒有可用影格
}
tiles = ls.pick_tiles(stations, {"tamsui": 10, "bali": 20, "xiangshan": 48}, "sunset")
assert [(t["station"], t["off"]) for t in tiles] == [
    ("tamsui", -20), ("tamsui", 10), ("tamsui", 20), ("xiangshan", 0)], tiles
assert tiles[2]["file"] == "tamsui-t+20.jpg", tiles
assert [t["n"] for t in tiles] == [1, 2, 3, 4], tiles
print("✅ 夠暖或預報夠高的站才入表；放會燒的時段+最暖那張，依時間排序、編號連續")

sunrise = ls.pick_tiles({"hongludi": [(-20, 6.0, "h-20.jpg"), (10, 3.0, "h+10.jpg")]}, {}, "sunrise")
assert [t["off"] for t in sunrise] == [-20], sunrise
print("✅ 日出用日出前的時段 (-30~0)")

again = ls.pick_tiles(stations, {"xiangshan": 48}, "sunset", already={("tamsui", 20), ("xiangshan", 0)})
assert [(t["station"], t["off"]) for t in again] == [("tamsui", -20), ("tamsui", 10)], again
print("✅ 已標註過的影格不再放進表")

assert ls.pick_tiles({"bali": [(-40, ls.WARM_PCT_MIN, "b.jpg")]}, {}, "sunset"), "門檻值本身要入表"
print("✅ 暖色面積剛好等於門檻也入表")

meta = {"key": "2026-10-17-sunset", "bundle": "2026-10-17-sunset-2100", "tiles": tiles}
rows = ls.apply_labels(meta, partial=[2], full=[])
assert [r["y"] for r in rows] == [0, 1, 0, 0], rows
assert rows[1]["src"] == "auto:2026-10-17-sunset#2" and rows[1]["split"] == "dev", rows
print("✅ 只列有燒的編號，其他自動記為不算")

burned = [dict(bundle="2026-10-17-sunset-1945", station="tamsui", y=1),
          dict(bundle="2026-10-17-sunset-2100", station="tamsui", y=2),   # 同一場另一份 bundle
          dict(bundle="2026-10-17-sunset-2100", station="bali", y=0),
          dict(bundle="2026-10-18-sunset-2100", station="tamsui", y=1)]
assert ls.burn_events(burned) == 2, burned
print("✅ 有燒的場數：同一場次同一站的多張只算一場")

for bad in (dict(partial=[5], full=[]), dict(partial=[1], full=[1])):
    try:
        ls.apply_labels(meta, **bad)
    except ValueError:
        pass
    else:
        raise AssertionError(f"應該擋下 {bad}")
print("✅ 表上沒有的編號、同一張同時標兩種 → 擋下")

print("🎉 火燒雲人工標註表測試全數 PASS!\n")
