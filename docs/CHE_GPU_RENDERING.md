# CHE procedural GPU rendering: audit, benchmark harness, measurements

Owner directive (2026-10-18): inspect the existing renderers, benchmark one scene (the
Brain) native vs Three.js/WebGL vs a WebGPU prototype with measurements before any
adoption, bundle assets offline (no CDNs), detect WebGPU in the real iPhone WebView with
fallbacks for GPU init failure, lost device, backgrounding, memory pressure, thermal
state, Low Power Mode and Reduce Motion, adapt 60/30 FPS, bridge scene parameters through
validated JSON (never arbitrary JavaScript), keep live rendering separate from MP4 export,
never label an interactive scene as a completed MP4, never add a competing 3D engine, and
deliver working implementations backed by measurements.

## 1. Audit of what exists (main `ce1ebf5`, 2026-10-18)

| Surface | Renderer | How it is loaded | Device handling today |
|---|---|---|---|
| Brain Room (`lib/brain/che_brain_space.dart`, `lib/home/che_memory_brain.dart`) | Flutter `CustomPainter` on the Flutter canvas (Impeller on iOS): one `drawRawAtlas` for every orb, batched line lists, a 64-px glow sprite built once, label painters cached | Native widget, no assets | Reduce Motion stops drift and firing; the ticker stops when idle under Reduce Motion; labels follow the text setting (capped) |
| Office floor, War Room, Theater, Markets, Art Studio, Workshop, Pipeline, Music | `CheNativeSceneWorld` (`lib/widgets/che_native_scene_world.dart`): `flutter_scene` 0.23 on Flutter GPU/Impeller, GLB models from assets | Native; `CheSceneQualityStore` with Performance / Balanced / Realistic tiers (visual limits 300 / 900 / 1800) | Reduce Motion honored; quality tier chosen by the owner |
| `assets/office3d/*.html` + `three.min.js`, `assets/characters/app/` + `characters-vendor.js` | Three.js `WebGLRenderer` in `webview_flutter` | Bundled with the app (`loadFlutterAsset`); the only outside URL is a YouTube embed in `theater.html` | `Che3DRoomView` / `Office3DView` pause the loop when the app is backgrounded or the tab's tickers are off; **no call sites remain in `lib/`**: the native scenes replaced them |
| MP4 export (YouTube line) | `tools/che_video_render.py` on GitHub Actions | Separate pipeline | Separate from every live scene above; a live scene is never an MP4 |

Not present anywhere before this work: WebGPU feature detection, WebGL context-loss or
WebGPU device-loss handling, thermal or Low Power Mode awareness, an adaptive frame
cadence, a measurement harness. `flutter_scene` already puts the rooms on the GPU; the
Brain is the one scene still drawn as canvas commands, so it is the scene to measure.

## 2. The harness (this branch)

- `assets/brain3d/bench.html` (bundled, no CDN; uses the already bundled
  `../office3d/three.min.js`): draws a Brain-shaped cloud of orbs and connections, the same
  volumes the native layout uses, on **WebGL** (Three.js `Points` + `LineSegments`) or **raw
  WebGPU** (one WGSL module: instanced soft-disc quads and a line list), orbits the camera for
  a fixed number of seconds and reports `frames`, `fps`, JS work per frame (avg, p95), the
  pixel ratio, the backend version and whether the loop dropped to a 30 fps cadence.
  - The only entry point is `window.brainBenchRun(params)`: an object with known keys only
    (`nodes` 100–20000, `edges` 0–60000, `seconds` 1–20, `backend` auto|webgl|webgpu,
    `pixelRatioCap` 1–3, `label`); anything else is refused with a reason and nothing runs.
  - Fallbacks: `navigator.gpu` missing → WebGL; no adapter or device → WebGL; `device.lost`
    → reported, run stopped, WebGL; `webglcontextlost` → reported, run stopped; page hidden
    → loop paused and the paused time excluded; `prefers-reduced-motion` → camera held still
    and reported; pixel ratio capped; a second of frames over 20 ms → 30 fps cadence,
    reported. Thermal state and Low Power Mode are not observable from a WebView; they show
    up in the measured frame rate and are reported as such, never guessed.
  - Results go through the `BrainBench` JavaScript channel to the app and to the console as
    `BRAIN_BENCH {…}` for the headless runner.
- `tool/bench_brain_webgl.mjs`: runs the page in headless Chromium (Playwright) and prints
  the messages as JSON lines. On this VM Chromium draws with SwiftShader (software), so its
  numbers describe the harness and the fallback path, not a GPU.
