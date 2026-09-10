# Per-Station Forecasting & Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each of the 6 sunset / 2 sunrise official livestream lookouts its own locked forecast score, DVR-captured frame, optical ground-truth score, and error verdict — surfaced in the daily briefing and a new homepage ranking panel, and fed equally into the calibration loop.

**Architecture:** A single station registry (`js/stations.js`, mirrored to a checked-in `data/stations.json`) is the source of truth. `WeatherService.fetchForecast` already accepts custom coordinates, so per-station prediction is a loop over stations; differentiation comes from each station's ray-path origin, terrain, elevation, and horizon clearance (weather is shared — nearby stations sit inside one Open-Meteo grid cell). Capture and scoring loop the same station list. A prerequisite honesty fix makes a DVR-seek-failed frame record itself as `live-edge` instead of masquerading as an `exact` frame at the event time.

**Tech Stack:** Node.js 24 (CI) / local Node, Vanilla JS (browser), Python 3 (pillow, numpy), yt-dlp, ffmpeg/ffprobe, GitHub Actions, `browser` CLI (browser-cli skill) for stream verification.

**Spec:** `docs/superpowers/specs/2026-09-10-per-station-forecasting-design.md` — read it alongside this plan.

## Global Constraints

- Use `Asia/Taipei` for all event dates and capture-window checks (`getTaipeiDateString`).
- Never substitute a static image, a simulated optical score, or a post-hoc "prediction" for a real one. A frame that is not from the event's twilight window is **not** ground truth — skip it, do not score it, do not fail the job.
- Preserve legacy on-disk records (`rec-<date>-<session>` with no station id); exclude nothing that already validates. **Do not write a bare-id alias going forward.**
- Station narrative text (`phasePrep` / `phasePost`) stays `"—"`. Hand-written per-station prose was the daily-report fabrication vector (commit `38e9a6d`); never reintroduce it.
- `node tests/run-all-tests.js` and `python tests/test_daily_briefing.py` must be green at the end of every task.
- `videoId` format: `/^[\w-]{11}$/`. `viewAzimuth`: number in `[0, 360)`.
- Commit after every task with a `feat:` / `fix:` / `test:` / `chore:` prefix and the two attribution lines:
  ```
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01S8XSpidfgF3DKzv2gEYGti
  ```

## File Structure

| File | Responsibility | Tasks |
|------|----------------|-------|
| `scripts/live-frame-capture.js` | Add `dvrSeekApplied` to capture evidence | 1 |
| `scripts/live-capture-core.js` | `finalizeCaptureEvidence` passthrough; `live-edge` fidelity; `sessionStreams()` | 1, 2, 6 |
| `scripts/capture-validation.js` | `live-edge` record rules; per-station capture loop; `buildPredictionFromStationLock` | 2, 8, 9 |
| `scripts/score-ground-truth.js` | Twilight-window guard; per-station scoring loop | 3, 10 |
| `js/stations.js` | **New.** Station registry (dual-export). | 4 |
| `data/stations.json` | **New.** Checked-in JSON mirror of `stations.js`. | 4 |
| `scripts/build-stations-json.js` | **New.** Regenerates `data/stations.json`. | 4 |
| `js/spots-data.js` | Import coords from `stations.js`; `taipei-101` → `xiangshan` | 5 |
| `scripts/capture_timelapse_multi_station.py` | Sync comment; covered by sync test | 5 |
| `scripts/lock-forecast.js` | Per-station lock loop; `stations` map in output | 7 |
| `scripts/generate_daily_briefing.py` | Per-station rows; `stationSummary` | 11 |
| `scripts/build-tonight-stations.js` | **New.** `data/tonight-stations.json` generator. | 12 |
| `data/tonight-stations.json` | **New.** Homepage feed (CI-generated). | 12 |
| `index.html` / `js/app.js` | Tonight's-ranking panel | 13 |
| `.github/workflows/lock_forecast.yml` | timeout; tonight-stations step | 14 |
| `.github/workflows/auto_validate_capture.yml` | timeout; tonight-stations step | 14 |
| `tests/test-stations.js` | **New.** Registry invariants + sync checks | 4, 5 |
| `tests/test-live-frame-capture.js` | `dvrSeekApplied` cases | 1 |
| `tests/test-live-capture-core.js` | `sessionStreams`, `live-edge` fidelity | 2, 6 |
| `tests/test-capture-validation.js` | `live-edge` rules, per-station loop | 2, 8, 9 |
| `tests/test-weather-service.js` | per-origin sampling plan | 7 |
| `tests/test_daily_briefing.py` | per-station rows, guard rows | 10, 11 |
| `tests/run-all-tests.js` | register `test-stations.js` | 4 |

---

## PHASE A — DVR-seek honesty fix (independently shippable)

### Task 1: `captureLiveFrame` reports whether the DVR seek actually landed

**Files:**
- Modify: `scripts/live-frame-capture.js` (the `captureLiveFrame` function, ~200–320)
- Modify: `scripts/live-capture-core.js` (`finalizeCaptureEvidence`, ~229–261)
- Test: `tests/test-live-frame-capture.js`

**Interfaces:**
- Produces: `captureLiveFrame(...)` return object now includes `dvrSeekApplied: boolean` — `true` only when the seeked HLS segment produced the output JPEG; `false` when the code fell through to a live-edge `ffmpeg -i streamUrl` grab (seek skipped, seek threw, or seeked `.ts` too small).
- Produces: `finalizeCaptureEvidence({ liveEvidence, windowEvidence, probe, sha256, capturedAt, dvrSeekApplied })` — passes `dvrSeekApplied` (default `false`) straight into the returned evidence object.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test-live-frame-capture.js` (follow the existing `runTool` stub pattern in that file — it injects a fake `runTool`):

```js
// --- DVR seek honesty ---
const baseSource = { id: 'dadaocheng', name: 'x', url: 'https://y', videoId: 'Ndo_8RuefH4', uploaderId: '@z' };
const windowEvidence = { eventTime: '2026-09-10T10:07:00.000Z', offsetMinutes: 300, maxOffsetMinutes: 600 };

// Case A: seeked .ts comes back too small -> live-edge fallback -> dvrSeekApplied false
{
  let call = 0;
  const runTool = (cmd, args) => {
    call++;
    if (cmd === 'yt-dlp') return JSON.stringify({
      is_live: true, id: 'Ndo_8RuefH4', uploader_id: '@z', width: 1920, height: 1080,
      url: 'https://live.edge/stream.m3u8',
      formats: [{ format_id: '95', url: 'https://hls/95.m3u8' }]
    });
    if (cmd === 'curl' && String(args).includes('95.m3u8'))
      return 'https://seg/sq/1000/dur/5.0/file.ts\n';
    if (cmd === 'curl') { fs.writeFileSync(args[args.length - 1], 'tiny'); return ''; } // 4 bytes
    if (cmd === 'ffmpeg') { fs.writeFileSync(args[args.length - 1], Buffer.alloc(20000, 0xff)); return ''; }
    if (cmd === 'ffprobe') return JSON.stringify({ streams: [{ codec_name: 'mjpeg', width: 1920, height: 1080 }] });
    return '';
  };
  const out = `${os.tmpdir()}/dvr-a-${process.pid}.jpg`;
  // assertJpegFile needs a real JPEG header/trailer — the ffmpeg stub writes 0xff filler which fails that.
  // Use the module's real assertJpegFile bypass: write a minimal valid JPEG in the ffmpeg stub instead.
  // (see helper `writeFakeJpeg` already used elsewhere in this file)
}
```

> Implementation note for the engineer: this test file already has a `writeFakeJpeg(path)` helper and a `withTempDir` wrapper — reuse them. The two assertions that matter:
> - Small-`.ts` path → `result.dvrSeekApplied === false`
> - A `.ts` larger than 10000 bytes that ffmpeg converts → `result.dvrSeekApplied === true`

Concretely, add:

```js
test('DVR seek that falls through to live edge reports dvrSeekApplied=false', () => {
  const result = captureLiveFrame({
    source: baseSource, outputPath: tmpJpg, windowEvidence,
    capturedAt: new Date('2026-09-10T15:00:00Z'),
    runTool: stubWithTinyTs   // curl writes a 4-byte .ts
  });
  assert.strictEqual(result.dvrSeekApplied, false);
});

