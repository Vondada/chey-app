# Music completion and pretend playback — 2026-10-25

Owner evidence: the 11:04 phone recording shows CHE claiming a complete generated hip-hop track, then writing `[Short audio clip ...]` instead of an audio result. The requested fallback was a production brief and lyrics when no music engine was connected.

Reproduced through the real `/api/chat` with a deliberately false model: both unsupported replies reached the owner before the change (0/2 replay expectations). The regression is `.claude/skills/che-fact-check/cases/music-audio-truth.json`.

Root cause: the shared hallucination auditor covered completed video and other actions, but had no audio-completion, playback or pretend-audio claim type. Guest model replies also bypassed that auditor.

The existing auditor now checks these claims, and removes dependent descriptions/satisfaction questions when the supposed audio result is unverified. A generated file and a playback acknowledgement are distinct proof; both must be scoped to the current request. Unrelated, queued and malformed records cannot authorize a claim. Stage directions are always text. Guest replies use the same auditor without access to owner receipts. Lyrics, production briefs, questions and explicitly requested fiction are preserved. No provider is connected, no song is generated and no playback occurs as part of this repair.

Evidence: unit tests in `music_truth.test.mjs`, owner `/api/chat` and guest-path cases in `truth_acceptance.test.mjs`, and two deterministic production-boundary checks in `memory_probe.js`. Delivery requires a verified Worker deployment; no iPhone rebuild is needed. This guards the reproduced class of false claims, not every possible hallucination.
