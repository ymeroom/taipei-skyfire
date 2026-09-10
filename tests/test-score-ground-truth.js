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
