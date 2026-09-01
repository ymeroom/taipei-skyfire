/**
 * test-ray-path-model.js - 測試向量光路分層帶狀取樣模型 (Layered Ray-Path Sampling)
 */

const assert = require('assert');
const WeatherService = require('../js/weather-service.js');

console.log('--- 🧪 測試 8: 向量光路分層帶狀取樣模型 ---');

// ----------------------------------------------------------------
// A. 光路幾何：射線在上游各距離處的高度
// 地球曲率下，抵達觀測點上空 h 公里的近水平射線，
// 其切地點距離為 sqrt(2Rh)；在上游 d 公里處的高度為 (sqrt(2Rh) - d)^2 / (2R)。
// ----------------------------------------------------------------
const altHigh60 = WeatherService.rayAltitudeAtDistanceKm(6, 60);
assert(
  Math.abs(altHigh60 - 3.68) < 0.05,
  `照亮 6km 高雲的射線在上游 60km 處應約 3.68km 高，實得 ${altHigh60}`
);

const altHigh260 = WeatherService.rayAltitudeAtDistanceKm(6, 260);
assert(
  altHigh260 < 0.1,
  `照亮 6km 高雲的射線在上游 260km 處應已貼近地面，實得 ${altHigh260}`
);

// 超過切地點之後射線已在地面下，一律回傳 0
assert.strictEqual(
  WeatherService.rayAltitudeAtDistanceKm(1, 150),
  0,
  '超過切地點的距離應回傳 0（射線已被地表截斷）'
);

console.log('✅ 光路曲率幾何計算正確');

// ----------------------------------------------------------------
// B. 分層取樣階梯：沿方位角一次產生整條光路的取樣點
// ----------------------------------------------------------------
const plan = WeatherService.buildRayPathSamplingPlan(25.057045, 121.507718, 279.8);

assert.deepStrictEqual(
  plan.map(p => p.distanceKm),
  WeatherService.RAY_PATH_LADDER_KM,
  '取樣階梯距離應與 RAY_PATH_LADDER_KM 一致'
);

assert(plan.length >= 5, '光路取樣點至少 5 個，單點取樣不足以偵測帶狀雲系');

// 每個取樣點都必須落在該方位角、該距離上
plan.forEach(point => {
  const expected = WeatherService.calculateUpstreamCoords(25.057045, 121.507718, 279.8, point.distanceKm);
  assert.strictEqual(point.lat, expected.lat, `${point.distanceKm}km 取樣點緯度應沿方位角外推`);
  assert.strictEqual(point.lng, expected.lng, `${point.distanceKm}km 取樣點經度應沿方位角外推`);
});

// 日落方位角 279.8° 朝西，取樣點必須往西（經度遞減）
assert(
  plan[plan.length - 1].lng < plan[0].lng,
  '日落光路取樣點應隨距離往西延伸'
);

console.log('✅ 分層光路取樣階梯建立正確');

// ----------------------------------------------------------------
// C. 帶狀遮蔽：一條光路上只要有任何一點被擋住，整條光路就斷了。
// 因此帶內取最差點 (max)，不是取平均。
// 每一層雲有自己的取樣距離區間，不可互相汙染。
// ----------------------------------------------------------------
const bandSamples = [
  { distanceKm: 60,  cloudLow: 100, cloudTotal: 100 },
  { distanceKm: 110, cloudLow: 10,  cloudTotal: 20 },
  { distanceKm: 160, cloudLow: 20,  cloudTotal: 30 },
  { distanceKm: 210, cloudLow: 90,  cloudTotal: 95 },
  { distanceKm: 260, cloudLow: 30,  cloudTotal: 40 }
];

assert.strictEqual(
  WeatherService.computeBandBlocking(bandSamples, 'high'),
  90,
  '高雲帶應取帶內最差點 (210km 的 90%)，且不受帶外 60km 的 100% 影響'
);

assert.strictEqual(
  WeatherService.computeBandBlocking(bandSamples, 'low'),
  100,
  '低雲帶涵蓋 60km，應取到該點的 100%'
);

console.log('✅ 帶狀遮蔽取最差點且分層隔離正確');

// ----------------------------------------------------------------
// D. 複合透光窗：本地垂直柱穿透率 × 上游光路穿透率
// 舊版由上游值「完全覆寫」，導致本地滿天低雲卻仍拿滿分。
// ----------------------------------------------------------------
const localBlocked = WeatherService.computeRayPathHorizonClearance({
  localWeather: { cloudLow: 90, cloudTotal: 95 },
  bandBlocking: { low: 0, mid: 0, high: 0 }
});
assert(
  localBlocked < 30,
  `本地低雲 90% 時透光窗應大幅下降，實得 ${localBlocked}`
);

