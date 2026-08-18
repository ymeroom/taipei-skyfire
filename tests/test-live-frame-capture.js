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

console.log('🎉 真實直播影格擷取邊界測試全數 PASS!\n');
