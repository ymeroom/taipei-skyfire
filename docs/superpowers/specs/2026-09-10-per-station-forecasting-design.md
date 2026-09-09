# Per-Station Forecasting & Validation — Design Spec

**Date:** 2026-09-10
**Status:** Approved for planning (revised after advisor review)
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

- New single-source-of-truth station registry (`js/stations.js` +
  checked-in `data/stations.json`).
- Per-station prediction in `lock-forecast.js` → per-station `stations` map in
  `locked-<session>-forecast.json`.
- **DVR-seek honesty fix** in `live-frame-capture.js`: a frame that fell back
  to the live edge must never be recorded as `exact` at the event time.
- Per-station capture + optical scoring in `capture-validation.js` /
  `score-ground-truth.js` → per-station records in `verification-records.json`,
  with a twilight-window guard.
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
- A jiufen-specific "anti-solar afterglow" model (see §1 limitation).

## Sessions & Stations

| id | name | icon | session | isPrimary | videoId |
|----|------|------|---------|-----------|---------|
| `dadaocheng` | 台北大稻埕碼頭 | ⛵ | sunset | ✅ | `Ndo_8RuefH4` |
| `xiangshan` | 台北象山看 101 | 🏙️ | sunset | | `z_fY1pj1VBw` |
| `tamsui` | 新北淡水漁人碼頭 | 🌉 | sunset | | `xwAWSh35uuw` |
| `bali` | 新北八里左岸 | 🌊 | sunset | | `di-4DCblWq4` |
| `maokong` | 台北貓空指南宮 | ⛩️ | sunset | | `215ahZ_0rTg` |
| `jiufen` | 新北九份即時影像 | 🏮 | sunset | | `XSD5ptYisw8` |
| `hongludi` | 新北中和烘爐地 | ⛰️ | sunrise | ✅ (tentative) | (verify) |
| `waimushan` | 基隆外木山濱海 | 🌊 | sunrise | (see §C) | (verify) |

lat/lng/elevation come from `js/spots-data.js` where present (`bali` is absent
there and must be added). The two sunrise videoIds and every station's DVR
rewind depth are confirmed during implementation via `browser-cli` (each stream
live, 4K, DVR-capable). **Sunrise `isPrimary` cannot be finalized until
`waimushan`'s stream is confirmed DVR-capable** — see §C.

### `viewAzimuth` is metadata, not a model input

Each station gets a numeric `viewAzimuth` (camera bearing, degrees) used only
for: the homepage compass hint, and human-readable station framing. **It is
NOT fed to the sampling geometry.** The upstream ray path always follows the
computed *solar* azimuth — "upstream" means toward the light source, and all
Taipei-area stations share nearly the same solar azimuth anyway.

**jiufen limitation (documented, accepted):** jiufen's camera faces NE (~45°);
at sunset the sun sets behind the mountains to its west. The model will sample
the solar (W) direction from jiufen's coordinates, find terrain blocking the
horizon, and return a low, horizon-capped score — which is the *truthful*
prediction for "a classic sunset shot from jiufen." jiufen's actual value is
anti-solar afterglow / high cloud lit from below in its eastern view; the
current engine does not model that. The user wants jiufen in the set anyway;
its score is honest about what it measures.

## Components

### 1. `js/stations.js` — station registry (new)

Plain data module, `module.exports` + `window.STATIONS` dual-export (same
pattern as `spots-data.js`). One array of station objects:
`{ id, name, icon, session, isPrimary?, lat, lng, elevation, videoId, url,
uploaderId, viewAzimuth, tag }`.

Helpers:

- `stationsForSession(session)` → array, stable display order.
- `primaryStation(session)` → the `isPrimary` station (exactly one per session).

Invariants (enforced by `tests/test-stations.js`): unique ids;
`session ∈ {sunrise, sunset}`; exactly one `isPrimary` per session; `videoId`
matches `/^[\w-]{11}$/`; `viewAzimuth` in `[0, 360)`.

**Reconciliation:**

- `spots-data.js` keeps its map-UI role but imports coordinates from
  `stations.js` — no duplicated lat/lng. Old id `taipei-101` → `xiangshan`,
  consumers updated in the same PR.
