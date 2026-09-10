/**
 * test-capture-validation.js - 鎖定預測 → 驗證紀錄的欄位擷取邊界
 *
 * 迴歸重點：舊版讀 lockedData.skyfire.diagnostics?.highCloud (diagnostics 是
 * 陣列，永遠 undefined→0)，使每筆鎖定路徑紀錄雲量全 0、auto-calibrate 對噪音調參。
 */

const assert = require('assert');
const { buildPredictionFromLock, buildPredictionFromStationLock } = require('../scripts/capture-validation.js');

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

// --- buildPredictionFromStationLock：每站鎖定區塊 → 預測欄位 ---
const stationLocked = {
  lockedAt: '2026-09-10T07:30:00.000Z',
  stations: {
    tamsui: {
      score: 51, rating: '局部霞光', color: '#E5A50A',
      weather: { cloudHigh: 2, cloudMid: 40, cloudLow: 8, cloudTotal: 45, humidity: 78, precipProb: 10, visibilityKm: 22 },
      metrics: { horizonClearance: 71, visKm: 22 }
    }
  }
};
const sp = buildPredictionFromStationLock(stationLocked, 'tamsui');
assert.strictEqual(sp.score, 51);
assert.strictEqual(sp.rating, '局部霞光');
assert.strictEqual(sp.lowCloud, 8);
assert.strictEqual(sp.midCloud, 40);
assert.strictEqual(sp.humidity, 78);
assert.strictEqual(sp.horizonClearance, 71);
assert.strictEqual(sp.visibilityKm, 22);
assert.strictEqual(sp.isSimulated, false);
assert.strictEqual(sp.lockedAt, '2026-09-10T07:30:00.000Z');
assert.strictEqual(buildPredictionFromStationLock(stationLocked, 'nope'), null, '站不存在 → null');
assert.strictEqual(buildPredictionFromStationLock({}, 'tamsui'), null, '無 stations map → null');
console.log('✅ buildPredictionFromStationLock 正確讀取每站鎖定區塊\n');

// ----------------------------------------------------------------
// live-edge 誠實標記
//
// DVR seek 沒落地 (dvrSeekApplied:false) 且回溯量 > 15 分時，該影格是直播
// 邊緣影像、不是出景當刻，必須記成 fidelity:'live-edge' 並把
// frameEffectiveTimeUtc 標成擷取當下 (capturedAt)，不得冒充 targetTime 的
// exact 影格 —— 否則 score-ground-truth 會拿白天畫面當 ground truth，
// 又是一次「假資料汙染校準」。
// ----------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const SolarCalc = require('../js/solar-calc.js');
const { runCapturePipeline } = require('../scripts/capture-validation.js');
const { isExactLiveFrameRecord } = require('../scripts/live-capture-core.js');

function makeLockedDir(session, score) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyfire-live-edge-'));
  fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  fs.writeFileSync(path.join(dir, `locked-${session}-forecast.json`), JSON.stringify({
    date: dateStr, session, lockedAt: now.toISOString(),
    skyfire: { score, rating: { badge: '局部霞光', color: '#E5A50A' },
      metrics: { horizonClearance: 60, visKm: 22 }, diagnostics: [] }
  }), 'utf8');
  return dir;
}

const goodJpeg = () => Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(12000, 0x42), Buffer.from([0xff, 0xd9])
]);
const ffprobeJson = JSON.stringify({ streams: [{ codec_name: 'mjpeg', width: 1920, height: 1080 }] });
const { STATIONS } = require('../js/stations.js');
const UID = Object.fromEntries(STATIONS.map(s => [s.videoId, s.uploaderId]));
const parseVid = args => (String(args).match(/v=([\w-]{11})/) || [])[1];

