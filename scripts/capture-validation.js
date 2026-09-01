/**
 * Phase 1: capture a real frame from an official YouTube livestream inside
 * the Taipei sunrise/sunset validation window, then record its provenance.
 */

const fs = require('fs');
const path = require('path');

const SolarCalc = require('../js/solar-calc.js');
const WeatherService = require('../js/weather-service.js');
const {
  OFFICIAL_STREAMS,
  getTaipeiDateString,
  resolveSessionType,
  assertCaptureWindow
} = require('./live-capture-core.js');
const { captureLiveFrame, capturePosterFrame } = require('./live-frame-capture.js');

const MAX_CAPTURE_OFFSET_MINUTES = 600; // 支援 10 小時 YouTube DVR 時光機回溯窗口

function loadRecords(recordsFile) {
  if (!fs.existsSync(recordsFile)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(recordsFile, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    throw new Error(`cannot read verification records: ${error.message}`);
  }
}

function writeRecord(recordsFile, record) {
  const records = loadRecords(recordsFile);
  const existingIndex = records.findIndex(item => item.id === record.id);
  if (existingIndex >= 0) {
    records[existingIndex] = record;
  } else {
    records.unshift(record);
  }
  fs.writeFileSync(recordsFile, JSON.stringify(records.slice(0, 90), null, 2), 'utf8');
}

async function runCapturePipeline(inputSession = '', options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const sessionType = resolveSessionType(
    inputSession,
    options.schedule || process.env.GITHUB_EVENT_SCHEDULE || ''
  );
  const source = OFFICIAL_STREAMS[sessionType];
  const dateStr = getTaipeiDateString(now);
  const targetDate = new Date(`${dateStr}T12:00:00+08:00`);
  const solarTimes = SolarCalc.getTimes(targetDate);
  const eventTime = sessionType === 'sunrise' ? solarTimes.sunrise : solarTimes.sunset;
  const preflightWindow = assertCaptureWindow({
    now,
    eventTime,
    sessionType,
    maxOffsetMinutes: MAX_CAPTURE_OFFSET_MINUTES
  });

  console.log('====================================================');
  console.log(`📸 啟動實況影格擷取管線 [${sessionType}]`);
  console.log(`📅 台北觀測日期: ${dateStr}`);
  console.log(`⏰ 天文時刻: ${SolarCalc.formatTime(eventTime)} / 啟動偏移: ${preflightWindow.offsetMinutes} 分鐘`);
  console.log(`📍 官方直播: ${source.name}`);

  const dataDir = options.dataDir || path.join(__dirname, '../data');
  const outputDir = path.join(dataDir, 'snapshots');
  const snapshotFileName = `${dateStr}-${sessionType}.jpg`;
  const snapshotPath = path.join(outputDir, snapshotFileName);
  const recordsFile = path.join(dataDir, 'verification-records.json');

  let predictionScore = null;
  let predictionData = {};
  
  // 嘗試讀取提前鎖定的預測
  const lockFile = path.join(dataDir, `locked-${sessionType}-forecast.json`);
  if (fs.existsSync(lockFile)) {
    try {
      const lockedData = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (lockedData.date === dateStr && lockedData.skyfire) {
        console.log(`[Lock Forecast] 成功讀取提前鎖定的預測分數: ${lockedData.skyfire.score}`);
        predictionScore = lockedData.skyfire.score;
        predictionData = {
          score: lockedData.skyfire.score,
          rating: lockedData.skyfire.rating.badge,
          color: lockedData.skyfire.rating.color,
          highCloud: lockedData.skyfire.diagnostics?.highCloud || 0,
          midCloud: lockedData.skyfire.diagnostics?.midCloud || 0,
          lowCloud: lockedData.skyfire.diagnostics?.lowCloud || 0,
          horizonClearance: lockedData.skyfire.metrics.horizonClearance,
          visibilityKm: lockedData.skyfire.metrics.visKm,
          isSimulated: false,
          lockedAt: lockedData.lockedAt
        };
      }
    } catch (e) {
      console.warn('讀取鎖定預測失敗，降級為即時預測', e.message);
    }
  }

  // 如果沒有鎖定資料，則抓取即時資料
  if (!predictionScore) {
    const forecastData = await WeatherService.fetchForecast(true);
    const matchingDay = forecastData.daysForecast.find(day =>
      getTaipeiDateString(new Date(day.date)) === dateStr
    ) || forecastData.daysForecast[0];
    const sessionForecast = matchingDay[sessionType];
    console.log(`即時預測分數: ${sessionForecast.skyfire.score} 分 (${sessionForecast.skyfire.rating.badge})`);
    
    predictionData = {
      score: sessionForecast.skyfire.score,
      rating: sessionForecast.skyfire.rating.badge,
      color: sessionForecast.skyfire.rating.color,
      highCloud: sessionForecast.weather.cloudHigh,
      midCloud: sessionForecast.weather.cloudMid,
      lowCloud: sessionForecast.weather.cloudLow,
      horizonClearance: sessionForecast.skyfire.metrics.horizonClearance,
      visibilityKm: sessionForecast.skyfire.metrics.visKm,
      isSimulated: forecastData.isSimulated === true
    };
  }

  console.log('準備利用 yt-dlp 擷取影片，再以 ffmpeg 輸出為截圖...');

  const capturedAt = options.now instanceof Date ? options.now : new Date();
  const captureWindow = assertCaptureWindow({
    now: capturedAt,
    eventTime,
    sessionType,
    maxOffsetMinutes: MAX_CAPTURE_OFFSET_MINUTES
  });

  // ------------------------------------------------------------------
  // 分層擷取策略
  //
  // Tier A: yt-dlp + ffmpeg 取回精確直播影格 (fidelity: exact)
  //   YouTube 對資料中心 IP 施行 bot check，GitHub 託管 runner 必然失敗。
  //   設定 YT_COOKIES secret 或改用自架 runner (residential IP) 即可啟用。
  // Tier B: i.ytimg.com 靜態 CDN 的直播海報影格 (fidelity: degraded)
  //   不經 bot check，是真實但可能落後數分鐘的畫面。
  // 兩層皆失敗時誠實記錄 capture_unavailable，絕不捏造 ground truth，
  // 也絕不拋出 —— 否則後續的光學評分與每日日報會被整串跳過。
  // ------------------------------------------------------------------
  let capture = null;
  let fallbackReason = null;

  try {
    const exact = captureLiveFrame({
      source,
      outputPath: snapshotPath,
      windowEvidence: captureWindow,
      capturedAt,
      runTool: options.runTool
    });
    capture = { ...exact, fidelity: 'exact' };
    console.log(`Tier A 精確影格已驗證: ${capture.width}x${capture.height}`);
  } catch (error) {
    fallbackReason = error.message;
    console.warn(`Tier A (yt-dlp 精確影格) 失敗: ${error.message}`);
    console.warn('降級嘗試 Tier B: i.ytimg.com 直播海報影格...');
    try {
      capture = capturePosterFrame({
        source,
        outputPath: snapshotPath,
        windowEvidence: captureWindow,
        capturedAt,
        fetchImage: options.fetchImage
      });
      console.log(`Tier B 海報影格已取得: ${capture.width}x${capture.height} (${capture.posterQuality})`);
    } catch (posterError) {
      console.error(`Tier B 亦失敗: ${posterError.message}`);
      fallbackReason = `${fallbackReason} | poster: ${posterError.message}`;
    }
  }

  const baseRecord = {
    id: `rec-${dateStr}-${sessionType}`,
    date: dateStr,
    session: sessionType,
    targetTime: eventTime.toISOString(),
    source: source.name,
    prediction: predictionData
  };

  const record = capture
    ? {
        ...baseRecord,
        snapshotUrl: `data/snapshots/${snapshotFileName}`,
        capture: {
          width: capture.width,
          height: capture.height,
          fileName: snapshotFileName,
          sha256: capture.sha256,
          capturedAt: capturedAt.toISOString(),
          offsetMinutes: captureWindow.offsetMinutes,
          kind: capture.kind || 'youtube-live-frame',
          fidelity: capture.fidelity || 'exact',
          posterQuality: capture.posterQuality || null,
          fallbackReason: capture.fidelity === 'degraded' ? fallbackReason : null,
          validated: true
        },
        verification: {
          status: 'captured_ready_for_scoring',
          groundTruthScore: null,
          errorAbsolute: null,
          isSimulated: false
        }
      }
    : {
        ...baseRecord,
        snapshotUrl: null,
        capture: {
          kind: null,
          fidelity: 'none',
          validated: false,
          capturedAt: capturedAt.toISOString(),
          offsetMinutes: captureWindow.offsetMinutes,
          error: fallbackReason
        },
        verification: {
          status: 'capture_unavailable',
          groundTruthScore: null,
          errorAbsolute: null,
          isSimulated: false
        }
      };

  writeRecord(recordsFile, record);
  console.log(capture
    ? `驗證紀錄已更新 (${record.capture.fidelity}): SHA-256 ${capture.sha256}`
    : '已誠實記錄 capture_unavailable，未捏造任何 ground truth');
  console.log('====================================================\n');
  return record;
}

if (require.main === module) {
  runCapturePipeline(process.argv[2] || '').catch(error => {
    console.error(`擷取管線設定錯誤 (時段解析／擷取窗口): ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_CAPTURE_OFFSET_MINUTES,
  loadRecords,
  writeRecord,
  runCapturePipeline
};
