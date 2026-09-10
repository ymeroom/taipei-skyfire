/**
 * test-score-ground-truth.js - Phase 2 光學評分的暮光窗口守門
 *
 * 迴歸重點：DVR seek 沒落地的 live-edge 影格 (畫面所屬時刻 ≈ 擷取當下、
 * 可能是大白天) 絕不能進光學評分冒充 ground truth。必須標成
 * skipped_out_of_window、groundTruthScore 留 null，且不呼叫 Python 分析器。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGroundTruthScoring } = require('../scripts/score-ground-truth.js');

console.log('--- 🧪 測試: 光學評分暮光窗口守門 ---');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyfire-sgt-'));
const dataDir = path.join(dir, 'data');
fs.mkdirSync(path.join(dataDir, 'snapshots'), { recursive: true });

// live-edge 影格：畫面時刻是台北清晨 10:24 (日落前 8 小時) —— 必須跳過
const records = [{
  id: 'rec-2026-09-10-sunset',
  date: '2026-09-10',
  session: 'sunset',
  targetTime: '2026-09-10T10:07:00.000Z',
  source: '大稻埕碼頭（4K 官方即時影像）',
  prediction: { score: 44 },
  snapshotUrl: 'data/snapshots/2026-09-10-sunset.jpg',
  capture: {
    kind: 'youtube-live-frame',
    validated: true,
    fidelity: 'live-edge',
    frameEffectiveTimeUtc: '2026-09-10T02:24:00.000Z',
    sha256: 'a'.repeat(64)
  },
  verification: { status: 'captured_ready_for_scoring', groundTruthScore: null }
}];
fs.writeFileSync(path.join(dataDir, 'verification-records.json'), JSON.stringify(records, null, 2), 'utf8');

let analyzerCalled = false;
runGroundTruthScoring('2026-09-10', 'sunset', {
  dataDir,
  runAnalyzer: () => { analyzerCalled = true; return { score: 14, badge: 'x', level: 'OVERCAST' }; }
});

const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'verification-records.json'), 'utf8'))[0];
assert.strictEqual(analyzerCalled, false, 'live-edge 影格不得呼叫 Python 分析器');
assert.strictEqual(after.verification.status, 'skipped_out_of_window');
assert.strictEqual(after.verification.groundTruthScore, null, '不得捏造 ground truth');
assert.ok(after.verification.reason, '應留下跳過原因');

fs.rmSync(dir, { recursive: true, force: true });
console.log('✅ 暮光窗口外的影格被跳過、未捏造 ground truth');

// ----------------------------------------------------------------
// 每站評分迴圈：in-window exact 評分、live-edge 跳過、capture_unavailable 不動
// ----------------------------------------------------------------
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'skyfire-sgt2-'));
const dataDir2 = path.join(dir2, 'data');
const snapDir2 = path.join(dataDir2, 'snapshots', '2026-09-10', 'sunset');
fs.mkdirSync(snapDir2, { recursive: true });

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(12000, 0x42), Buffer.from([0xff, 0xd9])]);
const crypto = require('crypto');
function mkRec(station, fidelity, effIso) {
  const rel = `data/snapshots/2026-09-10/sunset/${station}.jpg`;
  fs.writeFileSync(path.join(dir2, rel), jpeg);
  return {
    id: `rec-2026-09-10-sunset-${station}`, date: '2026-09-10', session: 'sunset', station,
    targetTime: '2026-09-10T10:07:00.000Z', source: station,
    prediction: { score: 40 },
    snapshotUrl: rel,
    capture: {
      kind: 'youtube-live-frame', validated: true, fidelity,
      frameEffectiveTimeUtc: effIso,
      sha256: crypto.createHash('sha256').update(jpeg).digest('hex')
    },
    verification: { status: 'captured_ready_for_scoring', groundTruthScore: null }
  };
}
const recs2 = [
  mkRec('dadaocheng', 'exact', '2026-09-10T10:07:00.000Z'),      // in window → 評分
  mkRec('tamsui', 'live-edge', '2026-09-10T02:24:00.000Z'),       // live-edge → 跳過
  { id: 'rec-2026-09-10-sunset-jiufen', date: '2026-09-10', session: 'sunset', station: 'jiufen',
    targetTime: '2026-09-10T10:07:00.000Z', snapshotUrl: null, capture: { fidelity: 'none' },
    verification: { status: 'capture_unavailable', groundTruthScore: null } },
];
fs.writeFileSync(path.join(dataDir2, 'verification-records.json'), JSON.stringify(recs2, null, 2), 'utf8');

let analyzerCalls = 0;
runGroundTruthScoring('2026-09-10', 'sunset', {
  dataDir: dataDir2,
  runAnalyzer: () => { analyzerCalls += 1; return { score: 15, badge: '陰沉沉寂', level: 'OVERCAST', chromatic_purity: 30, sky_coverage_pct: 0 }; }
});

const out2 = JSON.parse(fs.readFileSync(path.join(dataDir2, 'verification-records.json'), 'utf8'));
const by = id => out2.find(r => r.id === id);
assert.strictEqual(analyzerCalls, 1, '只有 in-window 影格呼叫分析器一次');
assert.strictEqual(by('rec-2026-09-10-sunset-dadaocheng').verification.status, 'verified_completed');
assert.strictEqual(by('rec-2026-09-10-sunset-dadaocheng').verification.errorAbsolute, 25, '|40 - 15|');
assert.strictEqual(by('rec-2026-09-10-sunset-tamsui').verification.status, 'skipped_out_of_window');
assert.strictEqual(by('rec-2026-09-10-sunset-jiufen').verification.status, 'capture_unavailable', 'capture_unavailable 不動');

fs.rmSync(dir2, { recursive: true, force: true });
console.log('✅ 每站評分迴圈：in-window 評分 / live-edge 跳過 / capture_unavailable 不動');
