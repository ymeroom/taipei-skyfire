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

// ----------------------------------------------------------------
// G. 地形判斷：光路可能跨越山脈，該處的低雲語意與海面完全不同，
//    而且山體本身就會直接遮斷射線。
//    註：Open-Meteo 的 elevation 對台北盆地也回傳 0，因此「高度 0」只能
//    判定為「海面或平原」，不能斷言是海。真正可計算的是地形遮蔽。
// ----------------------------------------------------------------
assert.strictEqual(WeatherService.classifyTerrain(0).kind, 'sea_level', '高度 0 應歸類為海面／平原');
assert.strictEqual(WeatherService.classifyTerrain(120).kind, 'lowland', '120m 應歸類為平原丘陵');
assert.strictEqual(WeatherService.classifyTerrain(2136).kind, 'mountain', '2136m（阿里山）應歸類為山區');

// 抵達 6km 高雲的射線在上游 160km 處僅約 1.07km 高 → 3000m 山體完全擋死
assert.strictEqual(
  WeatherService.computeTerrainBlocking({ elevationM: 3000, distanceKm: 160, targetAltitudeKm: 6 }),
  100,
  '射線高度 1.07km 處的 3000m 山體應完全遮斷'
);

// 同一條射線在上游 60km 處已爬到 3.68km → 2136m 的山擋不到
assert.strictEqual(
  WeatherService.computeTerrainBlocking({ elevationM: 2136, distanceKm: 60, targetAltitudeKm: 6 }),
  0,
  '射線高度 3.68km 處的 2136m 山體不應造成遮蔽'
);

assert.strictEqual(
  WeatherService.computeTerrainBlocking({ elevationM: 0, distanceKm: 160, targetAltitudeKm: 6 }),
  0,
  '海面高度不應造成地形遮蔽'
);

// 射線高度已貼近地表時，該處地形就是「日落地平線」本身，
// 而地平線已由 SolarCalc 的日落時刻反映，再扣一次即為重複計算。
// 例：台北日落光路 260km 處為福建丘陵 475m，射線僅 21m 高。
assert.strictEqual(
  WeatherService.computeTerrainBlocking({ elevationM: 475, distanceKm: 260, targetAltitudeKm: 6 }),
  0,
  '射線貼近地平線處的地形屬日落地平線本身，不應重複扣分'
);

console.log('✅ 地形分類與地形遮蔽計算正確');

// 帶狀遮蔽必須同時考慮雲與山，取兩者較嚴重者
const terrainSamples = [
  { distanceKm: 60,  cloudLow: 0, cloudTotal: 0, elevationM: 0 },
  { distanceKm: 110, cloudLow: 0, cloudTotal: 0, elevationM: 0 },
  { distanceKm: 160, cloudLow: 0, cloudTotal: 0, elevationM: 3000 },
  { distanceKm: 210, cloudLow: 0, cloudTotal: 0, elevationM: 0 },
  { distanceKm: 260, cloudLow: 0, cloudTotal: 0, elevationM: 0 }
];
assert.strictEqual(
  WeatherService.computeBandBlocking(terrainSamples, 'high'),
  100,
  '晴空無雲但光路穿越 3000m 山脈時，天幕帶仍應判定為完全遮斷'
);
assert.strictEqual(
  WeatherService.computeBandBlocking(terrainSamples, 'low'),
  0,
  '160km 的山體不在低雲染色帶範圍內，不應汙染該帶'
);

console.log('✅ 帶狀遮蔽同時涵蓋雲層與地形');

// 端到端：取樣點必須揭露地形資訊
const makeRawTerrain = (cloudLow, elevation) => {
  const raw = makeRaw(cloudLow);
  raw.elevation = elevation;
  return raw;
};
const mountainPath = ladder.map(km => makeRawTerrain(0, km === 160 ? 3000 : 0));
const parsedTerrain = WeatherService.processRawData(clearLocal, mountainPath, mountainPath);
const terrainSunset = parsedTerrain.daysForecast[0].sunset;

const at160 = terrainSunset.upstream.samples.find(x => x.distanceKm === 160);
assert.strictEqual(at160.terrain.kind, 'mountain', '160km 取樣點應標記為山區');
assert.strictEqual(at160.elevationM, 3000, '取樣點應保留地形高度');
assert.strictEqual(
  terrainSunset.upstream.bands.high,
  100,
  '穿越山脈的光路應反映在天幕帶遮蔽率上'
);

console.log('✅ 光路取樣點地形資訊端到端揭露正確');

console.log('🎉 向量光路分層帶狀取樣模型測試全數 PASS!\n');
