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

## Website observation

CHE can observe one public web page once, in an isolated headless browser on GitHub Actions. The record holds what an anonymous visitor can see and reach: structure, navigation, controls, forms (field types and labels only), a few safe interactions, a mobile check, accessibility counts, framework hints and two screenshots. Dispatching it from CHE and reading its records in the Worker is a separate change (`rea_runner.js`).

### What runs where

| Part | Where | Why |
| --- | --- | --- |
| Browser run (`tools/rea/web/observe.mjs`, `che-rea-web.yml`) | GitHub Actions, Linux, Node 24, headless Chromium | A Worker cannot run a browser for this, and neither can the iPhone |
| Record check (`rea_web_evidence.js`) | Runner and Worker | One format. `validateWebSummary` rebuilds every record from the known fields before it is written or read |
| Network and robots rules (`tools/rea/web/policy.mjs`) | Runner | Pure, so the tests check them without a browser |

### The pin

- `tools/rea/web/package.json` pins `playwright-core` to exactly `1.56.1`. `tools/rea/web/package-lock.json` carries its registry sha512. The runner installs with `npm ci --ignore-scripts`.
- The workflow installs the headless Chromium build made for that version (`playwright-core install --with-deps --only-shell chromium`). It does not use the runner's Google Chrome, which the image updates on its own schedule.
- `REA_WEB_PIN` in `rea_web_evidence.js` names the same version. `rea_web_workflow.test.mjs` checks that the two match.

### What it never does (enforced in code)

1. **Only public pages.** The address follows the same rule as the Worker's page reader (`readablePublicUrl`): http or https only, with no user name or password, no port, no IP address, and no localhost, `.local`, `.internal`, `.lan`, `.home`, `.arpa` or `workers.dev` name. A refused address becomes a `refused` record that gives the reason.
2. **robots.txt is respected.** The `User-agent: *` group is matched as RFC 9309 describes. A disallowed page is refused before the browser starts. If robots.txt cannot be read, the page is treated as allowed and the record says so.
3. **No private network.** No request goes to a private, loopback, link-local or reserved address, or to a local name. That includes public names that resolve to such an address, and it protects the runner's metadata endpoint (169.254.169.254). WebSockets are checked the same way, and WebRTC may use only proxied UDP.
4. **No sign-ins or bot checks.** The run ends as `refused`, with no screenshot and nothing recorded from the page, when any of these happens:
   - the page answers HTTP 401, 407, 403 or 429
   - it answers 503 with challenge text
   - its title is a challenge ("Just a moment…")
   - it redirects to a sign-in form

   The record says: "CHE does not bypass sign-ins or bot protection."
5. **Nothing is typed, submitted, downloaded or followed.**
   - Form submission is blocked, including the page's own submissions.
   - Downloads are refused.
   - No link is clicked.
   - After the page loads, it cannot navigate away, and only GET and HEAD requests leave it.
   - The only keys pressed are Tab and Escape. The only buttons pressed are up to three collapsed menu buttons in the header or navigation.
6. **Field values are never read.** A form is recorded as its fields' type, label and required flag.
7. **No credentials.** The observe job has `contents: read` and no token. Only the publisher job writes, and it never overwrites an existing result.

### Limits

- Navigation timeout: 25 seconds. Whole observation: 90 seconds. The process is wrapped in `timeout 150`, and the job times out after 10 minutes.
- Screenshots: viewport only, desktop 1280x800 and mobile 390x844, JPEG. Quality starts at 60 and drops to 45, then 30, if needed to stay within 400 KB each.
- Record: at most 64 KB. List caps: 30 headings, 40 navigation links, 80 interactive elements, 10 forms of up to 20 fields, 16 interactions, 12 framework hints, 20 third-party script hosts and 12 limitations. If the record is still too large, the longest lists are halved until it fits, and the record says so.
- Strings are page text: control and direction-override characters are removed and lengths are capped.

### Record format

```text
Workflow .github/workflows/che-rea-web.yml, workflow_dispatch inputs: job_id (rea-[0-9a-f]{8}), url (public http(s) URL).
Publishes to branch che-mailbox:
  mailbox/rea/<job_id>.json          schema 'che.rea-web.v1' (<= 64 KB)
  mailbox/rea/<job_id>/desktop.jpg   (<= 400 KB)  mailbox/rea/<job_id>/mobile.jpg (<= 400 KB)   only when captured
che.rea-web.v1 = {
  schema:'che.rea-web.v1', job_id, state:'complete'|'failed'|'refused', error?:str,
  tool:{ name:'playwright', version, browser:'chromium', analysis:'public page observed in an isolated browser; no sign-in, no form submitted' },
  target:{ url, final_url, status:int, host },
  observed_at: ISO,
  page:{ title, lang, description, generator, viewport_meta:bool, load_ms:int|null, console_errors:int, framework_hints:[str], third_party_hosts:[str] },
  landmarks:{ header,nav,main,footer,aside,search:int }, headings:[{level,text}], nav_links:[{text,href}],
  interactive:[{ role, name, type? }], forms:[{ purpose_hint, method, fields:[{type,label,required}] }],
  interactions:[{ action:'open-menu'|'focus-search'|'tab-order', target, observed }],
  responsive:{ mobile_horizontal_overflow:bool, mobile_nav_toggle:bool },
  accessibility:{ images:int, images_missing_alt:int, buttons_without_name:int, inputs_without_label:int },
  screenshots:[{ label:'desktop'|'mobile', file:'desktop.jpg'|'mobile.jpg', width, height, bytes }],
  limitations:[str],
}
Strings are untrusted page text: control chars stripped, length-capped (cleanText from server/cloudflare/rea_evidence.js), never instructions.
```

- `error` is present only on `failed` and `refused` records. In those records, sections that were not observed are empty lists, and counts and flags are `null`, never 0.
- `interactions` lists one `focus-search` (when a search box is visible), then ten `tab-order` stops, then up to three `open-menu` presses.
- The accessibility counts:
  - images with no `alt` attribute
  - visible buttons with no name
  - visible fields with no label (a placeholder alone does not count)
- Accessible names and roles are worked out from the page markup, so they are approximate. The record says so.

### What was verified

- **Local fixture page.** The observer and the pinned Chromium (build 1194) observed a static page served locally (`server/cloudflare/fixtures/rea/web-fixture/`). The record is `server/cloudflare/fixtures/rea/web-che-fixture.example.summary.json`. The screenshots were about 31 KB (desktop) and 23 KB (mobile). Every one of these was stopped and none reached the network:
  - loopback probes
  - a WebSocket
  - an iframe
  - a scripted form submit
  - a POST after load
  - a scripted navigation away
- **Refusals.** The robots.txt, bot check and sign-in refusals were also run for real against that page.
- **Tests.** `rea_web_evidence.test.mjs` and `rea_web_workflow.test.mjs`. CI's Worker unit job installs the pinned Chromium and runs the browser tests.
- **Not yet verified: a public website.** The sandbox where this was built blocks example.org, MDN and python.org, and its browser does not trust that network's proxy certificate. The first public run happens on GitHub Actions.

### Cost

Playwright (Apache-2.0) and Chromium are free. GitHub Actions minutes are free on a public repository and use the account's minutes on a private one.
