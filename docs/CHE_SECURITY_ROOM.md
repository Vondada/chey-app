# Security Room: full visibility and Knox, the Office Security Chief

Owner requests, 2026-10-23: "CHE Security Room — Full Visibility and Physical Device Integration" (11 items), then
"replace the generic Security identity with a named Office Security Chief".

## Audit before the change (main `7c991bc`)

### Office roster and agent identities
- Names: `server/cloudflare/agent_runtime.js:116` (`AGENT_NAMES`), canonical roster `server/cloudflare/office_company.js:8` (`LA_AGENCIA_ROLES`), starter roster `server/cloudflare/che_platform.js:34`.
- Personality: `agent_runtime.js:123`, Knox: "Skeptical by default. Hunts for failure modes, security holes and bad assumptions."
- Strengths and avatar: `agent_runtime.js:150`, Knox: strengths include "Failure-mode and security review"; appearance is tall, square face, locs, tech outfit, headset.
- Skills: `server/cloudflare/skill_import.js:10`, Knox: engineering, testing, **security**, game-development.
- Assigned job: `office_company.js:8`, Knox's Office role is "Engineering / Codex jobs".
- Voice: no per-agent voice exists in code. CHE is the only speaker; Office agents report through her.
- Office desk: `lib/agents/che_office_floor_screen.dart` (`CheOfficeFloorScreen(initialAgentName:)` opens one agent's desk; `lib/home_state/hub_rooms.dart` `_openOfficeFloor(agentName:)`).

### Security Core and its 8 specialists
- Chain of command: `server/cloudflare/security_core/agent.js:25` (`hierarchy`): owner → lead → `security` (named by `config.agent_name`) → specialists.
- Specialists: `agent.js:9` (`SPECIALISTS`, 8): threat analyst, malware reviewer, identity guard, access warden, device monitor, repository and dependency reviewer, incident lead, security librarian.
- Product layer: `server/cloudflare/security_core_che.js:17` (`CHE_SECURITY`, `agent_name: 'Security'` before this change), `:137` (`chePrincipals`), `:230` (`coreView`).
- Security Intelligence (checks, sessions, intents): `server/cloudflare/security_intelligence.js:84` (`SESSION_SCOPES`), `:321` (`securityIntent`).
- Physical layer: `server/cloudflare/security_core/physical.js:53` (`physicalView`), `:41` (`physicalResponse`), `:38` (`FORBIDDEN_RESPONSES`). It is architecture only, with no adapters.

### Permission system
- Access principals and least-privilege review: `server/cloudflare/security_core/access.js:10` (`principal`), `:22` (`reviewAccess`).
- Office agent job permissions: `server/cloudflare/agent_permissions.js:30` (`assertAgentMayRun`).
- Face ID scoped sessions: `security_intelligence.js:84`.
- There is one access registry. This change adds no second permission system.

### The 11 Security Room items, against main before this change

| # | Requirement | Before | After |
|---|---|---|---|
| 1 | Every count tappable to its exact entries | PARTIAL: section counts were expandable, but only Access opened a list, and principals only | DONE: 8 categories; count = list length by construction (`security_visibility.js`), tested |
| 2 | Inventory from real registries | PARTIAL: principals covered agents, capability tools, granted apps and devices | DONE: adds Office agents, catalog commands, connectors, Face ID sessions (metadata only) and every granted scope |
| 3 | Searchable categories and filters | MISSING | DONE: search plus category chips (Agents, Tools, Apps, Devices, Sessions, Permissions, Threats, History) |
| 4 | Findings open evidence, severity, resource, time and action | PARTIAL: events showed summary, severity and time | DONE: evidence refs, affected resource, verification, recommended action |
| 5 | Plain-language least privilege | PARTIAL: the issue code only ("broad scope network:*") | DONE: "X can: …; that is wider than any one job needs …" |
| 6 | Coverage gaps and unknowns | PARTIAL: readiness excluded unmeasured parts | DONE: each check is checked, not checked, stale, unknown or not monitored; zero findings is never an all-clear |
| 7 | Physical Security connections page | PARTIAL: a one-line note | DONE: devices, researched platforms with official API sources, all Unsupported |
| 8 | Never "connected" without a handshake | DONE in `physical.js` | Kept; now shown and tested end to end |
| 9 | Notify and record automatically; sensitive actions need the owner | PARTIAL: owner confirmation existed | DONE: Face ID every time (`physicalActionGate`); life-safety refusals kept |
| 10 | Chrome HUD, compact cards, green, amber and red | PARTIAL | DONE: `CheStatusPill`/`CheChromeText`; words always accompany color |
| 11 | Tests and existing rules | — | Worker and widget tests below |

## Knox as the Office Security Chief

**Chosen agent: Knox.** Knox already exists on the canonical roster. Knox's established persona hunts security holes, Knox's
profile lists security review, and Knox's skill tags include security. No agent was created or duplicated. The Security
Core keeps its engines, 8 specialists, history, permissions and incident records. Only the displayed name of its
second-in-command (`config.agent_name`) and of the `security` access principal changed, from "Security" to "Knox".

**Open concern, not changed here:** Knox's Office job is also "Engineering / Codex jobs". The Security Core already
keeps a coding agent outside the security chain (`separate: Atlas`). The checks Knox reports are deterministic Security
Intelligence code, not Knox's model judgment, so Knox's engineering work does not grade itself. The owner may still want a
separation-of-duties decision.

- Chain: Owner → CHE → Knox → 8 specialists. It is shown in the Security Room and spoken for "who's on my security team".
- One record: `security_chief.js` builds name, title, supervisor, persona, appearance, responsibilities, specialists,
  configured permissions (access registry), verified checks (coverage), status and recent verified activity (recorded
  checks and audit only). It is served at `GET /api/security/core` as `chief`.
- Tapping Knox in the Security Room opens Knox's Office desk (`_openOfficeFloor(agentName: 'Knox')`), the same record the
  Office shows.
- Chat: "CHE, have Knox check security" runs the real check (`securityCoreCheck`) and CHE reports which checks ran,
  when, the findings, and what was not checked. Route: `security-chief` in `command_catalog.js`. Negative tests cover
  sentences that only mention Knox.
- Conduct: monitor, warn, record, and use owner-confirmed protective controls only. Knox never harms, threatens, traps,
  confronts or retaliates, and life safety is preserved (`physical.js` `FORBIDDEN_RESPONSES`).

## Voice and typing
- "Open security access" / "Who has access to CHE?" (`/security-access`) open the Agents list and read the counts and coverage.
- "Show security findings" (`/security-findings`) opens Threats and reads the findings and coverage.
- "Have Knox check security" (`/security-chief`) runs the check and reports it.
