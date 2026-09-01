/**
 * test-live-capture-core.js - Ground-truth livestream capture policy
 */

const assert = require('assert');
const {
  OFFICIAL_STREAMS,
  getTaipeiDateString,
  resolveSessionType,
  assertCaptureWindow,
  validateLiveMetadata,
  finalizeCaptureEvidence,
  validateOpticalResult,
  isValidatedLiveCaptureRecord,
  isVerifiedLiveFrameRecord,
  resolveScheduledInstant,
  resolveLockTarget,
} = require('../scripts/live-capture-core.js');

console.log('--- 🧪 測試 6: 真實日出／日落直播影格驗證政策 ---');

assert.strictEqual(
  getTaipeiDateString(new Date('2026-08-17T21:30:00.000Z')),
  '2026-08-18',
  '清晨 UTC 日期必須轉換成 Asia/Taipei 的當地日期'
);

assert.strictEqual(resolveSessionType('sunrise', ''), 'sunrise');
assert.strictEqual(resolveSessionType('', '30 21 * * *'), 'sunrise');
assert.strictEqual(resolveSessionType('', '45 10 * * *'), 'sunset');
assert.throws(() => resolveSessionType('', '0 0 * * *'), /cannot resolve/i);

const sunriseEvent = new Date('2026-08-17T21:30:00.000Z');
const allowedWindow = assertCaptureWindow({
  now: new Date('2026-08-17T21:42:00.000Z'),
  eventTime: sunriseEvent,
  sessionType: 'sunrise',
  maxOffsetMinutes: 30
});
assert.strictEqual(allowedWindow.offsetMinutes, 12);
assert.throws(() => assertCaptureWindow({
  now: new Date('2026-08-18T00:03:28.316Z'),
  eventTime: sunriseEvent,
  sessionType: 'sunrise',
  maxOffsetMinutes: 30
}), /outside sunrise capture window/i);

const sunriseSource = OFFICIAL_STREAMS.sunrise;
const validMetadata = {
  id: sunriseSource.videoId,
  is_live: true,
  live_status: 'is_live',
  uploader_id: sunriseSource.uploaderId,
  protocol: 'm3u8_native',
  url: 'https://manifest.googlevideo.com/api/manifest/hls_playlist/example.m3u8',
  width: 3840,
  height: 2160,
  format_id: '96'
};

const evidence = validateLiveMetadata(validMetadata, sunriseSource);
assert.strictEqual(evidence.validated, true);
assert.strictEqual(evidence.kind, 'youtube-live-frame');

assert.throws(
  () => validateLiveMetadata({ ...validMetadata, is_live: false, live_status: 'was_live' }, sunriseSource),
  /not live/i
);

const finalizedEvidence = finalizeCaptureEvidence({
  liveEvidence: evidence,
  windowEvidence: allowedWindow,
  probe: { streams: [{ codec_name: 'mjpeg', width: 1920, height: 1080 }] },
  sha256: 'a'.repeat(64),
  capturedAt: new Date('2026-08-17T21:42:00.000Z')
});
assert.strictEqual(finalizedEvidence.width, 1920);
assert.strictEqual(finalizedEvidence.height, 1080);
assert.strictEqual(finalizedEvidence.sha256, 'a'.repeat(64));
assert.throws(() => finalizeCaptureEvidence({
  liveEvidence: evidence,
  windowEvidence: allowedWindow,
  probe: { streams: [{ codec_name: 'mjpeg', width: 320, height: 180 }] },
  sha256: 'b'.repeat(64),
  capturedAt: new Date('2026-08-17T21:42:00.000Z')
}), /resolution too small/i);

assert.strictEqual(validateOpticalResult({
  score: 74,
  level: 'GREAT',
  badge: '壯麗火燒雲',
  chromatic_purity: 61.5,
  sky_coverage_pct: 55.2,
  is_simulated: false
}).score, 74);
assert.throws(() => validateOpticalResult({ score: 70, is_simulated: true }), /simulated/i);
assert.throws(() => validateOpticalResult({ score: null, is_simulated: false }), /invalid optical score/i);
assert.throws(
  () => validateLiveMetadata({ ...validMetadata, id: 'wrongVideo1' }, sunriseSource),
  /unexpected video/i
);
assert.throws(
  () => validateLiveMetadata({
    ...validMetadata,
    protocol: 'https',
    url: `https://i.ytimg.com/vi/${sunriseSource.videoId}/maxresdefault.jpg`
  }, sunriseSource),
  /thumbnail or non-stream/i
);

assert.strictEqual(isVerifiedLiveFrameRecord({
  snapshotUrl: 'assets/epic_sunset.jpg',
  verification: { status: 'verified_completed' }
}), false, '沒有擷取證據的歷史圖片不得進入實況驗證走廊');

assert.strictEqual(isValidatedLiveCaptureRecord({
  snapshotUrl: 'data/snapshots/2026-08-18-sunrise.jpg',
  capture: { ...evidence, capturedAt: '2026-08-18T05:30:00+08:00' },
  verification: { status: 'captured_ready_for_scoring' }
}), true);
assert.strictEqual(isValidatedLiveCaptureRecord({
  snapshotUrl: 'data/snapshots/2026-08-18-sunrise.jpg',
  verification: { status: 'captured_ready_for_scoring' }
}), false);

assert.strictEqual(isVerifiedLiveFrameRecord({
  snapshotUrl: 'data/snapshots/2026-08-18-sunrise.jpg',
  capture: { ...evidence, capturedAt: '2026-08-18T05:30:00+08:00' },
  verification: { status: 'verified_completed', isSimulated: true, groundTruthScore: 70 }
}), false, '模擬評分不得冒充實況驗證');

