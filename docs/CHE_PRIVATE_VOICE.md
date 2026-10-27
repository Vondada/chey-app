# CHE Private voice

The owner asked (2026-10-25): "Is there a way I can use live voice and it doesn't go to OpenAI or anyone and stays
private? Show me that way."

**Short answer:** yes for your voice audio, mostly for your words. With **Private voice** on, your microphone audio
never leaves the iPhone and CHE's spoken replies are made on the iPhone. The *text* of what you said still goes to
CHE's own server (the Cloudflare Worker in your account), where Cloudflare Workers AI in that same account works out
the answer. No OpenAI, Google, Groq, ElevenLabs, Fish or other AI company receives it. A fully offline answer needs a
language model running on the iPhone, which CHE does not have yet (see "Next step" below).

Private voice is not a new voice engine. It is the existing local voice loop (`lib/che_local_voice_loop.dart`, Apple's
recognizer plus the on-device Kokoro voice) with the cloud parts switched off and enforced in code.

## Turn it on

- Say or type **"turn on private voice"** (also "go private", "enable private mode"). Off: **"turn off private voice"**.
- Ask **"is my voice private?"** (also "where does my voice go?", "what leaves my phone?"). CHE answers from the actual
  current settings: whether Private voice is on, whether this iPhone reports on-device recognition, whether the
  on-device voice is loaded, and whether live voice to OpenAI is set up.
