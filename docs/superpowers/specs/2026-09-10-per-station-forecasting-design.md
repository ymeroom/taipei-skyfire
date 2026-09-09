# Per-Station Forecasting & Validation — Design Spec

**Date:** 2026-09-10
**Status:** Approved for planning
**Approach:** Shared local weather + per-station geometry (方案 2)

## Problem

The prediction engine emits **one "Taipei" skyfire score per session**. The
website, the locked-forecast files, `verification-records.json`,
`score-ground-truth.js`, and the daily briefing all assume that single score.

The user expects **one forecast score per observation station** — 6 sunset
lookouts, 2 sunrise lookouts — each independently locked, captured, optically
scored, and error-checked, so the daily report and homepage can answer "which
lookout should I shoot tonight" and the calibration loop gets more samples.

The 6-station format that already exists in `daily-reports.json` history and in
`app.js`'s table renderer is the **old fabricated one** (hand-written, static,
identical every day — the reason "fake daily reports" went undetected until
commit `38e9a6d`). This design brings the 6/2 rows back, but every number in
them is real per-station computation or a real per-station measurement.

## Scope

In scope:

- New single-source-of-truth station registry.
- Per-station prediction in `lock-forecast.js` → per-station `stations` map in
  `locked-<session>-forecast.json`.
- Per-station capture + optical scoring in `capture-validation.js` /
  `score-ground-truth.js` → per-station records in `verification-records.json`.
- Per-station rows in `generate_daily_briefing.py` → `daily-reports.json`.
- New homepage panel: tonight's stations ranked by predicted score, fed by a
  CI-generated static `data/tonight-stations.json`.
- All per-station verified records feed `auto-calibrate-model.py` equally.
- Workflow timeout bumps + the `tonight-stations.json` generation step.
- Tests for every changed unit.

Out of scope (note but do not touch):

- The hardcoded `statAcc = '96.5%'` / `statMAE = '±3.8 分'` in `app.js`
  (lines ~815–817) — same data-honesty smell, separate fix.
- GitHub schedule drift / punctual locking.
- Client-side per-station forecasting in the browser.

## Sessions & Stations

| id | name | icon | session | isPrimary | videoId | viewAzimuth notes |
|----|------|------|---------|-----------|---------|-------------------|
| `dadaocheng` | 台北大稻埕碼頭 | ⛵ | sunset | ✅ | `Ndo_8RuefH4` | ≈ solar sunset azimuth |
| `xiangshan` | 台北象山看 101 | 🏙️ | sunset | | `z_fY1pj1VBw` | W over basin toward 觀音山 |
| `tamsui` | 新北淡水漁人碼頭 | 🌉 | sunset | | `xwAWSh35uuw` | W over open Taiwan Strait |
| `bali` | 新北八里左岸 | 🌊 | sunset | | `di-4DCblWq4` | W/SW over strait, 淡江大橋 |
| `maokong` | 台北貓空指南宮 | ⛩️ | sunset | | `215ahZ_0rTg` | high vantage, W over basin |
| `jiufen` | 新北九份即時影像 | 🏮 | sunset | | `XSD5ptYisw8` | **faces NE (~45°)** — override required |
| `hongludi` | 新北中和烘爐地 | ⛰️ | sunrise | ✅ | (verify) | E over basin |
| `waimushan` | 基隆外木山濱海 | 🌊 | sunrise | | (verify) | E over Pacific |

`viewAzimuth` (numeric, degrees) is the camera's actual bearing. For most
stations it is close to the computed solar azimuth and could be omitted, but
**`jiufen` at sunset and both sunrise stations must set it explicitly** or the
upstream ray path samples the wrong ocean.

lat/lng/elevation come from `js/spots-data.js` where present (`bali` is absent
there and must be added). Exact `viewAzimuth` values and the two sunrise
videoIds are resolved during implementation via `browser-cli` (confirm each
stream is live, 4K, DVR-capable, and note its rewind depth).

## Components

### 1. `js/stations.js` — station registry (new)

Plain data module, `module.exports` + `window.STATIONS` dual-export (same
pattern as `spots-data.js`). One array of station objects with the fields in
the table above plus `lat`, `lng`, `elevation`, `url` (derived from videoId),
`uploaderId`, `tag`.

Helpers:

- `stationsForSession(session)` → array, in a stable display order.
- `primaryStation(session)` → the `isPrimary` station (exactly one per session).

Invariants (enforced by tests): unique ids; `session ∈ {sunrise, sunset}`;
exactly one `isPrimary` per session; `videoId` matches `/^[\w-]{11}$/`;
`viewAzimuth` in `[0, 360)` when present.

