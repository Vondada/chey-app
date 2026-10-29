# CHE Dolphin (offline model): readiness

Scope: the private offline model integration. Written 2026-10-29 from the source in branch `wt/dolphin-readiness`
(base `origin/main` at 60ba3a08). No device, no model file, and no network fetch was used.

Network note: huggingface.co is blocked in this session. No model was downloaded, and no attempt was made to reach it.
Every model hash, size and licence below is taken from the repository or must be checked by the owner.

## 1. What exists

| Item | Where | State |
|---|---|---|
| Engine selector (pure Dart, no network, no model load) | `lib/che_model_selector.dart` | Exists. `chooseCheEngine` picks `onDevice`, `online` or `none` for the modes Auto, Offline and Online, and always returns a reason. Model-agnostic: the on-device name is a parameter. |
| Selector tests | `test/che_model_selector_test.dart` | Exists, 10 cases. Uses the label `Dolphin 3.0 1B (on this iPhone)` as a test string only. Not run in this session (no Flutter SDK installed here). |
| Local Brain wrapper | `lib/che_local_brain.dart` | Exists. Download, verify, load, generate, cancel and dispose through `MethodChannel('che/local_brain')`, falling back to `CheLocalAI` (`che/local_ai`). |
| Pinned model entry | `cheDefaultLocalBrainModel` in `lib/che_local_brain.dart` | SmolLM2 1.7B Instruct Q4_K_M. Filename `smollm2-1.7b-instruct-q4_k_m.gguf`, 1,058,914,304 bytes, context 8192, expected RAM 1800 MB, licence recorded as Apache-2.0. **`sha256` is the empty string.** |
| Download path | `CheLocalBrain.downloadModel` | Passes an empty `sha256` to the native `download` and `verify` calls, so the file is not checked against a hash. |
| Status line on a platform screen | `lib/platform/che_platform_screens.dart` (about line 703) | Shows `CheLocalBrain().health()`. This is not the Brain Room. |
| Offline audit | `docs/CHE_OFFLINE_BRAIN_AUDIT.md`, `docs/CHE_PRIVATE_VOICE.md`, `docs/CHE_UNIFIED_BRAIN.md` | Existing notes. They say no on-device model answers today. |

Checked in this session:
- `grep -c "local_ai\|local_brain" tool/bootstrap.sh` returns 0. The generator writes no native handler for either channel.
- `ios/` is gitignored (`.gitignore` line 12), so the native project is generated, not stored.
- `chooseCheEngine` is imported only by its test. No production code calls it.
- No file in the repository pins a Dolphin model: no source URL, filename, size, licence or hash. "Dolphin" appears only in the test file.

## 2. What is missing

### 2.1 On-device runtime (blocks any offline answer)

- The `che/local_brain` and `che/local_ai` channels have no native implementation. A call raises `MissingPluginException`,
  which `CheLocalAI.respond` turns into `null`. So on-device inference does not run on the iPhone today.
- No runtime is chosen. Two options are documented and neither is built:
  - Apple Foundation Models (`LanguageModelSession`): no download, but only on Apple Intelligence iPhones, iOS 26 or later.
    Availability must be checked on the owner's phone.
  - llama.cpp with a GGUF file (Metal): runs on more devices, needs an XCFramework added to the generated Xcode project
    and a 1 to 2 GB download.
- Dolphin cannot run until a runtime exists that loads its file. For a GGUF Dolphin, that is the llama.cpp path.

### 2.2 Verified model hashes

- SmolLM2: `sha256` is empty. Verification is skipped. The owner must add a hash computed from the approved file,
  checked against the publisher's stored SHA-256 for that file.
- Dolphin: no entry exists. No file, size, licence or hash has been chosen.

### 2.3 Benchmark harness

- Only `tools/dolphin_bench/README.md` exists (added in this branch). It defines the metrics and the record format.
- There is no harness code, no test fixture and no recorded device run. No speed, memory, accuracy or battery number exists.

### 2.4 Brain Room link

- Nothing in the Brain Room (`lib/home/che_memory_brain.dart`, `lib/home_state/hub_rooms.dart`) reads the model mode,
  the selected engine, or the Local Brain health.
- The only UI that shows Local Brain health is the platform screen in `lib/platform/che_platform_screens.dart`.
- The selector's reason text is not shown on any answer yet. The owner's rule is that the reason must be visible.

### 2.5 Test status

- `flutter test test/che_model_selector_test.dart` was not run: Flutter is not installed in this session, and the disk has
  about 4.8 GB free, so no SDK was installed. The test was read, not executed. The expected reasons in the test match the
  strings in `chooseCheEngine`.

## 3. Model files and the approval the owner must give

### 3.1 Currently pinned (SmolLM2 1.7B Instruct Q4_K_M)

| Field | Value in repo | Owner must confirm |
|---|---|---|
| Source file | `https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF/resolve/main/smollm2-1.7b-instruct-q4_k_m.gguf` | Still the file the owner wants |
| Source page | `https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF` | Open it and check the licence |
| Licence | Apache-2.0 (code comment) | Verify on the source page |
| Size | 1,058,914,304 bytes | Match the publisher's file size |
| SHA-256 | empty | Compute on the downloaded file, then compare with the hash the publisher lists |

### 3.2 Dolphin

No source is pinned. The owner must name, in writing:
1. the exact repository and the exact GGUF filename (the repo does not say which Dolphin release or quantization);
2. the quantization and approximate size, which set the RAM need against the 1800 MB figure in the model entry;
3. the licence, read from the source page, and whether it allows on-device use;
4. the SHA-256, copied from the publisher's listing and compared with a local computation.

Only after that approval can the model entry (`CheLocalBrainModel`) be changed. No Dolphin file has been
inspected in this session.

## 4. Exact owner actions that unblock each item

1. **Runtime**: choose Apple Foundation Models or llama.cpp. For llama.cpp, approve adding the XCFramework to the
   generator (`tool/bootstrap.sh`), then run a new iPhone build. Nothing here can be verified without the owner's device.
2. **Model file**: approve one source (Section 3). Then download it on a machine with internet access, compute
   `sha256sum` on it, compare with the publisher's listed hash, and send the hash and size to the agent to write into
   `cheDefaultLocalBrainModel` (or a new Dolphin entry).
3. **Benchmark**: run the procedure in `tools/dolphin_bench/README.md` on the owner's iPhone, with the same build, and send
   the record file. No number is claimed before that.
4. **Brain Room link**: the owner decides where the engine and reason show (Brain Room card, chat answer label, or both).
   Then the agent wires `chooseCheEngine` into the send path and adds a test for the visible label.
5. **Test run**: on a machine with Flutter, run `flutter test test/che_model_selector_test.dart` and record the output.

## 5. Not claimed

- No offline model answers today.
- No Dolphin model is identified, downloaded or verified.
- No hash, speed, memory, accuracy or battery figure exists.
- The selector test has not been run in this session.
- No change was made to `tools/certification/` or `server/cloudflare/`, and no deploy or paid call was made.