- More → UI Controls → Voice replies → **Private voice** switch (VoiceOver: "Private voice is off. Turn on private
  voice"). The switch runs the same route as the spoken command, so the change is confirmed aloud.
- While it is on, a quiet banner at the top of the app reads "Private voice on · voice stays on this iPhone", with a
  labelled **Turn off** button. It is never spoken by itself (passive screens stay silent).
- The setting is saved on the iPhone (`SharedPreferences`, key `che.voice.privateVoice`) and survives restarts.

## Where your voice and words go

Hosts verified in code on 2026-10-25 (file references below the table).

| | **Realtime live voice** (default when OpenAI live voice is set up) | **Standard local voice** (Private voice off, no live voice) | **Private voice** |
|---|---|---|---|
| **1. Microphone audio** | Streamed over WebRTC to **OpenAI** (`api.openai.com/v1/realtime/calls`; the session key comes from the Worker's `/api/live/token`, which calls `api.openai.com/v1/realtime/client_secrets`). | Apple's speech recognizer on the iPhone. The Swift side sets `requiresOnDeviceRecognition` when the iPhone supports it; **when it does not, Apple's servers do the recognition**. | Apple's recognizer **on the iPhone only**. If this iPhone/language cannot recognize on-device, CHE says so and keeps the mic closed; it never falls back to Apple's servers. Realtime never connects. |
| **2. Transcribed text (your words)** | OpenAI returns the transcript to the app; the app sends it to **CHE's Worker** (`/api/chat`). | **CHE's Worker** (`/api/chat`). | **CHE's Worker** (`/api/chat` with `private: true`). |
| **Which AI answers** | The Worker's router: free keyed engines first for owner chat (Groq, Google Gemini, Cerebras, Mistral, GitHub Models, SambaNova, Hugging Face, OpenRouter, whichever keys exist), then **Cloudflare Workers AI**. Paid OpenAI/xAI/Anthropic only if `CHE_ALLOW_PAID_AI=1`. Web research may send the question to Wikipedia, DuckDuckGo, GDELT/news sites or a research connector. | Same as Realtime. | **Cloudflare Workers AI only**, through the Worker's own `AI` binding in CHE's Cloudflare account. No keyed or keyless engine, no web search, research, other AIs, agents, picture reading or video. |
| **3. Reply text for speech** | **ElevenLabs** (`api.elevenlabs.io`), then **Fish Audio** (`api.fish.audio`) through the Worker's `/api/voice/edge`. | Same as Realtime (ElevenLabs, then Fish). | **Kokoro on the iPhone** (sherpa-onnx). ElevenLabs and Fish are never called. If Kokoro is not loaded yet, the reply is shown as large text with a haptic instead of spoken. |
| **Wake word "Chay"** | Porcupine on the iPhone (audio stays on the phone; Picovoice's SDK checks its AccessKey online). | Same. | Same. |
| **Passwords, master profile, vault** | Handled on the iPhone only; never sent. | Same. | Same. |

What still leaves the phone in Private voice, said plainly:

- The text of your words, to CHE's own Worker (Cloudflare), which runs Workers AI in your Cloudflare account to answer.
  Cloudflare is the host of CHE's server in every mode; Private voice removes every *other* recipient.
- The Worker keeps the conversation in CHE's own storage (memory, history) as it does in every mode.
- The egress guard still lets the Worker reach CHE's own hosts and the owner's own compute: his GitHub repository
  (`api.github.com` for that repository only), his Cloudflare account API, and his own Ollama or computer server if
  one is configured. These belong to the owner, not to an AI company.
- One-time model downloads with no personal data: the Kokoro voice model from GitHub (`k2-fsa/sherpa-onnx` releases).

## How it is enforced (code, not instructions)

On the iPhone:

- `lib/che_private_voice.dart` holds the setting, the spoken replies, the command parser and the banner.
- `cheUseLiveVoice(... privateVoice:)` (`lib/che_voice_health.dart`) returns false, and
  `CheRealtimeVoiceEngine.connect()` (`lib/che_realtime_voice.dart`) throws before any token request, audio-session
  change or peer connection.
- `CheNativeVoice.start()` and `wake()` (`lib/che_native_voice.dart`) ask the native bridge for
  `on_device_recognition` (Apple's `supportsOnDeviceRecognition`) and refuse to start without it. The Flutter
  `speech_to_text` fallback runs with `onDevice: true`, which errors instead of using Apple's servers.
- `CheEdgeVoice.speak()` (`lib/che_edge_voice.dart`) returns without a network call. `_openSpeechTurn`
  (`lib/home_state/voice.dart`) synthesizes each clip with Kokoro and plays it locally.
- Every `/api/chat` body spreads `ChePrivateVoice.chatFields()` (`lib/home_state/streaming.dart`). Coding jobs and new
  projects (other routes that use outside AI) are refused on the phone with the reason.

On the Worker (`server/cloudflare/private_voice.js`):

- `privateTurn` wraps the whole Durable Object request. While a private turn runs, and while background work it
  started (memory records, summaries) is still running, Security Intelligence's egress guard refuses every outbound
  fetch to a host that is not CHE's own or the owner's own compute ("Private voice is on, so api.groq.com was not
  called").
- `routeText` (`ai_router.js`) answers with the Workers AI binding only while the hold is on or the call says
  `che_private`, adds a note that no search or other AI is available this turn, and reports a failure as
  "only Cloudflare Workers AI may answer, and it did not … No outside AI was used." `callSpecificModel` refuses.
- `privateChatGate` (inside `/api/chat`, after the device is authenticated) refuses web search, research, news, links,
  other AIs, second opinions, agents and the coding crew, video, and attachments, saying nothing was sent; it clears
  the request's plugin and research fields. The main reply path skips its automatic research for private turns.
- A private reply's done event carries `private: true, private_engine: "cloudflare-workers-ai"`.

Known limit: the hold is per Worker isolate, so for the length of a private turn any other request in the same isolate
(for example a background job) is also kept off outside hosts. That only ever makes things more private.

## Tests

- `test/che_private_voice_test.dart`: setting persists; live voice never chosen and the Realtime engine refuses to
  connect with no HTTP request; ElevenLabs/Fish never requested; chat body carries `private: true`; unsupported
  on-device recognition is reported and the recognizer is not started (no server fallback); commands; the data-flow
  answer; Kokoro-only reply path; banner semantics.
- `server/cloudflare/private_voice.test.mjs`: a private request uses only Workers AI even with every provider key
  present; outside hosts are refused while held and reachable again after; the real `/api/chat` answers a private turn
  with no outside host reached; a private web search or "ask Grok" is refused before any model runs.

## What needs the iPhone to verify

No native (Swift) change was made, so the current IPA works; Private voice reaches the phone with the next Shorebird
patch or build. On the iPhone, check:

1. Say "turn on private voice": the banner appears and CHE confirms aloud in the on-device voice.
2. Talk: replies come back in the Kokoro voice (UI Controls voice diagnostics show "On-device voice (private)"), and
   live voice does not connect.
3. Settings → Airplane Mode with Wi-Fi off: CHE should still *hear* you (on-device recognition) but say she cannot
   reach her server; this proves the audio is not going anywhere.
4. Ask "is my voice private?" and check the answer matches what you see.
5. If CHE says this iPhone cannot recognize on the phone, check Settings → General → Keyboard → Dictation languages
   (on-device support depends on the iPhone model and language).

## Next step: fully offline answers (evaluated, not built)

To keep the *words* on the phone too, CHE needs an on-device language model:

- **Apple Foundation Models** (announced at WWDC 2025 for iOS 26): a roughly 3-billion-parameter on-device model with a
  Swift API (`LanguageModelSession`), no download, available only on Apple Intelligence iPhones (iPhone 15 Pro and
  later). Most practical path: a small Swift bridge on the existing `che/local_ai` channel. Needs a new IPA.
  Source: https://developer.apple.com/documentation/foundationmodels (not re-checked in this session).
- **llama.cpp** (GGUF, Metal) or **MLC LLM**: CHE already has the Dart side (`lib/che_local_brain.dart`, SmolLM2 1.7B
  Q4_K_M, about 1 GB, about 1.8 GB RAM, channels `che/local_brain` and `che/local_ai`), but `tool/bootstrap.sh`
  generates no native handler for those channels today, so it always returns nothing. Building it means adding
  llama.cpp's XCFramework to the generated Xcode project. Expect a 1 to 2 GB download, slower and weaker answers
  than Workers AI, and heat or battery cost on long chats.

Either path would let Private voice answer simple questions with nothing leaving the iPhone, falling back to the
Worker only with the owner's yes.