**Reconciliation:** `spots-data.js` keeps its map-UI role but imports
coordinates from `stations.js` (no duplicated lat/lng). `xiangshan` supersedes
the old `taipei-101` id — `spots-data.js` consumers updated.
`capture_timelapse_multi_station.py` keeps an inline station list but gains a
header comment "keep in sync with js/stations.js"; a test asserts the two lists
agree on id/lat/lng/videoId.

### 2. `js/weather-service.js` — per-station geometry

Add an optional third argument to `fetchForecast`:

```js
static async fetchForecast(forceRefresh = false, customCoords = null, geometryOptions = null)
// geometryOptions: { sunsetAzimuth?: number, sunriseAzimuth?: number }
```

Threaded into `buildSamplingGeometry(lat, lng, referenceDate, geometryOptions)`:
when `sunsetAzimuth` / `sunriseAzimuth` is a finite number, use it instead of
`SolarCalcModule.getPosition(...).azimuth` for that session's anchor and
`buildRayPathSamplingPlan`. Default `null` → current behavior, byte-for-byte.

No caching when `customCoords` is set (already true). The browser's existing
`fetchForecast()` / `fetchForecast(true)` calls are unaffected.

### 3. `scripts/lock-forecast.js` — per-station lock

After `resolveLockTarget` gives `{ session, dateStr }`:

```
stations = stationsForSession(session)
for st of stations:
    fc = await WeatherService.fetchForecast(true, {lat: st.lat, lng: st.lng},
             session === 'sunset' ? { sunsetAzimuth: st.viewAzimuth }
                                  : { sunriseAzimuth: st.viewAzimuth })
    day = fc.daysForecast matching dateStr (fallback [0])
    sf  = day[session]
    stationLock[st.id] = {
      score: sf.skyfire.score,
      rating: sf.skyfire.rating.badge,
      color: sf.skyfire.rating.color,
      weather: { cloudHigh, cloudMid, cloudLow, cloudTotal, humidity, precipProb, visibilityKm },
      metrics: { horizonClearance: sf.skyfire.metrics.horizonClearance, visKm: sf.skyfire.metrics.visKm },
      viewAzimuth: st.viewAzimuth ?? null
    }
```

Output file `data/locked-<session>-forecast.json`:

```jsonc
{
  "date": "...", "session": "...", "lockedAt": "...",
  "skyfire": <primary station's full sf.skyfire>,   // top-level kept for back-compat + existing tests
  "weather": <primary station's weather block>,      // "
  "stations": { "<id>": { score, rating, color, weather, metrics, viewAzimuth }, ... }
}
```

`buildPredictionFromLock` in `capture-validation.js` gains a station-aware
variant `buildPredictionFromStationLock(lockedData, stationId)` reading
`lockedData.stations[stationId]`; the existing function stays for the primary /
back-compat path.

Cost: 6 (or 2) Open-Meteo batch requests per session, 11 coords each. Free tier
is 10k/day. Lock job runtime ~10s → ~30–60s.

### 4. `scripts/live-capture-core.js` — session station list

Replace `OFFICIAL_STREAMS` (2 entries) with a derivation from `stations.js`:
`sessionStreams(session)` → `[{ id, name, url, videoId, uploaderId }, ...]`.
`OFFICIAL_STREAMS[session]` kept as a getter returning the primary station so
nothing else breaks mid-migration. `SCHEDULE_TO_SESSION`, `resolveSessionType`,
`resolveLockTarget`, `assertCaptureWindow` unchanged.

### 5. `scripts/capture-validation.js` — per-station capture

`runCapturePipeline(session)` inner body becomes a per-station loop:

```
for st of sessionStreams(session):
    snapshotPath = data/snapshots/<date>/<session>/<st.id>.jpg
    prediction   = buildPredictionFromStationLock(locked, st.id)  // or live fallback per station
    try:
        capture = captureLiveFrame({ source: st, outputPath, windowEvidence, capturedAt })  // DVR → eventTime
        record  = { id: `rec-<date>-<session>-<st.id>`, station: st.id, snapshotUrl, capture, verification: captured_ready }
    catch windowError | captureError:
        record  = { id: `rec-<date>-<session>-<st.id>`, station: st.id, snapshotUrl: null, capture: {fidelity:'none', error}, verification: capture_unavailable }
    writeRecord(record)   // unshift, dedupe by id, slice cap raised 90 → 300
```