// 每站 Tier-A 影格；withFormats=true 才走 DVR seek 分支
function tierAStub({ withFormats, tsBytes }) {
  return (command, args) => {
    if (command === 'yt-dlp') {
      const vid = parseVid(args);
      const meta = {
        id: vid, is_live: true, live_status: 'is_live', uploader_id: UID[vid],
        protocol: 'm3u8_native', url: 'https://live.example/stream.m3u8',
        width: 1920, height: 1080, format_id: '95'
      };
      if (withFormats) meta.formats = [{ format_id: '95', url: 'https://hls.example/95.m3u8' }];
      return JSON.stringify(meta);
    }
    if (command === 'curl' && !args.includes('-o')) return 'https://seg.example/sq/100000/dur/5.0/segment.ts\n';
    if (command === 'curl' && args.includes('-o')) { fs.writeFileSync(args[args.indexOf('-o') + 1], Buffer.alloc(tsBytes, 0x11)); return ''; }
    if (command === 'ffmpeg') { fs.writeFileSync(args[args.length - 1], goodJpeg()); return ''; }
    if (command === 'ffprobe') return ffprobeJson;
    throw new Error(`unexpected tool: ${command}`);
  };
}

const sunsetEvent = SolarCalc.getTimes(new Date()).sunset;
const dirLiveEdge = makeLockedDir('sunset', 55);
const dirSeekOk = makeLockedDir('sunset', 55);
const findPrimary = records => records.find(r => r.station === 'dadaocheng');

module.exports = runCapturePipeline('sunset', {
  now: new Date(sunsetEvent.getTime() + 40 * 60000),   // 日落後 40 分：窗口內、回溯量 40 分 > 15
  dataDir: dirLiveEdge,
  runTool: tierAStub({ withFormats: false, tsBytes: 4 })   // 無 formats → seek 跳過
}).then(records => {
  assert.strictEqual(records.length, 6, '日落 6 站各一筆紀錄');
  const record = findPrimary(records);
  assert.strictEqual(record.capture.fidelity, 'live-edge', 'seek 沒落地 + 回溯 > 15 分 → live-edge');
  assert.strictEqual(record.capture.dvrRewindMinutes, 0, 'live-edge 不宣稱回溯');
  assert.strictEqual(record.capture.frameEffectiveTimeUtc, record.capture.capturedAt, 'live-edge 畫面時刻 = 擷取當下');
  assert.notStrictEqual(record.capture.frameEffectiveTimeUtc, record.targetTime, 'live-edge 不得冒充 targetTime');
  assert.strictEqual(isExactLiveFrameRecord(record), false, 'live-edge 不算 exact 影格');
  assert.strictEqual(record.id, 'rec-' + record.date + '-sunset-dadaocheng', '每站紀錄 id 帶 station 後綴');
  assert.strictEqual(record.station, 'dadaocheng');
  assert.ok(!records.some(r => r.id === 'rec-' + record.date + '-sunset'), '不寫 bare-id 別名');
  console.log('✅ 每站擷取迴圈 + live-edge 誠實標記正確');
  fs.rmSync(dirLiveEdge, { recursive: true, force: true });

  return runCapturePipeline('sunset', {
    now: new Date(sunsetEvent.getTime() + 40 * 60000),
    dataDir: dirSeekOk,
    runTool: tierAStub({ withFormats: true, tsBytes: 50000 })   // seek 成功
  });
}).then(records => {
  const record = findPrimary(records);
  assert.strictEqual(record.capture.fidelity, 'exact', 'seek 確實落地 → 維持 exact');
  assert.strictEqual(record.capture.frameEffectiveTimeUtc, record.targetTime, 'exact 影格畫面時刻 = targetTime');
  assert.strictEqual(isExactLiveFrameRecord(record), true);
  console.log('✅ 確認 DVR seek 落地時維持 exact');
  fs.rmSync(dirSeekOk, { recursive: true, force: true });
}).catch(err => {
  console.error('❌ 每站擷取 / live-edge 標記測試未通過:', err.message);
  process.exit(1);
});
