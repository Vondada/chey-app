# CHE Security Intelligence

`server/cloudflare/security_intelligence.js` adds defense in depth on top of what CHE already had. It lowers risk;
it does not make CHE unhackable, and CHE never says it does.

## Reused, not duplicated

- **Device pairing.** Hashed device tokens, failure limits (5 per address, a global cap) and per-device revocation
  (`che_platform.js`).
- **Lockdown** (`resilience.js` `setLockdown` / `isLockedDown`). Incident response turns it on.
- **Action gates.** The money/delete gate and the per-app permission gate (`owner_action_gate.js`). Target identity
  checks extend the app gate.
- **`privacy_policy.redactSecrets`.** It now also runs the scanner, so the model audit log gets the stronger patterns.
- **Phone vault.** Face ID through `CheVaultAuth` / `CheAccountBridge.authenticate` (iOS LocalAuthentication), and the
  Keychain password vault. Both are unchanged.
- **Office.** The `review` (QA/Security) role stays. Security work now goes to the new `security` specialist,
  **Security Intelligence**.
- **REA.** Every repository read by `inspectGithubRepo` now carries a static security and licence review
  (`facts.security`).
- **Capability registry** (`capability_registry.js`):
  - `securityCheckForCapability` provides the `security` promotion check.
  - `checkToolAccess` enforces each capability's `permissions`.

## Controls

| Control | Where |
|---|---|
| Secret scanner: key formats, assignments, high-entropy tokens. SHAs, UUIDs and data: URIs are left alone. | `scanSecrets`, `redact`, `redactDeep` |
| One pattern set: workflow import/export and the phone use `BROAD_SECRET_RE` / `cheLooksSecret` | `security_intelligence.js`, `lib/security/che_secret_scan.dart` |
| Final guard before every model provider | `ai_router.routedEnv` and `callSpecificModel` → `guardModelInput` |
| Logs and audit, workflow exports, stored chat history | `privacy_policy.redactSecrets`, `/api/workflows/export`, DO `fetch` memory write |
| Threat detection over CHE's own telemetry, with each event classified benign, suspicious or contained (see list below) | `detectThreats`, `runSecurityCheck` |
| Malware safety loop: hashes, executable magic, install scripts, curl-to-shell, eval/atob, mining, credential exfiltration, licence. Verdicts are allow / quarantine / reject / owner_review. Nothing is executed. | `inspectArtifacts`, `mayExecute` |
| Generated code gate: syntax, tests, security review and owner approval | `reviewGeneratedCode` |
| Dependency advisories from package.json and pubspec.lock. A small built-in list, not a full database, and the report says so. | `dependencyAdvisories` |
| Scoped Face ID sessions (see notes below) | `issueNonce`, `createSession`, `checkSession`, `revokeSessions` |
| Wrong app, domain (look-alikes, punycode, non-HTTPS) or account stops the action | `checkTargetIdentity` |
| Internal tool permissions; a new tool starts with nothing | `checkToolAccess` |
| Incident response: revoke sessions, optionally revoke other devices, lockdown, rotation list, verify, report | `respondToIncident` |
| Backup and rollback: a hashed trusted snapshot of config, workflows and the registry (no secrets). A tampered snapshot is refused. | `snapshotTrustedState`, `restoreTrustedState` |
| Internal-only mode, enforced on every outbound `fetch` (allowed: CHE's own origin, the owner's GitHub and Cloudflare; the model answers through the Workers AI binding) | `installEgressGuard`, `che:egress_policy` |
| Phone-side: a password or key typed or spoken into ordinary chat never leaves the phone | `cheChatLooksSecret` in `send.dart` |

**Threat detection signals:**
- pairing failures
- unknown and revoked tokens
- server error spikes
- new devices
- the live version tag vs `main` (via GitHub compare; a pending deploy is benign)
- unreviewed or wildcard-access capabilities
- redactions
- advisories

**Face ID session details:**
- Only `{ok, method}`, the nonce and the scope are accepted. Biometric-looking fields are refused.
- Each session is bound to its device, expires after 10 minutes and uses a single-use nonce.
- Each session carries two factors: the device token and the OS biometric.
- Restore, unlocking via the API, re-enabling external services and incident device revocation all need one.

## Owner controls

- **Say:**
  - "run a security check"
  - "security status"
  - "revoke my sessions"
  - "review internal tools"
  - "review knowledge access"
  - "disable external dependencies"
  - "we have been hacked" (incident response)
  - "back up your trusted state"
  - "lock down CHE" (the existing lockdown command)
- **API:** `/api/security`, owner only.
- **Page:** More → Security. It shows large text, has a manual Read Aloud, VoiceOver labels and Face ID-gated actions.

## Honest limits

- **Face ID on the Worker.** The Worker trusts the paired device's statement that Face ID succeeded. There is no App
  Attest yet, so device integrity is not proven server-side.
- **Passkeys.** The Worker accepts a passkey result as a factor. The app has no native passkey flow yet, so it needs a
  native build.
- **Internal-only mode.** It is enforced in the capability registry and in `externalCallAllowed`. Routing every
  existing outbound call through it is the Capability Engine's work.
- **Advisories.** The list is small and built in. It is not a live CVE feed.
- **Deploy comparison.** It needs `CHE_GITHUB_TOKEN` and the deploy job's version tag.
