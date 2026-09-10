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
  assertCaptureWindow,
  LIVE_EDGE_FIDELITY
} = require('./live-capture-core.js');
const { captureLiveFrame, capturePosterFrame } = require('./live-frame-capture.js');

const MAX_CAPTURE_OFFSET_MINUTES = 600; // 支援 10 小時 YouTube DVR 時光機回溯窗口

/**
 * 從提前鎖定的預測 JSON 取出「驗證與日後校準」所需的預測欄位。
 *
 * 雲量三頻 (highCloud/midCloud/lowCloud) 是重點：auto-calibrate-model.py 會拿
 * 這些值重算候選權重下的 sim_pred。舊版讀 lockedData.skyfire.diagnostics?.highCloud
 * —— diagnostics 是 [{label,status,desc}] 陣列，該存取永遠 undefined，`|| 0`
 * 讓每筆鎖定路徑紀錄的雲量都變 0，校準因此在對噪音調參 (MAE 每次只降 ~0.1)。
 * 現改讀 lock-forecast.js 寫入的結構化 weather 區塊；缺欄位時填 null，
 * 讓下游 (校準) 能明確跳過而非誤用 0。
 */
function buildPredictionFromLock(lockedData) {
  const w = lockedData.weather || {};
  const m = lockedData.skyfire.metrics || {};
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const visKm = num(w.visibilityKm);
  return {
    score: lockedData.skyfire.score,
    rating: lockedData.skyfire.rating.badge,
    color: lockedData.skyfire.rating.color,
    highCloud: num(w.cloudHigh),
    midCloud: num(w.cloudMid),
    lowCloud: num(w.cloudLow),
    totalCloud: num(w.cloudTotal),
    humidity: num(w.humidity),
    precipProb: num(w.precipProb),
    horizonClearance: num(m.horizonClearance),
    visibilityKm: visKm !== null ? visKm : num(m.visKm),
    isSimulated: false,
    lockedAt: lockedData.lockedAt
  };
}

/**
 * 從每站鎖定區塊 (lockedData.stations[stationId]) 取出該站的預測欄位。
 * 站不存在時回傳 null，讓呼叫端退回即時預測。
 */
