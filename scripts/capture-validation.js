/**
 * Phase 1: capture a real frame from an official YouTube livestream inside
 * the Taipei sunrise/sunset validation window, then record its provenance.
 */

const fs = require('fs');
const path = require('path');

const SolarCalc = require('../js/solar-calc.js');
const WeatherService = require('../js/weather-service.js');
const {
  sessionStreams,
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
  // 每場 8 站 → 90 筆只夠 ~11 天。720 筆 ≈ 90 天季節跨度。
  fs.writeFileSync(recordsFile, JSON.stringify(records.slice(0, 720), null, 2), 'utf8');
  return record;
}

function stationSnapshotUrl(dateStr, sessionType, stationId) {
  return `data/snapshots/${dateStr}/${sessionType}/${stationId}.jpg`;
}

// 預測解析順序：每站鎖定區塊 → 頂層共用鎖定 (舊格式/相容) → 該站座標的即時預測。
async function resolveStationPrediction(lockedData, station, sessionType, dateStr) {
  if (lockedData) {
    const perStation = buildPredictionFromStationLock(lockedData, station.id);
    if (perStation) return perStation;
    if (lockedData.skyfire) return buildPredictionFromLock(lockedData);
  }
  const forecastData = await WeatherService.fetchForecast(true, { lat: station.lat, lng: station.lng });
  const day = forecastData.daysForecast.find(d =>
    getTaipeiDateString(new Date(d.date)) === dateStr
  ) || forecastData.daysForecast[0];
  const sf = day[sessionType];
  const w = sf.weather || {};
  return {
    score: sf.skyfire.score,
    rating: sf.skyfire.rating.badge,
    color: sf.skyfire.rating.color,
    highCloud: w.cloudHigh ?? null,
    midCloud: w.cloudMid ?? null,
    lowCloud: w.cloudLow ?? null,
    totalCloud: w.cloudTotal ?? null,
    humidity: w.humidity ?? null,
    precipProb: w.precipProb ?? null,
    horizonClearance: sf.skyfire.metrics.horizonClearance,
    visibilityKm: sf.skyfire.metrics.visKm,
    isSimulated: forecastData.isSimulated === true
  };
}

function unavailableStationRecord(station, ctx, errorMessage, prediction = {}) {
  return {
    id: `rec-${ctx.dateStr}-${ctx.sessionType}-${station.id}`,
    date: ctx.dateStr,
    session: ctx.sessionType,
    station: station.id,
    targetTime: ctx.eventTime.toISOString(),
    source: station.name,
    prediction,
    snapshotUrl: null,
    capture: {
      kind: null,
      fidelity: 'none',
      validated: false,
      capturedAt: ctx.capturedAt.toISOString(),
      offsetMinutes: ctx.captureWindow.offsetMinutes,
      error: errorMessage
    },
    verification: {
      status: 'capture_unavailable',
      groundTruthScore: null,
      errorAbsolute: null,
      isSimulated: false
    }
  };
}