- `lib/widgets/che_render_bench.dart` → Settings → **Rendering benchmark**: on the owner's
  phone, runs the native painter (the real `CheBrainSpace` painter under a timing wrapper,
  camera orbiting; the engine's `FrameTiming` gives raster times on a device), then the
  WebGL pass, then the WebGPU pass of the bundled page, with the same orb count. Benchmark
  orbs are labelled benchmark data, never memories, and nothing is stored. Results are large
  text; **Read results aloud** and **Copy results** are the owner's actions; nothing speaks
  on its own. Tests: `test/che_render_bench_test.dart`.

## 2b. Adaptive frame budget (implemented on this branch, device-independent)

The Brain Room now adapts its live rendering to measured frame times, whatever the renderer
behind it (`lib/brain/che_frame_budget.dart`, wired in `che_brain_space.dart`):

- Input: Flutter's `FrameTiming` (build + raster) for every frame while the Brain is on screen.
  Never the device model.
- **Full** rate while frames fit the 60 Hz budget. **Economy** after 20 consecutive frames over
  20 ms: the painter runs on every other ticker tick (30 Hz paint; the camera and the neuron
  animation still advance every tick, so nothing slows down visibly), the blurred bokeh pass
  (the one costly backdrop pass) is skipped, and node labels are capped at 3 instead of 7.
- Back to full after 120 consecutive frames under 12 ms. Every re-entry into economy doubles
  that wait (up to 8×), so the level never flickers.
- Frames between 12 and 20 ms, or an isolated slow frame, change nothing.
- `CheFrameBudget.describe()` is available for a Read-aloud status; nothing is spoken by itself.

Verified: `test/che_frame_budget_test.dart` (entry, alternation, recovery, doubled waits,
indifference to the middle band and to isolated slow frames) and the controller tick without a
repaint. **Not verified on an iPhone:** the 20 ms / 12 ms thresholds come from the 60 Hz budget,
not from device measurements; the owner's benchmark run will show whether economy engages on his
phone at 2 000 and 10 000 records.

## 3. Measurements so far

All numbers below are from this VM (CPU only). They are not iPhone numbers.

| Scene | Backend | Where | Result |
|---|---|---|---|
| 2 000 orbs, 2 730 edges | native painter, canvas commands only | `flutter test` (Skia software) | 6.9 ms avg, 15.3 ms p95 per frame |
| 5 000 orbs | native painter | `flutter test` | 7.8 ms avg, 9.7 ms p95 |
| 10 000 orbs | native painter | `flutter test` | 14.6 ms avg, 21.3 ms p95 |
| 2 000 orbs, 3 000 edges | WebGL (bundled Three.js) | headless Chromium, SwiftShader | 16.6 fps, 50 frames in 3 s, JS work 4.8 ms avg; the loop dropped to the 30 fps cadence |
| 2 000 orbs | WebGPU (raw) | headless Chromium, SwiftShader | adapter and device obtained, then `device.lost` ("A valid external Instance reference no longer exists"); reported and fell back to WebGL |
| bridge | — | headless Chromium | `brainBenchRun({nodes: 2000, evil: 'alert(1)'})` refused: "unknown parameter: evil" |

What this shows: the harness runs end to end, the validated bridge refuses what it should,
and the WebGPU fallback chain fires for real. What it does not show: how either backend
performs on an iPhone's GPU, where the native painter's canvas work is rasterized by
Impeller on Metal and the WebView is WKWebView. That is the measurement the directive
asks for, and only the owner's phone can give it.

**Pending (owner):** open Settings → Rendering benchmark on the iPhone, press Run, then
**Copy results** or **Read results aloud**, and paste or dictate them here. The result
lines name each backend, the frame rate, canvas/JS work per frame, raster time per frame
(native), frames over budget, whether WebGPU was available (iOS 26 WKWebView exposes
WebGPU; earlier iOS does not) and every fallback that fired.

## 4. Decision rule (set now, applied to the iPhone numbers)

- Keep the native painter as the Brain's live renderer unless WebGPU or WebGL on the phone
  sustains at least 1.5× the native frame rate at the same orb count with the same
  features (glow, labels, selection, pulses), **and** the fallback chain above holds on the
  device (lost device, backgrounding, Reduce Motion, Low Power Mode).
- If adopted, the WebGPU/WebGL page becomes a second *backend* of `CheBrainSpace` fed by the
  same `CheBrainSpaceController` through the validated parameter bridge; it is never a
  second Brain, never a second scene graph, and never replaces `flutter_scene` in the rooms.
- The MP4 pipeline stays what it is; no live scene is ever presented as an export.

## 5. Not verified

An iPhone (frame rates, WebGPU availability in WKWebView, Reduce Motion and Low Power
Mode behavior); the production app build with the new asset folder (declared in
`pubspec.yaml`, built by the next IPA).
