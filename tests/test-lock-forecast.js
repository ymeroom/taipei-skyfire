/**
 * test-lock-forecast.js - 每站鎖定預測輸出形狀
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

console.log('--- 🧪 測試: lock-forecast 每站鎖定 ---');

process.env.MANUAL_SESSION = 'sunset';
delete process.env.EVENT_SCHEDULE;

// 在 require lock-forecast.js 之前替換 WeatherService.fetchForecast
const WeatherService = require('../js/weather-service.js');
let calls = 0;
WeatherService.fetchForecast = async (force, coords) => {
  calls += 1;
  const score = 30 + calls;                    // 每站不同分數
  const day = {
    date: new Date().toISOString(),
    sunset: {
      skyfire: {
        score,
        rating: { badge: '平淡暮光', color: '#7B88A8', level: 'FAINT' },
        metrics: { horizonClearance: 50 + calls, visKm: 18 + calls }
      },
      weather: { cloudHigh: 1, cloudMid: 10 + calls, cloudLow: 2, cloudTotal: 13 + calls, humidity: 80, precipProb: 5, visibilityKm: 18 + calls }
    },
    sunrise: { skyfire: { score: 5, rating: { badge: 'x', color: '#111' }, metrics: {} }, weather: {} }
  };
  return { isSimulated: false, daysForecast: [day] };
};

const { lockForecast } = require('../scripts/lock-forecast.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyfire-lock-'));

module.exports = (async () => {
  await lockForecast({ dataDir: path.join(dir, 'data') });

  const locked = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'locked-sunset-forecast.json'), 'utf8'));

  assert.strictEqual(Object.keys(locked.stations).length, 6, '6 個日落測站全部鎖定');
  assert.ok(locked.stations.dadaocheng, 'stations map 以 station id 為 key');
  assert.strictEqual(locked.skyfire.score, locked.stations.dadaocheng.score, '頂層 skyfire 鏡射主測站 (大稻埕)');
  assert.strictEqual(locked.weather.humidity, locked.stations.dadaocheng.weather.humidity, '頂層 weather 鏡射主測站');
  assert.strictEqual(typeof locked.stations.tamsui.weather.cloudMid, 'number');
  assert.strictEqual(typeof locked.stations.tamsui.metrics.horizonClearance, 'number');
  assert.strictEqual(locked.session, 'sunset');
  assert.ok(locked.lockedAt);

  // 每站分數應互不相同 (來自各自的 fetchForecast 呼叫)
  const scores = Object.values(locked.stations).map(s => s.score);
  assert.strictEqual(new Set(scores).size, 6, '每站有各自獨立算出的分數');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✅ lock-forecast 輸出含 6 站 stations map + 頂層主測站鏡射');
})().catch(err => {
  console.error('❌ lock-forecast 每站鎖定測試未通過:', err.message);
  process.exit(1);
});
