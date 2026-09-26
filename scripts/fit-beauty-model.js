/**
 * fit-beauty-model.js — 從 data/verification-records.json 擬合每站的天空美感分模型，
 * 寫入 data/model-calibration-params.json 的 beautyModel (其餘欄位原樣保留)。
 *
 * 輸入 x = 鎖定當下的 clearSkyUncappedScore。舊紀錄沒存這個欄位，就用鎖定時
 * 存下的同一組氣象輸入重跑引擎取得 (與鎖定分數逐筆比對過，重跑結果一致)。
 * 目標 y = 攝影機實測的暖色峰值 verification.peakScore。
 *
 * 用法: node scripts/fit-beauty-model.js [records.json] [params.json]
 */

const fs = require('fs');
const path = require('path');
const SkyFireEngine = require('../js/skyfire-engine.js');
const { fitStation } = require('../js/beauty-model.js');

function engineInputX(prediction, session) {
  if (typeof prediction.clearSkyUncappedScore === 'number') return prediction.clearSkyUncappedScore;
  const { highCloud, midCloud, lowCloud } = prediction;
  if ([highCloud, midCloud, lowCloud].some(v => typeof v !== 'number')) return null;
  return SkyFireEngine.calculate({
    highCloud, midCloud, lowCloud,
    totalCloud: prediction.totalCloud,
    humidity: prediction.humidity,
    precipProb: prediction.precipProb,
    horizonClearance: prediction.horizonClearance,
    visibility: prediction.visibilityKm,
    type: session,
  }).metrics.clearSkyUncappedScore;
}

function collectPoints(records) {
  const byStation = {};
  for (const r of records) {
    if (r.capture?.kind !== 'timelapse-multi-frame') continue;
    const y = r.verification?.peakScore;
    if (typeof y !== 'number' || !r.prediction || !r.station) continue;
    const x = engineInputX(r.prediction, r.session);
    if (x === null) continue;
    (byStation[r.station] ??= []).push({ x, y });
  }
  return byStation;
}

function fitBeautyModel(records, fittedAt = new Date().toISOString()) {
  const stations = {};
  for (const [id, points] of Object.entries(collectPoints(records))) {
    const fit = fitStation(points);
    if (fit) stations[id] = fit;
  }
  return { input: 'clearSkyUncappedScore', target: 'verification.peakScore', fittedAt, stations };
}

function run(recordsPath, paramsPath) {
  const records = JSON.parse(fs.readFileSync(recordsPath, 'utf8'));
  const params = fs.existsSync(paramsPath) ? JSON.parse(fs.readFileSync(paramsPath, 'utf8')) : {};
  params.beautyModel = fitBeautyModel(records);
  fs.writeFileSync(paramsPath, JSON.stringify(params, null, 2) + '\n', 'utf8');
  for (const [id, p] of Object.entries(params.beautyModel.stations)) {
    console.log(`[Beauty Model] ${id}: y = ${p.intercept} + ${p.slope}x  (n=${p.n}, MAE ${p.mae})`);
  }
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  run(process.argv[2] || path.join(root, 'data/verification-records.json'),
      process.argv[3] || path.join(root, 'data/model-calibration-params.json'));
}

module.exports = { fitBeautyModel, engineInputX };
