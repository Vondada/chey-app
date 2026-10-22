# CHE independent voice engine: evaluation and selection (2026-10-22)

Status: **evaluation only. No model is installed, no audio was generated, nothing is deployed.**
Owner direction: use an open-source voice-cloning model as CHE's long-term independent voice engine; evaluate licences, quality, expressive speech, iPhone compatibility and operating cost before selecting one; keep Kokoro as the offline fallback; keep Fish Audio and ElevenLabs as optional providers; start with licensed pretrained models and no GPU purchase.

## 1. What was actually checked

| Check | Result |
| --- | --- |
| Hugging Face (`huggingface.co`, `hf-mirror.com`, `cdn-lfs.huggingface.co`) | **Blocked** from this container. Model weights and model-card licences could not be read. |
| GitHub release downloads (`github.com/*/releases`) | **Blocked** (403). Weight files shipped as release assets cannot be fetched. |
| `raw.githubusercontent.com` (code, LICENSE, README) | Reachable. Licence and README text read for each candidate. |
| `pypi.org` (package metadata) | Reachable. Licence metadata read for each candidate. Wheels were **not** installed (no weights in them). |
| Local inference | **Not run.** No cloning weights were available, so quality, expressiveness, cadence and pronunciation were **not measured**. |

Consequence: the selection below is based on licence text, published capability claims and cost structure. It is not a listening test. Every quality claim here is marked as unverified until it is run on real weights.

## 2. Candidates and licence evidence

Code licence is what the repository or package states. **Weight licence** is what the model's own terms say; for the candidates marked "unverified", it must be read on Hugging Face before use.

| Candidate | Code licence (evidence) | Weight licence | Voice cloning | Expressive / emotion | Runs on CPU (no GPU) | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| **Chatterbox** (Resemble AI) | MIT (repo LICENSE and PyPI `chatterbox-tts` 0.1.7 metadata) | **Unverified** (HF blocked) | Yes (reference audio) | README lists paralinguistic tags (for example laughter) on the Turbo/Nano models | **Nano** (110M, English): README says about 3x realtime on 8 CPU cores. Multilingual V3 (500M, 23+ languages) and Turbo: GPU examples only in README | **Primary candidate to test.** Needs weight licence read first. |
| **OpenVoice V2** (MyShell) | MIT (repo LICENSE; PyPI `openvoice-cli` classifier MIT) | README: "OpenVoice V1 and V2 are MIT Licensed. Free for both commercial and research use." | Yes (tone colour cloning on a base TTS) | Style control is in the README (emotion, accent, rhythm, pauses), but depends on the base TTS voice | Not stated in README; light model | **Licence-clean fallback candidate.** Weaker expressiveness expected. Test first on CPU. |
| F5-TTS | MIT (repo LICENSE; PyPI `f5-tts` 1.1.22) | **CC-BY-NC** (README: "pre-trained models are licensed under the CC-BY-NC license") | Yes | Good | Not verified | **Excluded.** Non-commercial weights. |
| Coqui XTTS-v2 | MPL-2.0 (repo README badge; PyPI `TTS` 0.22.0) | Not in the repo README. From the project's published terms (not re-read here): non-commercial Coqui Public Model License | Yes | Good | Not verified | **Excluded** unless its weight terms are re-read and allow commercial use. |
| GPT-SoVITS | MIT (repo LICENSE) | **Unverified.** README points to HF for pretrained weights; no weight licence stated in the README | Yes (few-shot) | Good | Not checked here | **Parked.** Weight licence and training-data terms must be read first. |
| StyleTTS 2 | MIT code; the inference path depends on a GPL-licensed package (README). The MIT PyPI `styletts2` package is lower quality (README) | README pre-trained model terms: inform listeners the voice is synthesized, and only clone voices whose speakers allow it | Zero-shot style; not a cloning-first design | Strong prosody | Not verified | **Parked.** GPL path and consent terms conflict with a clean commercial build. |
| Kokoro-82M (already in the app) | Apache-2.0 weights (README) | Apache-2.0 | **No** cloning (fixed voices) | Limited emotion | Yes (on device, sherpa-onnx) | **Keep as the offline fallback.** Unchanged. |

