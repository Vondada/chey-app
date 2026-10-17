# CHE and REA (reverse engineering and investigation)

REA is CHE's investigation route. Version 1 runs `rea-agents` (MIT, https://github.com/morluto/rea), pinned, on one public npm package at an exact version. REA 2.0 keeps that route unchanged and adds investigations of other public targets through the same job log: a public GitHub repository, a public web page (plus an isolated browser run), an App Store listing, and an honest answer for apps CHE cannot reach. Findings become a feature map, are compared with CHE's live repository, and an approved plan is built through CHE's existing self-development job as a draft pull request.

## What runs where

| Part | Where | Why |
| --- | --- | --- |
| Commands, stages and answers (`rea_runner.js`) | Cloudflare Worker | Deterministic: parsing, permissions, the job log, answers |
| Target adapters (`rea_targets.js`) | Cloudflare Worker | Plain GETs of public data: the GitHub API and raw files at one commit, one page fetch, the App Store listing API |
| Feature map, CHE comparison, plan, verify (`rea_features.js`) | Cloudflare Worker | Deterministic: no model call |
| Evidence reduction (`rea_evidence.js`) | Worker and runner | One format; the Worker checks every record it reads |
| REA analysis (`tools/rea`, `che-rea-analysis.yml`) | GitHub Actions, Linux, Node 24 | REA runs on Node, which a Worker cannot run. The iPhone cannot run it either |
| Browser observation (`tools/rea/web`, `che-rea-web.yml`) | GitHub Actions, headless Chromium | No credentials in the browser job; see "Website observation" |
| Building (`queueSelfDevelopment`) | CHE's existing coding job | Draft pull request with tests and review; never a merge |
| Native binaries (Ghidra), APKs, IPAs | Not set up | Each needs its own host; nothing is run |

## The stages

Every investigation moves through the same 13 stages, each with its evidence note: understand, discover, inspect, map, architecture, compare, plan, build, test, review, integrate, verify, remember. Inspection fills the first five and remember. Compare runs when asked ("which of those features could improve your app?"). Plan, build, test, review and verify run only after the owner asks to build. Integrate (merge and deploy) always waits for the owner's separate yes.

## How CHE decides

- A GitHub link or `owner/name repo` is read at its current commit. Facts: licence, languages, manifests (dependencies with line numbers), README feature bullets, file-based routes (Next.js, SvelteKit, Remix, Nuxt) and routes declared in code (React Router, GoRouter, Flutter named routes, HTTP routes), entry points, tests and CI. A named feature ("how its search feature works") is searched in the code and cited by file and line.
- A web link is read once, after robots.txt allows it. A sign-in wall or bot check stops the read; CHE does not get around them. The isolated browser run then adds screenshots, menus, focus and phone layout.
- An App Store link (or an app name with no public source) reads the public listing.
- An app name is matched only to a public repository or App Store listing with exactly that name. Similar names are read out as a numbered choice ("number two" picks one) and nothing is read from them until the owner chooses.
- A private app ("the private iOS app X internals", an IPA or APK) gets the plain list of what CHE cannot reach and what she can do instead. Only the public listing is shown.
- Messages about CHE's own code ("your current repository") never become investigations.

## Comparing with CHE

Each feature kind names the CHE files that implement it. A feature counts as "CHE has it" only when one of those files exists in CHE's tree at the current main commit; the answer links that file at that commit. A file whose name matches, or a command named for that kind, is "partly". Before anything is called "missing", CHE's code is searched. An unreadable tree, or a search that failed, is "not checked", never "missing".

## Untrusted target text

README lines and listing text are data. Lines that read like instructions to an AI are dropped and counted as a limitation. Features known only from the target's own wording are never proposed automatically; the owner must name them, and the build request quotes them as target text. The build request always says: original code only, no copied source, branding, text or assets, and no merge or deploy.

## The pin