assert.strictEqual(isVerifiedLiveFrameRecord({
  snapshotUrl: 'data/snapshots/2026-08-18-sunrise.jpg',
  capture: { ...evidence, capturedAt: '2026-08-18T05:30:00+08:00' },
  verification: { status: 'verified_completed', isSimulated: false, groundTruthScore: 70 }
}), true);

// ----------------------------------------------------------------
// 降級海報影格 (Tier B) 的驗證政策
// 海報影格是真實影像，只是可能落後數分鐘，與「捏造 ground truth」不同，
// 因此允許進入光學評分；但它不得冒充精確影格計入招牌準確率統計。
// ----------------------------------------------------------------
const posterRecord = {
  snapshotUrl: 'data/snapshots/2026-09-01-sunset.jpg',
  capture: {
    kind: 'youtube-live-poster',
    fidelity: 'degraded',
    validated: true,
    capturedAt: '2026-09-01T18:19:00+08:00',
    sha256: 'a'.repeat(64),
    width: 1280,
    height: 720
  },
  verification: { status: 'captured_ready_for_scoring' }
};

assert.strictEqual(
  isValidatedLiveCaptureRecord(posterRecord),
  true,
  '降級海報影格為真實影像，應可進入光學評分'
);

assert.strictEqual(
  isVerifiedLiveFrameRecord({
    ...posterRecord,
    verification: { status: 'verified_completed', isSimulated: false, groundTruthScore: 70 }
  }),
  false,
  '降級海報影格不得計入精確實況影格的準確率統計'
);

console.log('✅ 降級海報影格驗證政策正確');

// ----------------------------------------------------------------
// 排程時刻回推 (Scheduled Instant Snapping)
//
// GitHub 的排程延遲極不穩定，實測有 4-7 小時。lock-forecast 原本用實際
// 執行時間 (now) 決定目標日期，一旦延遲跨過台北午夜就會鎖錯天：
// 2026-08-31 的 16:30 鎖定作業延遲到台北時間 09-01 00:17 才跑，
// 結果鎖成 09-01 的日落，08-31 當天根本沒鎖到。
//
// 修正方式：cron 字串裡有排定的時刻，把 now 往回吸附到最近一次符合
// 該 cron 的 UTC 時刻，再由該時刻推算台北日期。
// ----------------------------------------------------------------
assert.strictEqual(
  resolveScheduledInstant('30 8 * * *', new Date('2026-08-31T16:17:23Z')).toISOString(),
  '2026-08-31T08:30:00.000Z',
  '延遲 7h47m 執行時，應回推到當日 08:30 UTC 的排定時刻'
);

assert.strictEqual(
  resolveScheduledInstant('30 8 * * *', new Date('2026-08-31T05:00:00Z')).toISOString(),
  '2026-08-30T08:30:00.000Z',
  '執行時間早於當日排定時刻時，最近一次應為前一天'
);

assert.strictEqual(
  resolveScheduledInstant('30 8 * * *', new Date('2026-08-31T08:30:00Z')).toISOString(),
  '2026-08-31T08:30:00.000Z',
  '恰好準點執行時應回推到當下'
);

assert.throws(
  () => resolveScheduledInstant('*/5 * * * *', new Date('2026-08-31T08:30:00Z')),
  /daily cron/i,
  '僅支援每日固定時刻的 cron，其他形式應明確拒絕'
);

console.log('✅ 排程時刻回推正確');

// ----------------------------------------------------------------
// 鎖定目標解析：由排定時刻 (而非執行時刻) 決定時段與目標日期
// ----------------------------------------------------------------
const delayedSunset = resolveLockTarget({
  schedule: '30 8 * * *',
  now: new Date('2026-08-31T16:17:23Z')  // 台北 09-01 00:17，已跨午夜
});
assert.strictEqual(delayedSunset.session, 'sunset');
assert.strictEqual(
  delayedSunset.dateStr,
  '2026-08-31',
  '16:30 的日落鎖定即使延遲跨過台北午夜，仍應鎖定 08-31 當天的日落'
);
assert.strictEqual(delayedSunset.delayMinutes, 467, '應如實回報延遲分鐘數');

const delayedSunrise = resolveLockTarget({
  schedule: '50 15 * * *',
  now: new Date('2026-08-31T20:50:00Z')
});
assert.strictEqual(delayedSunrise.session, 'sunrise');
assert.strictEqual(
  delayedSunrise.dateStr,
  '2026-09-01',
  '23:50 的日出鎖定目標為隔日日出'
);

// 準點執行時結果必須與延遲執行完全相同
const onTimeSunset = resolveLockTarget({
  schedule: '30 8 * * *',
  now: new Date('2026-08-31T08:30:00Z')
});
assert.strictEqual(onTimeSunset.dateStr, delayedSunset.dateStr, '準點與延遲應鎖定同一天');
assert.strictEqual(onTimeSunset.delayMinutes, 0);

// 手動觸發沒有 cron，退回以執行時刻判斷
const manual = resolveLockTarget({
  manualSession: 'sunrise',
  now: new Date('2026-08-31T20:50:00Z')  // 台北 09-01 04:50
});
assert.strictEqual(manual.session, 'sunrise');
assert.strictEqual(manual.dateStr, '2026-09-01', '手動觸發於清晨時應鎖定當日日出');
assert.strictEqual(manual.scheduledAt, null, '手動觸發沒有排定時刻');

console.log('✅ 鎖定目標由排定時刻決定，不受排程延遲影響');

console.log('🎉 真實直播影格驗證政策測試全數 PASS!\n');