Chosen for testing: **Chatterbox** (Nano first, because the CPU claim is in its README and the cost is lowest), with **OpenVoice V2** as the licence-clean comparison. Neither is selected for production until a weight licence is read and a listening test passes.

## 3. iPhone compatibility

- None of the cloning candidates runs inside the iPhone app in this repo. They are PyTorch models, and no on-device conversion (Core ML or ONNX) exists or was tested.
- So the cloning engine must run on a server, and the phone plays the returned audio through the existing native player (`lib/che_native_voice.dart`). The on-device Kokoro path stays as it is.
- The Cloudflare Worker cannot host these models (no PyTorch, no GPU, CPU and memory limits). The engine therefore needs a separate service. That is a new hosting decision, which the owner has not approved.

## 4. Operating cost

Not priced here. No provider was contacted and no price was read, so no figure is given. The cost drivers are:

- A CPU-only host with enough memory for the model and an always-on or on-demand endpoint.
- Per-request CPU time. For Nano, the README's 3x realtime on 8 cores means a 10 s reply takes about 3 s of wall-clock time on 8 cores, before network time.
- Storage for reference voices (owner-authorized recordings only).
- No GPU is needed for Nano. Multilingual V3 and Turbo are GPU-oriented in their README examples, so they are out of scope under the no-GPU rule.

A quote from a real provider is needed before any hosting decision. Nothing is bought.

## 5. Fit with CHE's existing voice architecture

- Kokoro stays the offline fallback (`lib/che_kokoro_voice.dart`).
- Fish Audio (`server/cloudflare/fish_audio_voice.js`) and ElevenLabs stay as optional providers.
- The new engine is one more adapter in the existing engine chain (`server/cloudflare/speech_delivery.js`, `chooseEngine`). It must not become a second router. The existing consent rules stay in force: a voice is cloned only from recordings the owner has authorized, and ElevenLabs output is refused as training material.
- The playback controller (`lib/che_speech_playback.dart`) needs no change for a new engine, because it consumes clips and not providers.

## 6. Reported measurement from the owner's recording (not verified by this evaluation)

The `claude-voice-evidence` note in `che-mailbox` reports that, in the owner's screen recording, the voice changed at about 34 s into a reply (higher pitch, band-limited audio, consistent with a 16 kHz fallback voice), and that gaps between clips reached about 600 ms. This evaluation did not analyse that recording. It is a reason to keep the engine chain pinned to one voice per reply, and it belongs to the voice-continuity work (task #71, already shipped) rather than to selection. Treat it as a reported finding until someone re-measures it.

## 7. Selection and conditions

1. **Read the Chatterbox weight licence on Hugging Face** (`ResembleAI/chatterbox-nano`, and the Multilingual and Turbo models if used). Proceed only if it allows commercial use and voice cloning with the owner's own recordings.
2. **Read the OpenVoice V2 model page licence** on Hugging Face to confirm the MIT statement in the README.
3. **Run a CPU test** of Chatterbox-Nano and OpenVoice V2 on the owner's authorized female reference recording. Score: naturalness, identity match to the reference, emotion, cadence, pronunciation of names and numbers, and time to first audio. Keep the outputs and the listening notes in the handoff.
4. **Listening test** with the owner. No selection without it.
5. **Hosting decision**: owner approves a CPU-only host and a price quote. No GPU purchase.
6. Keep Kokoro, Fish and ElevenLabs unchanged until step 4 passes.

## 8. What is not done

- No model downloaded, installed or run. No audio generated. No quality, expressiveness, pronunciation or naturalness claim is made.
- No hosting, no provider signup, no purchase.
- No change to the app or Worker behaviour. Only this document and the handoff were updated.
- The named licensed speech corpus is still not named. Training on any corpus is blocked until the owner names it and its licence is read.
