# CHE architecture audit: where native or server-side technology pays off (2026-10-25)

Flutter stays CHE's app framework. This audit asks, for each heavy subsystem: is there a measured bottleneck, a
capability Flutter cannot reach, or an integration gap? A rewrite is recommended only where the answer is yes.

Numbers below were measured in a Linux cloud container (x86-64), not on the iPhone. They show relative cost and
headroom. On-device numbers still need the owner's phone.

## What CHE runs today (verified in the repo)

| Subsystem | Today | Where |
|---|---|---|
| Capture, monitoring, speech recognition, TTS playback | Swift in AppDelegate: AVAudioEngine, AVAudioSession `.playAndRecord`/`.voiceChat`, SFSpeechRecognizer (on-device when available) | `tool/bootstrap.sh` (generated `AppDelegate.swift`) |
| Wake word, local ASR/TTS | Porcupine 4 (on-device), sherpa-onnx, Kokoro | `pubspec.yaml`, `lib/che_kokoro_voice.dart` |
| Studio effects, mixing, pitch correction, beat synthesis | Pure Dart on `Float32List`, already off the UI thread (`Isolate.run`) | `lib/music/che_dsp.dart`, `che_song.dart`, `che_studio_controller.dart` |
| Live monitoring effects | Swift AVAudioUnit EQ/dynamics/delay/reverb (real time) | `tool/bootstrap.sh` `updateMonitor` |
| Brain Room | Flutter `CustomPainter`, pre-rendered glow sprite, capped orb count, Flutter semantics for VoiceOver | `lib/brain/che_brain_space.dart` |
| Characters, creation viewport, 3D office | three.js in WebViews | `assets/characters/`, `assets/office3d/` |
| AI and creative compute | Cloudflare Worker (Durable Object queue and alarms) + free GitHub Actions CPU worker (Blender) + owner's Colab T4 while its notebook is open | `docs/CHE_CLOUD_COMPUTER.md`, `.github/workflows/che-creation-worker.yml` |

## 1. Real-time DSP: Rust/C++ versus Dart

**Measured.** AOT-compiled (as on the iPhone), a 3-minute 44.1 kHz vocal through each effect:

| Effect | Before | After | Realtime factor after |
|---|---|---|---|
| EQ | 120 ms | same | 1500x |
| Compressor | 373 ms | same | 480x |
| Limiter | 68 ms | same | 2600x |
| Delay | 53 ms | same | 3400x |
| Reverb (Freeverb) | 325 ms | same | 550x |
| Noise reduction | 112 ms | same | 1600x |
| **Pitch correction (YIN)** | **25,820 ms** | **2,644 ms** | **68x** |
| Whole chain, one vocal | 26.9 s | 3.7 s | |

**Finding.** The bottleneck was the algorithm, not the language: YIN's difference function was computed as a direct
O(window × lag) double loop, about 0.9 million multiply-adds per 11.6 ms frame. Rewritten exactly as
E0 + E(τ) − 2r(τ), with r from a packed real-pair FFT, pitch correction is about 10x faster in the same Dart. The new
form matches the old one to below 1e-9 relative error (`test/che_dsp_yin_test.dart`).

**Recommendation: no Rust/C++ now.** A native port would add an FFI build for iOS (xcframework, CI signing, crash
surface) to speed up code that already runs hundreds of times faster than real time. Real-time paths (monitoring)
already run in Apple's AVAudioUnits. Revisit only if a measured per-sample real-time effect exceeds the iPhone
audio callback budget. Then the strongest free option is a small C library through `dart:ffi` (or the
`flutter_rust_bridge` route if Rust is preferred), measured first.

## 2. Swift for advanced iPhone audio and voice

Swift already owns the audio session, capture and recognition, which is the right split. The real gaps are
capabilities that only native code can reach:

| Gap (evidence) | Status |
|---|---|
| Hands-free speech showed no live words (handoff 8f): the recognizer asked for partial results but never sent them to Flutter | **Fixed in this PR**: `partial` events after the echo guard; the composer shows them and never overwrites typed text. Needs a full IPA. |
| Reply gaps between TTS chunks, per-chunk mic reinit (handoff 8i) | Open: a native gapless queue (AVAudioEngine player node scheduling buffers back to back) is the right fix. Needs an IPA and device timing. |
| End-of-turn pause 1.6 to 3.6 s on the native path | Open: tune only with device telemetry (end of speech → utterance → first audio). |
| Long-form on-device recognition | Recommendation: Apple's newer SpeechAnalyzer/SpeechTranscriber API (iOS 26) for faster on-device dictation. It needs iOS 26 on the owner's phone, so it would sit behind an availability check with SFSpeechRecognizer as the fallback. Not built. |

## 3. Brain Room: CustomPainter versus three.js versus Godot

**Measured.** Per-frame CPU (camera update + full paint recording) in unoptimised JIT test mode, an upper bound for
the phone's CPU cost; GPU rasterisation was not measured:

| Records | CPU per frame |
|---|---|
| 300 | 1.5 ms |
| 1,000 | 1.4 ms |
| 3,000 | 3.6 ms |

The 120 Hz budget is 8.3 ms, so the Brain Room has at least 2x CPU headroom at 3,000 records.

**Recommendation: keep the Flutter painter.** For a voice-first, possibly blind owner, its decisive advantage is that
every region and record is a Flutter semantics node: VoiceOver labels, custom actions and spoken navigation are
already built and tested. Moving to three.js in a WebView or to Godot would mean rebuilding that accessibility layer:

- **Godot** adds an engine runtime to the IPA and needs a new embedding and bridge.
- **three.js** draws in a canvas that VoiceOver cannot read.

Neither has a measured problem to fix. The remaining unknown is the GPU cost of the new blur layers on the owner's
phone: measure it with the performance overlay before changing anything. If true 3D meshes are ever needed,
`flutter_scene` (Impeller-native 3D, already a dependency in `lib/widgets/che_native_scene_world.dart`) keeps the
scene inside Flutter. three.js stays the right tool where it is used now: model viewers that load GLB files.

## 4. Persistent CPU/GPU workers

The architecture already has one manager (`docs/CHE_CLOUD_COMPUTER.md`):

- the Durable Object queue with checkpoints, recovery and alarms;
- a free GitHub CPU worker, verified live: Blender GLB in 1.7 minutes;
- the owner's Colab T4 while its notebook runs.

The mission engine proof in this PR adds verified artifacts with SHA-256 receipts on that same queue.

**Recommendation: no new worker system.** The strongest free GPU options all need an interactive session or a
token: Colab, Kaggle, Hugging Face. CHE cannot run them unattended at $0, and the docs say so. The highest-value next
step is operational: the first verified Colab GPU heartbeat and render receipt on the owner's account.

## Implemented in this audit

1. Pitch correction about 10x faster (`lib/music/che_dsp.dart`, `test/che_dsp_yin_test.dart`).
2. Hands-free live transcript (`tool/bootstrap.sh`, `lib/che_live_partial.dart`, `lib/home_state/voice.dart`,
   `test/che_live_partial_test.dart`, `tool/test_ios_audio_session.py`).

## Not verified

- iPhone timings: DSP, Brain Room GPU, voice latency.
- The live transcript on a device: it needs a full IPA.
