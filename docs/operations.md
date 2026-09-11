# Taipei SkyFire 現況運作說明

最後更新：2026-09-11（本機排程器上線當天）

這份文件說明網站背後「每天實際在做什麼」——從凌晨到深夜，資料怎麼被算出來、
怎麼被驗證、怎麼被呈現到首頁。給未來的自己（或協作者）快速抓回全貌用。

---

## 一句話說明

**Taipei SkyFire** 是一個「日出/日落火燒雲預測」網站：每天在 8 個攝影機位
（6 個日落 + 2 個日出）鎖定一次預測分數，出景當下去對應的 YouTube 即時影像
擷取一張畫面做光學分析、算出「實際」分數，兩者互相比對來檢驗模型準不準，
再定期用這些比對結果回頭微調模型參數。

- 線上網址：https://ymeroom.github.io/taipei-skyfire/
- 前端：純 HTML/CSS/原生 JS（無框架），靜態部署在 GitHub Pages
- 後端運算：沒有伺服器，全部靠 GitHub Actions（排定時間執行的腳本）+ 一台
  自己的電腦（DESKTOP-B9TP0EK，當 self-hosted runner）
- 資料庫：沒有真正的資料庫，所有資料就是 repo 裡的 JSON 檔（`data/` 目錄），
  每次寫入就是 git commit + push

---

## 8 個測站

| id | 中文名 | 時段 | YouTube 頻道 | 備註 |
|---|---|---|---|---|
| dadaocheng | 大稻埕碼頭 | 日落 | 臺北旅遊網 | **日落主測站** |
| xiangshan | 象山看 101 | 日落 | 臺北旅遊網 | |
| tamsui | 淡水漁人碼頭 | 日落 | 新北觀光 | |
| bali | 八里左岸 | 日落 | 新北觀光 | |
| maokong | 貓空指南宮 | 日落 | 臺北旅遊網 | |
| jiufen | 九份 | 日落 | 新北觀光 | DVR 可回溯約 10 小時 |
| hongludi | 烘爐地 | 日出 | 新北觀光 | **日出主測站** |
| waimushan | 外木山 | 日出 | 國家海洋研究院 | DVR 可回溯約 12 小時（曾誤判為「沒有 DVR」，2026-09-11 已用手動拉播放進度條驗證更正） |

每站的座標、YouTube 影片 ID、頻道帳號等唯一真實來源是 `js/stations.js`；
`data/stations.json` 是從它自動產生的唯讀複本（`node scripts/build-stations-json.js`），
兩者不同步會被測試擋下來。

「主測站」只是首頁頂層摘要顯示用的鏡射對象，模型計算、鎖定、擷取、評分全部
是 8 站獨立進行、互不影響、**全部平等餵進校準**。

---

## 每天的時間軸（台北時間）

觸發時鐘：**你電腦上的 Windows 工作排程器**（2026-09-11 起，取代原本的
GitHub Actions `schedule:`，見下方「觸發機制」一節）。

| 時間 | 工作 | 做什麼 |
|---|---|---|
| 05:30 | 擷取日出 | 到 2 個日出站抓即時影像畫面 + 光學評分 + 產生日報 |
| 09:00 | 日出日報 | 同一條管線再跑一次（補跑/確保日報有發布） |
| 15:30 | **鎖定日落預測** | 對 6 個日落站各自算一次模型分數，寫死存檔，事後不能改 |
| 18:45 | 擷取日落 | 到 6 個日落站抓即時影像畫面 + 光學評分 + 產生日報 |
| 21:00 | 日落日報 | 同一條管線再跑一次（補跑/確保日報有發布） |
| 23:45 | **鎖定日出預測** | 對 2 個日出站各自算一次模型分數，鎖定的是**明天**日出 |

另外還有兩條非每日的背景工作：

- **多機位縮時擷取**（`auto_timelapse_multi_station.yml`）：日出/日落窗口
  （事件前後 40 分鐘、每 10 分鐘一張）另外補跑一次縮時序列，純粹是留存
  影像素材，跟上面的預測驗證管線互不影響、互不依賴。只能在自架 runner
  上跑（需要住宅 IP 才能穩定用 DVR 回溯）。
