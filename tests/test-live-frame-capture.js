/**
 * test-live-frame-capture.js - External-tool capture boundary integration test
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OFFICIAL_STREAMS } = require('../scripts/live-capture-core.js');
const { captureLiveFrame } = require('../scripts/live-frame-capture.js');

console.log('--- 🧪 測試 7: yt-dlp / ffmpeg 真實直播影格擷取邊界 ---');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyfire-live-frame-test-'));
const outputPath = path.join(tempDir, 'capture.jpg');
const source = OFFICIAL_STREAMS.sunset;
const calls = [];

function fakeTool(command, args) {
  calls.push({ command, args });
  if (command === 'yt-dlp') {
    return JSON.stringify({
      id: source.videoId,
      is_live: true,
      live_status: 'is_live',
      uploader_id: source.uploaderId,
      protocol: 'm3u8_native',
      url: 'https://manifest.googlevideo.com/api/manifest/hls_playlist/live.m3u8',
      width: 1920,
      height: 1080,
      format_id: '95'
    });
  }
  if (command === 'ffmpeg') {
    const target = args[args.length - 1];
    fs.writeFileSync(target, Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.alloc(12000, 0x42),
      Buffer.from([0xff, 0xd9])
    ]));
    return '';
  }
  if (command === 'ffprobe') {
    return JSON.stringify({ streams: [{ codec_name: 'mjpeg', width: 1920, height: 1080 }] });
  }
  throw new Error(`unexpected tool: ${command}`);
}

try {
  const evidence = captureLiveFrame({
    source,
    outputPath,
    runTool: fakeTool,
    capturedAt: new Date('2026-08-18T10:45:00.000Z'),
    windowEvidence: {
      eventTime: '2026-08-18T10:27:00.000Z',
      offsetMinutes: 18,
      maxOffsetMinutes: 30
    }
  });

  assert.strictEqual(fs.existsSync(outputPath), true);
  assert.strictEqual(evidence.validated, true);
  assert.strictEqual(evidence.width, 1920);
  assert.strictEqual(evidence.height, 1080);
  assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
  assert.deepStrictEqual(calls.map(call => call.command), ['yt-dlp', 'ffmpeg', 'ffprobe']);
  assert.strictEqual(calls.some(call => call.args.some(arg => /ytimg\.com/.test(arg))), false);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// ----------------------------------------------------------------
// Tier B: 直播海報影格 (i.ytimg.com)
// YouTube 對資料中心 IP 做 bot check，yt-dlp 在 GitHub Actions 上必然失敗；
// 但 i.ytimg.com 是靜態 CDN，不經過該檢查。此為降級但真實的證據來源，
// 必須以不同的 kind 與 fidelity 標示，不可與精確影格混為一談。
// ----------------------------------------------------------------
const { capturePosterFrame, readJpegDimensions } = require('../scripts/live-frame-capture.js');

function buildJpeg(width, height, padding = 20000) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),                    // SOI
    Buffer.from([0xff, 0xe0, 0x00, 0x04, 0, 0]),  // APP0 (長度 4)
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),  // SOF0
    Buffer.from([(height >> 8) & 0xff, height & 0xff]),
    Buffer.from([(width >> 8) & 0xff, width & 0xff]),
    Buffer.alloc(10, 0),                          // SOF0 剩餘欄位
    Buffer.alloc(padding, 0x42),
    Buffer.from([0xff, 0xd9])                     // EOI
  ]);
}

assert.deepStrictEqual(
  readJpegDimensions(buildJpeg(1280, 720)),
  { width: 1280, height: 720 },
  'readJpegDimensions 應由 SOF0 標記讀出尺寸，不需外部工具'
);

const posterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyfire-poster-test-'));
try {
  const fetched = [];
  const posterEvidence = capturePosterFrame({
    source,
    outputPath: path.join(posterDir, 'poster.jpg'),
    capturedAt: new Date('2026-08-18T10:45:00.000Z'),
    windowEvidence: {
      eventTime: '2026-08-18T10:27:00.000Z',
      offsetMinutes: 18,
      maxOffsetMinutes: 600
    },
    fetchImage: (url) => {
      fetched.push(url);
      return buildJpeg(1280, 720);
    }
  });

  assert.strictEqual(posterEvidence.kind, 'youtube-live-poster', '海報影格必須以獨立 kind 標示');
  assert.strictEqual(posterEvidence.fidelity, 'degraded', '海報影格必須標示為降級證據');
  assert.strictEqual(posterEvidence.width, 1280);
  assert.strictEqual(posterEvidence.height, 720);
  assert.match(posterEvidence.sha256, /^[a-f0-9]{64}$/);
  assert.strictEqual(posterEvidence.videoId, source.videoId);
  assert(/i\.ytimg\.com/.test(fetched[0]), '應向 i.ytimg.com 靜態 CDN 取圖');
  assert(fetched[0].includes(source.videoId), '取圖網址須包含設定的直播 videoId');

  // 尺寸過小的佔位圖 (YouTube 無縮圖時回傳的灰底圖) 必須拒絕
  assert.throws(
    () => capturePosterFrame({
      source,
      outputPath: path.join(posterDir, 'tiny.jpg'),
      capturedAt: new Date('2026-08-18T10:45:00.000Z'),
      windowEvidence: { eventTime: '2026-08-18T10:27:00.000Z', offsetMinutes: 18, maxOffsetMinutes: 600 },
      fetchImage: () => buildJpeg(120, 90, 200)
    }),
    /too small|resolution/i,
    '應拒絕 YouTube 的低解析度佔位縮圖'
  );

  console.log('✅ 降級海報影格擷取與證據標示正確');
} finally {
  fs.rmSync(posterDir, { recursive: true, force: true });
}

// ----------------------------------------------------------------
// 管線降級：yt-dlp 被 bot check 擋下時，必須降級到海報影格，
// 並且絕不可讓整條管線失敗 —— 否則後續的光學評分與每日日報全被連坐跳過。
// 這正是 2026-08-18 起排程連續 33 次全紅的原因。
// ----------------------------------------------------------------
const SolarCalcForTest = require('../js/solar-calc.js');
const { runCapturePipeline } = require('../scripts/capture-validation.js');

function makePipelineDir(session, score) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyfire-pipeline-test-'));
  fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  fs.writeFileSync(path.join(dir, `locked-${session}-forecast.json`), JSON.stringify({
    date: dateStr,
    session,
    lockedAt: now.toISOString(),
    skyfire: {
      score,
      rating: { badge: '局部霞光', color: '#E5A50A' },
      metrics: { horizonClearance: 60, visKm: 22 },
      diagnostics: []
    }
  }), 'utf8');
  return dir;
}

const botCheckError = () => {
  throw new Error("ERROR: [youtube] Sign in to confirm you're not a bot.");
};
const sunsetEvent = SolarCalcForTest.getTimes(new Date()).sunset;
const insideWindow = new Date(sunsetEvent.getTime() + 5 * 60000);

const degradedDir = makePipelineDir('sunset', 55);
const unavailableDir = makePipelineDir('sunset', 55);

module.exports = runCapturePipeline('sunset', {
  now: insideWindow,
  dataDir: degradedDir,
  runTool: botCheckError,
  fetchImage: () => buildJpeg(1280, 720)
}).then(record => {
  assert.strictEqual(record.capture.kind, 'youtube-live-poster', 'yt-dlp 失敗後應降級為海報影格');
  assert.strictEqual(record.capture.fidelity, 'degraded', '降級證據必須明確標示');
  assert.match(record.capture.fallbackReason, /bot/i, '必須記錄降級原因');
  assert.strictEqual(record.verification.status, 'captured_ready_for_scoring');
  assert.strictEqual(record.prediction.score, 55, '應沿用提前鎖定的預測分數');
  console.log('✅ yt-dlp 遭 bot check 時正確降級為海報影格');

  // 兩層都失敗：誠實記錄不可用，但不得拋出（否則後續步驟全被跳過）
  return runCapturePipeline('sunset', {
    now: insideWindow,
    dataDir: unavailableDir,
    runTool: botCheckError,
    fetchImage: () => { throw new Error('cdn unreachable'); }
  });
}).then(record => {
  assert.strictEqual(record.verification.status, 'capture_unavailable', '應誠實記錄擷取不可用');
  assert.strictEqual(record.snapshotUrl, null, '無影像時不得指向任何快照檔');
  assert.strictEqual(record.verification.groundTruthScore, null, '不得捏造 ground truth');
  assert.match(record.capture.error, /bot|cdn/i, '應保留兩層失敗的原因');
  console.log('✅ 兩層擷取皆失敗時誠實記錄且不中斷管線');

  fs.rmSync(degradedDir, { recursive: true, force: true });
  fs.rmSync(unavailableDir, { recursive: true, force: true });
  console.log('🎉 真實直播影格擷取邊界測試全數 PASS!\n');
}).catch(err => {
  console.error('❌ 擷取降級測試未通過:', err.message);
  process.exit(1);
});