// 單站擷取：分層 Tier A → Tier B，套用 live-edge 誠實標記，寫入該站紀錄。
async function captureOneStation(station, ctx) {
  const { dateStr, sessionType, eventTime, captureWindow, windowError, capturedAt, dataDir, lockedData, options, recordsFile } = ctx;

  const snapshotUrl = stationSnapshotUrl(dateStr, sessionType, station.id);
  const snapshotPath = path.join(dataDir, 'snapshots', dateStr, sessionType, `${station.id}.jpg`);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });

  let prediction = {};
  try {
    prediction = await resolveStationPrediction(lockedData, station, sessionType, dateStr);
  } catch (err) {
    console.warn(`[capture] ${station.id}: 預測解析失敗，仍嘗試擷取影格 (${err.message})`);
  }

  const runTool = (options.runToolFor && options.runToolFor(station.id)) || options.runTool;

  let capture = null;
  let fallbackReason = windowError;
  try {
    if (windowError) throw new Error(windowError);
    const exact = captureLiveFrame({
      source: station,
      outputPath: snapshotPath,
      windowEvidence: captureWindow,
      capturedAt,
      runTool
    });
    capture = { ...exact, fidelity: 'exact' };
  } catch (error) {
    fallbackReason = error.message;
    if (!windowError) {
      try {
        capture = capturePosterFrame({
          source: station,
          outputPath: snapshotPath,
          windowEvidence: captureWindow,
          capturedAt,
          fetchImage: options.fetchImage
        });
      } catch (posterError) {
        fallbackReason = `${fallbackReason} | poster: ${posterError.message}`;
      }
    }
  }

  if (!capture) {
    const rec = unavailableStationRecord(station, ctx, fallbackReason, prediction);
    console.log(`[capture] ${station.id}: capture_unavailable (${fallbackReason})`);
    return writeRecord(recordsFile, rec);
  }

  const fileName = `${station.id}.jpg`;
  const offsetAbs = Math.abs(captureWindow.offsetMinutes);
  const isLiveEdgeFrame = Boolean(
    capture.fidelity === 'exact' && capture.dvrSeekApplied !== true && offsetAbs > 15
  );
  const effectiveFidelity = isLiveEdgeFrame ? LIVE_EDGE_FIDELITY : capture.fidelity || 'exact';

  const rec = {
    id: `rec-${dateStr}-${sessionType}-${station.id}`,
    date: dateStr,
    session: sessionType,
    station: station.id,
    targetTime: eventTime.toISOString(),
    source: station.name,
    prediction,
    snapshotUrl,
    capture: {
      width: capture.width,
      height: capture.height,
      fileName,
      sha256: capture.sha256,
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
  };
  console.log(`[capture] ${station.id}: ${effectiveFidelity} ${capture.width}x${capture.height}`);
  return writeRecord(recordsFile, rec);
}

async function runCapturePipeline(inputSession = '', options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const sessionType = resolveSessionType(
    inputSession,
    options.schedule || process.env.GITHUB_EVENT_SCHEDULE || ''
  );
  const dateStr = getTaipeiDateString(now);
  const targetDate = new Date(`${dateStr}T12:00:00+08:00`);
  const solarTimes = SolarCalc.getTimes(targetDate);
  const eventTime = sessionType === 'sunrise' ? solarTimes.sunrise : solarTimes.sunset;
  const offsetMinutes = Math.round((now.getTime() - eventTime.getTime()) / 60000);

  let windowError = null;
  try {
    assertCaptureWindow({ now, eventTime, sessionType, maxOffsetMinutes: MAX_CAPTURE_OFFSET_MINUTES });
  } catch (error) {
    windowError = error.message;
  }

  const capturedAt = now;
  const captureWindow = windowError
    ? { eventTime: eventTime.toISOString(), offsetMinutes, maxOffsetMinutes: MAX_CAPTURE_OFFSET_MINUTES }
    : assertCaptureWindow({ now: capturedAt, eventTime, sessionType, maxOffsetMinutes: MAX_CAPTURE_OFFSET_MINUTES });

  const dataDir = options.dataDir || path.join(__dirname, '../data');
  const recordsFile = path.join(dataDir, 'verification-records.json');

  let lockedData = null;
  const lockFile = path.join(dataDir, `locked-${sessionType}-forecast.json`);
  if (fs.existsSync(lockFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (parsed.date === dateStr) lockedData = parsed;
    } catch (e) {
      console.warn('讀取鎖定預測失敗，改用即時預測', e.message);
    }
  }

  const stations = sessionStreams(sessionType);
  console.log('====================================================');
  console.log(`📸 啟動實況影格擷取管線 [${sessionType}] ${stations.length} 站`);
  console.log(`📅 台北觀測日期: ${dateStr} / ⏰ ${SolarCalc.formatTime(eventTime)} / 偏移: ${offsetMinutes} 分`);
  if (windowError) {
    console.warn(`⚠️ ${windowError} —— 跳過擷取、誠實記錄`);
  }

  const ctx = { dateStr, sessionType, eventTime, captureWindow, windowError, capturedAt, dataDir, lockedData, options, recordsFile };
  const results = [];
  for (const st of stations) {
    try {
      results.push(await captureOneStation(st, ctx));
    } catch (err) {
      console.error(`[capture] ${st.id} 未預期錯誤，記為 capture_unavailable: ${err.message}`);
      results.push(writeRecord(recordsFile, unavailableStationRecord(st, ctx, err.message)));
    }
  }

  const ok = results.filter(r => r.snapshotUrl).length;
  console.log(`✅ ${ok}/${stations.length} 站擷取到影格`);
  console.log('====================================================\n');
  return results;
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
