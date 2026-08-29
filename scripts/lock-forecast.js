/**
 * lock-forecast.js
 * 提前向 Open-Meteo 請求氣象資料並計算預測分數，將結果鎖定存入 JSON，
 * 供之後的歷史日報 (Ground Truth) 驗證使用。
 */

const fs = require('fs');
const path = require('path');
const WeatherService = require('../js/weather-service.js');
const { getTaipeiDateString } = require('./live-capture-core.js');

async function lockForecast() {
  const schedule = process.env.EVENT_SCHEDULE || '';
  const manualSession = process.env.MANUAL_SESSION || '';
  
  let sessionType = 'sunset';
  if (manualSession) {
    sessionType = manualSession;
  } else if (schedule.includes('50 15')) {
    // 23:50 (UTC 15:50) 鎖定隔日日出
    sessionType = 'sunrise';
  } else if (schedule.includes('30 8')) {
    // 16:30 (UTC 08:30) 鎖定當日日落
    sessionType = 'sunset';
  }

  const now = new Date();
  let targetDate = new Date(now);
  if (sessionType === 'sunrise') {
    // 如果是晚上 23:50 鎖定日出，那目標是「明天」的日出
    targetDate.setDate(targetDate.getDate() + 1);
  }
  const dateStr = getTaipeiDateString(targetDate);

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
