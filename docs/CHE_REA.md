# CHE and REA (reverse engineering)

REA is `rea-agents`, an MIT-licensed reverse-engineering tool (https://github.com/morluto/rea). CHE uses one pinned version of its static JavaScript analysis to inspect a public npm package, explain what its files show, and plan an original feature from that evidence.

## What runs where

| Part | Where | Why |
| --- | --- | --- |
| Commands and answers (`rea_runner.js`) | Cloudflare Worker | Deterministic: parsing, permissions, job log, answers |
| Evidence reduction (`rea_evidence.js`) | Worker and runner | One format; the Worker checks every record it reads |
| REA analysis (`tools/rea`, `che-rea-analysis.yml`) | GitHub Actions, Linux, Node 24 | REA runs on Node, which a Worker cannot run. The iPhone cannot run it either |
| Native binaries (Ghidra) | Not set up | Needs an external analysis host with Ghidra and Java. Nothing is run |

## The pin

- `tools/rea/package.json` pins `rea-agents` to exactly `6.5.0`. `tools/rea/package-lock.json` carries its registry sha512.
- The runner installs with `npm ci --ignore-scripts --omit=optional`, so no package install script or native add-on runs.
- The Worker and the runner name the same version (`REA_PIN` in `rea_evidence.js`); `rea_workflow.test.mjs` checks they match.
- Upgrading REA is a deliberate change: bump both, regenerate the lockfile, and rerun the tests and a real analysis.

## Commands

All six are in the Command Center under Websites, Apps & AI. Each one routes to `rea_runner.js` and never to a coding job.

| Command | Mode | What it does |
| --- | --- | --- |
| `/rea-inspect` | Read-only | Runs static analysis on `npm:<name>@<exact version>`. |
| `/rea-explain` | Read-only | Explains the structure from the recorded evidence; reuses it when present. |
| `/rea-debug` | Read-only | Reviews static evidence for a symptom. It cannot see a crash, and says so. |
| `/rea-compare` | Read-only | Returns REA's side. Comparing with CHE's own code is not built yet. |
| `/rea-rebuild` | Plan only | Writes a plan from recorded evidence. Nothing is built. |
| `/rea-status` | Read-only | Capabilities, recent jobs, and the latest finished evidence. |

Plain phrases work too, such as `REA inspect: npm:semver@7.7.2`, or "reverse engineer npm package semver 7.7.2".

## Permission rules (enforced in code)

1. **Inspection is not permission to change anything.** Inspect, explain, debug and compare dispatch one analysis run. The Worker test proves no coding job, commit or pull request starts, even when the request says "fix" or "open a pull request".
2. **Public targets only, at one exact version.** Ranges (`^7`), tags (`latest`), URLs, local paths and devices are refused with the reason. A private target needs its own approval flow, which is not built.
3. **Integrity first.** The registry's sha512 for the exact tarball is checked before anything is extracted. A mismatch stops the run.
4. **Archives are checked.** Symbolic links, hard links, entries that leave the folder, more than 20,000 entries, or more than 200 MB unpacked are refused.
5. **The analysis job has no credentials.** Only the publisher job can write, and it only writes one bounded summary JSON to `che-mailbox`.
6. **Results are data.** Names and strings from the analyzed package are cleaned, length-capped, and labelled untrusted. The Worker checks every result record again before it is stored or shown.
7. **Build is separate.** `/rea-rebuild` names the step (`CHE, build <feature> using REA job <id>`). That is the existing build route, with its own yes. Merging and deploying need another yes.

## Resource limits

- Workflow timeout 15 minutes; REA itself is killed after 600 seconds (`timeout --kill-after=30`).
- REA runs with `--analysis-timeout-ms 300000 --max-heap-mb 1024`.
- The reduced summary is at most 64 KB. REA's raw Evidence for a real package can be about 11 MB, which never reaches CHE.
- Each finished result is reused for the same package, version, checksum and REA version, so repeat questions cost no new run.
- A job with no result after two hours is reported as stalled.

## What was verified

- The real pinned REA ran on `semver@7.7.2` (MIT) from the npm registry and on a small sample app. Its exit was 0, and the summary validated.
- `server/cloudflare` test suite: all tests pass, including `rea_evidence`, `rea_runner`, `rea_workflow` (archive checks run for real) and the chat-level tests in `command_center.test.mjs`.

See `CHE_COMMAND_CENTER.md` for how commands run, and `server/cloudflare/fixtures/rea/` for the real REA outputs the tests use.

## Not built yet

- Native binary analysis (needs a Ghidra host and Java).
- Runtime capture or observation of running software (each target would need approval first).
- Private targets.
- Comparing REA evidence with CHE's own code.
- An iPhone screen for findings and history. The Command Center lists the commands from the catalog; findings appear in chat.

## Cost and owner decisions

- REA is free (MIT). The npm registry is free. GitHub Actions minutes are free on a public repository and use the account's minutes on a private one. Each run uses CHE's GitHub connection.
- Native analysis would need a host with Ghidra (free) and Java. That is an owner decision about where it runs.
