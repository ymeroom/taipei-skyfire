/**
 * lock-forecast.js
 * 提前向 Open-Meteo 請求每個測站的氣象資料並計算預測分數，鎖定存入 JSON，
 * 供之後的歷史日報 (Ground Truth) 驗證使用。
 *
 * 每個時段鎖定該時段全部測站 (日落 6 站 / 日出 2 站)。頂層 skyfire / weather
 * 鏡射主測站，維持既有讀取端與測試相容；stations map 帶每站獨立結果。
 */

const fs = require('fs');
const path = require('path');
const WeatherService = require('../js/weather-service.js');
const { getTaipeiDateString, resolveLockTarget } = require('./live-capture-core.js');
const { stationsForSession } = require('../js/stations.js');

function pickSessionForecast(forecastData, dateStr, sessionType) {
  const day = forecastData.daysForecast.find(d =>
    getTaipeiDateString(new Date(d.date)) === dateStr
  ) || forecastData.daysForecast[0];
  return day[sessionType];
}

function stationLockEntry(sf) {
  const w = sf.weather || {};
  const m = sf.skyfire.metrics || {};
  return {
    score: sf.skyfire.score,
    rating: sf.skyfire.rating.badge,
    color: sf.skyfire.rating.color,
    weather: {
      cloudHigh: w.cloudHigh ?? null,
      cloudMid: w.cloudMid ?? null,
      cloudLow: w.cloudLow ?? null,
      cloudTotal: w.cloudTotal ?? null,
      humidity: w.humidity ?? null,
      precipProb: w.precipProb ?? null,
      visibilityKm: m.visKm ?? w.visibilityKm ?? null
    },
    metrics: {
      horizonClearance: m.horizonClearance ?? null,
      visKm: m.visKm ?? null
    }
  };
}

async function lockForecast({ dataDir } = {}) {
  // 目標日期一律由 cron 的「排定時刻」推算，而非實際執行時刻 (GitHub 排程延遲
  // 實測可達 4-7 小時，用執行時刻會在跨過台北午夜時鎖錯天)。
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

  const stations = stationsForSession(sessionType);
  console.log(`[Lock Forecast] 準備鎖定 ${dateStr} 的 ${sessionType} 預測 (${stations.length} 站)`);

  const stationLocks = {};
  let primarySkyfire = null;
  let primaryWeather = null;

  for (const st of stations) {
    let sf;
    try {
      // fetchForecast 已支援自訂座標：各站以自己的座標建立上游光路取樣幾何。
      const fc = await WeatherService.fetchForecast(true, { lat: st.lat, lng: st.lng });
      sf = pickSessionForecast(fc, dateStr, sessionType);
    } catch (err) {
      console.warn(`[Lock Forecast] ${st.id}: 取得預測失敗，略過 (${err.message})`);
      continue;
    }
    if (!sf || !sf.skyfire) {
      console.warn(`[Lock Forecast] ${st.id}: 無預測資料，略過`);
      continue;
    }
    stationLocks[st.id] = stationLockEntry(sf);
    console.log(`[Lock Forecast]   ${st.id}: ${sf.skyfire.score} 分`);
    if (st.isPrimary) {
      primarySkyfire = sf.skyfire;
      primaryWeather = stationLocks[st.id].weather;
    }
  }

  if (!primarySkyfire) {
    throw new Error('主測站預測缺失，鎖定中止');
  }

  const scoreData = {
    date: dateStr,
    session: sessionType,
    lockedAt: now.toISOString(),
    skyfire: primarySkyfire,
    weather: primaryWeather,
    stations: stationLocks
  };

  const outDir = dataDir || path.join(__dirname, '../data');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const lockFile = path.join(outDir, `locked-${sessionType}-forecast.json`);
  fs.writeFileSync(lockFile, JSON.stringify(scoreData, null, 2), 'utf8');

  console.log(`[Lock Forecast] 已鎖定 ${Object.keys(stationLocks).length} 站；主測站 ${scoreData.skyfire.score} 分`);
  console.log(`[Lock Forecast] 檔案已儲存至: ${lockFile}`);
  return scoreData;
}

if (require.main === module) {
  lockForecast().catch(err => {
    console.error('[Lock Forecast] Error:', err);
    process.exit(1);
  });
}

module.exports = { lockForecast };