- **每週校準**（`weekly_auto_calibration.yml`，每週一 00:00）：把過去一週
  所有測站的「預測 vs 實測」誤差丟給 `auto-calibrate-model.py`，微調
  `data/model-calibration-params.json` 裡的物理模型權重。

---

## 資料怎麼流動（單一場次，例如某天的日落）

```
15:30  lock-forecast.js
       ├─ 對 6 個日落站各自呼叫 WeatherService.fetchForecast()
       │   （每站自己的座標 → 自己的太陽方位角 → 自己的上游雲層取樣路徑）
       └─ 寫入 data/locked-sunset-forecast.json
          { stations: { dadaocheng: {...}, xiangshan: {...}, ... } }

18:45  capture-validation.js
       ├─ 讀剛才鎖定的 6 站預測
       ├─ 對每一站：連上對應 YouTube 直播 → DVR 往回轉到日落當下時刻
       │   → 存一張快照 data/snapshots/<日期>/sunset/<站名>.jpg
       └─ 寫入 data/verification-records.json
          （每站一筆記錄，含預測分數 + 影格證據 + 尚未評分）

       score-ground-truth.js（緊接著跑）
       ├─ 對每一筆記錄：檢查影格是否真的落在暮光時間窗口內
       │   （DVR 沒轉到位的「live-edge」影格一律跳過，絕不冒充實測）
       ├─ 在窗口內的 → Python 光學分析器讀 CIELAB/HSV 色彩直方圖 → 算出
       │   0-100 分的「實測」分數
       └─ 更新 verification-records.json：預測 vs 實測 + 誤差 + 判定
          （誤差 ≤8 命中 / ≤18 輕微偏差 / >18 需校準）

       generate_daily_briefing.py（緊接著跑）
       └─ 把當天 6 站的完整結果整理成一份日報，存進 data/daily-reports/

       build-tonight-stations.js（緊接著跑）
       └─ 把「今晚」場次的 6 站預測分數排序，寫入 data/tonight-stations.json
          （首頁讀這份檔案顯示排名，不需要等實測出來）

每週一 00:00  auto-calibrate-model.py
       └─ 讀一週份 verification-records.json 的誤差，回頭微調
          data/model-calibration-params.json
```

**誠實性防呆（前後修過 4 次同類 bug，逐一列出目前在檔的機制）：**

1. `frameIsInWindow` — DVR 沒轉到暮光窗口內的影格標成
   `skipped_out_of_window`，`groundTruthScore` 留 `null`，絕不硬塞假分數。
2. `dvrSeekApplied` — 只有 DVR seek 真的落地成功的影格才算 `exact`，沒落地
   的標成 `live-edge`，評分階段直接排除。
3. `clean_cloud_bands` — 區分「雲量欄位真的是 0（晴空）」跟「欄位擷取失敗
   的假 0」，不讓假 0 混進日報或校準樣本。
4. `has_usable_cloud_inputs` — 校準守門，壞紀錄（沒有可用雲量輸入）不會
   被拿去訓練模型權重。

---

## 觸發機制（2026-09-11 剛換過）

**舊做法：** GitHub Actions 的 `schedule:` cron。

**問題：** 實測延遲 4-7 小時是常態。對「鎖定」這種動作是致命的——遲到的
鎖定等於「看到結果之後才假裝做出的預測」；對「擷取」也很致命——常常整個
錯過暮光窗口。

**新做法：** 兩個 workflow（`lock_forecast.yml`、`auto_validate_capture.yml`）
的 `schedule:` 已整段移除，只留 `workflow_dispatch`（手動/程式觸發用）。
準時的鬧鐘改由**你電腦上的 Windows 工作排程器**負責：

