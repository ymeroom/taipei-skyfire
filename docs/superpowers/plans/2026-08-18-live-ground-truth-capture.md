# Live Ground-Truth Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the Ground Truth Verification Corridor accepts only real YouTube livestream frames captured inside the Taipei sunrise or sunset validation window.

**Architecture:** Extract deterministic capture-policy functions into a CommonJS module, keep external `yt-dlp`/`ffmpeg` execution at the edge, and attach provenance evidence to every accepted record. The UI and optical scorer reject legacy, simulated, thumbnail, fallback, out-of-window, or otherwise unvalidated records.

**Tech Stack:** Node.js 20, yt-dlp, ffmpeg/ffprobe, Vanilla JavaScript, GitHub Actions.

**Spec:** User requirement in the 2026-08-18 QA request: screenshots must be real scenes captured at sunrise or sunset, never generated images, thumbnails, channel banners, or fallback images.

## Global Constraints

- Use Asia/Taipei for event dates and capture-window checks.
- Accept only configured official live-video IDs and uploader IDs.
- Never substitute a static image or simulated optical score when capture/scoring fails.
- Preserve legacy records on disk, but exclude them from corridor statistics and rendering.

---

### Task 1: Capture policy and provenance tests

**Files:**
- Create: `tests/test-live-capture-core.js`
- Create: `scripts/live-capture-core.js`
- Modify: `tests/run-all-tests.js`

**Interfaces:**
- Produces: `getTaipeiDateString(date)`, `resolveSessionType(input, schedule)`, `assertCaptureWindow(options)`, `validateLiveMetadata(metadata, source)`, `isVerifiedLiveFrameRecord(record)`.

- [ ] **Step 1: Write tests that reject non-live thumbnails, untrusted videos, out-of-window captures, simulated results, and legacy records.**
- [ ] **Step 2: Run `node tests/test-live-capture-core.js` and verify RED because the policy module does not exist.**
- [ ] **Step 3: Implement the smallest pure policy module that satisfies the tests.**
- [ ] **Step 4: Run `node tests/test-live-capture-core.js` and verify GREEN.**

### Task 2: Real livestream frame capture

**Files:**
- Modify: `scripts/capture-validation.js`
- Test: `tests/test-live-capture-core.js`

**Interfaces:**
- Consumes: capture policy functions from Task 1.
- Produces: a JPEG captured by `ffmpeg` from a `yt-dlp`-validated live HLS URL and a record containing `capture.kind`, `capture.validated`, event time, offset, video/uploader IDs, dimensions, and SHA-256.

- [ ] **Step 1: Add a test proving invalid evidence cannot produce a corridor-eligible record.**
- [ ] **Step 2: Replace YouTube search/thumbnail download/static fallback with configured official live video URLs and `yt-dlp` metadata validation.**
- [ ] **Step 3: Capture one current frame with `ffmpeg`, validate it with `ffprobe`, and write via a temporary file followed by rename.**
- [ ] **Step 4: Fail without writing a verified record when any capture requirement is unmet.**

### Task 3: Honest scoring and corridor filtering

**Files:**
- Modify: `scripts/score-ground-truth.js`
- Modify: `js/app.js`
- Modify: `tests/test-dom-bindings.js`

**Interfaces:**
- Consumes: `isVerifiedLiveFrameRecord(record)` contract.
- Produces: no simulated ground-truth scores; UI statistics and cards derived only from validated live frames.

- [ ] **Step 1: Add assertions for legacy/simulated record rejection.**
- [ ] **Step 2: Require exact record/session matching and validated capture evidence before optical scoring.**
- [ ] **Step 3: Remove the prediction-derived simulated ground-truth fallback.**
- [ ] **Step 4: Filter corridor cards and metrics to validated live-frame records only.**

### Task 4: Correct GitHub Actions session routing

**Files:**
- Modify: `.github/workflows/auto_validate_capture.yml`
- Test: `tests/test-live-capture-core.js`

**Interfaces:**
- Consumes: scheduled cron expression or manual session input.
- Produces: `sunrise` for `30 21 * * *` and `sunset` for `45 10 * * *`.

- [ ] **Step 1: Test scheduled and manual session resolution.**
- [ ] **Step 2: Resolve the session once in the workflow and pass the same value to capture and scoring.**
- [ ] **Step 3: Run the complete test suite and syntax checks.**

### Task 5: QA evidence

**Files:**
- Create: `docs/QA_REPORT_2026-08-18.md`

**Interfaces:**
- Consumes: unit/integration/E2E/security/performance evidence.
- Produces: reproducible findings, status, limitations, and deployment verification steps.

- [ ] **Step 1: Run all local tests and JavaScript syntax checks.**
- [ ] **Step 2: Verify production index/video/camera flows in the Codex in-app browser.**
- [ ] **Step 3: Record that live capture itself requires the GitHub Actions Linux toolchain and the next real solar window.**
