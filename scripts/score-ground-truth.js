/**
 * Phase 2: score only a provenance-validated real livestream frame.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  getTaipeiDateString,
  resolveSessionType,
  isValidatedLiveCaptureRecord,
  validateOpticalResult,
  LIVE_EDGE_FIDELITY
} = require('./live-capture-core.js');
const SolarCalc = require('../js/solar-calc.js');

// 影格畫面所屬時刻是否落在 targetTime 當天的民用曙暮光窗口內。
// 與 analyze_sky_ground_truth.py 的 get_twilight_window 同定義：
//   sunrise → [civilDawn, sunriseGoldenEnd]；sunset → [sunsetGoldenStart, civilDusk]
function twilightWindow(targetIso, session) {
  const dateStr = getTaipeiDateString(new Date(targetIso));
  const t = SolarCalc.getTimes(new Date(`${dateStr}T12:00:00+08:00`));
  return session === 'sunrise'
    ? [new Date(t.civilDawn), new Date(t.sunriseGoldenEnd)]
    : [new Date(t.sunsetGoldenStart), new Date(t.civilDusk)];
}

// live-edge 影格 (DVR seek 沒落地) 一律排除；其餘用 frameEffectiveTimeUtc 對窗口。
// 沒有 frameEffectiveTimeUtc 的舊紀錄維持原行為 (視為在窗口內)。
function frameIsInWindow(record) {
  const cap = record.capture || {};
  if (cap.fidelity === LIVE_EDGE_FIDELITY) return false;
  if (!cap.frameEffectiveTimeUtc) return true;
  const [start, end] = twilightWindow(record.targetTime, record.session);
  const t = new Date(cap.frameEffectiveTimeUtc).getTime();
  return t >= start.getTime() && t <= end.getTime();
}

function runPythonAnalyzer(scriptPath, snapshotPath, capturedAtIso) {
  const pythonBin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  const args = capturedAtIso ? [scriptPath, snapshotPath, capturedAtIso] : [scriptPath, snapshotPath];
  const result = spawnSync(pythonBin, args, {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `analyzer exited with ${result.status}`).trim());
  }
  return validateOpticalResult(JSON.parse(result.stdout));
}

function assertSnapshotIntegrity(snapshotPath, expectedSha256) {
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`validated snapshot is missing: ${snapshotPath}`);
  }
  const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(snapshotPath)).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error('snapshot SHA-256 does not match capture provenance');
  }
}

function verdictForError(errorAbsolute) {
  if (errorAbsolute <= 8) return { verdict: 'EXACT_MATCH', verdictBadge: '🎯 極致精準 (誤差 ≤ 8分)' };
  if (errorAbsolute <= 18) return { verdict: 'SLIGHT_DEVIATION', verdictBadge: '⚡ 輕微偏差 (誤差 ≤ 18分)' };
  return { verdict: 'MISMATCH', verdictBadge: '⚠️ 出現偏差需校準' };
}

// 對單筆已擷取影格：暮光窗口守門 → 光學評分 → 誤差判定，回寫該筆 verification。
function scoreOneRecord(record, ctx) {
  const { dataDir, analyzer } = ctx;

  // 暮光窗口守門：live-edge 影格、或畫面時刻落在 targetTime 曙暮光窗口外者，
  // 不是出景當刻的實況證據 —— 標記跳過、不評分、不捏造 ground truth，也不讓 job 失敗。
  if (!frameIsInWindow(record)) {
    const reason = (record.capture || {}).fidelity === LIVE_EDGE_FIDELITY
      ? 'live-edge 影格不代表出景當刻，畫面時刻約為擷取當下'
      : 'frameEffectiveTimeUtc 落在 targetTime 的民用曙暮光窗口之外';
    record.verification = {
      status: 'skipped_out_of_window',
      groundTruthScore: null,
      errorAbsolute: null,
      reason,
      verifiedAt: new Date().toISOString(),
      isSimulated: false
    };
    console.log(`⏭️  ${record.id}: ${reason} —— 跳過光學評分`);
    return;
  }

  const snapshotPath = path.resolve(dataDir, '..', record.snapshotUrl);
  const snapshotsRoot = path.resolve(path.join(dataDir, 'snapshots'));
  if (!snapshotPath.startsWith(`${snapshotsRoot}${path.sep}`)) {
    throw new Error('snapshot path escapes the validated snapshots directory');
  }
  assertSnapshotIntegrity(snapshotPath, record.capture.sha256);

  const opticalResult = validateOpticalResult(analyzer(
    path.join(__dirname, 'analyze_sky_ground_truth.py'),
    snapshotPath,
    record.targetTime
  ));

  const groundTruthScore = opticalResult.score;
  const errorAbsolute = Math.abs(record.prediction.score - groundTruthScore);
  const { verdict, verdictBadge } = verdictForError(errorAbsolute);

  record.verification = {
    captureFidelity: record.capture.fidelity || 'exact',
    captureKind: record.capture.kind,
    status: 'verified_completed',
    groundTruthScore,
    groundTruthBadge: opticalResult.badge,
    groundTruthLevel: opticalResult.level,
    errorAbsolute,
    verdict,
    verdictBadge,
    chromaticPurity: opticalResult.chromatic_purity,
    skyCoveragePct: opticalResult.sky_coverage_pct,
    nightGate: opticalResult.nightGate || null,
    rainGate: opticalResult.rainGate || null,
    verifiedAt: new Date().toISOString(),
    engine: 'Optical Chromatic Histogram Analysis (CIELAB/HSV)',
    isSimulated: false
  };
  console.log(`  ${record.id}: 實測 ${groundTruthScore} / 誤差 ${errorAbsolute} (${verdict})`);
}

function runGroundTruthScoring(targetDateStr = '', inputSession = '', options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, '../data');
  const recordsFile = path.join(dataDir, 'verification-records.json');
  const dateStr = targetDateStr || getTaipeiDateString(options.now || new Date());
  const sessionType = resolveSessionType(
    inputSession,
    options.schedule || process.env.GITHUB_EVENT_SCHEDULE || ''
  );
  const prefix = `rec-${dateStr}-${sessionType}`;

  if (!fs.existsSync(recordsFile)) {
    throw new Error('verification-records.json does not exist');
  }

  const records = JSON.parse(fs.readFileSync(recordsFile, 'utf8'));
  // 該日該時段全部測站 (帶或不帶 station 後綴)；只評分具備真實影像證據者。
  const targets = records.filter(r =>
    (r.id === prefix || r.id.startsWith(`${prefix}-`)) && isValidatedLiveCaptureRecord(r)
  );
  if (targets.length === 0) {
    console.warn(`無可評分的已擷取影格: ${prefix}*`);
    return [];
  }

  console.log('====================================================');
  console.log(`🔬 Phase 2: 實況天空光學色彩分析 (${targets.length} 筆)`);

  const ctx = { dataDir, analyzer: options.runAnalyzer || runPythonAnalyzer };
  for (const record of targets) {
    scoreOneRecord(record, ctx);
  }

  fs.writeFileSync(recordsFile, JSON.stringify(records, null, 2), 'utf8');
  console.log('====================================================\n');
  return targets;
}

if (require.main === module) {
  try {
    runGroundTruthScoring('', process.argv[2] || '');
  } catch (error) {
    console.error(`❌ 實況光學評分失敗，未產生模擬驗證值: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  runPythonAnalyzer,
  assertSnapshotIntegrity,
  runGroundTruthScoring
};
