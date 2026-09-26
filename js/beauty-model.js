/**
 * beauty-model.js — 天空美感分預報。
 *
 * 火燒雲分 (skyfire-engine 的 score) 只問「有沒有雲被染紅」，晴空一律封頂 35。
 * 天空美感分預報的是攝影機實測的暖色峰值 (verification.peakScore)：晴天的橘色
 * 暮光本身就能拿高分，而且高低幾乎由機位構圖決定 (淡水/八里/貓空晴天峰值
 * 穩定 85-95，象山因畫面大半是 101 只有 ~35)。所以每站各擬合一條
 *   beauty = intercept + slope × clearSkyUncappedScore
 * 參數由 scripts/fit-beauty-model.js 從驗證紀錄擬合，存於
 * data/model-calibration-params.json 的 beautyModel。
 */

const MIN_SAMPLES = 3;

function predictBeauty(beautyModel, stationId, clearSkyUncappedScore) {
  const p = beautyModel?.stations?.[stationId];
  if (!p || typeof clearSkyUncappedScore !== 'number' || (p.n ?? 0) < MIN_SAMPLES) return null;
  const raw = p.intercept + p.slope * clearSkyUncappedScore;
  return Math.max(5, Math.min(100, Math.round(raw)));
}

function fitStation(points) {
  const n = points.length;
  if (n < MIN_SAMPLES) return null;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  const sxx = points.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  const sxy = points.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0);
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const mae = points.reduce((a, p) => a + Math.abs(intercept + slope * p.x - p.y), 0) / n;
  const r = (v) => Math.round(v * 1000) / 1000;
  return { slope: r(slope), intercept: r(intercept), n, mae: r(mae) };
}

const BeautyModel = { predictBeauty, fitStation, MIN_SAMPLES };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BeautyModel;
}
if (typeof window !== 'undefined') {
  window.BeautyModel = BeautyModel;
}