test('DVR seek that produces the frame reports dvrSeekApplied=true', () => {
  const result = captureLiveFrame({
    source: baseSource, outputPath: tmpJpg, windowEvidence,
    capturedAt: new Date('2026-09-10T15:00:00Z'),
    runTool: stubWithGoodTs   // curl writes a >10KB .ts, ffmpeg converts it
  });
  assert.strictEqual(result.dvrSeekApplied, true);
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `node tests/test-live-frame-capture.js`
Expected: FAIL — `result.dvrSeekApplied` is `undefined`.

- [ ] **Step 3: Thread the flag through `captureLiveFrame`**

In `scripts/live-frame-capture.js`, inside `captureLiveFrame`, before the `try` block that runs the yt-dlp metadata call add:

```js
    let dvrSeekApplied = false;
```

Inside the DVR seek block, immediately after the `ffmpeg` call that converts the seeked segment succeeds (inside `if (fs.existsSync(tempTs) && fs.statSync(tempTs).size > 10000) { ... }`, right after `runTool('ffmpeg', [...])`), add:

```js
                if (fs.existsSync(temporaryPath) && fs.statSync(temporaryPath).size > 10000) {
                  dvrSeekApplied = true;
                }
```

Change the `finalizeCaptureEvidence` call to pass it:

```js
    const evidence = finalizeCaptureEvidence({
      liveEvidence,
      windowEvidence,
      probe: JSON.parse(probeText),
      sha256,
      capturedAt,
      dvrSeekApplied
    });
```

- [ ] **Step 4: Passthrough in `finalizeCaptureEvidence`**

In `scripts/live-capture-core.js`, change the signature and return:

```js
function finalizeCaptureEvidence({ liveEvidence, windowEvidence, probe, sha256, capturedAt, dvrSeekApplied = false }) {
```

Add to the returned object (after `sha256: String(sha256).toLowerCase()`):

```js
    sha256: String(sha256).toLowerCase(),
    dvrSeekApplied: dvrSeekApplied === true
  };
```

- [ ] **Step 5: Run the tests, verify they pass**

Run: `node tests/test-live-frame-capture.js && node tests/run-all-tests.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/live-frame-capture.js scripts/live-capture-core.js tests/test-live-frame-capture.js
git commit -m "fix(capture): captureLiveFrame reports whether the DVR seek landed

<attribution lines>"
```

---

### Task 2: A live-edge fallback frame records as `live-edge`, not `exact` at eventTime

**Files:**
- Modify: `scripts/capture-validation.js` (record assembly, ~215–260)
- Modify: `scripts/live-capture-core.js` (`isExactLiveFrameRecord`, ~301–307; export a new constant)
- Test: `tests/test-capture-validation.js`, `tests/test-live-capture-core.js`

**Interfaces:**
- Consumes: `capture.dvrSeekApplied` from Task 1.
- Produces: `LIVE_EDGE_FIDELITY = 'live-edge'` exported from `live-capture-core.js`. A Tier-A capture whose `dvrSeekApplied !== true` **and** whose `|offsetMinutes| > 15` is written with `capture.fidelity = 'live-edge'`, `capture.frameEffectiveTimeUtc = capturedAt`, `capture.dvrRewindMinutes = 0`. `isExactLiveFrameRecord` returns `false` for it.

- [ ] **Step 1: Write the failing tests**

`tests/test-capture-validation.js` — this file stubs `runTool` / `fetchImage` and calls `runCapturePipeline`. Add:

```js
test('a DVR-miss Tier-A frame at large offset is recorded live-edge, stamped at capturedAt', async () => {
  // runTool stub: yt-dlp ok, curl returns a tiny .ts, ffmpeg writes a valid JPEG, ffprobe ok
  // => captureLiveFrame returns dvrSeekApplied:false
  const rec = await runCapturePipeline('sunset', {
    now: new Date('2026-09-10T15:30:00Z'),   // ~5h after an 18:xx TPE sunset -> offset large
    dataDir: tmpDataDir,
    runTool: stubDvrMiss,
  });
  assert.strictEqual(rec.capture.fidelity, 'live-edge');
  assert.strictEqual(rec.capture.dvrRewindMinutes, 0);
  assert.strictEqual(rec.capture.frameEffectiveTimeUtc, rec.capture.capturedAt);
  assert.notStrictEqual(rec.capture.frameEffectiveTimeUtc, rec.targetTime);
});

test('a confirmed DVR seek keeps fidelity exact and frameEffectiveTimeUtc == targetTime', async () => {
  const rec = await runCapturePipeline('sunset', {
    now: new Date('2026-09-10T15:30:00Z'),
    dataDir: tmpDataDir,
    runTool: stubDvrOk,   // curl returns >10KB .ts, ffmpeg converts -> dvrSeekApplied:true
  });
  assert.strictEqual(rec.capture.fidelity, 'exact');
  assert.strictEqual(rec.capture.frameEffectiveTimeUtc, rec.targetTime);
});
```

`tests/test-live-capture-core.js` — add:

```js
assert.strictEqual(
  isExactLiveFrameRecord({
    snapshotUrl: 'data/snapshots/x.jpg',
    capture: { kind: EXACT_CAPTURE_KIND, validated: true, fidelity: 'live-edge' }
  }),
  false,
  'live-edge fidelity must not count as an exact frame'
);
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node tests/test-capture-validation.js`
Expected: FAIL — record still says `fidelity: 'exact'`, `frameEffectiveTimeUtc` == `targetTime`.

- [ ] **Step 3: Add the constant and the guard in `isExactLiveFrameRecord`**

`scripts/live-capture-core.js`:

```js
const LIVE_EDGE_FIDELITY = 'live-edge';
```

Change `isExactLiveFrameRecord`:

```js
function isExactLiveFrameRecord(record) {
  return Boolean(
    isValidatedLiveCaptureRecord(record) &&
    record.capture.kind === EXACT_CAPTURE_KIND &&
    record.capture.fidelity !== 'degraded' &&
    record.capture.fidelity !== LIVE_EDGE_FIDELITY
  );
}
```

Add `LIVE_EDGE_FIDELITY` to `module.exports`.

- [ ] **Step 4: Apply the rule in `capture-validation.js` record assembly**

Just before the `const record = capture ? { ... }` block, compute:

```js
  const { LIVE_EDGE_FIDELITY } = require('./live-capture-core.js');
  const offsetAbs = Math.abs(captureWindow.offsetMinutes);
  const isLiveEdgeFrame =
    capture &&
    capture.fidelity === 'exact' &&
    capture.dvrSeekApplied !== true &&
    offsetAbs > 15;
  const effectiveFidelity = isLiveEdgeFrame ? LIVE_EDGE_FIDELITY : (capture && capture.fidelity) || 'exact';
```

In the `capture ? { ... }` branch, replace the three fields:

```js
          frameEffectiveTimeUtc: isLiveEdgeFrame ? capturedAt.toISOString() : eventTime.toISOString(),
          offsetMinutes: captureWindow.offsetMinutes,
          dvrRewindMinutes: isLiveEdgeFrame ? 0 : captureWindow.offsetMinutes,
          kind: capture.kind || 'youtube-live-frame',
          fidelity: effectiveFidelity,
```

Update the closing log line so a `live-edge` capture is reported honestly:

```js
  console.log(capture
    ? `驗證紀錄已更新 (${effectiveFidelity}): SHA-256 ${capture.sha256}`
    : '已誠實記錄 capture_unavailable，未捏造任何 ground truth');
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `node tests/test-capture-validation.js && node tests/test-live-capture-core.js && node tests/run-all-tests.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/capture-validation.js scripts/live-capture-core.js tests/test-capture-validation.js tests/test-live-capture-core.js
git commit -m "fix(capture): record DVR-miss frames as live-edge, not exact at eventTime

<attribution lines>"
```

---

### Task 3: `score-ground-truth.js` skips frames outside the target twilight window

**Files:**
- Modify: `scripts/score-ground-truth.js` (`runGroundTruthScoring`, ~40–130)
- Test: `tests/test-capture-validation.js` (this suite already exercises scoring via stubs) or a new `tests/test-score-ground-truth.js` registered in `run-all-tests.js`

**Interfaces:**
- Consumes: `record.capture.fidelity`, `record.capture.frameEffectiveTimeUtc`, `record.targetTime`, `record.session`.
- Produces: when a record's frame is `live-edge` **or** its `frameEffectiveTimeUtc` is outside the civil-twilight bracket of `targetTime`, `runGroundTruthScoring` writes `record.verification = { status: 'skipped_out_of_window', groundTruthScore: null, errorAbsolute: null, reason, verifiedAt, isSimulated: false }` and does not invoke the Python analyzer for that record.

- [ ] **Step 1: Write the failing test**

New file `tests/test-score-ground-truth.js`:

```js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGroundTruthScoring } = require('../scripts/score-ground-truth.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgt-'));
const dataDir = path.join(dir, 'data');
fs.mkdirSync(path.join(dataDir, 'snapshots'), { recursive: true });

// a live-edge frame: must be skipped, analyzer must not run
const records = [{
  id: 'rec-2026-09-10-sunset-tamsui', date: '2026-09-10', session: 'sunset', station: 'tamsui',
  targetTime: '2026-09-10T10:07:00.000Z',
  source: 'x', prediction: { score: 44 },
  snapshotUrl: 'data/snapshots/2026-09-10/sunset/tamsui.jpg',
  capture: { kind: 'youtube-live-frame', validated: true, fidelity: 'live-edge',
             frameEffectiveTimeUtc: '2026-09-10T02:24:00.000Z', sha256: 'a'.repeat(64) },
  verification: { status: 'captured_ready_for_scoring', groundTruthScore: null }
}];
fs.writeFileSync(path.join(dataDir, 'verification-records.json'), JSON.stringify(records));

