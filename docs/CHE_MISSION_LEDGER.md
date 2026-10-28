# CHE mission ledger (2026-10-26)

| # | Mission | State | Last evidence |
|---|---|---|---|
| 1 | Release gate (PR #672) | Implemented, CI pending | `e4ad3894`; run `40412656254` queued |
| 2 | Trading order-flow test | Implemented, not verified on CI | `integration_test/trading_order_flow_test.dart` |
| 3 | Owner-visible Alpaca ticket | Blocked on owner decision | `kShowAlpacaPaper = false` |
| 4 | MNQ manual orders | Blocked | No futures paper broker connected |
| 5 | Conversation reliability | Not started in this session | — |
| 6 | Coding engine | Blocked | Free model failing; eval not scored |

## 7. Background GPU and 3D worlds (added 2026-10-28)

Goal: CHE builds a 3D world on her own, renders it, and keeps creating in the background without the owner watching.
25 upgrades with next steps: `docs/CHE_GPU_WORLD_UPGRADES.md` (queue item Q-35). Status: not built. Paid GPU needs the
owner's spend decision and a cap above $0.

Other missions: see `mailbox/briefs/LIVE-HANDOFF.md` §2 on `che-mailbox`. Not re-verified here.
