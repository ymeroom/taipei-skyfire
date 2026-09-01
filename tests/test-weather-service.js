/**
 * test-weather-service.js - 測試 Taipei SkyFire 氣象服務
 */

const assert = require('assert');
const WeatherService = require('../js/weather-service.js');

console.log('--- 🧪 測試 3: Taipei WeatherService 氣象服務測試 ---');

const sim = WeatherService.generateSimulatedForecast();
assert.strictEqual(sim.isSimulated, true, '離線模擬標記應為 true');
assert.strictEqual(sim.daysForecast.length, 6, '台北預報應生成 6 天日出/日落數據');
assert(sim.daysForecast[0].sunset.skyfire.score >= 0, '日落分數應為有效數字');

console.log('✅ 台北離線模擬預報結構生成正確 (6 天日出日落)');

const mockRaw = {
  hourly: {
    time: ['2026-08-16T18:00'],
    cloudcover_high: [50],
    cloudcover_mid: [40],
    cloudcover_low: [10],
    cloudcover: [60],
    visibility: [25000],
    relativehumidity_2m: [60],
    precipitation_probability: [0],
    temperature_2m: [30],
    weathercode: [1]
  }
};

const parsed = WeatherService.processRawData(mockRaw);
assert.strictEqual(parsed.isSimulated, false);
assert.strictEqual(parsed.daysForecast.length, 6);

console.log('✅ 台北 Open-Meteo 原始數據解析正確');

// ----------------------------------------------------------------
// 上游取樣座標一致性 (Ray-Path Sampling Provenance)
// processRawData 收到的上游氣象資料只來自「一組」座標，
// 因此每一天回報的 upstream.coords 必須是那個實際被取樣的點，
// 不可每天用當天方位角重算出一個沒有對應氣象資料的座標。
// ----------------------------------------------------------------
const parsedProvenance = WeatherService.processRawData(mockRaw, mockRaw, mockRaw, WeatherService.TAIPEI_COORDS);
const provenanceDay0 = parsedProvenance.daysForecast[0].sunset.upstream.coords;
const provenanceDay5 = parsedProvenance.daysForecast[5].sunset.upstream.coords;
assert.deepStrictEqual(
  provenanceDay5,
  provenanceDay0,
  '各日回報的上游取樣座標必須一致（等於實際取樣點），不可逐日重算'
);

console.log('✅ 上游取樣座標與實際取樣點一致');

console.log('🎉 Taipei WeatherService 測試案例全數 PASS!\n');