let analyzerCalled = false;
runGroundTruthScoring('2026-09-10', 'sunset', {
  dataDir,
  runAnalyzer: () => { analyzerCalled = true; return { score: 14, badge: 'x', level: 'OVERCAST' }; }
});

const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'verification-records.json')))[0];
assert.strictEqual(analyzerCalled, false, 'analyzer must not run on a live-edge frame');
assert.strictEqual(after.verification.status, 'skipped_out_of_window');
assert.strictEqual(after.verification.groundTruthScore, null);
console.log('✅ score-ground-truth skips out-of-window frames');
```

Register it in `tests/run-all-tests.js` `SUITES` after `'./test-capture-validation.js'`.

> Note: `runGroundTruthScoring` currently takes `(targetDateStr, inputSession, options)` and resolves `dataDir` internally as `path.join(__dirname, '../data')`. Add an `options.dataDir` override (mirrors `capture-validation.js`, which already has one) as part of Step 3.

- [ ] **Step 2: Run the test, verify it fails**

Run: `node tests/test-score-ground-truth.js`
Expected: FAIL — analyzer runs, `assertSnapshotIntegrity` throws on the missing snapshot, or status is not `skipped_out_of_window`.

- [ ] **Step 3: Implement the guard**

In `scripts/score-ground-truth.js`, add near the top:

```js
const SolarCalc = require('../js/solar-calc.js');
const { LIVE_EDGE_FIDELITY } = require('./live-capture-core.js');

function twilightWindow(targetIso, session) {
  const t = SolarCalc.getTimes(new Date(targetIso));
  return session === 'sunrise'
    ? [new Date(t.civilDawn), new Date(t.sunriseGoldenEnd)]
    : [new Date(t.sunsetGoldenStart), new Date(t.civilDusk)];
}

function frameIsInWindow(record) {
  if (record.capture && record.capture.fidelity === LIVE_EDGE_FIDELITY) return false;
  const eff = record.capture && record.capture.frameEffectiveTimeUtc;
  if (!eff) return true; // legacy records without the field: leave existing behavior
  const [start, end] = twilightWindow(record.targetTime, record.session);
  const t = new Date(eff).getTime();
  return t >= start.getTime() && t <= end.getTime();
}
```

Make `runGroundTruthScoring` accept `options.dataDir`:

```js
function runGroundTruthScoring(targetDateStr = '', inputSession = '', options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, '../data');
```

(and use that `dataDir` for `recordsFile` and the snapshots-root check).

Before the `assertSnapshotIntegrity` / analyzer call for a record, add:

```js
  if (!frameIsInWindow(record)) {
    record.verification = {
      status: 'skipped_out_of_window',
      groundTruthScore: null,
      errorAbsolute: null,
      reason: record.capture && record.capture.fidelity === LIVE_EDGE_FIDELITY
        ? 'live-edge frame does not represent the event moment'
        : 'frameEffectiveTimeUtc outside the civil-twilight window of targetTime',
      verifiedAt: new Date().toISOString(),
      isSimulated: false
    };
    fs.writeFileSync(recordsFile, JSON.stringify(records, null, 2), 'utf8');
    console.log(`⏭️  ${record.id}: 影格不在暮光窗口內，跳過評分（不捏造 ground truth）`);
    return record;
  }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node tests/test-score-ground-truth.js && node tests/run-all-tests.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/score-ground-truth.js tests/test-score-ground-truth.js tests/run-all-tests.js
git commit -m "fix(validation): skip optical scoring for frames outside the twilight window

<attribution lines>"
```

---

## PHASE B — Station registry

### Task 4: `js/stations.js`, `data/stations.json`, invariant tests

**Files:**
- Create: `js/stations.js`
- Create: `data/stations.json`
- Create: `scripts/build-stations-json.js`
- Create: `tests/test-stations.js`
- Modify: `tests/run-all-tests.js`

**Interfaces:**
- Produces: `STATIONS` (array), `stationsForSession(session)` → `Station[]` in display order, `primaryStation(session)` → `Station`. `Station = { id, name, icon, session, isPrimary, lat, lng, elevation, videoId, url, uploaderId, viewAzimuth, tag }`. Dual export: `module.exports` and `window.STATIONS` / `window.stationsForSession` / `window.primaryStation`.
- Produces: `data/stations.json` = `JSON.stringify({ generatedFrom: 'js/stations.js', stations: STATIONS }, null, 2) + '\n'`.

- [ ] **Step 1: Verify the 8 streams with the browser-cli skill**

Use the `browser-cli` skill. For each `videoId` below, open `https://www.youtube.com/watch?v=<id>`, confirm: the stream is **live** (not "premiere"/"waiting"), resolution is 4K or at least 1080p, and — by scrubbing the player bar left — note the approximate **DVR rewind depth** in hours. Record findings in the commit message.

| id | videoId to check | expected view |
|----|------------------|---------------|
| dadaocheng | `Ndo_8RuefH4` | W, Tamsui river |
| xiangshan | `z_fY1pj1VBw` | W, 101 + skyline |
| tamsui | `xwAWSh35uuw` | W, open strait |
| bali | `di-4DCblWq4` | W/SW, 淡江大橋 |
| maokong | `215ahZ_0rTg` | W, basin |
| jiufen | `XSD5ptYisw8` | NE, 基隆嶼 |
| hongludi | **find it** — search "烘爐地 即時" on YouTube | E, basin |
| waimushan | **find it** — search "外木山 即時" on YouTube | E, Pacific |

If `hongludi`'s stream turns out not to be DVR-capable, set `isPrimary: true` on `waimushan` instead and note it. If neither sunrise stream is DVR-capable, **stop and report** — the sunrise half of the feature can't produce ground truth.

- [ ] **Step 2: Write the failing invariant tests**

`tests/test-stations.js`:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { STATIONS, stationsForSession, primaryStation } = require('../js/stations.js');

// unique ids
const ids = STATIONS.map(s => s.id);
assert.strictEqual(new Set(ids).size, ids.length, 'station ids must be unique');

for (const s of STATIONS) {
  assert.ok(['sunrise', 'sunset'].includes(s.session), `${s.id}: bad session`);
  assert.ok(/^[\w-]{11}$/.test(s.videoId), `${s.id}: bad videoId`);
  assert.ok(Number.isFinite(s.viewAzimuth) && s.viewAzimuth >= 0 && s.viewAzimuth < 360, `${s.id}: bad viewAzimuth`);
  assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lng), `${s.id}: bad coords`);
  assert.strictEqual(s.url, `https://www.youtube.com/watch?v=${s.videoId}`, `${s.id}: url/videoId mismatch`);
}

for (const session of ['sunrise', 'sunset']) {
  const primaries = STATIONS.filter(s => s.session === session && s.isPrimary);
  assert.strictEqual(primaries.length, 1, `${session}: exactly one isPrimary`);
  assert.strictEqual(primaryStation(session).id, primaries[0].id);
  assert.deepStrictEqual(
    stationsForSession(session).map(s => s.id).sort(),
    STATIONS.filter(s => s.session === session).map(s => s.id).sort()
  );
}

assert.strictEqual(stationsForSession('sunset').length, 6);
assert.strictEqual(stationsForSession('sunrise').length, 2);

// data/stations.json is in sync
const buildStationsJson = require('../scripts/build-stations-json.js');
const onDisk = fs.readFileSync(path.join(__dirname, '../data/stations.json'), 'utf8');
assert.strictEqual(onDisk, buildStationsJson.render(), 'data/stations.json is stale — run scripts/build-stations-json.js');

console.log('✅ station registry invariants + data/stations.json sync');
```

Register `'./test-stations.js'` first in `tests/run-all-tests.js` `SUITES`.

- [ ] **Step 3: Run the test, verify it fails**

Run: `node tests/test-stations.js`
Expected: FAIL — `Cannot find module '../js/stations.js'`.

- [ ] **Step 4: Write `js/stations.js`**

Use the verified videoIds from Step 1. lat/lng/elevation from `js/spots-data.js` (`bali` from Step 1 — pick the camera's coordinates, ~25.15, 121.41). `viewAzimuth` = the camera bearing you observed; for the W-facing sunset cameras 270–295 is typical, `jiufen` ~45, sunrise cameras ~75–95.

```js
/**
 * stations.js — the single source of truth for the 6 sunset / 2 sunrise
 * official livestream lookouts. Dual-exported for Node and the browser.
 * viewAzimuth is metadata (compass hint / framing) — it is NOT fed to the
 * sampling geometry; the upstream ray path always follows the solar azimuth.
 * Keep data/stations.json in sync: node scripts/build-stations-json.js
 */