- `capture_timelapse_multi_station.py` keeps an inline station list, gains a
  header comment "keep in sync with js/stations.js"; a sync test asserts they
  agree on id/lat/lng/videoId.

### 2. `data/stations.json` — checked-in registry mirror (new)

`stations.js` re-emitted as JSON, **committed to the repo** (not
CI-generated). `scripts/build-stations-json.js` regenerates it;
`tests/test-stations.js` asserts `data/stations.json` byte-matches the current
`stations.js` output, so a drift fails CI on a clean checkout. Python
(`generate_daily_briefing.py`, `build-tonight-stations.js` if run standalone)
reads this file — no JS dependency, and it exists before the workflow's test
steps run.

### 3. `js/weather-service.js` — no change

`fetchForecast(forceRefresh, customCoords)` **already** accepts custom
coordinates, builds per-coordinate `buildSamplingGeometry` (its own solar
azimuth + upstream ray path from that origin), and skips the cache when
`customCoords` is set. Per-station forecasting is just calling it in a loop.
Differentiation between nearby stations comes from: ray-path origin coordinates
(parallel paths ~30 km apart still sample sea points ~30 km apart at 260 km),
terrain/elevation sampled along the bearing, and horizon clearance. No new
parameters, no risk to the browser's existing calls.

### 4. `scripts/lock-forecast.js` — per-station lock

After `resolveLockTarget` → `{ session, dateStr }`:

```
stations = stationsForSession(session)
for st of stations:
    fc  = await WeatherService.fetchForecast(true, { lat: st.lat, lng: st.lng })
    day = fc.daysForecast matching dateStr (fallback [0])
    sf  = day[session]
    stationLock[st.id] = {
      score: sf.skyfire.score,
      rating: sf.skyfire.rating.badge,
      color: sf.skyfire.rating.color,
      weather: { cloudHigh, cloudMid, cloudLow, cloudTotal, humidity, precipProb, visibilityKm },
      metrics: { horizonClearance: sf.skyfire.metrics.horizonClearance, visKm: sf.skyfire.metrics.visKm }
    }
```

Output `data/locked-<session>-forecast.json`:

```jsonc
{
  "date": "...", "session": "...", "lockedAt": "...",
  "skyfire": <primary station's full sf.skyfire>,   // top-level kept for back-compat + existing tests
  "weather": <primary station's weather block>,      // "
  "stations": { "<id>": { score, rating, color, weather, metrics }, ... }
}
```

`capture-validation.js` gains `buildPredictionFromStationLock(lockedData,
stationId)` reading `lockedData.stations[stationId]`; the existing
`buildPredictionFromLock` stays for the primary / live-fallback path.

Cost: 6 (or 2) Open-Meteo batch requests per session, 11 coords each. Free tier
10k/day. Lock job runtime ~10 s → ~30–60 s.

### 5. `scripts/live-frame-capture.js` — DVR-seek honesty fix (blocking)

Today, when the seeked `.ts` segment is out of DVR range, `captureLiveFrame`
silently falls through to a live-edge `ffmpeg -i streamUrl` grab
(`live-frame-capture.js:282–293`) and the caller still stamps
`frameEffectiveTimeUtc = eventTime`, `fidelity: 'exact'`,
`dvrRewindMinutes: <full offset>`. A daytime frame becomes an indistinguishable
"exact twilight frame" and scores as a false-negative ground truth.

Fix:

- `captureLiveFrame` tracks `dvrSeekApplied` — set `true` **only** when the
  seeked segment actually produced the output JPEG; `false` when it fell
  through to the live-edge branch.
- Return it in the evidence object.
- In `capture-validation.js`, when `dvrSeekApplied === false` (and the offset
  is non-trivial, say > 15 min):
  - `frameEffectiveTimeUtc = capturedAt` (the real wall-clock of the grab),
    **not** `eventTime`
  - `fidelity: 'live-edge'` (a new value, distinct from `exact` / `degraded` /
    `none`)
  - `dvrRewindMinutes: 0`
