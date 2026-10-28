# CHE project history (append-only)

Each entry is dated and says what the evidence is. Never edit or remove an entry: when a fact changes, add a new entry.
The owner's vision lives in `mailbox/briefs/2026-10-03-che-master-handoff.md` on the `che-mailbox` branch (section 1
for identity and voice rules, section 2 for what existed on 2026-10-03). Owner rules are in `AGENTS.md` on `main`.

| Date (UTC) | Entry | Kind | Evidence |
|---|---|---|---|
| 2026-10-03 | Master handoff written: the owner's requirements gathered across sessions, voice-first and accessibility rules, identity rules | requirement | reported (`che-mailbox` `mailbox/briefs/2026-10-03-che-master-handoff.md`) |
| 2026-10-11 | Owner rule: CHE stays silent on launch and passive navigation; reads on request | requirement | reported (`AGENTS.md`) |
| 2026-10-21 | Master mission inventory and owner program recorded | requirement | reported (`docs/CHE_MISSION_LEDGER.md` sections 6–7) |
| 2026-10-26 | Mission ledger and standing work queue established (`docs/CHE_WORK_QUEUE.md`) | decision | reported (repository files) |
| 2026-10-28 | PR #731 (M2a scene document) merged as `74760ee3`; Worker deploy `40616639438` succeeded; live commit check verified `74760ee3` live | milestone | verified this session (`release_status`, deploy run `40616639438`) |
| 2026-10-28 | Reliability: 12 × 17 answered by computation; receipt corrections no longer replace correct answers; save commands not treated as library documents (PR #737) | implementation | verified in tests on the branch (`node --test`); not yet verified on the deployed Worker |
| 2026-10-28 | Failure: CHE replied "I could not generate a response, sir" and later "204 … off by one" to 12 × 17 (owner's device) | failure | reported by the owner; the causes are reproduced in tests, not in production logs |
| 2026-10-28 | Failure: staging live gate red on PRs #733, #736, #737 (Wikipedia 503 in the study probe) | failure | verified in run logs `40616814157`, `40621739146`, `40623541767` |
| 2026-10-28 | Fix in progress: Wikipedia retries honour Retry-After (PR #738, `ad616d21`) | implementation | checks in progress at snapshot time; not yet verified |
| 2026-10-28 | Video-to-implementation workflow built (PR #739, `7b82db5d`); record starts empty | implementation | checks in progress at snapshot time; no video has been received yet |
| 2026-10-28 | Owner reports coding autonomy paused and that a resume request was saved as a library entry | failure | reported by the owner; the saving route is fixed in PR #737 |
| 2026-10-28 | Owner reports repeated paper-trading losses; trading audit requested, not yet done | failure | reported by the owner; no audit completed |
