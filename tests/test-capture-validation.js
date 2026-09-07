/**
 * test-capture-validation.js - 鎖定預測 → 驗證紀錄的欄位擷取邊界
 *
 * 迴歸重點：舊版讀 lockedData.skyfire.diagnostics?.highCloud (diagnostics 是
 * 陣列，永遠 undefined→0)，使每筆鎖定路徑紀錄雲量全 0、auto-calibrate 對噪音調參。
 */

const assert = require('assert');
const { buildPredictionFromLock } = require('../scripts/capture-validation.js');

console.log('--- 🧪 測試 9: 鎖定預測欄位擷取 (buildPredictionFromLock) ---');

// 真實 lock-forecast.js 輸出形狀 (data/locked-sunrise-forecast.json 2026-09-07)
const lockedReal = {
  date: '2026-09-07',
  session: 'sunrise',
  lockedAt: '2026-09-06T17:43:10.956Z',
  skyfire: {
    score: 65,
    rating: { badge: '局部霞光', color: '#E5A50A' },
    metrics: { horizonClearance: 73, visKm: 18 },
    diagnostics: [
      { label: '高空卷雲 (6,000m+)', status: 'fair', desc: '高雲量僅 20%' }
    ]
  },
  weather: {
    cloudHigh: 20,
    cloudMid: 15,
    cloudLow: 25,
    cloudTotal: 48,
    humidity: 78,
    precipProb: 10,
    visibilityKm: 18
  }
};

const pred = buildPredictionFromLock(lockedReal);
assert.strictEqual(pred.score, 65, 'score 應直接取自 skyfire.score');
assert.strictEqual(pred.rating, '局部霞光');
assert.strictEqual(pred.highCloud, 20, 'highCloud 應取自 weather.cloudHigh，不是 diagnostics');
assert.strictEqual(pred.midCloud, 15);
assert.strictEqual(pred.lowCloud, 25);
assert.strictEqual(pred.totalCloud, 48);
assert.strictEqual(pred.humidity, 78);
assert.strictEqual(pred.precipProb, 10);
assert.strictEqual(pred.visibilityKm, 18);
assert.strictEqual(pred.horizonClearance, 73);
assert.strictEqual(pred.lockedAt, '2026-09-06T17:43:10.956Z');
assert.strictEqual(pred.isSimulated, false);
assert.ok(
  !(pred.highCloud === 0 && pred.midCloud === 0 && pred.lowCloud === 0),
  '有 weather 區塊時，雲量三頻絕不應全為 0 (舊 bug 徵兆)'
);

// 舊版格式 (無 weather 區塊)：填 null 而非 0，讓校準能明確跳過
const lockedLegacy = {
  date: '2026-08-30',
  session: 'sunrise',
  lockedAt: '2026-08-29T17:40:00.000Z',
  skyfire: {
    score: 51,
    rating: { badge: '局部霞光', color: '#E5A50A' },
    metrics: { horizonClearance: 91, visKm: 18.6 }
  }
};

const legacyPred = buildPredictionFromLock(lockedLegacy);
assert.strictEqual(legacyPred.highCloud, null, '缺 weather 時 highCloud 應為 null，不是 0');
assert.strictEqual(legacyPred.midCloud, null);
assert.strictEqual(legacyPred.lowCloud, null);
assert.strictEqual(legacyPred.visibilityKm, 18.6, '缺 weather.visibilityKm 時回退 metrics.visKm');
assert.strictEqual(legacyPred.horizonClearance, 91);

console.log('✅ 測試 9 通過：雲量三頻正確取自結構化 weather 區塊\n');