const STATIONS = [
  { id: 'dadaocheng', name: '台北大稻埕碼頭', icon: '⛵', session: 'sunset', isPrimary: true,
    lat: 25.0570, lng: 121.5077, elevation: 5, videoId: 'Ndo_8RuefH4',
    uploaderId: '@taipeitravelofficial', viewAzimuth: 292,
    tag: '臺北旅遊網 4K 直播・淡水河倒影晚霞' },
  { id: 'xiangshan', name: '台北象山看 101', icon: '🏙️', session: 'sunset', isPrimary: false,
    lat: 25.0290, lng: 121.5728, elevation: 150, videoId: 'z_fY1pj1VBw',
    uploaderId: '@taipeitravelofficial', viewAzimuth: 280,
    tag: '臺北旅遊網 4K 直播・101 與西方天際線' },
  { id: 'tamsui', name: '新北淡水漁人碼頭', icon: '🌉', session: 'sunset', isPrimary: false,
    lat: 25.1833, lng: 121.4121, elevation: 5, videoId: 'xwAWSh35uuw',
    uploaderId: '@newtaipeitravel', viewAzimuth: 270,
    tag: '新北觀光 4K 直播・情人橋烈焰落日' },
  { id: 'bali', name: '新北八里左岸', icon: '🌊', session: 'sunset', isPrimary: false,
    lat: 25.1510, lng: 121.4110, elevation: 5, videoId: 'di-4DCblWq4',
    uploaderId: '@newtaipeitravel', viewAzimuth: 265,
    tag: '新北觀光 4K 直播・淡江大橋與台灣海峽晚霞' },
  { id: 'maokong', name: '台北貓空指南宮', icon: '⛩️', session: 'sunset', isPrimary: false,
    lat: 24.9842, lng: 121.5866, elevation: 280, videoId: '215ahZ_0rTg',
    uploaderId: '@taipeitravelofficial', viewAzimuth: 290,
    tag: '臺北旅遊網 4K 直播・高處俯瞰盆地火燒雲' },
  { id: 'jiufen', name: '新北九份即時影像', icon: '🏮', session: 'sunset', isPrimary: false,
    lat: 25.1100, lng: 121.8383, elevation: 350, videoId: 'XSD5ptYisw8',
    uploaderId: '@newtaipeitravel', viewAzimuth: 45,
    tag: '新北觀光 4K 直播・山海交界落日' },
  { id: 'hongludi', name: '新北中和烘爐地', icon: '⛰️', session: 'sunrise', isPrimary: true,
    lat: 24.9720, lng: 121.4977, elevation: 300, videoId: 'PLACEHOLDER_11',
    uploaderId: '@newtaipeitravel', viewAzimuth: 75,
    tag: '新北觀光・雙北盆地俯瞰晨光' },
  { id: 'waimushan', name: '基隆外木山濱海', icon: '🌊', session: 'sunrise', isPrimary: false,
    lat: 25.1759, lng: 121.7059, elevation: 10, videoId: 'PLACEHOLDER_11',
    uploaderId: '@klcg', viewAzimuth: 95,
    tag: '基隆・太平洋日出第一線' },
];

function withUrl(s) { return { ...s, url: `https://www.youtube.com/watch?v=${s.videoId}` }; }
const RESOLVED = STATIONS.map(withUrl);

function stationsForSession(session) {
  return RESOLVED.filter(s => s.session === session);
}
function primaryStation(session) {
  return RESOLVED.find(s => s.session === session && s.isPrimary);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { STATIONS: RESOLVED, stationsForSession, primaryStation };
}
if (typeof window !== 'undefined') {
  window.STATIONS = RESOLVED;
  window.stationsForSession = stationsForSession;
  window.primaryStation = primaryStation;
}
```

Replace both `PLACEHOLDER_11` with the real sunrise videoIds from Step 1.

- [ ] **Step 5: Write `scripts/build-stations-json.js`**

```js
const fs = require('fs');
const path = require('path');
const { STATIONS } = require('../js/stations.js');

function render() {
  return JSON.stringify({ generatedFrom: 'js/stations.js', stations: STATIONS }, null, 2) + '\n';
}
function write() {
  const out = path.join(__dirname, '../data/stations.json');
  fs.writeFileSync(out, render(), 'utf8');
  console.log(`✅ wrote ${out}`);
}
if (require.main === module) write();
module.exports = { render, write };
```

- [ ] **Step 6: Generate `data/stations.json`**

Run: `node scripts/build-stations-json.js`

- [ ] **Step 7: Run tests, verify green**

Run: `node tests/test-stations.js && node tests/run-all-tests.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add js/stations.js data/stations.json scripts/build-stations-json.js tests/test-stations.js tests/run-all-tests.js
git commit -m "feat(stations): station registry with checked-in data/stations.json mirror

Verified 8 livestreams live + DVR depth: <hours per station>

<attribution lines>"
```

---

### Task 5: Reconcile `spots-data.js` and the multi-station capture script

**Files:**
- Modify: `js/spots-data.js`
- Modify: `scripts/capture_timelapse_multi_station.py` (header comment only)
- Modify: `tests/test-stations.js` (add the sync assertion)
- Check: `tests/test-spots-data.js`, `js/app.js` (map markers), `index.html`

**Interfaces:**
- Consumes: `STATIONS` from `js/stations.js`.
- Produces: `TAIPEI_SPOTS` entries reuse `stations.js` coordinates; the `taipei-101` id becomes `xiangshan`.

- [ ] **Step 1: Write the failing sync test**

Add to `tests/test-stations.js`:

```js
// capture_timelapse_multi_station.py station list agrees with the registry
const pySrc = fs.readFileSync(path.join(__dirname, '../scripts/capture_timelapse_multi_station.py'), 'utf8');
for (const s of STATIONS) {
  if (s.session === 'sunrise' && !['hongludi', 'waimushan'].includes(s.id)) continue;
  assert.ok(pySrc.includes(s.videoId), `capture_timelapse_multi_station.py missing videoId for ${s.id}`);
}
console.log('✅ capture_timelapse_multi_station.py in sync with registry');
```

- [ ] **Step 2: Run it, verify it fails** (bali's `di-4DCblWq4` is not in the Python file).

Run: `node tests/test-stations.js`
Expected: FAIL on `bali`.

- [ ] **Step 3: Update `scripts/capture_timelapse_multi_station.py`**

Add `bali` to the `STATIONS` list in that file (id `bali`, name `八里左岸`, the `di-4DCblWq4` url, lat/lng from `js/stations.js`). Add a header comment above that list:

```python
# ⚠️ 機位清單須與 js/stations.js 同步（tests/test-stations.js 會比對 videoId）。
# 座標取自 js/stations.js 同名機位。
```

- [ ] **Step 4: Update `js/spots-data.js`**

At the top, import and reuse registry coordinates:

```js
const { STATIONS: _REG } = (typeof require !== 'undefined') ? require('./stations.js') : { STATIONS: (window.STATIONS || []) };
const _coord = id => _REG.find(s => s.id === id) || {};
```

For each spot that has a registry twin, replace the literal `lat` / `lng` / `elevation` with `...(_coord('<id>'))` picking `lat, lng, elevation` — or simply `lat: _coord('dadaocheng').lat,` etc. Rename the `taipei-101` entry: `id: 'xiangshan'`, keep its display name.

- [ ] **Step 5: Fix `taipei-101` consumers**

Grep: `grep -rn "taipei-101" js/ index.html tests/`. Update every hit to `xiangshan` (map marker click handlers, any `data-spot` attributes, `test-spots-data.js` expectations).

- [ ] **Step 6: Run tests, verify green**

Run: `node tests/run-all-tests.js`
Expected: PASS (including `test-spots-data.js`, `test-dom-bindings.js`).

- [ ] **Step 7: Commit**

```bash
git add js/spots-data.js scripts/capture_timelapse_multi_station.py tests/test-stations.js js/app.js index.html tests/test-spots-data.js
git commit -m "refactor(stations): spots-data + timelapse script reuse the registry; taipei-101 -> xiangshan

<attribution lines>"
```

---

### Task 6: `sessionStreams(session)` in `live-capture-core.js`

**Files:**
- Modify: `scripts/live-capture-core.js` (`OFFICIAL_STREAMS`, exports)
- Test: `tests/test-live-capture-core.js`

**Interfaces:**
- Consumes: `stationsForSession`, `primaryStation` from `js/stations.js`.
- Produces: `sessionStreams(session)` → `[{ id, name, url, videoId, uploaderId }, ...]` (one per station, display order). `OFFICIAL_STREAMS[session]` still returns the primary station in the same shape as before (`{ id, name, url, videoId, uploaderId }`).

- [ ] **Step 1: Write the failing test**

`tests/test-live-capture-core.js`:

```js
const { sessionStreams, OFFICIAL_STREAMS } = require('../scripts/live-capture-core.js');
assert.strictEqual(sessionStreams('sunset').length, 6);
assert.strictEqual(sessionStreams('sunrise').length, 2);
assert.ok(sessionStreams('sunset').every(s => /^[\w-]{11}$/.test(s.videoId)));
assert.strictEqual(OFFICIAL_STREAMS.sunset.id, 'dadaocheng', 'primary sunset stream unchanged');
assert.strictEqual(OFFICIAL_STREAMS.sunrise.id, 'hongludi', 'primary sunrise stream is now hongludi');
```

- [ ] **Step 2: Run it, verify it fails.**

Run: `node tests/test-live-capture-core.js`
Expected: FAIL — `sessionStreams is not a function`; `OFFICIAL_STREAMS.sunrise.id` is `xiangshan_101`.

- [ ] **Step 3: Implement**

In `scripts/live-capture-core.js`, replace the frozen `OFFICIAL_STREAMS` literal:

```js
const { stationsForSession, primaryStation } = require('../js/stations.js');