- Offset ≤ 15 min (genuinely near the live edge): live-edge grab is fine,
  `fidelity: 'exact'`, `frameEffectiveTimeUtc = capturedAt`.

Test: seek returns a 5 KB file → record must not claim `exact` or `eventTime`.

### 6. `scripts/live-capture-core.js` — session station list

Replace `OFFICIAL_STREAMS` (2 entries) with `sessionStreams(session)` derived
from `stations.js` → `[{ id, name, url, videoId, uploaderId }, ...]`.
`OFFICIAL_STREAMS[session]` kept as a getter returning the primary station so
nothing else breaks mid-migration. `SCHEDULE_TO_SESSION`, `resolveSessionType`,
`resolveLockTarget`, `assertCaptureWindow` unchanged. Add `fidelity: 'live-edge'`
to `validateOpticalResult` / record-shape validators as an accepted value that
is **not** treated as verified-exact.

### 7. `scripts/capture-validation.js` — per-station capture

`runCapturePipeline(session)` inner body → per-station loop:

```
locked = load locked-<session>-forecast.json (if date matches)
for st of sessionStreams(session):
    snapshotPath = data/snapshots/<date>/<session>/<st.id>.jpg
    prediction   = locked ? buildPredictionFromStationLock(locked, st.id)
                          : <live per-station fallback>
    try:
        capture = captureLiveFrame({ source: st, outputPath, windowEvidence, capturedAt })
        record  = { id: `rec-<date>-<session>-<st.id>`, station: st.id, source: st.name,
                    snapshotUrl, capture: {...§5 honesty rules...},
                    verification: { status: 'captured_ready_for_scoring', ... } }
    catch windowError | captureError:
        record  = { id: `rec-<date>-<session>-<st.id>`, station: st.id, source: st.name,
                    snapshotUrl: null, capture: { fidelity: 'none', error },
                    verification: { status: 'capture_unavailable', ... } }
    writeRecord(record)          // unshift, dedupe by id
records.slice(0, 720)            // was 90; 8/day × ~90 days seasonal span
```

- **Per-station isolation:** one station's window-miss / dead stream / DVR
  failure never aborts the others. Same honest-record policy, per station.
- **No bare-id alias.** Historical `rec-<date>-<session>` records stay
  untouched; the new series is per-station only. Consumers that want "the
  headline number" resolve `primaryStation(session)` →
  `rec-<date>-<session>-<primaryId>`.
- Snapshots move to `data/snapshots/<date>/<session>/<st.id>.jpg` (layered,
  matching `capture_timelapse_multi_station.py`). No flat-path copy.

### 8. `scripts/score-ground-truth.js` — per-station scoring + twilight guard

`runGroundTruthScoring(dateStr, session)` loops every record whose id matches
`rec-<date>-<session>-<id>` and `isValidatedLiveCaptureRecord` is true:

```
for rec of matching:
    if rec.capture.fidelity === 'live-edge'
       OR frameEffectiveTimeUtc NOT within twilight window of rec.targetTime:
        rec.verification = { status: 'skipped_out_of_window', groundTruthScore: null,
                             reason: '...', isSimulated: false }
        continue
    assertSnapshotIntegrity(rec.snapshotUrl, rec.capture.sha256)
    optical = analyzer(analyze_sky_ground_truth.py, snapshotPath, rec.targetTime)
    errorAbsolute = |rec.prediction.score - optical.score|
    rec.verification = { ...verdict fields... }
writeFileSync(records)
```

- Twilight window = civil-twilight bracket of `targetTime` (SolarCalc, the same
  `nightGate` window `analyze_sky_ground_truth.py` already computes). A record
  whose `frameEffectiveTimeUtc` is outside it is not ground truth — skip, don't
  fabricate, don't fail the job.
- Verdict thresholds (≤8 EXACT, ≤18 SLIGHT, else MISMATCH) unchanged.
- `capture_unavailable` and `skipped_out_of_window` records are excluded from
  calibration automatically (`groundTruthScore` is null).
- 8 stations × ~5 s Python ≈ 40 s.

### 9. `scripts/generate_daily_briefing.py` — per-station rows

