/**
 * Pure validation policy for real sunrise/sunset livestream captures.
 * External tools and filesystem writes stay in capture-validation.js.
 */

const OFFICIAL_STREAMS = Object.freeze({
  sunrise: Object.freeze({
    id: 'xiangshan_101',
    name: '象山看台北 101（4K 官方即時影像）',
    url: 'https://www.youtube.com/watch?v=z_fY1pj1VBw',
    videoId: 'z_fY1pj1VBw',
    uploaderId: '@taipeitravelofficial'
  }),
  sunset: Object.freeze({
    id: 'dadaocheng',
    name: '大稻埕碼頭（4K 官方即時影像）',
    url: 'https://www.youtube.com/watch?v=Ndo_8RuefH4',
    videoId: 'Ndo_8RuefH4',
    uploaderId: '@taipeitravelofficial'
  })
});

const SCHEDULE_TO_SESSION = Object.freeze({
  '30 21 * * *': 'sunrise', // 05:30 TPE
  '0 1 * * *': 'sunrise',   // 09:00 TPE (fallback/定稿)
  '45 10 * * *': 'sunset',  // 18:45 TPE
  '0 13 * * *': 'sunset'    // 21:00 TPE (fallback/定稿)
});

function getTaipeiDateString(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('date must be a valid Date');
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function resolveSessionType(inputSession = '', schedule = '') {
  const normalized = String(inputSession || '').trim().toLowerCase();
  if (normalized) {
    if (normalized !== 'sunrise' && normalized !== 'sunset') {
      throw new Error(`cannot resolve capture session from input: ${inputSession}`);
    }
    return normalized;
  }

  const scheduledSession = SCHEDULE_TO_SESSION[String(schedule || '').trim()];
  if (!scheduledSession) {
    throw new Error(`cannot resolve capture session from schedule: ${schedule || '(empty)'}`);
  }
  return scheduledSession;
}

function assertCaptureWindow({ now, eventTime, sessionType, maxOffsetMinutes = 30 }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  if (!(eventTime instanceof Date) || Number.isNaN(eventTime.getTime())) {
    throw new TypeError('eventTime must be a valid Date');
  }
  if (sessionType !== 'sunrise' && sessionType !== 'sunset') {
    throw new Error(`invalid session type: ${sessionType}`);
  }

  const offsetMinutes = Math.round((now.getTime() - eventTime.getTime()) / 60000);
  if (Math.abs(offsetMinutes) > maxOffsetMinutes) {
    throw new Error(
      `outside ${sessionType} capture window: offset ${offsetMinutes} minutes exceeds ±${maxOffsetMinutes}`
    );
  }

  return {
    eventTime: eventTime.toISOString(),
    offsetMinutes,
    maxOffsetMinutes
  };
}

function validateLiveMetadata(metadata, source) {
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('missing yt-dlp metadata');
  }
  if (!source || typeof source !== 'object') {
    throw new Error('missing configured live source');
  }
  if (metadata.id !== source.videoId) {
    throw new Error(`unexpected video id: ${metadata.id || '(missing)'}`);
  }
  if (metadata.uploader_id !== source.uploaderId) {
    throw new Error(`unexpected uploader id: ${metadata.uploader_id || '(missing)'}`);
  }
  if (metadata.is_live !== true || metadata.live_status !== 'is_live') {
    throw new Error(`source is not live: ${metadata.live_status || 'unknown'}`);
  }

  const protocol = String(metadata.protocol || '').toLowerCase();
  const streamUrl = String(metadata.url || '');
  if (!protocol.startsWith('m3u8') || !/^https?:\/\//i.test(streamUrl) || /ytimg\.com/i.test(streamUrl)) {
    throw new Error('thumbnail or non-stream URL rejected');
  }

  return {
    kind: 'youtube-live-frame',
    validated: true,
    sourceId: source.id,
    videoId: metadata.id,
    uploaderId: metadata.uploader_id,
    protocol,
    formatId: metadata.format_id || null,
    sourceWidth: Number.isFinite(metadata.width) ? metadata.width : null,
    sourceHeight: Number.isFinite(metadata.height) ? metadata.height : null
  };
}