- `tools/rea/package.json` pins `rea-agents` to exactly `6.5.0`. `tools/rea/package-lock.json` carries its registry sha512.
- The runner installs with `npm ci --ignore-scripts --omit=optional`, so no package install script or native add-on runs.
- The Worker and the runner name the same version (`REA_PIN` in `rea_evidence.js`); `rea_workflow.test.mjs` checks they match.
- Upgrading REA is a deliberate change: bump both, regenerate the lockfile, and rerun the tests and a real analysis.

## Commands

All ten are in the Command Center under Websites, Apps & AI. Each one routes to `rea_runner.js`.

| Command | Aliases | Mode | What it does |
| --- | --- | --- | --- |
| `/rea-inspect` | `/rea-investigate` | Read-only | Investigates an app name, link, GitHub repository or `npm:<name>@<exact version>`. |
| `/rea-discover` | | Read-only | Names the target and the public sources REA can use; reads nothing in depth. |
| `/rea-features` | `/rea-map` | Read-only | The feature map: purpose, use, evidence, unknowns, effort. |
| `/rea-explain` | `/rea-architecture` | Read-only | Architecture, split into observed, inferred and unknown. |
| `/rea-debug` | | Read-only | Static evidence for a symptom; it cannot see a crash, and says so. |
| `/rea-compare` | `/rea-gap` | Read-only | Each feature against CHE's live repository, and the gaps worth adding. |
| `/rea-rebuild` | `/rea-plan` | Plan only | An original-implementation plan with acceptance checks. Nothing is built. |
| `/rea-build` | | Build | Hands the approved plan to CHE's coding job: a draft pull request. Never a merge. |
| `/rea-verify` | | Read-only | The build's pull request, CI checks and changed tests. It passes only after both always-on PR workflows (`flutter-check.yml`, `che-ui-analyze.yml`) have finished green on the head commit. The iPhone is never claimed verified. |
| `/rea-status` | `/rea-capabilities`, `/rea-history` | Read-only | What REA can and cannot analyze, and recent investigations. |

Plain speech works too: "CHE, investigate this app and tell me how its interface and features work", "Which of those features could improve your app?", "Build those approved features into yourself", "Remember that app we looked at? Add the export feature we discussed." npm phrases keep working as before ("reverse engineer npm package semver 7.7.2").

These read-only routes serve the investigations to the app: `GET /api/rea/investigations`, `GET /api/rea/investigations/<id>` and `GET /api/rea/files/<id>/desktop.jpg` (screenshots, only when the investigation lists them). The iPhone Investigations page that reads them is part of the Flutter app update (the REA view), not of this Worker change. Until that update is installed, investigations are used through chat and the deploy check.

## Permission rules (enforced in code)

1. **Inspection is not permission to change anything.** Inspect, explain, debug and compare read public data or dispatch one analysis run; only `/rea-build` (or "build those features into yourself" from the owner's own device) starts a coding job, and that job opens a draft pull request. The Worker test proves no coding job, commit or pull request starts, even when the request says "fix" or "open a pull request".
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

- Native binary analysis (needs a Ghidra host and Java), APK analysis (apktool or jadx), and anything inside an installed iOS app (encrypted per device; no macOS host).
- Runtime capture of installed software.
- Analysis of screenshots or recordings the owner sends. REA says so and suggests a public link instead.
- Google Play listings (CHE asks for the app's website or source instead).

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
2. **robots.txt is respected.** REA obeys the group that names its own product token, `CHE-REA` for the page read and `CHE-REA-web` (or `CHE-REA`) for the browser. It falls back to `User-agent: *` only when no group names it. Rules are matched as RFC 9309 describes, after both the path and the rule are put in one percent-encoded form (`/%70rivate` is `/private`). A disallowed page is refused before the browser starts. A missing robots.txt (a 4xx answer) allows the page, and the record says so. An unreachable one (a network error, a timeout, a 5xx answer, or a redirect off the public web) stops the run before anything is opened, as RFC 9309 requires. That is a temporary failure; asking again retries it.
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
