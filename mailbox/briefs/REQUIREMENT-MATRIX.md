# CHE requirement matrix (owner master spec, reconciled 2026-10-08)

Status: VERIFIED = proven by a test or live run in the evidence column. PARTIAL = some of it is built. MISSING = no code found. BLOCKED = needs something only the owner or Apple can provide. NOT CHECKED = not examined this session. Nothing here is marked done without evidence.

| Area | Status | Evidence | Still open |
|---|---|---|---|
| Money and delete gate | VERIFIED once PR #256 merges | PR #256 head 0d3e2f6; `owner_action_gate.js`; wired in `/api/chat`; Worker tests 767/0 | merge, then deploy check |
| App-permission gate | PARTIAL | `gateAppAccess` unit-tested but not called. Every client open path starts with the owner: voice "open X" (`send.dart`), a voice-picked link (`streaming.dart`), taps, the rollback dialog (`main.dart`). No CHE-initiated open exists. | call it before any future CHE-initiated open; standing per-app grants if the owner wants them |
| Structured-output (JSON) recovery | VERIFIED by tests | `self_development.js` `repairJsonText`, `jsonObject`; tests for fenced, wrapped, Dart escapes, trailing commas, truncated output never completed; format repair uses its own `format_retry` stage | the live re-run of the exact autonomy test (not run; live Worker unreachable from the sandbox) |
| Autonomy acceptance suite (3 consecutive passes) | MISSING | none run | four tests need the live Worker |
| CHE autonomy exam, Round 7 | VERIFIED: PASS 5/5 | claude.jsonl f650b597; reply 23:14:57Z | none |
| Autonomy and self-coding Round 8 (10 questions) | IN PROGRESS | sent 7e4e932; CHE's 23:38 reply was one fragment; re-asked d8f3406 | grade the full answers |
| Conversation brain | VERIFIED in code; live not verified | `brain_memory.js`; deploy 189b59f succeeded | none in code |
| Shared pgvector memory | PARTIAL | `vector_memory.js` recall and writes wired; `AI` binding in `wrangler.jsonc` | owner sets `CHE_PGVECTOR_REST_URL`/token and runs `pgvector_setup.sql`; check `/api/capabilities` for `postgres_pgvector: true` |
| Office agents on one shared memory (phase 1) | MISSING | no per-agent write path; only `owner_context` rows | build it |
| Soul settings as structured fields | MISSING | 0 files | build it |
| Office status UI | PARTIAL, not checked on a device | 22 files mention office status | visual check |
| War Room | PARTIAL, not checked on a device | 30 files | visual check |
| 3D characters in the app | MISSING in app | `assets/characters/` only; 2.3 to 3 MB each | embed, compress (about 20 MB total), facial blend shapes, lip-sync, IK |
| Immersive 3D engine | PARTIAL | `flutter_scene` ^0.23.0 in `pubspec.yaml` | check where it is used |
| Face ID / biometric gate | MISSING | `local_auth` not in `pubspec.yaml` | add the package and the gate |
| Remote push (APNs) | BLOCKED | no `aps-environment` entitlement | Apple provisioning (owner) |
| Local notifications | NOT CHECKED | none | check |
| Device continuity handoff | MISSING | 0 files | not started |
| Parental guidance and family profiles | UNKNOWN | 3 files mention it; no feature found | check whether any of it is real |
| Car and parked location | UNKNOWN | 2 files mention vehicle or parked location | check |
| Change history | PARTIAL | `truth_layer.js` `changeHistoryIntent`, `loadChangeHistory` | accessible UI; backfill from Git only |
| YouTube connection | PARTIAL | PR #253 merged as f7921c0; deploy 37836179612 succeeded | owner secrets and Google OAuth test; one unlisted test upload |
| Trading Room learning | PARTIAL | PR #178 first cut | intraday data needs the owner's feed; learning shown in UI |
| Starred repositories | BLOCKED | owner has not named them | owner names them |
| Stale branch `chatgpt/postmerge-reliability-132` | BLOCKED | the permission system blocks the delete | owner runs the delete |
| Mailbox collaboration | VERIFIED in use | che-mailbox commits 7e4e932, d8f3406, 115a1ff | none |