- **Per-station isolation:** one station's window-miss or dead stream never
  aborts the others. Same honest-record policy as today, per station.
- **Primary alias:** after the loop, also `writeRecord` a copy of the primary
  station's record under the bare id `rec-<date>-<session>` (no station
  suffix), pointing at the **same layered `snapshotUrl`** (no flat-path copy —
  the alias shares the primary's snapshot and its sha, so
  `assertSnapshotIntegrity` still passes). Keeps `score-ground-truth.js` /
  `generate_daily_briefing.py` working before they are updated, and keeps the
  history contiguous.
- `writeRecord` slice cap `records.slice(0, 90)` → `slice(0, 300)` (8×/day now).

### 6. `scripts/score-ground-truth.js` — per-station scoring

`runGroundTruthScoring(dateStr, session)` loops every record whose id matches
`rec-<date>-<session>` or `rec-<date>-<session>-<id>` and
`isValidatedLiveCaptureRecord` is true:

```
for rec of matching:
    assertSnapshotIntegrity(rec.snapshotUrl, rec.capture.sha256)
    optical = analyzer(analyze_sky_ground_truth.py, snapshotPath, rec.targetTime)
    errorAbsolute = |rec.prediction.score - optical.score|
    rec.verification = { ...verdict fields... }
writeFileSync(records)
```

Verdict thresholds (≤8 EXACT, ≤18 SLIGHT, else MISMATCH) unchanged. Skip (not
fail) records still `capture_unavailable`. 8 stations × ~5s Python ≈ 40s.

### 7. `scripts/generate_daily_briefing.py` — per-station rows

- `resolve_target_record` → `resolve_target_records`: collect all
  `rec-<date>-<session>-*` (plus the bare alias, deduped, primary first). Same
  "today, or yesterday if schedule crossed midnight, never older" rule applied
  to the set.
- `build_station_rows` returns one row per station, every field from that
  station's record:
  - `name` / `icon` / `tag` ← `stations.js` (bundled as `data/stations.json`,
    CI-generated, so Python has no JS dependency)
  - `forecast` ← station's locked prediction score `+ "（低雲 X%）"`
  - `phasePeak` ← `光學觀測判定 X 分（rating）` | `擷取失敗` | `評分中`
  - `verdict` / `verdictColor` ← station's own verdict
  - `phasePrep` / `phasePost` ← `"—"` always. **No hand-written narrative
    text** — that was the fabrication vector; never reintroduce it.
- Top-level `report.prediction` / `report.groundTruth` ← primary station
  (existing banner unchanged).
- New `report.stationSummary`:
  `{ verified, pending, bestStation, bestScore, worstError, meanError }`
  computed only from verified rows.

### 8. `data/tonight-stations.json` — homepage feed (new, CI-generated)

Written by a new step in `auto_validate_capture.yml` (and by
`lock_forecast.yml`, so it refreshes at lock time too). A tiny generator
`scripts/build-tonight-stations.js`:

```jsonc
{
  "session": "sunset", "date": "2026-09-10", "generatedAt": "...",
  "stations": [
    { "id": "tamsui", "name": "...", "icon": "🌉", "score": 51, "rating": "局部霞光",
      "color": "#E5A50A", "viewAzimuth": 270, "tag": "...", "youtubeUrl": "..." },
    ... sorted by score desc
  ]
}
```

Source: `locked-<session>-forecast.json` `stations` map (already has scores) +
`stations.js` metadata. Session picked the same way the briefing picks it
(Taipei hour < 15 → sunrise, else sunset).

### 9. `index.html` + `js/app.js` — ranking panel

- New `<section class="tonight-stations-section">` after
  `forecast-5day-section`.
- `app.js`: `loadTonightStations()` (called from the existing
  `DOMContentLoaded` handler) — `fetch('data/tonight-stations.json')`, render a
  ranked list of cards: rank number, station name + icon, score with the
  rating color chip, `viewAzimuth` as a compass hint, a "看直播" link. Degrade
  silently if the file is missing (same as `loadDailyReportsAndArchive`).
- No new Open-Meteo calls in the browser.

### 10. `scripts/auto-calibrate-model.py` — no logic change

It already iterates every record with `groundTruthScore != null` and usable
cloud inputs, keyed only by presence of fields, not by id shape. Per-station
records with the same shape are picked up automatically → "feed all equally"
is satisfied for free.