- `resolve_target_record` → `resolve_target_records`: collect all
  `rec-<date>-<session>-*`, primary first, same "today or yesterday, never
  older" rule applied to the set.
- `build_station_rows` returns one row per station, every field from that
  station's record:
  - `name` / `icon` / `tag` ← `data/stations.json`
  - `forecast` ← station's locked prediction score `+ "（低雲 X%）"`
  - `phasePeak` ← `光學觀測判定 X 分（rating）` | `擷取失敗` | `窗口外` | `評分中`
  - `verdict` / `verdictColor` ← station's own verdict (or pending)
  - `phasePrep` / `phasePost` ← `"—"` always. **No hand-written narrative** —
    that was the fabrication vector; never reintroduce it.
- Top-level `report.prediction` / `report.groundTruth` ← primary station.
- New `report.stationSummary`:
  `{ verified, pending, bestStation, bestScore, worstError, meanError }`
  computed only from verified rows.

### 10. `data/tonight-stations.json` — homepage feed (new, CI-generated)

`scripts/build-tonight-stations.js`, run after the lock and again after
capture:

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

Source: `locked-<session>-forecast.json` `stations` map + `data/stations.json`.
Session chosen the same way the briefing chooses it (Taipei hour < 15 →
sunrise, else sunset). Missing stations (Open-Meteo failed at lock) are simply
absent from the list.

### 11. `index.html` + `js/app.js` — ranking panel

- New `<section class="tonight-stations-section">` after
  `forecast-5day-section`.
- `app.js`: `loadTonightStations()` from the existing `DOMContentLoaded`
  handler — `fetch('data/tonight-stations.json')`, render a ranked card list:
  rank, station name + icon, score with rating-color chip, `viewAzimuth`
  compass hint, "看直播" link. Degrade silently if the file is missing.
- No new Open-Meteo calls in the browser.

### 12. `scripts/auto-calibrate-model.py` — no logic change

Already iterates every record with `groundTruthScore != null` and usable cloud
inputs, keyed only by field presence. Per-station records with the same shape
are picked up automatically → "feed all equally" satisfied for free.
`skipped_out_of_window` / `capture_unavailable` records have null
`groundTruthScore` and are ignored.

**Known limitation (accepted):** `calculate_score` recomputes `sim_pred` from
the cloud triplet only, and the 6 stations' *local* cloud values are ~identical
under 方案 2, so geometry-driven ground-truth variance is partly noise to the
grid search. Mitigation: per-station `horizonClearance` and `visibilityKm` do
differ and `calculate_score` consumes both; the locked station block stores
them. Net: primary-station signal quality undiluted, 4× sample count, some
added noise. Revisit if MAE regresses after a few weeks.

### 13. Workflows

- `.github/workflows/lock_forecast.yml`: script unchanged, runs longer →
  `timeout-minutes: 10` (explicit); add a `build-tonight-stations.js` step
  after the lock. Existing `git add data/` covers new files.
- `.github/workflows/auto_validate_capture.yml`: `timeout-minutes: 20 → 30`
  (6–8 DVR captures + 6–8 optical scores); add a `build-tonight-stations.js`
  step after the briefing.
- `data/stations.json` is checked in, so no generation step is needed in CI
  and the early test steps (`run-all-tests.js`, `test_daily_briefing.py`) pass
  on a clean checkout.
- No new secrets, runners, or triggers. Self-hosted runner (residential IP,
  Tier A frames) just loops more streams.

## Data Flow

```
lock_forecast.yml (15:30 / 23:45 TPE)
  └─ lock-forecast.js
       └─ per station: WeatherService.fetchForecast(true, {lat,lng})
       └─ write locked-<session>-forecast.json { skyfire, weather, stations{} }
  └─ build-tonight-stations.js → data/tonight-stations.json

auto_validate_capture.yml (18:45 / 05:30 TPE + 09:00 / 21:00 briefings)
  └─ capture-validation.js
       └─ per station: captureLiveFrame (DVR → eventTime, honesty-flagged §5)
       └─ write rec-<date>-<session>-<id>   (no bare-id alias)
  └─ score-ground-truth.js
       └─ per record: twilight guard → analyze_sky_ground_truth.py → verdict
  └─ generate_daily_briefing.py
       └─ per-station rows → daily-reports.json
  └─ build-tonight-stations.js → data/tonight-stations.json (refresh)
  └─ git add data/ && commit && push

weekly_auto_calibration.yml
  └─ auto-calibrate-model.py (all per-station verified records, equal weight)
```

