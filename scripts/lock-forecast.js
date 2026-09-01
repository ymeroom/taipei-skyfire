/**
 * lock-forecast.js
 * 提前向 Open-Meteo 請求氣象資料並計算預測分數，將結果鎖定存入 JSON，
 * 供之後的歷史日報 (Ground Truth) 驗證使用。
 */

const fs = require('fs');
const path = require('path');
const WeatherService = require('../js/weather-service.js');
const { getTaipeiDateString, resolveLockTarget } = require('./live-capture-core.js');

async function lockForecast() {
  // 目標日期一律由 cron 的「排定時刻」推算，而非實際執行時刻。
  // GitHub 排程延遲實測可達 4-7 小時，用執行時刻會在跨過台北午夜時鎖錯天：
  // 08-31 16:30 的日落鎖定延遲到台北 09-01 00:17 執行，舊邏輯會鎖成
  // 09-01 的日落，08-31 當天完全沒鎖到，隔日驗證因此找不到對應預測。
  const target = resolveLockTarget({
    schedule: process.env.EVENT_SCHEDULE || '',
    manualSession: process.env.MANUAL_SESSION || '',
    now: new Date()
  });
  const sessionType = target.session;
  const dateStr = target.dateStr;
  const now = new Date();

  if (target.scheduledAt) {
    console.log(`[Lock Forecast] 排定時刻: ${target.scheduledAt} / 實際延遲: ${target.delayMinutes} 分鐘`);
    if (target.delayMinutes > 120) {
      console.warn(`[Lock Forecast] 注意：本次排程延遲 ${target.delayMinutes} 分鐘，已依排定時刻校正目標日期`);
    }
  } else {
    console.log('[Lock Forecast] 手動觸發，依執行時刻推算目標日期');
  }

  console.log(`[Lock Forecast] 準備鎖定 ${dateStr} 的 ${sessionType} 預測`);

  const forecastData = await WeatherService.fetchForecast(true);
  const matchingDay = forecastData.daysForecast.find(day =>
    getTaipeiDateString(new Date(day.date)) === dateStr
  ) || forecastData.daysForecast[0];
  
  const sessionForecast = matchingDay[sessionType];
  
  if (!sessionForecast || !sessionForecast.skyfire) {
    throw new Error('無法取得預測資料');
  }

  const scoreData = {
    date: dateStr,
    session: sessionType,
    lockedAt: now.toISOString(),
    skyfire: sessionForecast.skyfire
  };

  const dataDir = path.join(__dirname, '../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const lockFile = path.join(dataDir, `locked-${sessionType}-forecast.json`);
  fs.writeFileSync(lockFile, JSON.stringify(scoreData, null, 2), 'utf8');

  console.log(`[Lock Forecast] 已鎖定預測分數: ${scoreData.skyfire.score} 分`);
  console.log(`[Lock Forecast] 檔案已儲存至: ${lockFile}`);
}

lockForecast().catch(err => {
  console.error('[Lock Forecast] Error:', err);
  process.exit(1);
});