**Known limitation (accepted):** `calculate_score` recomputes `sim_pred` from
the cloud triplet only, and the 6 stations' *local* cloud values are ~identical
under 方案 2. So per-station ground-truth variance driven by geometry is partly
noise to the grid search. Mitigation: per-station `horizonClearance` and
`visibilityKm` *do* differ (geometry-driven) and `calculate_score` consumes
both — the locked station block stores them, so real geometric signal still
reaches the calibrator. Net: primary-station signal undiluted in quality, 4×
sample count, some added noise. Acceptable; revisit if MAE regresses.

### 11. Workflows

- `.github/workflows/lock_forecast.yml`: script unchanged, runs longer →
  `timeout-minutes` (currently unset, defaults to 360) made explicit at `10`;
  add a step running `scripts/build-tonight-stations.js` after the lock; the
  existing `git add data/` already covers the new files.
- `.github/workflows/auto_validate_capture.yml`: `timeout-minutes: 20` → `30`
  (6–8 DVR captures + 6–8 optical scores); add a `build-tonight-stations.js`
  step after the briefing; add `data/stations.json` generation (from
  `stations.js`) so the Python briefing has station metadata without a JS
  dependency.
- No new secrets, runners, or triggers. Self-hosted runner path (residential
  IP, Tier A frames) unaffected — it just loops more streams.

## Data Flow

```
lock_forecast.yml (15:30 / 23:45 TPE)
  └─ lock-forecast.js
       └─ per station: WeatherService.fetchForecast(true, coords, {azimuth})
       └─ write locked-<session>-forecast.json { skyfire, weather, stations{} }
       └─ build-tonight-stations.js → data/tonight-stations.json

auto_validate_capture.yml (18:45 / 05:30 TPE + 09:00 / 21:00 briefings)
  └─ capture-validation.js
       └─ per station: captureLiveFrame (DVR → eventTime)
       └─ write rec-<date>-<session>-<id> (+ primary alias)
  └─ score-ground-truth.js
       └─ per record: analyze_sky_ground_truth.py → verdict
  └─ generate_daily_briefing.py
       └─ per-station rows → daily-reports.json
  └─ build-tonight-stations.js → data/tonight-stations.json (refresh)
  └─ git add data/ && commit && push

weekly_auto_calibration.yml
  └─ auto-calibrate-model.py (reads all per-station verified records)
```

## Error Handling

| Failure | Behavior |
|---------|----------|
| One station's stream dead / window missed | That station → `capture_unavailable` record; loop continues |
| One station's DVR rewind fails | Falls to live-edge inside `captureLiveFrame` (existing), still that station only |
| Open-Meteo fails for one station's lock | That station omitted from `stations` map; `build-tonight-stations.js` skips missing; briefing row shows forecast `—` |
| All stations fail | Every record `capture_unavailable`; briefing = all-pending placeholder (existing all-pending path) |
| `locked-<session>-forecast.json` stale / wrong date | Per-station live fallback in `capture-validation.js` (existing single-station fallback, now per station) |
| `stations.js` invariant broken | Test suite fails in CI before deploy |

## Testing

`node tests/run-all-tests.js` must stay green. New / changed:

- **`tests/test-stations.js`** (new): registry invariants (§1).
- **`tests/test-live-capture-core.js`**: `sessionStreams(session)` returns the
  right count/order; `OFFICIAL_STREAMS` getter still yields the primary.
- **`tests/test-weather-service.js`**: `geometryOptions` azimuth override
  changes the sampling plan; `null` reproduces the current plan exactly.
- **`tests/test-capture-validation.js`**: per-station record id naming; one
  station failing does not abort others; primary alias record written; slice
  cap 300.
- **`tests/test-live-frame-capture.js`**: unaffected (per-station is a caller
  concern) — spot-check still green.
- **`tests/test_daily_briefing.py`**: N rows out; top-level primary mirror;
  `phasePrep`/`phasePost` never contain narrative; `stationSummary` math;
  all-pending placeholder still correct.
- **Sync test**: `capture_timelapse_multi_station.py` station list vs
  `stations.js` agree on id/lat/lng/videoId.

## Migration / Compatibility

- Existing `rec-<date>-<session>` records (no station id) are left as-is;
  `auto-calibrate-model.py` and history keep working.
- During transition the primary station is **double-written** (with and
  without the `-<id>` suffix, flat + layered snapshot path). After ~1 week of
  green runs, open an issue to drop the alias and the flat snapshot copy.
- `daily-reports.json` history untouched; only new reports get N rows.
- `spots-data.js` id change `taipei-101` → `xiangshan` done in the same PR with
  its consumers.

## Open Questions

None blocking. `viewAzimuth` exact values and the two sunrise videoIds are
implementation-time lookups, not design decisions.
