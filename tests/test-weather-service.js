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

console.log('🎉 Taipei WeatherService 測試案例全數 PASS!\n');