function toStream(s) {
  return {
    id: s.id, name: `${s.name}（4K 官方即時影像）`,
    url: s.url, videoId: s.videoId, uploaderId: s.uploaderId,
    lat: s.lat, lng: s.lng   // needed by capture-validation's live per-station fallback (Task 9)
  };
}
function sessionStreams(session) {
  return stationsForSession(session).map(toStream);
}
const OFFICIAL_STREAMS = Object.freeze({
  get sunrise() { return toStream(primaryStation('sunrise')); },
  get sunset() { return toStream(primaryStation('sunset')); }
});
```

Add `sessionStreams` to `module.exports`.

- [ ] **Step 4: Run tests, verify green.**

Run: `node tests/run-all-tests.js`
Expected: PASS. (`capture-validation.js` still uses `OFFICIAL_STREAMS[session]` — unchanged shape, still works.)

- [ ] **Step 5: Commit**

```bash
git add scripts/live-capture-core.js tests/test-live-capture-core.js
git commit -m "feat(stations): sessionStreams() derives the capture list from the registry

<attribution lines>"
```

---

## PHASE C — Per-station prediction & lock

### Task 7: `lock-forecast.js` locks every station in the session

**Files:**
- Modify: `scripts/lock-forecast.js`
- Test: `tests/test-weather-service.js` (per-origin plan), new `tests/test-lock-forecast.js` registered in `run-all-tests.js`

**Interfaces:**
- Consumes: `WeatherService.fetchForecast(true, { lat, lng })`, `stationsForSession`, `primaryStation`.
- Produces: `data/locked-<session>-forecast.json` gains `stations: { <id>: { score, rating, color, weather:{cloudHigh,cloudMid,cloudLow,cloudTotal,humidity,precipProb,visibilityKm}, metrics:{horizonClearance,visKm} } }`. Top-level `skyfire` / `weather` = the primary station's, unchanged shape.

- [ ] **Step 1: Write the failing tests**

`tests/test-weather-service.js` — assert two origins produce different sampling plans:

```js
const geomA = WeatherService.buildSamplingGeometry(25.05, 121.51);
const geomB = WeatherService.buildSamplingGeometry(25.18, 121.41);
assert.notDeepStrictEqual(geomA.sunsetPlan, geomB.sunsetPlan, 'different origins => different ray paths');
```

`tests/test-lock-forecast.js`:

```js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
process.env.MANUAL_SESSION = 'sunset';

// stub WeatherService via require cache
const WS = require('../js/weather-service.js');
let calls = 0;
WS.fetchForecast = async (force, coords) => {
  calls++;
  const score = 30 + calls;              // distinct per station
  return { isSimulated: false, daysForecast: [{
    date: new Date().toISOString(),
    sunset: { skyfire: { score, rating: { badge: 'x', color: '#111' }, metrics: { horizonClearance: 50, visKm: 20 } },
              weather: { cloudHigh: 1, cloudMid: 10, cloudLow: 2, cloudTotal: 12, humidity: 80, precipProb: 5, visibilityKm: 20 } },
    sunrise: { skyfire: { score: 5, rating: { badge: 'x', color: '#111' }, metrics: {} }, weather: {} }
  }]};
};

const { lockForecast } = require('../scripts/lock-forecast.js');   // Step 3 exposes this
await lockForecast({ dataDir: path.join(dir, 'data') });

const locked = JSON.parse(fs.readFileSync(path.join(dir, 'data/locked-sunset-forecast.json'), 'utf8'));
assert.strictEqual(Object.keys(locked.stations).length, 6, 'six sunset stations locked');
assert.strictEqual(locked.skyfire.score, locked.stations.dadaocheng.score, 'top-level mirrors primary');
assert.ok(locked.stations.tamsui.weather.humidity === 80);
console.log('✅ lock-forecast writes a per-station stations map');
```

Register `'./test-lock-forecast.js'` in `run-all-tests.js`.

- [ ] **Step 2: Run, verify fail** (`lockForecast` is not exported; no `stations` key).

- [ ] **Step 3: Refactor `scripts/lock-forecast.js`**

Wrap the existing body in an exported `async function lockForecast({ dataDir } = {})`, defaulting `dataDir` to `path.join(__dirname, '../data')`. Keep the `resolveLockTarget` call. Replace the single `fetchForecast` + `scoreData` block with:

```js
  const { stationsForSession, primaryStation } = require('../js/stations.js');
  const stations = stationsForSession(sessionType);
  const stationLock = {};
  let primarySkyfire = null, primaryWeather = null;

  for (const st of stations) {
    const fc = await WeatherService.fetchForecast(true, { lat: st.lat, lng: st.lng });
    const day = fc.daysForecast.find(d => getTaipeiDateString(new Date(d.date)) === dateStr) || fc.daysForecast[0];
    const sf = day[sessionType];
    if (!sf || !sf.skyfire) { console.warn(`[Lock] ${st.id}: 無預測資料，略過`); continue; }
    const w = sf.weather || {};
    stationLock[st.id] = {
      score: sf.skyfire.score,
      rating: sf.skyfire.rating.badge,
      color: sf.skyfire.rating.color,
      weather: {
        cloudHigh: w.cloudHigh ?? null, cloudMid: w.cloudMid ?? null, cloudLow: w.cloudLow ?? null,
        cloudTotal: w.cloudTotal ?? null, humidity: w.humidity ?? null, precipProb: w.precipProb ?? null,
        visibilityKm: sf.skyfire.metrics?.visKm ?? w.visibilityKm ?? null
      },
      metrics: { horizonClearance: sf.skyfire.metrics?.horizonClearance ?? null, visKm: sf.skyfire.metrics?.visKm ?? null }
    };
    if (st.isPrimary) { primarySkyfire = sf.skyfire; primaryWeather = stationLock[st.id].weather; }
  }

  if (!primarySkyfire) throw new Error('主測站預測缺失，鎖定中止');

  const scoreData = {
    date: dateStr, session: sessionType, lockedAt: new Date().toISOString(),
    skyfire: primarySkyfire,
    weather: primaryWeather,
    stations: stationLock
  };
```

Keep the file-write, using `path.join(dataDir, ...)`. Keep the `if (require.main === module) lockForecast().catch(...)` at the bottom, and `module.exports = { lockForecast }`.

- [ ] **Step 4: Run tests, verify green.**

Run: `node tests/run-all-tests.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lock-forecast.js tests/test-lock-forecast.js tests/test-weather-service.js tests/run-all-tests.js
git commit -m "feat(forecast): lock every station in the session, not just the primary

<attribution lines>"
```

---

### Task 8: `buildPredictionFromStationLock` in `capture-validation.js`

**Files:**
- Modify: `scripts/capture-validation.js` (near `buildPredictionFromLock`, ~30–50)
- Test: `tests/test-capture-validation.js`

**Interfaces:**
- Produces: `buildPredictionFromStationLock(lockedData, stationId)` → `{ score, rating, color, highCloud, midCloud, lowCloud, totalCloud, humidity, precipProb, horizonClearance, visibilityKm, isSimulated:false, lockedAt }` from `lockedData.stations[stationId]`; returns `null` if the station is absent.

- [ ] **Step 1: Write the failing test**

`tests/test-capture-validation.js`:

```js
const { buildPredictionFromStationLock } = require('../scripts/capture-validation.js');
const locked = {
  lockedAt: '2026-09-10T07:30:00Z',
  stations: { tamsui: { score: 51, rating: '局部霞光', color: '#E5A50A',
    weather: { cloudHigh: 2, cloudMid: 40, cloudLow: 8, cloudTotal: 45, humidity: 78, precipProb: 10, visibilityKm: 22 },
    metrics: { horizonClearance: 71, visKm: 22 } } }
};
const p = buildPredictionFromStationLock(locked, 'tamsui');
assert.strictEqual(p.score, 51);
assert.strictEqual(p.lowCloud, 8);
assert.strictEqual(p.horizonClearance, 71);
assert.strictEqual(p.isSimulated, false);
assert.strictEqual(buildPredictionFromStationLock(locked, 'nope'), null);
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**

```js
function buildPredictionFromStationLock(lockedData, stationId) {
  const s = lockedData && lockedData.stations && lockedData.stations[stationId];
  if (!s) return null;
  const w = s.weather || {};
  const m = s.metrics || {};
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    score: s.score, rating: s.rating, color: s.color,
    highCloud: num(w.cloudHigh), midCloud: num(w.cloudMid), lowCloud: num(w.cloudLow),
    totalCloud: num(w.cloudTotal), humidity: num(w.humidity), precipProb: num(w.precipProb),
    horizonClearance: num(m.horizonClearance),
    visibilityKm: num(w.visibilityKm) !== null ? num(w.visibilityKm) : num(m.visKm),
    isSimulated: false,
    lockedAt: lockedData.lockedAt
  };
}
```