- 6 個排程工作，註冊在工作排程器的 `\SkyFire\` 資料夾底下
  （`Lock-Sunset` / `Lock-Sunrise` / `Capture-Sunrise` / `Briefing-Sunrise` /
  `Capture-Sunset` / `Briefing-Sunset`）
- 時間一到，執行 `scripts/trigger-workflow.ps1`，它做的事只有一件：呼叫
  `gh workflow run <檔名> -f session=<sunrise|sunset>`，等同你自己手動按下
  GitHub 網頁上的「執行」按鈕。實際的擷取/評分/鎖定邏輯完全還是跑在
  GitHub Actions 裡（或自架 runner 上），沒有搬到本機執行。
- 登入模式用 **S4U**（不管你有沒有登入桌面都能跑，不像一般的「使用者
  登入時執行」——這台機器常態透過遠端連線使用，實測過「使用者登入時執行」
  會在沒有真正互動桌面工作階段時悄悄跳過、卻還回報成功，S4U 才是可靠的）。
- 「鎖定」類工作錯過時刻就跳過，不補跑（避免產生事後鎖定的假預測）；
  「擷取/日報」類工作錯過會在電腦醒來後自動補跑一次。
- 記錄檔在 `C:\ProgramData\SkyFireScheduler\`（`trigger.log` 看每次觸發
  結果、`probe.log` 看行程是否真的被啟動過）——刻意不放在 repo 內或使用者
  個人設定檔底下，理由：repo 內的檔案會被 self-hosted runner 的
  `actions/checkout` 之 `git clean` 清掉；使用者設定檔在 S4U 底下是否穩定
  載入不保證。
- `gh` 的認證：S4U 底下直接讀 Windows 憑證保存庫（keyring）就能成功，
  已實測驗證。腳本也保留一個備援（`gh-token.txt` 放同一個目錄），平常
  用不到。

**一鍵安裝/重灌：** `scripts/install-local-scheduler.ps1`（需要以系統管理員
身分執行一次，之後排程本身平常執行不需要）。可重複執行、會先移除舊的
同名工作再重建，改時間就直接改腳本裡的表格重跑。

**尚待自然驗證：** 目前只驗證過「手動點執行」這條路徑真的能跑通到
GitHub。還沒有被「時間真正到了、系統自己觸發」驗證過——第一次會是
2026-09-11 當天 18:45（日落擷取）。

---

## 首頁呈現什麼

- **今晚各機位霞光預測排名**：讀 `data/tonight-stations.json`，鎖定完成後
  立刻能顯示，不用等實測。
- **每日驗證日報 + 歷史歸檔**：讀 `data/daily-reports/`，逐站列出預測分數、
  實測分數、誤差、判定徽章。
- **12 個經典機位互動地圖**（Leaflet）：跟上面 8 站不是同一份清單——地圖
  是給遊客看的「推薦拍攝地點指南」（含交通方式、鏡頭焦段建議），8 站是
  「有官方即時影像可驗證」的機位子集，兩者共用同一份座標登錄表
  （`js/stations.js` 的 `_STATION_REG`）避免座標兜不起來。
- **即時預測引擎 + 氣象物理沙盒**：前端直接呼叫 Open-Meteo API 現場算，
  跟上面「鎖定」的每日一次快照分數是兩條獨立路徑——首頁看到的即時分數
  會隨你调整參數或天氣更新而變動，鎖定分數是當天固定不變的存證。

---

## 已知限制 / 觀察中的問題

- 九份（jiufen）、外木山（waimushan）過去被記錄成 DVR 能力有限甚至完全
  沒有 —— 2026-09-11 用手動拉 YouTube 播放器進度條驗證後更正：九份可
  回溯約 10 小時、外木山可回溯約 12 小時，跟其他站差不多。之前 9/10
  九份被跳過（`skipped_out_of_window`）比較可能是當次擷取時機沒抓好，
  不是這個站先天回溯不了那麼久。
- 2026-09-10 晚上的第一次每站驗證結果顯示：模型對「看盆地」的機位（象山/
  貓空/大稻埕）誤差偏大（30-50 分），對「面海」的機位（淡水/八里）幾乎
  精準命中——這是校準需要繼續觀察修正的方向，還沒有結論。
