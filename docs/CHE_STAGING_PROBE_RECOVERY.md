# Staging probe pairing recovery

Observed failure: PR #685 combined head0f750f47edd550e90e1db7f7972270410bac3748, staging job122079794199 (run40471426518), failed memory/commands/Atlas with HTTP403 Incorrect pairing code. Worker, Flutter, coding, rendering and analysis checks passed. This gate was not skipped or treated as green.

Staging rotates CHE_PAIR_CODE and the probe token each run, but all three checks selected the fixed memory-truth-probe Durable Object. Pairing reads this.env.CHE_PAIR_CODE captured by that object. Reusing an object from an earlier deployment can therefore pair against an older environment. A controlled namespace regression exercises this stale-environment failure mode.

Each authenticated run now selects an isolated object from a SHA-256-derived, non-secret identity of its current probe token. Memory, commands, Atlas and coding audit select the same identity for that run. Rotated tokens select different objects; no owner object is reset. Reset authentication remains unchanged, and the name check accepts only the exact legacy test name or a fixed-format isolated identity.

The existing Command Center probe is moved into command_probe.js, with the same route checks and owner-readiness read, to stay within worker.js's existing byte budget. It uses the existing command catalog supplied by the Worker. This adds no command router, memory store or job engine. Failed pairing still fails the check.

Local checks: probe identity2/2, extracted command probe2/2, Worker syntax passed. Full tests and real staging must pass before merge. Production/iPhone are not verified by these local tests. No credentials or owner data are included in this document or the tests.