const upstreamBlocked = WeatherService.computeRayPathHorizonClearance({
  localWeather: { cloudLow: 5, cloudTotal: 20 },
  bandBlocking: { low: 0, mid: 0, high: 100 }
});
assert(
  upstreamBlocked < 55,
  `上游高雲帶完全遮斷時透光窗應大幅下降，實得 ${upstreamBlocked}`
);

const bothClear = WeatherService.computeRayPathHorizonClearance({
  localWeather: { cloudLow: 0, cloudTotal: 10 },
  bandBlocking: { low: 0, mid: 0, high: 0 }
});
assert.strictEqual(bothClear, 100, '本地與上游均通透時應為滿分');

console.log('✅ 複合透光窗（本地 × 上游）計算正確');

// ----------------------------------------------------------------
// E. 端到端：processRawData 吃整條光路的多點資料，產出分層診斷
// ----------------------------------------------------------------
const makeRaw = (cloudLow) => ({
  hourly: {
    time: ['2026-08-16T18:00'],
    cloudcover_high: [50],
    cloudcover_mid: [40],
    cloudcover_low: [cloudLow],
    cloudcover: [Math.max(50, cloudLow)],
    visibility: [25000],
    relativehumidity_2m: [60],
    precipitation_probability: [0],
    temperature_2m: [30],
    weathercode: [1]
  }
});

const clearLocal = makeRaw(0);
const ladder = WeatherService.RAY_PATH_LADDER_KM;

// 只有 210km 那一點有厚低雲 —— 正好落在高雲天幕帶上
const blockedHighBand = ladder.map(km => makeRaw(km === 210 ? 90 : 0));
const parsedBlocked = WeatherService.processRawData(clearLocal, blockedHighBand, blockedHighBand);
const blockedSunset = parsedBlocked.daysForecast[0].sunset;

assert.strictEqual(
  blockedSunset.upstream.bands.high,
  90,
  '210km 的 90% 低雲應被高雲天幕帶偵測到'
);
assert.strictEqual(
  blockedSunset.upstream.bands.low,
  0,
  '210km 的低雲不在低雲染色帶範圍內，不應汙染低雲帶'
);

// 全線通透作為對照組
const allClear = ladder.map(() => makeRaw(0));
const parsedClear = WeatherService.processRawData(clearLocal, allClear, allClear);
const clearSunset = parsedClear.daysForecast[0].sunset;

assert(
  blockedSunset.upstream.horizonClearance < clearSunset.upstream.horizonClearance,
  '高雲天幕帶被遮斷時，透光窗必須低於全線通透的情況'
);
assert(
  blockedSunset.skyfire.score < clearSunset.skyfire.score,
  '光路被遮斷應反映在最終火燒雲評分上'
);

// 取樣點清單必須揭露整條光路，而非單一點
assert.deepStrictEqual(
  blockedSunset.upstream.samples.map(x => x.distanceKm),
  ladder,
  'upstream.samples 應揭露整條光路的取樣距離'
);

console.log('✅ processRawData 分層光路端到端整合正確');

// ----------------------------------------------------------------
// F. 批次請求組裝：一次 request 取回本地 + 兩條光路的所有取樣點
// ----------------------------------------------------------------
const reqCoords = { lat: 25.057045, lng: 121.507718 };
const reqGeometry = WeatherService.buildSamplingGeometry(reqCoords.lat, reqCoords.lng);
const url = WeatherService.buildForecastRequestUrl(reqCoords, reqGeometry);

const latList = decodeURIComponent(url.match(/latitude=([^&]+)/)[1]).split(',');
const lngList = decodeURIComponent(url.match(/longitude=([^&]+)/)[1]).split(',');

const expectedCount = 1 + WeatherService.RAY_PATH_LADDER_KM.length * 2;
assert.strictEqual(latList.length, expectedCount, `應請求 ${expectedCount} 組座標（本地 + 日落光路 + 日出光路）`);
assert.strictEqual(lngList.length, expectedCount, '經度數量應與緯度數量相同');

assert.strictEqual(Number(latList[0]), reqCoords.lat, '第一組座標必須是觀測點本身');
assert.strictEqual(
  Number(latList[1]),
  reqGeometry.sunsetPlan[0].lat,
  '第二組起應為日落光路取樣點，順序需與 sunsetPlan 一致'
);
assert.strictEqual(
  Number(latList[1 + WeatherService.RAY_PATH_LADDER_KM.length]),
  reqGeometry.sunrisePlan[0].lat,
  '日落光路之後應接日出光路取樣點'
);

console.log('✅ Open-Meteo 批次請求座標組裝正確');

console.log('🎉 向量光路分層帶狀取樣模型測試全數 PASS!\n');