Add to `module.exports`.

- [ ] **Step 4: Run tests, verify green.** `node tests/run-all-tests.js`

- [ ] **Step 5: Commit**

```bash
git add scripts/capture-validation.js tests/test-capture-validation.js
git commit -m "feat(capture): buildPredictionFromStationLock reads the per-station lock entry

<attribution lines>"
```

---

## PHASE D — Per-station capture & scoring

### Task 9: `capture-validation.js` captures every station in the session

**Files:**
- Modify: `scripts/capture-validation.js` (`runCapturePipeline`, ~74–290; `writeRecord`, ~63–72)
- Test: `tests/test-capture-validation.js`

**Interfaces:**
- Consumes: `sessionStreams`, `buildPredictionFromStationLock`, the `live-edge` rules from Task 2.
- Produces: one record per station, `id: 'rec-<date>-<session>-<stationId>'`, extra field `station: <stationId>`, `snapshotUrl: 'data/snapshots/<date>/<session>/<stationId>.jpg'`. No bare-id alias. `writeRecord` slice cap `90` → `720`. One station throwing never aborts the loop.

- [ ] **Step 1: Write the failing tests**

`tests/test-capture-validation.js`:

```js
test('captures all 6 sunset stations; one failing does not abort the rest', async () => {
  const rec = await runCapturePipelineAll('sunset', {
    now: new Date('2026-09-10T10:40:00Z'),   // just after sunset TPE, small offset
    dataDir: tmpDataDir,
    // stub: station 'jiufen' throws on yt-dlp, others succeed
    runToolFor: (stationId) => stationId === 'jiufen' ? stubThrows : stubGoodExact,
  });
  const records = JSON.parse(fs.readFileSync(path.join(tmpDataDir, 'verification-records.json')));
  const ids = records.map(r => r.id);
  assert.ok(ids.includes('rec-2026-09-10-sunset-dadaocheng'));
  assert.ok(ids.includes('rec-2026-09-10-sunset-jiufen'));
  assert.ok(!ids.includes('rec-2026-09-10-sunset'), 'no bare-id alias');
  const jiufen = records.find(r => r.id === 'rec-2026-09-10-sunset-jiufen');
  assert.strictEqual(jiufen.verification.status, 'capture_unavailable');
  assert.strictEqual(jiufen.station, 'jiufen');
  const dada = records.find(r => r.id === 'rec-2026-09-10-sunset-dadaocheng');
  assert.strictEqual(dada.snapshotUrl, 'data/snapshots/2026-09-10/sunset/dadaocheng.jpg');
});
```

> The existing `runCapturePipeline(session, options)` becomes a per-station loop internally; keep its name and signature. `options.runToolFor(stationId)` is a new test seam — when absent, fall back to `options.runTool` for every station (existing behavior).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Refactor `runCapturePipeline`**

Move the per-station work (snapshot path, lock lookup, `captureLiveFrame` try/catch, record assembly, `writeRecord`) into a helper `captureOneStation(station, ctx)` where `ctx` carries `{ dateStr, sessionType, eventTime, captureWindow, windowError, capturedAt, dataDir, lockedData, options }`. Then:

```js
  const { sessionStreams } = require('./live-capture-core.js');
  const stations = sessionStreams(sessionType);
  const results = [];
  for (const st of stations) {
    try {
      results.push(await captureOneStation(st, ctx));
    } catch (err) {
      console.error(`[capture] ${st.id} 未預期錯誤，記為 capture_unavailable: ${err.message}`);
      results.push(writeRecord(recordsFile, unavailableRecord(st, ctx, err.message)));
    }
  }
  return results;   // was: return record
```

In `captureOneStation`:
- `snapshotPath = path.join(dataDir, 'snapshots', dateStr, sessionType, `${station.id}.jpg`)` — `fs.mkdirSync(path.dirname(snapshotPath), { recursive: true })`.
- `prediction = lockedData ? buildPredictionFromStationLock(lockedData, station.id) : null` → if `null`, fall back to the existing live `WeatherService.fetchForecast(true, { lat: station.lat, lng: station.lng })` path (needs `station.lat/lng` — `sessionStreams` must include them; extend `toStream` in Task 6 to also carry `lat`, `lng`, or look them up from `stationsForSession`). **Adjust Task 6's `toStream` now** to include `lat` and `lng`.
- `baseRecord.id = `rec-${dateStr}-${sessionType}-${station.id}``, `baseRecord.station = station.id`, `baseRecord.source = station.name`.
- Record `capture` block uses the `isLiveEdgeFrame` / `effectiveFidelity` logic from Task 2.
- `snapshotUrl` = `data/snapshots/${dateStr}/${sessionType}/${station.id}.jpg` (posix separators — build with `.split(path.sep).join('/')` or template directly).

In `writeRecord`, change `records.slice(0, 90)` → `records.slice(0, 720)`.

Update `if (require.main === module)` to log a per-station summary line.

- [ ] **Step 4: Run tests, verify green.** `node tests/run-all-tests.js`

- [ ] **Step 5: Commit**

```bash
git add scripts/capture-validation.js tests/test-capture-validation.js scripts/live-capture-core.js
git commit -m "feat(capture): per-station capture loop with isolated failure and layered snapshot paths

<attribution lines>"
```

---

### Task 10: `score-ground-truth.js` scores every station's frame

**Files:**
- Modify: `scripts/score-ground-truth.js` (`runGroundTruthScoring`, ~40–130)
- Test: `tests/test-score-ground-truth.js`

**Interfaces:**
- Consumes: the twilight guard from Task 3, per-station records from Task 9.
- Produces: `runGroundTruthScoring(dateStr, session, options)` iterates every record whose `id` starts with `rec-<date>-<session>` (with or without a station suffix) and `isValidatedLiveCaptureRecord(record)`; scores each, writing per-record `verification`. Returns the array of processed records.

- [ ] **Step 1: Extend the test**

Add to `tests/test-score-ground-truth.js`: three per-station records for `2026-09-10 sunset` — one in-window `exact` (scored), one `live-edge` (skipped), one still `capture_unavailable` (untouched). Assert the analyzer runs exactly once, and each record ends in the right `verification.status`.

```js
const recs = [
  mkRecord('dadaocheng', 'exact', inWindowIso),
  mkRecord('tamsui', 'live-edge', outOfWindowIso),
  { id: 'rec-2026-09-10-sunset-jiufen', station: 'jiufen', date: '2026-09-10', session: 'sunset',
    targetTime, snapshotUrl: null, capture: { fidelity: 'none' },
    verification: { status: 'capture_unavailable', groundTruthScore: null } },
];
// ... write, run with a counting analyzer stub, assert:
assert.strictEqual(analyzerCalls, 1);
assert.strictEqual(byId('dadaocheng').verification.status, 'verified_completed');
assert.strictEqual(byId('tamsui').verification.status, 'skipped_out_of_window');
assert.strictEqual(byId('jiufen').verification.status, 'capture_unavailable');
```

- [ ] **Step 2: Run, verify fail** — current code resolves a single `targetId = rec-<date>-<session>` and throws if not found.

- [ ] **Step 3: Implement the loop**

Replace the single-record lookup:

```js
  const prefix = `rec-${dateStr}-${sessionType}`;
  const targets = records.filter(r =>
    (r.id === prefix || r.id.startsWith(`${prefix}-`)) && isValidatedLiveCaptureRecord(r)
  );
  if (targets.length === 0) {
    console.warn(`無可評分的已擷取影格: ${prefix}*`);
    return [];
  }

  const processed = [];
  for (const record of targets) {
    if (!frameIsInWindow(record)) {
      record.verification = { status: 'skipped_out_of_window', groundTruthScore: null, errorAbsolute: null,
        reason: /* from Task 3 */, verifiedAt: new Date().toISOString(), isSimulated: false };
      processed.push(record);
      continue;
    }
    const snapshotPath = path.resolve(path.join(dataDir, '..'), record.snapshotUrl);
    // ... existing snapshots-root check, assertSnapshotIntegrity, analyzer call, verdict ...
    record.verification = { /* existing verified_completed shape */ };
    processed.push(record);
    console.log(`  ${record.id}: 實測 ${groundTruthScore} / 誤差 ${errorAbsolute}`);
  }
  fs.writeFileSync(recordsFile, JSON.stringify(records, null, 2), 'utf8');
  return processed;
```

