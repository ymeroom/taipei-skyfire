/**
 * test-skyfire-engine.js - 測試 Taipei SkyFire 物理演算法引擎
 */

const assert = require('assert');
const SkyFireEngine = require('../js/skyfire-engine.js');

console.log('--- 🧪 測試 2: Taipei SkyFire 大氣物理模型測試 ---');

// 1. 史詩級情境
const epic = SkyFireEngine.calculate({
  highCloud: 55,
  midCloud: 40,
  lowCloud: 10,
  totalCloud: 65,
  visibility: 30000,
  horizonClearance: 90,
  type: 'sunset'
});

assert(epic.score >= 82, `理想條件應評為 EPIC (>=82 分)，實際得分: ${epic.score}`);
assert.strictEqual(epic.rating.level, 'EPIC');
console.log('✅ 台北史詩級火燒雲 (EPIC) 評分正確:', epic.score, '分 -', epic.rating.badge);

// 2. 厚低雲壓制
const overcast = SkyFireEngine.calculate({
  highCloud: 10,
  midCloud: 20,
  lowCloud: 90,
  totalCloud: 100,
  visibility: 5000,
  precipProb: 80,
  type: 'sunset'
});

assert(overcast.score <= 20, `厚低雲應壓低分數，實際得分: ${overcast.score}`);
console.log('✅ 台北陰雨天壓制邊界正確:', overcast.score, '分 -', overcast.rating.badge);

// 3. 晴空無雲邊界
const clear = SkyFireEngine.calculate({
  highCloud: 0,
  midCloud: 0,
  lowCloud: 0,
  visibility: 30000,
  type: 'sunset'
});

assert(clear.score <= 10, `完全無雲沒有可被染紅的雲，火燒雲分應 <= 10，實際得分: ${clear.score}`);
assert.strictEqual(clear.rating.level, 'CLEAR', '晴空不能標成「陰沉沉寂」');
assert.strictEqual(overcast.rating.level, 'OVERCAST', '厚低雲仍是陰沉');
console.log('✅ 晴空無雲防呆測試通過:', clear.score, '分 -', clear.rating.badge);

// 4. 天空美感分的輸入：不套無雲上限，但仍套厚低雲上限
assert(clear.metrics.clearSkyUncappedScore > 35,
  `晴空的 clearSkyUncappedScore 不該被無雲上限壓住，實際: ${clear.metrics.clearSkyUncappedScore}`);
assert(overcast.metrics.clearSkyUncappedScore <= 15,
  `低雲 >85% 的 clearSkyUncappedScore 仍應 <= 15，實際: ${overcast.metrics.clearSkyUncappedScore}`);
assert.strictEqual(epic.metrics.clearSkyUncappedScore, epic.score, '有雲時兩個分數相同');
console.log('✅ clearSkyUncappedScore 只略過無雲上限:', clear.metrics.clearSkyUncappedScore, '分');

console.log('🎉 Taipei SkyFireEngine 測試案例全數 PASS!\n');
