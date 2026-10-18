# CHE JARVIS Integration Audit — 2026-10-14

Source: live `main` at `fe18860bb60e15d5313d9cede2766d338c8ff7a0`, `AGENTS.md`, `che-mailbox` LIVE-HANDOFF, and directly inspected implementation. This is a bounded integration audit, **not** a claim that every CHE subsystem is defect-free.

## Verified existing systems (reused; do not replace)

| Need | Source of truth | Verified implementation |
|---|---|---|
| Commands / 71 workflows | `server/cloudflare/command_catalog.js`, `lib/commands/*` | Existing catalog, workflows, status, approvals, client |
| Google YouTube sign-in | `server/cloudflare/youtube_connection.js`, `lib/mailbox/che_mailbox_screen.dart` | Google OAuth with PKCE, callback, existing Connect YouTube route |
| NinjaTrader / Tradovate | `server/cloudflare/broker_tradovate.js`, `server/cloudflare/worker.js` | One-use state, official OAuth URL, existing callback and tokens |
| Broker risk permissions | `server/cloudflare/trading_desk.js` | Existing trading desk controls and confirmation flow; **not tested against owner's live broker** |
| Voice playback | `server/cloudflare/phone_voice.js`, `preferred_elevenlabs_voice.js`, `fish_audio_voice.js`, `lib/home_state/voice.dart` | ElevenLabs primary, Fish fallback, local voice settings separate |
| Memory & autonomy | `memory_provenance.js`, `objective_graph.js`, `coding_runtime.js`, `recovery_policy.js` | Existing paths; not duplicated here |
| SideStore / Shorebird | `.github/workflows/che-iphone-ipa.yml` and update code | Existing build/update pipeline; actual phone acceptance still requires owner |

## Gap inventory and PR #306 scope

1. **Verified:** Voice Settings previously selected Kokoro/iPhone fallback only; cloud voice selection did not control `/api/voice/edge`. PR #306 adds owner-scoped catalog of voices verified by the provider, persistent voice selection on the Worker, actual synthesis-route override, in-app Save and preview. Configured Fish speaker can become primary; arbitrary Fish speaker IDs are **not** accepted.
2. **Verified:** No unified CHE account connections page. PR #306 adds one based on `/api/commands` live connector readiness, not fabricated service claims. Only YouTube and Tradovate existing OAuth can connect through their official external consent screens; keys/configuration alone is labeled **Configured**, not **Connected**.
3. **Verified:** Google YouTube upload scopes do not grant Gmail, Google Drive or Calendar access. Those require new carefully scoped OAuth connections and owner consent; PR #306 marks them Unsupported rather than attempting a silent privilege escalation.
4. **Verified:** No Plaid or similar verified bank linking implementation exists. The banking row remains Unsupported, read-only by policy. **No bank passwords, bank tokens, fake balances, or transactions** may be created.
5. **Verified:** Client-scouting and business commands exist in Command Center; they are not proof of third-party CRM/accounts signed in. GitHub/Stripe secrets are shown as **Configured** until an actual OAuth/session receipt exists.
6. **Verified:** Previously connecting NinjaTrader from Chat required a model/answer round trip. PR #306 adds a thin owner-only POST wrapper around existing `connectLink()` and sends the official URL directly to the iPhone. It does not bypass trade approval.
7. **Known limitations:** Native iPhone audio, actual Google consent, broker OAuth, credentials, paid-provider billing/voice inventory, banking institutions, and current iPhone installation cannot be verified by mocked CI. User must explicitly authorize provider access and, if needed, paid enrollment.

## Security boundaries

- Owner-only `/api/voice/choices`, `/api/voice/choice`, `/api/voice/preview`, and `/api/broker/tradovate/connect/start` reuse the existing device bearer/tenant role authorization.
- A saved ElevenLabs voice ID must match `GET /v1/voices` for CHE's actual provider account; arbitrary IDs are rejected. Voice API secrets never leave the Worker.
- Natural cloud voice previews must be individually confirmed in CHE because they can use existing provider credits. No provider subscription is created.
- No new bank connector, transfer capability, trade execution, YouTube posting, or Google OAuth scopes are added by this slice.
- Do not silently claim money, broker orders, upload jobs, live quotes, or integration status from mock tests.
- The app remains quiet on passive page load. User-requested command navigation and Read This may speak.

