/**
 * test-solar-calc.js - 測試 Taipei SkyFire 太陽天文計算算法
 */

const assert = require('assert');
const SolarCalc = require('../js/solar-calc.js');

console.log('--- 🧪 測試 1: Taipei SolarCalc 天文算法測試 ---');

const testDate = new Date('2026-08-16T12:00:00+08:00');
const times = SolarCalc.getTimes(testDate);

assert(times.sunrise instanceof Date, '日出時間應為 Date 物件');
assert(times.sunset instanceof Date, '日落時間應為 Date 物件');
assert(times.sunrise < times.sunset, '日出時間必須早於日落時間');
assert(times.sunsetSkyfireWindow, '應包含日落火燒雲觀測窗口');

const sunsetPos = SolarCalc.getPosition(times.sunset);
assert(sunsetPos.azimuth >= 260 && sunsetPos.azimuth <= 310, '台北夏季日落方位角應在西北西 (270°-300°)');
assert(Math.abs(sunsetPos.elevation) <= 5, '日落時太陽仰角應接近地平線');

console.log('✅ 台北日出/日落與火燒雲最佳窗口計算正確:', {
  sunrise: SolarCalc.formatTime(times.sunrise),
  sunset: SolarCalc.formatTime(times.sunset),
  sunsetAzimuth: `${sunsetPos.azimuth}° (${sunsetPos.azimuthCompass})`
});

console.log('🎉 Taipei SolarCalc 測試案例全數 PASS!\n');
