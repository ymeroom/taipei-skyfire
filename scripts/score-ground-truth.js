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
  validateOpticalResult
} = require('./live-capture-core.js');

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

function runGroundTruthScoring(targetDateStr = '', inputSession = '', options = {}) {
  const dataDir = path.join(__dirname, '../data');
  const recordsFile = path.join(dataDir, 'verification-records.json');
  const dateStr = targetDateStr || getTaipeiDateString(options.now || new Date());
  const sessionType = resolveSessionType(
    inputSession,
    options.schedule || process.env.GITHUB_EVENT_SCHEDULE || ''
  );
  const targetId = `rec-${dateStr}-${sessionType}`;

  if (!fs.existsSync(recordsFile)) {
    throw new Error('verification-records.json does not exist');
  }

  const records = JSON.parse(fs.readFileSync(recordsFile, 'utf8'));
  const record = records.find(item => item.id === targetId);
  if (!record) {
    throw new Error(`exact capture record not found: ${targetId}`);
  }
  if (!isValidatedLiveCaptureRecord(record)) {
    throw new Error(`record is not a validated livestream frame: ${targetId}`);
  }

  const snapshotPath = path.resolve(path.join(__dirname, '..'), record.snapshotUrl);
  const snapshotsRoot = path.resolve(path.join(dataDir, 'snapshots'));
  if (!snapshotPath.startsWith(`${snapshotsRoot}${path.sep}`)) {
    throw new Error('snapshot path escapes the validated snapshots directory');
  }
  assertSnapshotIntegrity(snapshotPath, record.capture.sha256);

  console.log('====================================================');
  console.log('🔬 Phase 2: 實況天空光學色彩分析');
  console.log(`📸 影像: ${record.snapshotUrl}`);
  console.log(`🔗 來源: ${record.youtubeLiveUrl}`);

  // targetTime (非 capture.capturedAt) 才是影格畫面實際所屬的天文時刻 ——
  // capturedAt 記的是腳本執行的當下，DVR 回溯量大時兩者可能差到數小時。
  // 用 targetTime 餵暗夜閘門，暮光窗口外的暖色像素 (路燈/船燈/燈籠) 一律強制低分。
  const analyzer = options.runAnalyzer || runPythonAnalyzer;
  const opticalResult = validateOpticalResult(analyzer(
    path.join(__dirname, 'analyze_sky_ground_truth.py'),
    snapshotPath,
    record.targetTime
  ));

  const predictedScore = record.prediction.score;
  const groundTruthScore = opticalResult.score;
  const errorAbsolute = Math.abs(predictedScore - groundTruthScore);
  let verdict = 'MISMATCH';
  let verdictBadge = '⚠️ 出現偏差需校準';
  if (errorAbsolute <= 8) {
    verdict = 'EXACT_MATCH';
    verdictBadge = '🎯 極致精準 (誤差 ≤ 8分)';
  } else if (errorAbsolute <= 18) {
    verdict = 'SLIGHT_DEVIATION';
    verdictBadge = '⚡ 輕微偏差 (誤差 ≤ 18分)';
  }

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

  fs.writeFileSync(recordsFile, JSON.stringify(records, null, 2), 'utf8');
  console.log(`✅ 實況觀測 ${groundTruthScore} 分；與預測絕對誤差 ${errorAbsolute} 分`);
  console.log('====================================================\n');
  return record;
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
