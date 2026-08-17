/**
 * test-spots-data.js - 測試台北 12 大攝影機位資料庫
 */

const assert = require('assert');
const TAIPEI_SPOTS = require('../js/spots-data.js');

console.log('--- 🧪 測試 4: 台北 12 大攝影機位資料庫測試 ---');

assert.strictEqual(TAIPEI_SPOTS.length, 12, '應包含 12 大台北經典攝影熱點');

TAIPEI_SPOTS.forEach(spot => {
  assert(spot.name, '機位應有名稱');
  assert(spot.lat >= 24.9 && spot.lat <= 25.3, `機位 [${spot.name}] 緯度超出大台北範圍: ${spot.lat}`);
  assert(spot.lng >= 121.3 && spot.lng <= 121.8, `機位 [${spot.name}] 經度超出大台北範圍: ${spot.lng}`);
  assert(spot.recommendedFocal, '機位應有推薦焦段');
  assert(spot.traffic, '機位應有交通指南');
});

console.log('✅ 台北 12 大攝影機位經緯度與資訊完整性校驗合格');

console.log('🎉 台北攝影機位資料庫測試全數 PASS!\n');