function buildPredictionFromStationLock(lockedData, stationId) {
  const s = lockedData && lockedData.stations && lockedData.stations[stationId];
  if (!s) return null;
  const w = s.weather || {};
  const m = s.metrics || {};
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const visKm = num(w.visibilityKm);
  return {
    score: s.score,
    rating: s.rating,
    color: s.color,
    highCloud: num(w.cloudHigh),
    midCloud: num(w.cloudMid),
    lowCloud: num(w.cloudLow),
    totalCloud: num(w.cloudTotal),
    humidity: num(w.humidity),
    precipProb: num(w.precipProb),
    horizonClearance: num(m.horizonClearance),
    visibilityKm: visKm !== null ? visKm : num(m.visKm),
    isSimulated: false,
    lockedAt: lockedData.lockedAt
  };
}

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
  // 自架 runner 的機器可能關機，job 會排隊到開機才執行；GitHub 排程本身
  // 也有數小時延遲。超出擷取窗口是可預期的營運狀況，不該讓整個 job 變紅，
  // 但也絕不能拿窗口外的影格充當出景當刻的 ground truth。
  // 因此：不擷取、誠實記錄，並以 exit 0 讓後續日報照常產出。
  const offsetMinutes = Math.round((now.getTime() - eventTime.getTime()) / 60000);
  let windowError = null;
  try {
    assertCaptureWindow({
      now,
      eventTime,
      sessionType,
      maxOffsetMinutes: MAX_CAPTURE_OFFSET_MINUTES
    });
  } catch (error) {
    windowError = error.message;
  }

  console.log('====================================================');
  console.log(`📸 啟動實況影格擷取管線 [${sessionType}]`);
  console.log(`📅 台北觀測日期: ${dateStr}`);
  console.log(`⏰ 天文時刻: ${SolarCalc.formatTime(eventTime)} / 啟動偏移: ${offsetMinutes} 分鐘`);
  if (windowError) {
    console.warn(`⚠️ ${windowError}`);
    console.warn('   跳過擷取：窗口外的影格不能充當出景當刻的實況證據');
  }
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
        predictionData = buildPredictionFromLock(lockedData);
        predictionScore = predictionData.score;
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
    
    const w = sessionForecast.weather || {};
    predictionData = {
      score: sessionForecast.skyfire.score,
      rating: sessionForecast.skyfire.rating.badge,
      color: sessionForecast.skyfire.rating.color,
      highCloud: w.cloudHigh ?? null,
      midCloud: w.cloudMid ?? null,
      lowCloud: w.cloudLow ?? null,
      totalCloud: w.cloudTotal ?? null,
      humidity: w.humidity ?? null,
      precipProb: w.precipProb ?? null,
      horizonClearance: sessionForecast.skyfire.metrics.horizonClearance,
      visibilityKm: sessionForecast.skyfire.metrics.visKm,
      isSimulated: forecastData.isSimulated === true
    };
  }

  console.log('準備利用 yt-dlp 擷取影片，再以 ffmpeg 輸出為截圖...');

  const capturedAt = options.now instanceof Date ? options.now : new Date();
  const captureWindow = windowError
    ? { eventTime: eventTime.toISOString(), offsetMinutes, maxOffsetMinutes: MAX_CAPTURE_OFFSET_MINUTES }
    : assertCaptureWindow({
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
  let fallbackReason = windowError;

  try {
    if (windowError) {
      throw new Error(windowError);
    }
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
    if (windowError) {
      // 窗口外不做任何擷取：海報影格同樣無法代表出景當刻，
      // 保持 capture = null，後續會產出 capture_unavailable 紀錄。
      console.warn('已超出擷取窗口，不進行降級擷取');
    } else {
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
  }

  const baseRecord = {
    id: `rec-${dateStr}-${sessionType}`,
    date: dateStr,
    session: sessionType,
    targetTime: eventTime.toISOString(),
    source: source.name,
    prediction: predictionData
  };

  // Tier A 影格但 DVR seek 沒落地 (dvrSeekApplied !== true) 且回溯量 > 15 分：
  // 這是直播邊緣影像，畫面所屬時刻 ≈ capturedAt，不是 eventTime。標成 live-edge，
  // frameEffectiveTimeUtc 用 capturedAt，dvrRewindMinutes 歸零 —— 不冒充精確影格。
  const offsetAbs = Math.abs(captureWindow.offsetMinutes);
  const isLiveEdgeFrame = Boolean(
    capture &&
    capture.fidelity === 'exact' &&
    capture.dvrSeekApplied !== true &&
    offsetAbs > 15
  );
  const effectiveFidelity = isLiveEdgeFrame
    ? LIVE_EDGE_FIDELITY
    : (capture && capture.fidelity) || 'exact';

  const record = capture
    ? {
        ...baseRecord,
        snapshotUrl: `data/snapshots/${snapshotFileName}`,
        capture: {
          width: capture.width,
          height: capture.height,
          fileName: snapshotFileName,
          sha256: capture.sha256,
          // capturedAt = 腳本執行當下；frameEffectiveTimeUtc = 影格畫面實際所屬的
          // 天文時刻。fidelity 'exact' 時 == targetTime (DVR 已回溯至此)；
          // 'live-edge' 時 == capturedAt (seek 沒落地，抓的是直播當下)。
          // offsetMinutes = 兩者之間；dvrRewindMinutes = 實際回溯量 (live-edge 為 0)。
          capturedAt: capturedAt.toISOString(),
          frameEffectiveTimeUtc: isLiveEdgeFrame ? capturedAt.toISOString() : eventTime.toISOString(),
          offsetMinutes: captureWindow.offsetMinutes,
          dvrRewindMinutes: isLiveEdgeFrame ? 0 : captureWindow.offsetMinutes,
          dvrSeekApplied: capture.dvrSeekApplied === true,
          kind: capture.kind || 'youtube-live-frame',
          fidelity: effectiveFidelity,
          posterQuality: capture.posterQuality || null,
          fallbackReason: isLiveEdgeFrame
            ? (fallbackReason || 'DVR seek did not land; captured the live edge instead')
            : (capture.fidelity === 'degraded' ? fallbackReason : null),
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
  buildPredictionFromLock,
  buildPredictionFromStationLock,
  loadRecords,
  writeRecord,
  runCapturePipeline
};
