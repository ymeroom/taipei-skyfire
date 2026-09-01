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

// YouTube 在沒有可用縮圖時會回傳低解析度佔位圖，必須擋掉
const MIN_POSTER_WIDTH = 640;
const MIN_POSTER_HEIGHT = 360;

/**
 * 由 JPEG 的 SOF 標記直接讀出影像尺寸
 * 不依賴 ffprobe，讓降級路徑在缺少外部工具時仍可驗證解析度。
 */
function readJpegDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    throw new Error('not a JPEG buffer');
  }
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    // SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15 皆帶有尺寸欄位
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) throw new Error('malformed JPEG segment');
    offset += 2 + segmentLength;
  }
  throw new Error('JPEG dimensions not found');
}

function downloadImage(url) {
  const result = spawnSync('curl', [
    '-sL', '--max-time', '30',
    '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    '--output', '-', url
  ], { maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'buffer' });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`curl exited with ${result.status}`);
  return result.stdout;
}

/**
 * Tier B: 由 i.ytimg.com 靜態 CDN 取回直播海報影格。
 *
 * YouTube 對資料中心 IP 施行 bot check，yt-dlp 在 GitHub 託管 runner 上
 * 必然失敗；但 i.ytimg.com 是純 CDN，不經過該檢查。海報影格由 YouTube
 * 定期自直播畫面重新產生，是真實但可能落後數分鐘的畫面，因此以
 * kind='youtube-live-poster'、fidelity='degraded' 明確標示，
 * 不與 yt-dlp 取得的精確影格混為一談。
 */
function capturePosterFrame({
  source,
  outputPath,
  windowEvidence,
  capturedAt = new Date(),
  fetchImage = downloadImage
}) {
  if (!source || !source.videoId || !outputPath) {
    throw new Error('source.videoId and outputPath are required');
  }
  if (!windowEvidence || !Number.isFinite(windowEvidence.offsetMinutes)) {
    throw new Error('capture window was not validated');
  }
  if (!(capturedAt instanceof Date) || Number.isNaN(capturedAt.getTime())) {
    throw new Error('invalid capture timestamp');
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const candidates = ['maxresdefault', 'sddefault', 'hqdefault'];
  const failures = [];

  for (const quality of candidates) {
    const url = `https://i.ytimg.com/vi/${source.videoId}/${quality}.jpg`;
    let buffer;
    try {
      buffer = fetchImage(url);
    } catch (error) {
      failures.push(`${quality}: ${error.message}`);
      continue;
    }

    if (!Buffer.isBuffer(buffer) || buffer.length < 10000) {
      failures.push(`${quality}: payload too small (${buffer ? buffer.length : 0} bytes)`);
      continue;
    }
    if (!(buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)) {
      failures.push(`${quality}: not a JPEG`);
      continue;
    }

    let dimensions;
    try {
      dimensions = readJpegDimensions(buffer);
    } catch (error) {
      failures.push(`${quality}: ${error.message}`);
      continue;
    }
    if (dimensions.width < MIN_POSTER_WIDTH || dimensions.height < MIN_POSTER_HEIGHT) {
      failures.push(`${quality}: resolution too small (${dimensions.width}x${dimensions.height})`);
      continue;
    }

    fs.writeFileSync(outputPath, buffer);
    return {
      kind: 'youtube-live-poster',
      fidelity: 'degraded',
      validated: true,
      sourceId: source.id,
      videoId: source.videoId,
      uploaderId: source.uploaderId || null,
      posterQuality: quality,
      posterUrl: url,
      capturedAt: capturedAt.toISOString(),
      eventTime: windowEvidence.eventTime,
      offsetMinutes: windowEvidence.offsetMinutes,
      maxOffsetMinutes: windowEvidence.maxOffsetMinutes,
      width: dimensions.width,
      height: dimensions.height,
      codec: 'mjpeg',
      sha256: crypto.createHash('sha256').update(buffer).digest('hex')
    };
  }

  throw new Error(`poster frame unavailable — ${failures.join('; ')}`);
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
    // YouTube 對資料中心 IP 施行 bot check；提供 cookies 可解除。
    // 由 workflow 將 YT_COOKIES secret 寫入檔案後以此環境變數指向。
    const cookiesFile = process.env.YT_COOKIES_FILE;
    const cookieArgs = cookiesFile && fs.existsSync(cookiesFile)
      ? ['--cookies', cookiesFile]
      : [];

    const metadataText = runTool('yt-dlp', [
      ...cookieArgs,
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

    if (offsetSeconds > 60 && metadata.formats) {
      try {
        const formats = metadata.formats.filter(f => ['95', '96', '94', '93'].includes(String(f.format_id)) && f.url);
        const m3u8UrlToFetch = formats.length > 0 ? formats[0].url : metadata.manifest_url;
        
        if (m3u8UrlToFetch) {
          const m3u8Content = runTool('curl', ['-s', m3u8UrlToFetch]) || '';
          const lines = m3u8Content.split('\n').filter(l => l.startsWith('http'));
          
          if (lines.length > 0) {
            const latestUrl = lines[lines.length - 1];
            const sqMatch = latestUrl.match(/\/sq\/(\d+)\//);
            const durMatch = latestUrl.match(/\/dur\/([\d\.]+)\//);
            
            if (sqMatch) {
              const latestSq = parseInt(sqMatch[1], 10);
              const dur = durMatch ? parseFloat(durMatch[1]) : 5.0;
              
              const targetSq = latestSq - Math.floor(offsetSeconds / dur);
              const targetSegUrl = latestUrl.replace(/\/sq\/\d+\//, `/sq/${targetSq}/`);
              
              const tempTs = `${temporaryPath}.ts`;
              runTool('curl', ['-s', '-L', '-o', tempTs, targetSegUrl]);
              
              // 驗證下載的檔案是否足夠大 (有效的 ts 檔通常 > 50KB)
              if (fs.existsSync(tempTs) && fs.statSync(tempTs).size > 10000) {
                runTool('ffmpeg', [
                  '-hide_banner',
                  '-loglevel', 'error',
                  '-y',
                  '-i', tempTs,
                  '-frames:v', '1',
                  '-q:v', '2',
                  temporaryPath
                ]);
              }
              if (fs.existsSync(tempTs)) fs.rmSync(tempTs, { force: true });
            }
          }
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
  readJpegDimensions,
  downloadImage,
  capturePosterFrame,
  captureLiveFrame,
  MIN_POSTER_WIDTH,
  MIN_POSTER_HEIGHT
};
