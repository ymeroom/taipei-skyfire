/**
 * test-beauty-model.js - 天空美感分模型擬合與預報
 */

const assert = require('assert');
const { predictBeauty, fitStation } = require('../js/beauty-model.js');
const { fitBeautyModel, engineInputX } = require('../scripts/fit-beauty-model.js');
const SkyFireEngine = require('../js/skyfire-engine.js');

console.log('--- 🧪 測試: 天空美感分模型 ---');

const exact = fitStation([{ x: 10, y: 30 }, { x: 20, y: 50 }, { x: 30, y: 70 }]);
assert.strictEqual(exact.slope, 2);
assert.strictEqual(exact.intercept, 10);
assert.strictEqual(exact.mae, 0);
assert.strictEqual(fitStation([{ x: 1, y: 1 }, { x: 2, y: 2 }]), null, '樣本不足不擬合');

const flat = fitStation([{ x: 50, y: 80 }, { x: 50, y: 90 }, { x: 50, y: 100 }]);
assert.strictEqual(flat.slope, 0, 'x 全相同時退化成站點平均');
assert.strictEqual(flat.intercept, 90);

const model = { stations: { tamsui: { slope: 2, intercept: 10, n: 5 }, thin: { slope: 1, intercept: 0, n: 2 } } };
assert.strictEqual(predictBeauty(model, 'tamsui', 20), 50);
assert.strictEqual(predictBeauty(model, 'tamsui', 60), 100, '上限 100');
assert.strictEqual(predictBeauty(model, 'nowhere', 20), null, '沒有參數就不預報，不拿別站頂替');
assert.strictEqual(predictBeauty(model, 'thin', 20), null, '樣本不足的站不預報');
assert.strictEqual(predictBeauty(model, 'tamsui', null), null);
assert.strictEqual(predictBeauty(undefined, 'tamsui', 20), null);

// 舊紀錄沒存 clearSkyUncappedScore：用存下的氣象輸入重跑引擎
const pred = { score: 35, highCloud: 0, midCloud: 0, lowCloud: 2, totalCloud: 2, humidity: 72,
  precipProb: 0, horizonClearance: 97, visibilityKm: 25.1 };
const replay = SkyFireEngine.calculate({ highCloud: 0, midCloud: 0, lowCloud: 2, totalCloud: 2, humidity: 72,
  precipProb: 0, horizonClearance: 97, visibility: 25.1, type: 'sunset' });
assert(replay.metrics.clearSkyUncappedScore > 35, '美感模型的輸入不受火燒雲無雲上限影響');
assert.strictEqual(engineInputX(pred, 'sunset'), replay.metrics.clearSkyUncappedScore);
assert.strictEqual(engineInputX({ ...pred, clearSkyUncappedScore: 44 }, 'sunset'), 44, '有存就直接用');
assert.strictEqual(engineInputX({ score: 5 }, 'sunset'), null, '缺雲量輸入不猜');

const rec = (station, peak, extra = {}) => ({
  station, session: 'sunset', capture: { kind: 'timelapse-multi-frame' },
  prediction: { ...pred, clearSkyUncappedScore: 40 + peak / 10 }, verification: { peakScore: peak }, ...extra
});
const fitted = fitBeautyModel([
  rec('tamsui', 90), rec('tamsui', 95), rec('tamsui', 100),
  rec('tamsui', 50, { capture: { kind: 'youtube-live-frame' } }),
  rec('bali', 80), rec('bali', 85),
], 'fixed');
assert.deepStrictEqual(Object.keys(fitted.stations), ['tamsui'], '只用縮時紀錄；樣本不足的站不輸出');
assert.strictEqual(fitted.stations.tamsui.n, 3);
assert.strictEqual(fitted.fittedAt, 'fixed');

console.log('✅ 天空美感分模型擬合／預報／缺值處理正確\n');
