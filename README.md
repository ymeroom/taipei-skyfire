# Taipei SkyFire 霞光台北 🔥

> 專為大台北地區設計的日出與日落火燒雲（霞光）即時科學預測網站與攝影機位指南。

🌐 **線上即時體驗 (Live Demo)**: [https://ymeroom.github.io/taipei-skyfire/](https://ymeroom.github.io/taipei-skyfire/)

---

## ✨ 核心特色

- 📊 **多維度科學火燒雲預測演算法 (SkyFire Engine)**：
  - 綜合高空卷雲（6,000m+ 反射天幕）、中空高積雲（2,000-6,000m 立體魚鱗紋）、低空層雲（<2,000m 遮擋懲罰）。
  - 精算日落西方（台灣海峽）與日出東方（太平洋）遠方「地平線透光窗 (Horizon Optical Window)」。
  - 結合大氣能見度與米氏散射係數，提供 0 - 100 分精準出景指數與 5 大評級。
- ⏱️ **精準天文時程與倒數**：
  - 即時計算台北經緯度之民用曙光、日出、日落、黃金時刻、藍調時刻及火燒雲最佳觀測窗口。
- ☁️ **3D 大氣垂直雲層剖面圖**：
  - 動態視覺化呈現當前高、中、低空雲層厚度與光學穿透路徑。
- 🗺️ **台北 12 大火燒雲經典機位與互動地圖**：
  - 收錄大稻埕碼頭、淡水漁人碼頭、象山六巨石/超然亭、碧山巖、大屯山助航站、金面山剪刀石、彩虹河濱公園、圓山微風平台、觀音山硬漢嶺、南港山九五峰、汐止大尖山、貓空指南宮。
  - 地圖即時繪製「夕陽/日出方位角光錐射線 (Sun Azimuth Ray)」，並標註推薦鏡頭焦段與交通方式。
- 🧪 **氣象物理沙盒模擬器 (Simulation Sandbox)**：
  - 支援手動調節高/中/低雲量、能見度與透光窗，即時體驗各氣象因子對火燒雲的影響。
- 📷 **攝影師隨身小抄**：
  - 提供單眼/微單相機建議參數（光圈、快門、ISO、白平衡 K 值、軟式 GND 漸變鏡）與手機 HDR 測光降曝光技巧。

---

## 🛠️ 技術架構

- **前端核心**：Vanilla HTML5, Modern CSS3 (Glassmorphism, CSS Custom Properties, Responsive Grid, Dynamic Twilight Atmosphere)
- **程式邏輯**：純原生 ES6+ JavaScript (無肥大外部依賴，極速載入)
- **氣象資料來源**：[Open-Meteo API](https://open-meteo.com/)（即時取得台北經緯度多高度層雲量與能見度）
- **互動地圖**：[Leaflet.js](https://leafletjs.com/) + CartoDB Dark Matter 暗黑地圖圖磚
- **天文演算法**：內建精確太陽位置與曙暮光計算模組 (`SolarCalc`)

---

## 🚀 本地開發與執行

直接以瀏覽器開啟 `index.html`，或啟動輕量靜態伺服器：

```bash
# Clone 專案
git clone https://github.com/ymeroom/taipei-skyfire.git
cd taipei-skyfire

# 使用 Node.js 啟動本機預覽
npx serve ./
```

---

## 📄 授權條款

MIT License © 2026 ymeroom
