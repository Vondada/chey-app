# Security Core

Security is a major area inside CHE today. It is built so it can become its own security product later. The engine lives in a portable package (`server/cloudflare/security_core/`). CHE is one product layer on top of it. A future standalone product would be another.

Security Intelligence (#464, `security_intelligence.js`) is now CHE's adapter over the core. Its exports and behavior are unchanged, and all 29 of its tests still pass.

## Layers

```
┌───────────────────────────────┐   ┌────────────────────────────────────┐
│ CHE product layer             │   │ Security product layer (future)    │
│ security_core_che.js          │   │ own UI, tenants, billing, branding │
│ security_intelligence.js      │   │ — not built —                      │
│ worker.js /api/security/core  │   │                                    │
│ lib/security/* (SECURITY page)│   │                                    │
└──────────────┬────────────────┘   └──────────────────┬─────────────────┘
               │ config + adapters                      │ config + adapters
┌──────────────▼────────────────────────────────────────▼─────────────────┐
│ Shared Security Core  (security_core/, versioned, package.json)         │
│ engines: threat · malware · identity · access · device · repository ·   │
│ dependency · incident · knowledge · policies · event model ·            │
│ capability security · workflow library                                  │
│ + agent, readiness, simulations, physical architecture, brain categories│
└─────────────────────────────────────────────────────────────────────────┘
```

**Rule:** the core imports only its own files. Test S1 fails if any core file imports CHE, Music, Trading, UI or `worker.js`. Test S2 fails if the core hard-codes a brand ("CHE Security") or a price. The product name and the agent name come from `productConfig()`, and that function drops unknown keys such as `price`.

| Layer | Owns |
|---|---|
| Shared core | Event model and tenant bus, the 13 engines, incident lifecycle and replay, promotion pipeline, readiness, simulations, policies, physical rules |
| CHE layer | Where state is stored (`che:security_core_v1`), which CHE systems appear in the Cyber World, what CHE's lockdown really does, CHE's agents and apps, the owner's chain of command, voice/chat answers, the SECURITY page |
| Security product layer | Not built: multi-customer onboarding, its own UI, accounts, pricing, branding |

## Event model

Every engine reports one shape:

- `event_id`, `timestamp`, `event_type`, `source`, `affected_resource`
- `severity`, `confidence`, `evidence_refs`
- `status`, `actions_taken`, `verification`
- `tenant_id`, `customer_scope`

`openBus(store, tenant)` gives one tenant's partition. There is no call that reads, publishes into or updates another tenant's events (test S6). Text passes through the secret scanner, so a credential is stored as `[redacted:kind]` and never as its value (test S7). Simulation events carry `verification: 'simulation'` and are excluded from real queries.

In CHE there is one tenant, `owner`. Security Intelligence's events are mirrored into the bus once each (`si_<id>`). An open high or critical real event opens an incident.

## Incidents and replay

The lifecycle is DETECTED → TRIAGED → INVESTIGATING → CONTAINING → CONTAINED → RECOVERING → RECOVERED → RESOLVED.

- Incidents move forward only.
- Every step needs a note.
- Replay returns the recorded steps with their time offsets and adds nothing between them.
- A drill's replay is labelled SIMULATION; a real incident's replay is labelled REAL EVENT.

## Knowledge promotion pipeline

The stages are PRIVATE → GENERALIZED → DEIDENTIFIED → REVIEWED → TESTED → PROMOTED, or REJECTED at any gate.

- **Portability tags:** CHE_ONLY, SHARED_SECURITY, PRODUCT_GENERAL, CUSTOMER_PRIVATE, RESTRICTED. Only SHARED_SECURITY and PRODUCT_GENERAL can promote.
- **Stripping:** removes e-mail addresses, IP addresses, host names, UUIDs, long ids, phone numbers, home paths, secrets, and names the host supplies. In CHE that includes paired device names.
- **Review:** rejects an item if anything identifying is still present.
- **Testing:** a detection rule must catch every positive sample and none of the negatives. A lesson without a rule needs a reviewer note.
- **Promotion:** the promoted copy has no tenant id.

## Security second-in-command

The chain of command is Owner → CHE → Security → 8 specialists:

- threat analyst
- malware reviewer
- identity guard
- access warden
- device monitor
- repository and dependency reviewer
- incident lead
- security librarian

Atlas is a peer outside the chain.

The agent's state is MONITORING, INVESTIGATING, CONTAINING, RECOVERING or SECURED. It is derived only from open real incidents and the last check: there is no timer, and drills never count. SECURED means a check ran in the last day and nothing high-severity is open. Even then the agent says that risk is lower, not zero.

## Readiness score

The score covers eight measured components:

| Component | Weight |
|---|---|
| Recent check | 15 |
| Open incidents | 20 |
| High events | 15 |
| Least privilege | 15 |
| Reviewed tools | 10 |
| Dependencies | 10 |
| Backup | 10 |
| Secret exposures | 5 |

An unmeasured component is listed as unknown and left out of the score; it never counts as passing. A missing snapshot scores 0. The response includes every component, its weight and its evidence, plus the formula.

## Access control and lockdown

- **Principals:** agents, tools (from the capability registry), apps (`che:allowed_apps`) and paired devices. Each holds only the scopes it was granted. Wildcards and broad credential, delete or money scopes are flagged.
- **Lockdown preview:** lists what CHE's lockdown really enforces (remote engines paused, key changes refused, AI mail frozen) and what stays (devices, the on-phone vault, all data). Nothing changes when the preview is shown.
- **Activation:** needs the preview's token and `confirm: true` within ten minutes, and each preview is used once. The spoken "lock down" command keeps working as before; it is an explicit owner command.

## Security veto

`capability_registry.promote()` now calls `vetoCapability()` after all seven checks are recorded. These keep a candidate REJECTED:

- a failed security review
- wildcard network, credential, file or device access
- a credential stored in the record
- risky actions, paid external execution or high risk without owner approval

The previous verified version keeps serving. The call signature is unchanged, so the Capability Engine (#465) stays compatible.

## Simulations

There are five drills:

- leaked credential
- pairing flood
- malicious dependency
- unexpected deploy
- unreviewed capability

Each drill runs in a fresh, throwaway store under the `simulation` tenant. It receives no adapters, so it cannot call anything (test S12 checks that no fetch happens and the real store is unchanged). Every artifact is labelled SIMULATION.

## Physical security (architecture only)

Classes: camera, door lock, alarm, motion sensor, contact sensor, smoke detector, smart plug, gate. **No adapter ships.**

- A device is `connected` only after a supported adapter's handshake succeeds. Otherwise it is `unsupported`, `not_connected` or `error`.
- Autonomous responses are limited to notify, record and save a clip reference.
- Locks, alarms, sirens, power and gates need the owner and a verified device.
- Trapping, locking a person in, disabling life safety, confronting, using force, contacting an intruder, retaliating and publishing identity are refused even with the owner's confirmation.

## Brain

The seven security categories are registered in CHE's Knowledge Library through its existing `registerCategories` hook. They are also filed in the Brain Population Ledger (`brain_ledger.js`) under **Security**, using the new subcategories Incidents, Policies, Access, Devices and Simulations plus the existing Threat Detection and Repository Security.

The ledger receives one timestamped record per step:

- every capture
- every promotion
- every rejection
- every resolved real incident

Records carry no secrets: the item is already redacted, and the ledger scrubs again. Private items have scope `private`. The categories are:

- threats
- incidents
- policies
- access
- code
- devices
- simulations



## API and voice

- `GET /api/security/core` returns the whole page state plus `spoken`.
- `POST /api/security/core/` with one of these actions:
  - `check`, `simulate {scenario}`, `replay {incident_id}`
  - `incident/advance {incident_id, stage, note}`
  - `lockdown/preview`, `lockdown/confirm {token, confirm}`
  - `knowledge/capture`, `knowledge/advance {id, step}` with `step` = generalize, strip, review, test or promote
  - `policy/evaluate {verb, target}`
- These are owner-only, like `/api/security`.
- Voice and typing go through the existing security chat route (`securityIntent`), not a second router. Supported requests: "what's my security status", "security readiness", "preview lockdown", "show open incidents", "who is on my security team", "run a security drill for pairing", "open security". They use no model call.

## SECURITY page

Opened from Home (a new Security destination), More → Security, or "open security". The page has:

- **Protection header:** agent state and reason, lockdown, and readiness with "How this is computed".
- **Actions:** Run Security Check and Preview Lockdown (then Confirm or Cancel). The existing actions stay: Revoke Sessions, Back Up, Disable External Dependencies, and the Face ID actions.
- **Cyber World:** a node per real system: the server, the code repository, internal tools, the password vault (shown as unknown to the server), outside services and each paired device. A node pulses only for a real open event. A drill draws a dashed pulse with a SIMULATION tag. Animation stops with Reduce Motion, with no pulses, and offscreen (TickerMode, and the lazy list disposes it). Every node is a VoiceOver element with its status in words.
- **Sections:** Active Defense, Recent Defense, Systems (with the physical note), Threats, Access (opens Access Control), Identity, Code, Dependencies, Secrets, Malware, Backups, Knowledge, Policies, Simulations (run a drill, replay it).
- **Speech:** nothing speaks on open. Read Aloud reads the spoken summary. Actions report through large text, a haptic and an announcement.

## Tests

| File | Count | Covers |
|---|---|---|
| `security_core.test.mjs` | 15 + 6 | Sibling architecture/portability (S1–S15) and physical architecture (P1–P6) |
| `security_core_che.test.mjs` | 24 | CHE integration through the real Worker and chat (C1–C24, including the store size limit and the Brain Ledger) |
| `test/che_security_core_screen_test.dart` | 7 | Page, Cyber World motion rules, lockdown preview/confirm, drills, access control, replay, Home destination |
| `security_intelligence.test.mjs` | 29 | Unchanged and still passing |
| `test/che_security_screen_test.dart` | 5 | Unchanged and still passing |

## Extraction plan (for a standalone product)

1. Move `server/cloudflare/security_core/` to its own repository or package. It already has a `package.json` and only relative imports.
2. Write that product's layer:
   - storage adapter (one store per tenant set)
   - a telemetry adapter per customer integration
   - its own principals and lockdown mechanisms
   - its own UI
3. Add multi-tenant onboarding and authentication. The bus is already tenant-partitioned, and promoted knowledge carries no tenant.
4. Keep CHE on the same core version through the package, so CHE becomes one customer of the product.

## Not built

- The standalone product layer: UI, accounts, onboarding, billing, branding.
- Any physical-security adapter: no camera, lock or sensor integration exists.
- Automatic incident advancement. Incidents open automatically, but later stages are moved by the owner or a drill.
- Live dependency advisories beyond the vendored list (`ADVISORIES`), and live threat feeds.
- Promotion of shared knowledge across separate deployments: there is only one deployment today.
- Verification on the owner's iPhone and in production after deploy.
