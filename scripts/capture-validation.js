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
const { captureLiveFrame } = require('./live-frame-capture.js');

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

  const dataDir = path.join(__dirname, '../data');
  const outputDir = path.join(dataDir, 'snapshots');
  const snapshotFileName = `${dateStr}-${sessionType}.jpg`;
  const snapshotPath = path.join(outputDir, snapshotFileName);
  const recordsFile = path.join(dataDir, 'verification-records.json');

  const forecastData = await WeatherService.fetchForecast(true);
  const matchingDay = forecastData.daysForecast.find(day =>
    getTaipeiDateString(new Date(day.date)) === dateStr
  ) || forecastData.daysForecast[0];
  const sessionForecast = matchingDay[sessionType];

  console.log(`🔥 模型預測: ${sessionForecast.skyfire.score} 分 (${sessionForecast.skyfire.rating.badge})`);
  console.log('🎥 以 yt-dlp 驗證直播並以 ffmpeg 擷取當下影格...');

  const capturedAt = options.now instanceof Date ? options.now : new Date();
  const captureWindow = assertCaptureWindow({
    now: capturedAt,
    eventTime,
    sessionType,
    maxOffsetMinutes: MAX_CAPTURE_OFFSET_MINUTES
  });

  const capture = captureLiveFrame({
    source,
    outputPath: snapshotPath,
    windowEvidence: captureWindow,
    capturedAt,
    runTool: options.runTool
  });

  const record = {
    id: `rec-${dateStr}-${sessionType}`,
    date: dateStr,
    session: sessionType,
    sessionLabel: sessionType === 'sunrise' ? '日出實景' : '日落實景',
    capturedAt: capture.capturedAt,
    sourceStream: source.name,
    youtubeLiveUrl: source.url,
    snapshotUrl: `data/snapshots/${snapshotFileName}`,
    capture,
    prediction: {
      score: sessionForecast.skyfire.score,
      rating: sessionForecast.skyfire.rating.badge,
      color: sessionForecast.skyfire.rating.color,
      highCloud: sessionForecast.weather.cloudHigh,
      midCloud: sessionForecast.weather.cloudMid,
      lowCloud: sessionForecast.weather.cloudLow,
      horizonClearance: sessionForecast.skyfire.metrics.horizonClearance,
      visibilityKm: sessionForecast.skyfire.metrics.visKm,
      isSimulated: forecastData.isSimulated === true
    },
    verification: {
      status: 'captured_ready_for_scoring',
      groundTruthScore: null,
      errorAbsolute: null,
      isSimulated: false
    }
  };

  writeRecord(recordsFile, record);
  console.log(`✅ 實況影格已驗證: ${capture.width}x${capture.height}, SHA-256 ${capture.sha256}`);
  console.log('💾 驗證紀錄已更新: data/verification-records.json');
  console.log('====================================================\n');
  return record;
}

if (require.main === module) {
  runCapturePipeline(process.argv[2] || '').catch(error => {
    console.error(`❌ 實況擷取失敗，未寫入驗證紀錄: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_CAPTURE_OFFSET_MINUTES,
  loadRecords,
  writeRecord,
  runCapturePipeline
};