## Error Handling

| Failure | Behavior |
|---------|----------|
| One station's stream dead / window missed | That station → `capture_unavailable`; loop continues |
| One station's DVR rewind out of range | Live-edge grab, but recorded `fidelity: 'live-edge'` + `frameEffectiveTimeUtc = capturedAt`; scoring skips it (`skipped_out_of_window`); **never** counted as ground truth |
| Open-Meteo fails for one station's lock | Station omitted from `stations` map; tonight-stations skips it; briefing row forecast `—` |
| All stations fail | Every record `capture_unavailable`; briefing = all-pending placeholder (existing path) |
| `locked-<session>-forecast.json` stale / wrong date | Per-station live fallback in `capture-validation.js` |
| `stations.js` / `data/stations.json` drift | `tests/test-stations.js` fails in CI before deploy |

## Testing

`node tests/run-all-tests.js` must stay green.

- **`tests/test-stations.js`** (new): registry invariants; `data/stations.json`
  matches `stations.js` output; sync with `capture_timelapse_multi_station.py`.
- **`tests/test-live-capture-core.js`**: `sessionStreams(session)` count/order;
  `OFFICIAL_STREAMS` getter yields the primary; `live-edge` accepted as a
  non-verified fidelity.
- **`tests/test-live-frame-capture.js`**: seeked `.ts` too small → result has
  `dvrSeekApplied: false`; a real seeked segment → `true`.
- **`tests/test-capture-validation.js`**: per-station record id naming; one
  station failing does not abort others; `dvrSeekApplied: false` →
  record is `live-edge` + `frameEffectiveTimeUtc == capturedAt`, not `exact`;
  no bare-id alias written; slice cap 720.
- **`tests/test-weather-service.js`**: `customCoords` produces a distinct
  sampling plan per origin; unchanged when omitted.
- **`tests/test_daily_briefing.py`**: N rows out; top-level primary mirror;
  `phasePrep`/`phasePost` never contain narrative; `stationSummary` math;
  `skipped_out_of_window` row renders as pending, not a hit; all-pending
  placeholder still correct.

## Migration / Compatibility

- Existing `rec-<date>-<session>` records (no station id) are left as-is;
  `auto-calibrate-model.py` and the archive keep working. **No bare-id alias**
  is written going forward — the old series ends cleanly at the cutover date,
  the per-station series begins. The sunrise camera change (§C) is therefore
  not hidden inside a shared id.
- `daily-reports.json` history untouched; only new reports get N rows.
- `spots-data.js` id change `taipei-101` → `xiangshan` in the same PR with its
  consumers.
- The homepage accuracy stats (`96.5%` / `±3.8 分`) are hardcoded today, so the
  series discontinuity has no visible effect there; fixing those to be
  data-derived is a separate task.

## Open Questions

### C. Sunrise primary station

Historical `rec-<date>-sunrise` records are all camera `象山看台北 101`
(`z_fY1pj1VBw`). This design moves 象山 to the *sunset* set and the user's
sunrise stations are 烘爐地 + 外木山 only. Decision, to confirm with the user:

- **Recommended:** `hongludi` is sunrise primary (basin view, matches the
  narrative the old reports already used). `waimushan` secondary.
- Finalize only after `browser-cli` confirms both sunrise streams are live and
  DVR-capable. If `hongludi`'s stream is not DVR-capable, `waimushan` becomes
  primary; if neither is, escalate before building.
- No bare-id alias means the historical 象山 sunrise series simply ends — no
  silent viewpoint mixing.

### Other

`viewAzimuth` exact values and the two sunrise videoIds are implementation-time
`browser-cli` lookups, not design decisions.