function finalizeCaptureEvidence({ liveEvidence, windowEvidence, probe, sha256, capturedAt }) {
  if (!liveEvidence || liveEvidence.validated !== true) {
    throw new Error('live metadata was not validated');
  }
  if (!windowEvidence || !Number.isFinite(windowEvidence.offsetMinutes)) {
    throw new Error('capture window was not validated');
  }

  const videoStream = probe && Array.isArray(probe.streams)
    ? probe.streams.find(stream => Number.isFinite(stream.width) && Number.isFinite(stream.height))
    : null;
  if (!videoStream || videoStream.width < 640 || videoStream.height < 360) {
    throw new Error('captured frame resolution too small');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(sha256 || ''))) {
    throw new Error('invalid captured frame SHA-256');
  }
  if (!(capturedAt instanceof Date) || Number.isNaN(capturedAt.getTime())) {
    throw new Error('invalid capture timestamp');
  }

  return {
    ...liveEvidence,
    capturedAt: capturedAt.toISOString(),
    eventTime: windowEvidence.eventTime,
    offsetMinutes: windowEvidence.offsetMinutes,
    maxOffsetMinutes: windowEvidence.maxOffsetMinutes,
    width: videoStream.width,
    height: videoStream.height,
    codec: videoStream.codec_name || null,
    sha256: String(sha256).toLowerCase()
  };
}

function validateOpticalResult(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('missing optical analysis result');
  }
  if (result.is_simulated === true) {
    throw new Error('simulated optical result rejected');
  }
  if (!Number.isFinite(result.score) || result.score < 0 || result.score > 100) {
    throw new Error('invalid optical score');
  }
  return result;
}

// Tier A 取得的精確直播影格
const EXACT_CAPTURE_KIND = 'youtube-live-frame';
// Tier B 取得的直播海報影格：真實影像但可能落後數分鐘
const DEGRADED_CAPTURE_KIND = 'youtube-live-poster';
const SCORABLE_CAPTURE_KINDS = Object.freeze([EXACT_CAPTURE_KIND, DEGRADED_CAPTURE_KIND]);

/**
 * 該紀錄是否具備可供光學評分的真實影像證據。
 * 海報影格屬真實影像（與捏造的模擬值不同），因此允許評分，
 * 但其 fidelity 標示為 degraded，不得冒充精確影格。
 */
function isValidatedLiveCaptureRecord(record) {
  return Boolean(
    record &&
    typeof record.snapshotUrl === 'string' &&
    record.snapshotUrl.startsWith('data/snapshots/') &&
    record.capture &&
    SCORABLE_CAPTURE_KINDS.includes(record.capture.kind) &&
    record.capture.validated === true
  );
}

/**
 * 該紀錄是否為 Tier A 精確影格。招牌準確率統計只採計這一級。
 */
function isExactLiveFrameRecord(record) {
  return Boolean(
    isValidatedLiveCaptureRecord(record) &&
    record.capture.kind === EXACT_CAPTURE_KIND &&
    record.capture.fidelity !== 'degraded'
  );
}

function isVerifiedLiveFrameRecord(record) {
  return Boolean(
    isExactLiveFrameRecord(record) &&
    record.verification &&
    record.verification.status === 'verified_completed' &&
    record.verification.isSimulated !== true &&
    Number.isFinite(record.verification.groundTruthScore)
  );
}

module.exports = {
  OFFICIAL_STREAMS,
  SCHEDULE_TO_SESSION,
  getTaipeiDateString,
  resolveSessionType,
  assertCaptureWindow,
  validateLiveMetadata,
  finalizeCaptureEvidence,
  validateOpticalResult,
  isValidatedLiveCaptureRecord,
  isExactLiveFrameRecord,
  isVerifiedLiveFrameRecord,
  EXACT_CAPTURE_KIND,
  DEGRADED_CAPTURE_KIND,
  SCORABLE_CAPTURE_KINDS
};