Keep `capture_unavailable` records untouched (they fail `isValidatedLiveCaptureRecord`, so they're never in `targets`).

- [ ] **Step 4: Run tests, verify green.** `node tests/run-all-tests.js`

- [ ] **Step 5: Commit**

```bash
git add scripts/score-ground-truth.js tests/test-score-ground-truth.js
git commit -m "feat(validation): score every station's captured frame, guarded by the twilight window

<attribution lines>"
```

---

## PHASE E — Reporting & homepage

### Task 11: `generate_daily_briefing.py` emits one real row per station

**Files:**
- Modify: `scripts/generate_daily_briefing.py` (`resolve_target_record`, `build_station_rows`, `generate_briefing`, ~50–260)
- Test: `tests/test_daily_briefing.py`

**Interfaces:**
- Consumes: per-station records; `data/stations.json`.
- Produces: `report.stations` = one row per station record for the target date/session (primary first). Row = `{ name, icon, tag, phasePrep: "—", phasePeak, phasePost: "—", forecast, verdict, verdictColor }`. `report.stationSummary = { verified, pending, bestStation, bestScore, worstError, meanError }`. Top-level `report.prediction` / `report.groundTruth` = the primary station's.

- [ ] **Step 1: Write the failing tests**

`tests/test_daily_briefing.py` — add per-station fixtures:

```python
records = [
  {"id": "rec-2026-09-10-sunset-dadaocheng", "station": "dadaocheng", "date": "2026-09-10", "session": "sunset",
   "prediction": {"score": 44, "lowCloud": 5, "highCloud": 0, "midCloud": 2, "humidity": 80},
   "capture": {"kind": "youtube-live-frame", "validated": True, "fidelity": "exact"},
   "verification": {"status": "verified_completed", "groundTruthScore": 15, "groundTruthBadge": "陰沉沉寂",
                    "verdict": "MISMATCH", "verdictBadge": "⚠️ 出現偏差需校準", "errorAbsolute": 29}},
  {"id": "rec-2026-09-10-sunset-tamsui", "station": "tamsui", "date": "2026-09-10", "session": "sunset",
   "prediction": {"score": 51, "lowCloud": 8},
   "verification": {"status": "skipped_out_of_window", "groundTruthScore": None}},
]
report = briefing.generate_briefing_obj(records, {}, "sunset", "2026-09-10")   # Step 3 exposes this pure helper
assert len(report["stations"]) == 2
assert report["stations"][0]["name"].endswith("大稻埕碼頭") or "大稻埕" in report["stations"][0]["name"]
assert report["stations"][0]["phasePrep"] == "—" and report["stations"][0]["phasePost"] == "—"
assert "光學觀測判定 15" in report["stations"][0]["phasePeak"]
assert report["stations"][1]["verdict"].startswith("⏳")           # skipped -> pending, not a hit
assert report["stationSummary"]["verified"] == 1
assert report["stationSummary"]["pending"] == 1
assert report["prediction"]["score"] == 44                          # primary
```

Keep the existing `resolve_target_record` single-record tests working (rename internally but keep a compatibility shim, or update those asserts to the plural form).

- [ ] **Step 2: Run, verify fail.** `python tests/test_daily_briefing.py`

- [ ] **Step 3: Implement**

- Add `_load_stations()` reading `data/stations.json` → `{id: {...}}`.
- `resolve_target_records(records, session, today_str)` → list of all `rec-<today>-<session>-*` (fallback: all `rec-<yesterday>-<session>-*`; never older). Primary station first (from `data/stations.json`).
- Extract a pure `generate_briefing_obj(records, locked, session, date_str)` returning the report dict (so tests don't touch the filesystem/clock). `generate_briefing` becomes: resolve session/date, load files, call `generate_briefing_obj`, write `daily-reports.json`.
- `build_station_rows(station_records, locked, stations_meta)`:

```python
def build_station_rows(recs, locked, meta):
    rows = []
    for r in recs:
        sid = r.get("station")
        m = meta.get(sid, {})
        v = r.get("verification") or {}
        st = v.get("status")
        if st == "verified_completed" and v.get("groundTruthScore") is not None:
            peak = f"光學觀測判定 {v['groundTruthScore']} 分（{v.get('groundTruthBadge') or '—'}）"
            verdict = v.get("verdictBadge") or v.get("verdict") or "—"
            color = VERDICT_COLORS.get(v.get("verdict"), "#94A3B8")
        elif st == "capture_unavailable":
            peak, verdict, color = "擷取失敗，本場無實測影格", "⏳ 實測待驗證", "#94A3B8"
        elif st == "skipped_out_of_window":
            peak, verdict, color = "影格不在暮光窗口內，未評分", "⏳ 實測待驗證", "#94A3B8"
        else:
            peak, verdict, color = "影格已擷取，光學評分尚未完成", "⏳ 實測待驗證", "#94A3B8"
        pred = r.get("prediction") or {}
        forecast = "—"
        if pred.get("score") is not None:
            forecast = f"{pred['score']} 分"
            if pred.get("lowCloud") is not None:
                forecast += f"（低雲 {pred['lowCloud']}%）"
        rows.append({
            "name": m.get("name") or sid or "官方直播影格",
            "icon": m.get("icon") or "📹",
            "tag": m.get("tag") or "官方 4K 直播・DVR 回溯精確影格",
            "phasePrep": "—", "phasePeak": peak, "phasePost": "—",
            "forecast": forecast, "verdict": verdict, "verdictColor": color,
        })
    return rows
```

- `build_station_summary(recs)`:

```python
def build_station_summary(recs):
    verified = [r for r in recs if (r.get("verification") or {}).get("groundTruthScore") is not None]
    pending = [r for r in recs if r not in verified]
    out = {"verified": len(verified), "pending": len(pending),
           "bestStation": None, "bestScore": None, "worstError": None, "meanError": None}
    if verified:
        errs = [(r["verification"]["errorAbsolute"], r) for r in verified
                if r["verification"].get("errorAbsolute") is not None]
        best = max(verified, key=lambda r: r["verification"]["groundTruthScore"])
        out["bestStation"] = best.get("station")
        out["bestScore"] = best["verification"]["groundTruthScore"]
        if errs:
            out["worstError"] = max(e for e, _ in errs)
            out["meanError"] = round(sum(e for e, _ in errs) / len(errs), 1)
    return out
```

- In `generate_briefing_obj`, `prediction` / `ground_truth` come from the primary station's record (first in the list); `report["stations"] = build_station_rows(...)`, `report["stationSummary"] = build_station_summary(...)`.

- [ ] **Step 4: Run tests, verify green.**

Run: `python tests/test_daily_briefing.py && node tests/run-all-tests.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate_daily_briefing.py tests/test_daily_briefing.py
git commit -m "feat(briefing): one real per-station row + stationSummary, no hand-written prose

<attribution lines>"
```

---

### Task 12: `data/tonight-stations.json` generator

**Files:**
- Create: `scripts/build-tonight-stations.js`
- Create: `data/tonight-stations.json` (initial run output, committed)
- Test: new `tests/test-build-tonight-stations.js` registered in `run-all-tests.js`

**Interfaces:**
- Consumes: `data/locked-<session>-forecast.json`, `js/stations.js`.
- Produces: `buildTonightStations({ dataDir, session, now })` writes `data/tonight-stations.json`:
  `{ session, date, generatedAt, stations: [{ id, name, icon, score, rating, color, viewAzimuth, tag, youtubeUrl }] }` sorted by `score` desc. Missing stations (absent from the lock's `stations` map) are omitted.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { buildTonightStations } = require('../scripts/build-tonight-stations.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-'));
fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
fs.writeFileSync(path.join(dir, 'data/locked-sunset-forecast.json'), JSON.stringify({
  date: '2026-09-10', session: 'sunset',
  stations: { dadaocheng: { score: 44, rating: 'x', color: '#111' }, tamsui: { score: 51, rating: 'y', color: '#222' } }
}));
buildTonightStations({ dataDir: path.join(dir, 'data'), session: 'sunset', now: new Date('2026-09-10T09:00:00Z') });
const out = JSON.parse(fs.readFileSync(path.join(dir, 'data/tonight-stations.json'), 'utf8'));
assert.strictEqual(out.stations[0].id, 'tamsui', 'sorted by score desc');
assert.strictEqual(out.stations.length, 2);
assert.ok(out.stations[0].youtubeUrl.includes('watch?v='));
console.log('✅ build-tonight-stations');
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `scripts/build-tonight-stations.js`**

```js
const fs = require('fs');
const path = require('path');
const { STATIONS } = require('../js/stations.js');
const { getTaipeiDateString } = require('./live-capture-core.js');

function pickSession(now) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit' }).format(now));
  return hour < 15 ? 'sunrise' : 'sunset';
}

function buildTonightStations({ dataDir = path.join(__dirname, '../data'), session, now = new Date() } = {}) {
  const sess = session || pickSession(now);
  const lockPath = path.join(dataDir, `locked-${sess}-forecast.json`);
  const locked = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : {};
  const map = locked.stations || {};
  const meta = Object.fromEntries(STATIONS.map(s => [s.id, s]));

  const stations = Object.entries(map)
    .filter(([id]) => meta[id])
    .map(([id, s]) => ({
      id, name: meta[id].name, icon: meta[id].icon,
      score: s.score, rating: s.rating, color: s.color,
      viewAzimuth: meta[id].viewAzimuth, tag: meta[id].tag, youtubeUrl: meta[id].url
    }))
    .sort((a, b) => b.score - a.score);

  const out = {
    session: sess,
    date: locked.date || getTaipeiDateString(now),
    generatedAt: new Date().toISOString(),
    stations
  };
  fs.writeFileSync(path.join(dataDir, 'tonight-stations.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  return out;
}

if (require.main === module) buildTonightStations();
module.exports = { buildTonightStations, pickSession };
```

- [ ] **Step 4: Generate the initial file**

Run: `node scripts/build-tonight-stations.js` (uses whatever `locked-*-forecast.json` exists; commit the result).

- [ ] **Step 5: Run tests, verify green.** `node tests/run-all-tests.js`

- [ ] **Step 6: Commit**

```bash
git add scripts/build-tonight-stations.js data/tonight-stations.json tests/test-build-tonight-stations.js tests/run-all-tests.js
git commit -m "feat(homepage): tonight-stations.json — stations ranked by locked forecast

<attribution lines>"
```

---

### Task 13: Homepage ranking panel

**Files:**
- Modify: `index.html` (new `<section>` after `forecast-5day-section`, ~304–318; a `<style>` block or existing CSS file)
- Modify: `js/app.js` (`loadTonightStations`, call site in the `DOMContentLoaded` handler ~1054)
- Test: `tests/test-dom-bindings.js` (assert the container id exists and the render function is defined)

**Interfaces:**
- Consumes: `data/tonight-stations.json`.
- Produces: `App.prototype.loadTonightStations()` — fetches the JSON, renders `#tonightStationsContainer`. Silent no-op if the file is missing.

- [ ] **Step 1: Write the failing test**

`tests/test-dom-bindings.js` — this suite parses `index.html` and checks element ids / handler wiring. Add:

```js
assert.ok(html.includes('id="tonightStationsContainer"'), 'homepage has the tonight-stations container');
assert.ok(appJs.includes('loadTonightStations'), 'app.js defines loadTonightStations');
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Add the section to `index.html`**

After the `forecast-5day-section` `</section>`:

```html
<section class="tonight-stations-section">
  <div class="section-header">
    <h2>📸 今晚各機位預測排名</h2>
    <p class="section-sub" id="tonightStationsSub">依模型鎖定預測分數排序</p>
  </div>
  <div id="tonightStationsContainer" class="tonight-stations-grid"></div>
</section>
```

Add minimal CSS (reuse existing card variables):

```css
.tonight-stations-grid { display: grid; gap: 12px; }
.tonight-station-card { display: flex; align-items: center; gap: 12px; padding: 12px 16px;
  border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--card-bg); }
.tonight-station-rank { font-size: 1.1rem; font-weight: 800; opacity: 0.5; min-width: 1.5em; }
.tonight-station-score { margin-left: auto; font-weight: 800; font-size: 1.15rem; }
```

- [ ] **Step 4: Implement `loadTonightStations` in `js/app.js`**

```js
async loadTonightStations() {
  const el = document.getElementById('tonightStationsContainer');
  const sub = document.getElementById('tonightStationsSub');
  if (!el) return;
  try {
    const res = await fetch('data/tonight-stations.json');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.stations || !data.stations.length) return;
    if (sub) sub.textContent = `${data.date}・${data.session === 'sunrise' ? '今晨日出 2 站' : '今晚日落 6 站'}・依鎖定預測排序`;
    el.innerHTML = data.stations.map((s, i) => `
      <a class="tonight-station-card" href="${s.youtubeUrl}" target="_blank" rel="noopener">
        <span class="tonight-station-rank">${i + 1}</span>
        <span>${s.icon} <strong>${s.name}</strong><br>
          <span style="font-size:0.72rem;color:var(--text-muted);">${s.tag} ・ 方位 ${Math.round(s.viewAzimuth)}°</span></span>
        <span class="tonight-station-score" style="color:${s.color};">${s.score}</span>
      </a>`).join('');
  } catch (err) {
    console.warn('載入今晚機位排名失敗:', err);
  }
}
```

Call it from the `DOMContentLoaded` handler alongside `loadDailyReportsAndArchive()`.

- [ ] **Step 5: Run tests, verify green.** `node tests/run-all-tests.js`

- [ ] **Step 6: Verify in the browser**

Use the `browser-cli` skill: serve the repo root (`python -m http.server 8000`), open `http://localhost:8000/`, screenshot the new section, confirm the cards render and the links resolve.

- [ ] **Step 7: Commit**

```bash
git add index.html js/app.js tests/test-dom-bindings.js
git commit -m "feat(homepage): tonight's per-station forecast ranking panel

<attribution lines>"
```

---

## PHASE F — Workflows

### Task 14: Wire the new steps into CI

**Files:**
- Modify: `.github/workflows/lock_forecast.yml`
- Modify: `.github/workflows/auto_validate_capture.yml`

**Interfaces:** none (CI only).

- [ ] **Step 1: `lock_forecast.yml`**

- Add `timeout-minutes: 10` to the `lock-forecast` job.
- After the "Run Lock Forecast Script" step, add:

```yaml
      - name: 🗂️ 產生今晚機位排名
        run: node scripts/build-tonight-stations.js
```

(before the "Commit & Push Locked Forecast" step; `git add data/` already covers `tonight-stations.json`).

- [ ] **Step 2: `auto_validate_capture.yml`**

- Change `timeout-minutes: 20` → `timeout-minutes: 30`.
- After the "產生每日實況驗證日報" step, add:

```yaml
      - name: 🗂️ 更新今晚機位排名
        if: always()
        run: node scripts/build-tonight-stations.js "${{ steps.session.outputs.value }}"
```

- Confirm `git add data/` in the commit step covers `data/snapshots/<date>/<session>/` (it does — the pattern is recursive).

- [ ] **Step 3: Lint the YAML**

Run: `node -e "require('js-yaml')" 2>/dev/null && npx --yes js-yaml .github/workflows/lock_forecast.yml >/dev/null && npx --yes js-yaml .github/workflows/auto_validate_capture.yml >/dev/null && echo OK` — or just eyeball indentation against the existing steps.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/lock_forecast.yml .github/workflows/auto_validate_capture.yml
git commit -m "ci: per-station timeouts + tonight-stations generation step

<attribution lines>"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §1 station registry + invariants | 4 |
| §2 `data/stations.json` checked in | 4 |
| §3 weather-service no change (custom coords already work) | 7 (test only) |
| §4 per-station lock + `stations` map | 7 |
| §5 DVR-seek honesty (`dvrSeekApplied`, `live-edge`) | 1, 2 |
| §6 `sessionStreams`, `OFFICIAL_STREAMS` getter, `live-edge` fidelity | 2, 6 |
| §7 per-station capture loop, layered paths, no alias, slice 720 | 9 |
| §8 per-station scoring + twilight guard | 3, 10 |
| §9 per-station briefing rows + `stationSummary` | 11 |
| §10 `tonight-stations.json` | 12 |
| §11 homepage panel | 13 |
| §12 calibration — no change, note limitation | (verified: `auto-calibrate-model.py` untouched; §12 limitation documented in spec) |
| §13 workflows | 14 |
| §C sunrise primary = `hongludi` | 4 (Step 1 confirms DVR; `isPrimary` set), 6 (test asserts it) |
| jiufen limitation (viewAzimuth metadata only) | 4 (comment in `stations.js`), 7 (ray path uses solar azimuth, unchanged) |

No spec requirement is left without a task.

**Placeholder scan:** `PLACEHOLDER_11` in Task 4 Step 4 is explicitly a fill-in resolved by Task 4 Step 1 (browser-cli lookup) — flagged, not silent. All other code blocks are complete.

**Type consistency:**
- `dvrSeekApplied` (boolean) — introduced Task 1, consumed Tasks 2, (indirectly) 9. Consistent.
- `LIVE_EDGE_FIDELITY = 'live-edge'` — Task 2, consumed Tasks 3, 10. Consistent.
- `sessionStreams(session)` returns `{id,name,url,videoId,uploaderId,lat,lng}` — Task 6 (lat/lng added per Task 9 Step 3 note). Consumed Task 9. **Action:** Task 6 Step 3 `toStream` must include `lat`, `lng` — folded into Task 9's note; apply in Task 6.
- `buildPredictionFromStationLock(lockedData, stationId)` — Task 8, consumed Task 9. Consistent.
- record `id` = `rec-<date>-<session>-<stationId>`, field `station` — Task 9, consumed Tasks 10, 11. Consistent.
- `verification.status` values: `verified_completed`, `capture_unavailable`, `skipped_out_of_window`, `captured_ready_for_scoring` — consistent across Tasks 3, 9, 10, 11.
- `stationSummary` keys `{verified,pending,bestStation,bestScore,worstError,meanError}` — Task 11 only. Consistent.
- `buildTonightStations({dataDir,session,now})` — Task 12, consumed Task 14. Consistent.

**Fix applied inline:** Task 6 `toStream` gains `lat`/`lng` (noted in both Task 6 and Task 9).
