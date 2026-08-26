/**
 * Capture one current frame from a validated YouTube livestream.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  validateLiveMetadata,
  finalizeCaptureEvidence
} = require('./live-capture-core.js');

function runExternalTool(command, args) {
  let finalCmd = command;
  let finalArgs = args;

  if (command === 'yt-dlp') {
    // Check if yt-dlp is available or fallback to python -m yt_dlp
    const testDirect = spawnSync('yt-dlp', ['--version'], { windowsHide: true });
    if (testDirect.error || testDirect.status !== 0) {
      finalCmd = 'python';
      finalArgs = ['-m', 'yt_dlp', ...args];
    }
  }

  const result = spawnSync(finalCmd, finalArgs, {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${finalCmd} exited with ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '');
}

function assertJpegFile(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size < 10000) {
    throw new Error(`captured JPEG is too small: ${stat.size} bytes`);
  }

  const buffer = fs.readFileSync(filePath);
  const hasJpegHeader = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const hasJpegTrailer = buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  if (!hasJpegHeader || !hasJpegTrailer) {
    throw new Error('captured file is not a complete JPEG image');
  }
  return buffer;
}

function captureLiveFrame({
  source,
  outputPath,
  windowEvidence,
  capturedAt = new Date(),
  runTool = runExternalTool
}) {
  if (!source || !outputPath) {
    throw new Error('source and outputPath are required');
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp.jpg`;

  try {
    const metadataText = runTool('yt-dlp', [
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--format',
      'best[protocol^=m3u8]/best',
      source.url
    ]);
    const metadata = JSON.parse(metadataText);
    const liveEvidence = validateLiveMetadata(metadata, source);

    const streamUrl = metadata.url;
    const offsetSeconds = windowEvidence && windowEvidence.offsetMinutes ? Math.max(0, windowEvidence.offsetMinutes * 60) : 0;

    // 若延遲超過 60 秒且有 m3u8 串流，透過 DVR Sequence / Index 倒帶精準抓取天文事件時刻
    if (offsetSeconds > 60 && metadata.manifest_url) {
      try {
        const https = require('https');
        const m3u8Content = runTool('curl', ['-s', metadata.manifest_url]) || '';
        const lines = m3u8Content.split('\n').filter(l => l.startsWith('http'));
        if (lines.length > 0) {
          const durMatch = lines[lines.length - 1].match(/\/dur\/([\d\.]+)\//);
          const dur = durMatch ? parseFloat(durMatch[1]) : 5.0;
          const totalSecs = lines.length * dur;
          const secsFromStart = Math.max(0, totalSecs - offsetSeconds);
          const targetIdx = Math.max(0, Math.min(lines.length - 1, Math.floor(secsFromStart / dur)));
          const targetSegUrl = lines[targetIdx];

          const tempTs = `${temporaryPath}.ts`;
          runTool('curl', ['-s', '-L', '-o', tempTs, targetSegUrl]);
          runTool('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'error',
            '-y',
            '-i', tempTs,
            '-frames:v', '1',
            '-q:v', '2',
            temporaryPath
          ]);
          if (fs.existsSync(tempTs)) fs.rmSync(tempTs, { force: true });
        }
      } catch (dvrErr) {
        console.warn('DVR segment seek fallback to live edge:', dvrErr.message);
      }
    }

    if (!fs.existsSync(temporaryPath) || fs.statSync(temporaryPath).size < 10000) {
      runTool('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-rw_timeout', '15000000',
        '-i', streamUrl,
        '-frames:v', '1',
        '-q:v', '2',
        temporaryPath
      ]);
    }

    const jpegBuffer = assertJpegFile(temporaryPath);
    const probeText = runTool('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height',
      '-of', 'json',
      temporaryPath
    ]);
    const sha256 = crypto.createHash('sha256').update(jpegBuffer).digest('hex');
    const evidence = finalizeCaptureEvidence({
      liveEvidence,
      windowEvidence,
      probe: JSON.parse(probeText),
      sha256,
      capturedAt
    });

    fs.renameSync(temporaryPath, outputPath);
    return evidence;
  } catch (error) {
    if (fs.existsSync(temporaryPath)) {
      fs.rmSync(temporaryPath, { force: true });
    }
    throw error;
  }
}

module.exports = {
  runExternalTool,
  assertJpegFile,
  captureLiveFrame
};