## Release gates

Worker unit/security tests, Flutter analysis/tests, code review, Worker deployment with live commit verification, SideStore-compatible IPA, actual iPhone voice test and live connection consent where applicable. **Any unmet gate remains an explicit blocker; do not claim this is a fully deployed JARVIS-style assistant until they pass.**

## Speech continuity and one voice per reply (2026-10-18)

Owner request: one voice per response, natural continuous speech, clean spoken text, the chosen voice kept until he changes it, and diagnostics. Same pipeline as before (`lib/che_speech_pipeline.dart` → `/api/voice/edge` → native `playClip`); no second speech system.

Causes found in the code:
- **Voice switched mid-reply.** Every clip asked "ElevenLabs, else Fish" on its own. One ElevenLabs timeout paused ElevenLabs for two minutes, so the rest of that reply came from Fish. A selected Fish voice fell back to Mary the same way.
- **Clips over 800 characters went to Fish.** The streaming chunker had no size cap, and ElevenLabs refuses clips over 800 characters.
- **Clips split mid-phrase.** The chunker released text that ended at "3." or "Dr." while the reply was still streaming, and split after list numbers and abbreviations.
- **Symbols read aloud.** Read This had no Markdown cleanup; chat replies lost line breaks before cleanup, so headings and list items ran together, and links were read as URLs.
- **The chosen voice was undone.** The choice lives in the shared `che` record. A long request (chat turn, Office run) that loaded the record before the owner changed voice wrote its older copy back afterwards. The picker also preselected the first listed voice when the saved one was missing from the provider's list.

What changed:
- **Turn lock.** The phone sends `turn`, `index` and, after the first clip, `lock` (the provider that spoke it). The Worker keeps the turn's voice settings (`voiceTurnFor`), tries only the locked provider, retries once only when a second call cannot pay twice for one clip (a server error, a refused connection, or a short server rest that made no call; never a timeout, rate limit, credits or a refused key), and answers 204 with `X-CHE-Voice-Lock` instead of using the other voice. The first clip may still use the allowed backup (`X-CHE-Voice-Fallback: 1`); the whole reply then stays on it. A Fish turn also keeps its first clip's model.
- **Phone.** `lib/che_voice_turn.dart` assigns the lock, retries a lost server answer once, and stops the reply at the first part the locked voice cannot speak. The rest of the reply is shown in the silent-voice banner with the reason. Stop and barge-in cancel the turn; nothing more is requested.
- **Chunks.** `cheSentenceEnd` ends a sentence only where a person would stop, and never at the end of text still streaming. Streamed chunks are at most 640 characters and are cut at a phrase break when one sentence is longer. Lists and headings keep their lines.
- **Spoken text.** `cheSpeakableText` turns headings, list items (numbers kept), tables, links, web addresses (said as the site), inline code, emphasis, arrows and status marks into speech. Chat replies and Read This use it.
- **Voice choice.** Each change is stamped and kept under `voice_pref_v1`. Every load puts the newest choice back into `che` (`reconcileVoiceChoice`). All voice-change routes and Voice Studio chat use `saveVoiceChoice`.
- **Diagnostics.** Each clip's log entry has the lock, index, attempts and a voice tag (provider plus a one-way fingerprint of voice, model, speed and settings, never the ID). Each reply's phone report adds provider, tags, switches, fallback, interruption, Stop, retries, gaps (count, max, average), time to first audio, slowest synthesis and the iPhone's per-clip setup time. The Voice diagnostics sheet shows a "Last spoken reply" line.

Not changed, and why:
- **The native player still prepares each clip after the previous one ends.** A gapless native queue needs a new IPA, and this release is a Shorebird patch. The new "iPhone setup" figure measures that cost on the phone.
- **ElevenLabs `previous_text` context is not sent.** It could not be confirmed that it is free, and the owner's spending cap applies.
- **Clip edge silence is not trimmed.** That needs decoding the audio.

Tests: `server/cloudflare/phone_voice.test.mjs`, `test/che_voice_turn_test.dart`, `test/che_spoken_text_test.dart`, and new cases in `test/che_speech_chunker_test.dart`. All are mocked: none of them prove iPhone playback.
