// Guards the website observer: the pinned Playwright, the workflow's permissions and inputs,
// the publisher (run for real against a fake GitHub API), the network and robots rules, and,
// when tools/rea/web is installed with a browser, a full observation of a local fixture page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REA_WEB_PIN, REA_WEB_SHOT_MAX_BYTES, validateWebSummary } from './rea_web_evidence.js';
import { blockedHost, privateAddress, robotsVerdict } from '../../tools/rea/web/policy.mjs';
import { startWebFixture, leaks } from './fixtures/rea/web-fixture/server.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');
const WORKFLOW = read('.github/workflows/che-rea-web.yml');
const PKG = JSON.parse(read('tools/rea/web/package.json'));
const LOCK = JSON.parse(read('tools/rea/web/package-lock.json'));
const OBSERVER_SOURCE = read('tools/rea/web/observe.mjs');
const OBSERVER = new URL('../../tools/rea/web/observe.mjs', import.meta.url).pathname;
const OBSERVE_JOB = WORKFLOW.slice(WORKFLOW.indexOf('\n  observe:\n'), WORKFLOW.indexOf('\n  publish:\n'));
const PUBLISH_JOB = WORKFLOW.slice(WORKFLOW.indexOf('\n  publish:\n'));
const JOB = 'rea-0a1b2c3d';

function observer(args, env = {}) {
  return spawnSync('node', [OBSERVER, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

test('the observer pins one exact Playwright version, and the lockfile carries the registry checksum', () => {
  assert.deepEqual(PKG.dependencies, { 'playwright-core': '1.56.1' }, 'one exact version, no range');
  assert.equal(REA_WEB_PIN.version, PKG.dependencies['playwright-core'], 'the Worker and the runner name the same version');
  const pinned = LOCK.packages['node_modules/playwright-core'];
  assert.equal(pinned.version, '1.56.1');
  assert.equal(pinned.integrity, 'sha512-hutraynyn31F+Bifme+Ps9Vq59hKuUCz7H1kDOcBs+2oGguKkWTU50bBWrtz34OUWmIwpBTWDxaRPXrIXkgvmQ==');
  assert.match(pinned.resolved, /^https:\/\/registry\.npmjs\.org\/playwright-core\/-\/playwright-core-1\.56\.1\.tgz$/);
  assert.deepEqual(Object.keys(LOCK.packages), ['', 'node_modules/playwright-core'], 'no other package is installed');
  assert.match(WORKFLOW, /version: '1\.56\.1'/, 'the publisher\'s fallback record names the same version');
});

test('browser observations enforce connection-layer private-IP denial and refuse WebSockets', () => {
  assert.match(OBSERVE_JOB, /id: egress/);
  assert.match(OBSERVE_JOB, /sudo iptables -I OUTPUT 1 -d "\$cidr" -j REJECT/);
  assert.match(OBSERVE_JOB, /sudo ip6tables -I OUTPUT 1 -d "\$cidr" -j REJECT/);
  assert.match(OBSERVE_JOB, /sudo ip6tables -I OUTPUT 1 -j REJECT/, 'IPv6 tunnel addresses cannot bypass destination restrictions');
  assert.match(OBSERVE_JOB, /169\.254\.0\.0\/16/);
  assert.match(OBSERVE_JOB, /127\.0\.0\.0\/8/);
  assert.match(OBSERVE_JOB, /fc00::\/7/);
  assert.match(OBSERVE_JOB, /EGRESS_OUTCOME/);
  assert.match(OBSERVE_JOB, /egress firewall could not be enforced/);
  assert.match(OBSERVE_JOB, /--url "\$TARGET_URL"/, 'the validated URL is passed to the observer');
  assert.doesNotMatch(OBSERVE_JOB, /--url "\$WEB_URL"/, 'an undefined variable must never be used');
  assert.match(OBSERVER_SOURCE, /context\.routeWebSocket\(\/\.\*\/, \(ws\) =>/);
  assert.doesNotMatch(OBSERVER_SOURCE, /ws\.connectToServer\(/, 'no client WebSocket frames are forwarded');
  assert.match(OBSERVER_SOURCE, /CHE_REA_FIXTURE_PROXY === '1'/, 'synthetic proxy hosts require explicit test mode');
  assert.match(OBSERVER_SOURCE, /host === 'che-fixture\.example' \|\| host === 'cdn\.fixture-cdn\.example'/,
    'the test bypass cannot accept other hostnames');
  assert.match(OBSERVER_SOURCE, /until: now \+ 1000/, 'public DNS decisions expire quickly');
  assert.match(OBSERVER_SOURCE, /setTimeout\(\(\) => finish\(true\), 3000\)/, 'unanswered DNS fails closed');
  assert.match(OBSERVER_SOURCE, /\(\) => finish\(true\)/, 'DNS failures are blocked, not accepted');
});

test('the workflow runs only on dispatch, and the observe job can read but not write', () => {
  assert.match(WORKFLOW, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(WORKFLOW, /^ {2}(push|pull_request|schedule):/m, 'no automatic runs');
  assert.match(WORKFLOW, /^permissions:\n {2}contents: read/m);
  assert.match(OBSERVE_JOB, /permissions:\n {6}contents: read/);
  assert.doesNotMatch(OBSERVE_JOB, /contents: write|github\.token|GITHUB_TOKEN|secrets\./, 'the browser job holds no credentials');
  assert.match(OBSERVE_JOB, /persist-credentials: false/, 'no token is left in the checkout');
  assert.match(PUBLISH_JOB, /permissions:\n {6}contents: write/);
  assert.doesNotMatch(PUBLISH_JOB, /npm (ci|install)|observe\.mjs|playwright-core|actions\/checkout/, 'the writer runs no observer or browser code');
  assert.doesNotMatch(WORKFLOW, /secrets\./);
  assert.match(WORKFLOW, /group: che-rea-web-\$\{\{ inputs\.job_id \}\}\n {2}cancel-in-progress: false/);
});

test('the job-level env uses no runner context, and the work folder is set inside the first step', () => {
  const env = OBSERVE_JOB.slice(0, OBSERVE_JOB.indexOf('    steps:'));
  assert.doesNotMatch(env, /runner\./, 'runner.* is valid only inside steps');
  assert.match(WORKFLOW, /echo "WORK=\$WORK" >> "\$GITHUB_ENV"/);
  assert.match(WORKFLOW, /node tools\/rea\/web\/observe\.mjs validate --out "\$WORK\/out" >> "\$GITHUB_ENV"/);
});

test('the install runs no scripts, the browser is the pinned build, and the run has fixed limits', () => {
  assert.match(OBSERVE_JOB, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(OBSERVE_JOB, /node node_modules\/playwright-core\/cli\.js install --with-deps --only-shell chromium/);
  assert.match(OBSERVE_JOB, /timeout-minutes: 10/);
  assert.match(OBSERVE_JOB, /node-version: 24/);
  assert.match(OBSERVE_JOB, /timeout --kill-after=15 150 node tools\/rea\/web\/observe\.mjs observe --job "\$JOB_ID" --url "\$TARGET_URL"/);
  assert.match(OBSERVE_JOB, /if: always\(\) && steps\.validate\.outcome == 'success'/, 'a failed install still produces a failed record');
  assert.match(OBSERVER_SOURCE, /const NAV_TIMEOUT_MS = 25_000;/);
  assert.match(OBSERVER_SOURCE, /const BUDGET_MS = 90_000;/);
  assert.match(OBSERVER_SOURCE, /acceptDownloads: false, serviceWorkers: 'block', ignoreHTTPSErrors: false/);
  assert.match(OBSERVER_SOURCE, /fullPage: false/);
});

test('the observer never types, fills, picks files or submits; it presses only Tab and Escape', () => {
  assert.doesNotMatch(OBSERVER_SOURCE, /keyboard\.(type|insertText)\(|\.fill\(|\.pressSequentially\(|\.selectOption\(|\.setInputFiles\(|\.dispatchEvent\(/);
  assert.doesNotMatch(OBSERVER_SOURCE, /\.value\b/, 'field values are never read');
  const keys = [...OBSERVER_SOURCE.matchAll(/keyboard\.press\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(keys.length > 0);
  assert.deepEqual([...new Set(keys)].sort(), ['Escape', 'Tab']);
  assert.match(OBSERVER_SOURCE, /HTMLFormElement\.prototype\.submit = function submit\(\) \{\};/);
  assert.equal(spawnSync('node', ['--check', OBSERVER]).status, 0);
  assert.equal(spawnSync('node', ['--check', new URL('../../tools/rea/web/policy.mjs', import.meta.url).pathname]).status, 0);
});

test('job inputs reach the shell only through environment variables, never by template in a command', () => {
  for (const line of WORKFLOW.split('\n').filter((l) => l.includes('${{ inputs.'))) {
    const allowed = /^ {6,10}[A-Z_]+: \$\{\{ inputs\.[a-z_]+ \}\}$/.test(line)
      || /^ {2}group: che-rea-web-\$\{\{ inputs\.job_id \}\}$/.test(line)
      || /^ {10}name: rea-web-\$\{\{ inputs\.job_id \}\}$/.test(line);
    assert.ok(allowed, `unexpected input use: ${line.trim()}`);
  }
});

// The publisher's own script, run against a fake GitHub API.
function publisherScript() {
  const lines = PUBLISH_JOB.slice(PUBLISH_JOB.indexOf('script: |') + 'script: |'.length).split('\n').slice(1);
  return lines.filter((line) => line.startsWith('            ') || line === '').map((line) => line.slice(12)).join('\n');
}

async function publish({ files = {}, existing = new Set(), env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rea-web-publish-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const writes = [];
  const github = {
    rest: {
      repos: {
        getContent: async ({ path, ref }) => {
          assert.equal(ref, 'che-mailbox');
          if (existing.has(path)) return { data: {} };
          throw Object.assign(new Error('Not Found'), { status: 404 });
        },
        createOrUpdateFileContents: async ({ path, branch, content, sha }) => {
          assert.equal(branch, 'che-mailbox');
          assert.equal(sha, undefined, 'never an update of an existing file');
          if (existing.has(path)) throw Object.assign(new Error('exists'), { status: 422 });
          writes.push({ path, content: Buffer.from(content, 'base64') });
        },
      },
    },
  };
  const saved = { ...process.env };
  Object.assign(process.env, { JOB_ID: JOB, TARGET_URL: 'https://owner:pw@example.org/page', RECORD_DIR: dir, OBSERVE_RESULT: 'failure', ...env });
  try {
    const run = new Function('github', 'context', 'core', 'require', `return (async () => {\n${publisherScript()}\n})();`);
    await run(github, { repo: { owner: 'o', repo: 'r' } }, { info: () => {} }, createRequire(import.meta.url));
  } finally {
    for (const key of ['JOB_ID', 'TARGET_URL', 'RECORD_DIR', 'OBSERVE_RESULT']) {
      if (key in saved) process.env[key] = saved[key];
      else delete process.env[key];
    }
  }
  return writes;
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1000, 1)]);
const REAL = JSON.parse(readFileSync(new URL('./fixtures/rea/web-che-fixture.example.summary.json', import.meta.url), 'utf8'));

test('the publisher writes the screenshots first, then the record, and only on che-mailbox', async () => {
  const record = { ...REAL, job_id: JOB };
  const writes = await publish({ files: { 'summary.json': JSON.stringify(record), 'desktop.jpg': JPEG, 'mobile.jpg': JPEG } });
  assert.deepEqual(writes.map((w) => w.path), [`mailbox/rea/${JOB}/desktop.jpg`, `mailbox/rea/${JOB}/mobile.jpg`, `mailbox/rea/${JOB}.json`]);
  const written = JSON.parse(writes[2].content.toString('utf8'));
  assert.deepEqual(written.screenshots.map((s) => s.bytes), [JPEG.length, JPEG.length], 'sizes are the files actually written');
  assert.equal(validateWebSummary(written).ok, true);
});

test('the publisher never overwrites: an existing record stops everything', async () => {
  const writes = await publish({
    files: { 'summary.json': JSON.stringify({ ...REAL, job_id: JOB }), 'desktop.jpg': JPEG },
    existing: new Set([`mailbox/rea/${JOB}.json`]),
  });
  assert.deepEqual(writes, []);
  assert.match(WORKFLOW, /error\.status === 409 \|\| error\.status === 422/);
});

test('the publisher drops screenshots that are not JPEG, too large, renamed or already present', async () => {
  const record = { ...REAL, job_id: JOB, screenshots: [...REAL.screenshots, { label: 'desktop', file: '../../x.jpg' }] };
  const writes = await publish({
    files: { 'summary.json': JSON.stringify(record), 'desktop.jpg': Buffer.from('<svg/>'), 'mobile.jpg': Buffer.concat([JPEG, Buffer.alloc(REA_WEB_SHOT_MAX_BYTES)]) },
  });
  assert.deepEqual(writes.map((w) => w.path), [`mailbox/rea/${JOB}.json`]);
  assert.deepEqual(JSON.parse(writes[0].content).screenshots, []);
  const again = await publish({
    files: { 'summary.json': JSON.stringify({ ...REAL, job_id: JOB }), 'desktop.jpg': JPEG, 'mobile.jpg': JPEG },
    existing: new Set([`mailbox/rea/${JOB}/desktop.jpg`]),
  });
  assert.deepEqual(JSON.parse(again.at(-1).content).screenshots.map((s) => s.file), ['mobile.jpg'], 'a file it did not write is not listed');
});

test('when the observe job produced nothing, the publisher writes a failed record without the URL\'s password', async () => {
  const writes = await publish();
  assert.deepEqual(writes.map((w) => w.path), [`mailbox/rea/${JOB}.json`]);
  const record = JSON.parse(writes[0].content);
  assert.equal(record.state, 'failed');
  assert.match(record.error, /produced no record \(job result: failure\)/);
  assert.equal(record.target.url, 'https://example.org/page');
  const checked = validateWebSummary(record);
  assert.equal(checked.ok, true, checked.reason);
  await assert.rejects(publish({ env: { JOB_ID: '../escape' } }), /Invalid REA job id/);
});

test('validate accepts one public page and refuses everything else, writing a refused record', () => {
  const good = observer(['validate'], { JOB_ID: JOB, TARGET_URL: 'https://example.org/docs?q=1' });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout, 'WEB_URL=https://example.org/docs?q=1\nWEB_HOST=example.org\n', 'only GITHUB_ENV lines on stdout');
  const refusals = [
    'ftp://example.org/', 'https://user:pw@example.org/', 'https://example.org:8080/', 'http://127.0.0.1/', 'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'http://printer.local/', 'http://db.internal/', 'http://nas.lan/',
    'http://box.home/', 'http://x.in-addr.arpa/', 'https://che.example.workers.dev/', 'http://intranet/', 'file:///etc/passwd', '',
  ];
  for (const url of refusals) {
    const out = mkdtempSync(join(tmpdir(), 'rea-web-validate-'));
    const refused = observer(['validate', '--out', out], { JOB_ID: JOB, TARGET_URL: url });
    assert.equal(refused.status, 1, url);
    assert.equal(refused.stdout, '', 'nothing reaches GITHUB_ENV');
    const record = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    assert.equal(record.state, 'refused', url);
    assert.ok(record.error, url);
    assert.doesNotMatch(JSON.stringify(record), /pw@/, 'credentials are never recorded');
    assert.equal(validateWebSummary(record).ok, true, url);
  }
  const out = mkdtempSync(join(tmpdir(), 'rea-web-badjob-'));
  const badJob = observer(['validate', '--out', out], { JOB_ID: '../escape', TARGET_URL: 'https://example.org/' });
  assert.equal(badJob.status, 1);
  assert.equal(existsSync(join(out, 'summary.json')), false, 'no record for a job id that is not CHE\'s');
});

test('observe with an install failure writes a failed record and opens no browser', () => {
  const out = mkdtempSync(join(tmpdir(), 'rea-web-reason-'));
  const run = observer(['observe', '--job', JOB, '--url', 'https://example.org/', '--reason', 'The pinned Chromium could not be installed. No page was opened.', '--out', out]);
  assert.equal(run.status, 0, run.stderr);
  const record = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.equal(record.state, 'failed');
  assert.equal(record.error, 'The pinned Chromium could not be installed. No page was opened.');
  assert.deepEqual(record.screenshots, []);
  assert.equal(validateWebSummary(record).ok, true);
});

test('private, loopback, link-local and reserved addresses and local names are blocked', () => {
  for (const host of ['169.254.169.254', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '[::1]', '::', 'fe80::1', 'fd00::1', '::ffff:7f00:1', '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe', 'localhost', 'app.localhost', 'printer.local', 'db.internal', 'nas.lan', 'box.home', 'intranet', '']) {
    assert.equal(blockedHost(host), true, host);
  }
  for (const host of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111', 'example.org', 'cdn.jsdelivr.net']) {
    assert.equal(blockedHost(host), false, host);
  }
  assert.equal(privateAddress('169.254.169.254'), true, 'the cloud metadata endpoint');
  assert.equal(privateAddress('93.184.215.14'), false);
});

test('robots.txt matching follows RFC 9309: the * group, longest rule, Allow on a tie, * and $', () => {
  const robots = [
    'User-agent: Googlebot', 'Disallow: /', '',
    'User-agent: *', 'Disallow: /private/', 'Allow: /private/open', 'Disallow: /*.pdf$', 'Disallow: /tmp', 'Allow: /tmp', 'Disallow:',
  ].join('\n');
  assert.deepEqual(robotsVerdict(robots, '/'), { allowed: true, rule: '' });
  assert.deepEqual(robotsVerdict(robots, '/private/x'), { allowed: false, rule: 'Disallow: /private/' });
  assert.deepEqual(robotsVerdict(robots, '/private/open/page'), { allowed: true, rule: 'Allow: /private/open' });
  assert.deepEqual(robotsVerdict(robots, '/files/a.pdf'), { allowed: false, rule: 'Disallow: /*.pdf$' });
  assert.equal(robotsVerdict(robots, '/files/a.pdf?x=1').allowed, true, '$ anchors the end');
  assert.equal(robotsVerdict(robots, '/tmp/x').allowed, true, 'Allow wins a tie');
  assert.equal(robotsVerdict('User-agent: *\nDisallow: /', '/robots.txt').allowed, true);
  assert.equal(robotsVerdict('User-agent: *\nDisallow: /', '/anything').allowed, false);
  assert.equal(robotsVerdict('User-agent: other\nDisallow: /', '/anything').allowed, true, 'only the * group applies');
  assert.equal(robotsVerdict('', '/').allowed, true);
  const slow = `User-agent: *\nDisallow: /${'*a'.repeat(200)}b$`;
  const started = Date.now();
  assert.equal(robotsVerdict(slow, `/${'a'.repeat(5000)}`).allowed, true);
  assert.ok(Date.now() - started < 200, 'matching stays linear');
});

// Full observation, where tools/rea/web is installed and a Chromium can start (locally: npm ci
// in tools/rea/web; CHE_REA_CHROMIUM may name a browser). The plain unit run skips it; the CI
// step that installs the browser sets CHE_REA_WEB_E2E=required, so there it cannot skip.
const PLAYWRIGHT = new URL('../../tools/rea/web/node_modules/playwright-core/index.mjs', import.meta.url);
let browserReady = false;
if (existsSync(PLAYWRIGHT)) {
  try {
    const { chromium } = await import(PLAYWRIGHT.href);
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHE_REA_CHROMIUM || undefined });
    await browser.close();
    browserReady = true;
  } catch (_) {
    browserReady = false;
  }
}
const E2E = browserReady || process.env.CHE_REA_WEB_E2E === 'required' ? false : 'tools/rea/web is not installed with a browser here';

async function observeFixture(path) {
  assert.ok(browserReady, 'CHE_REA_WEB_E2E=required, but the pinned Chromium could not start');
  const fixture = await startWebFixture();
  const out = mkdtempSync(join(tmpdir(), 'rea-web-e2e-'));
  const env = { ...process.env, http_proxy: fixture.proxy, HTTP_PROXY: fixture.proxy, NODE_USE_ENV_PROXY: '1', CHE_REA_FIXTURE_PROXY: '1' };
  const code = await new Promise((resolve) => {
    const child = spawn('node', [OBSERVER, 'observe', '--job', JOB, '--url', `http://che-fixture.example${path}`, '--out', out], { env, stdio: 'ignore' });
    child.on('exit', resolve);
  });
  await fixture.close();
  return { code, out, log: fixture.log, record: JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) };
}

test('a real browser observes the fixture page and nothing leaves it that should not', { skip: E2E, timeout: 120_000 }, async () => {
  const { code, out, log, record } = await observeFixture('/');
  assert.equal(code, 0);
  assert.equal(validateWebSummary(record).ok, true);
  assert.equal(record.state, 'complete');
  assert.deepEqual(leaks(log), [], 'no loopback probe, WebSocket or iframe reached the network');
  assert.equal(log.some((e) => e.method === 'POST'), false, 'no form was submitted and nothing was posted after load');
  assert.equal(log.some((e) => e.path === '/elsewhere'), false, 'the page could not navigate away');
  assert.doesNotMatch(JSON.stringify(record), /owner@example\.com|fixture-secret-token|Norway|Iceland/);
  assert.deepEqual(record.headings.map((h) => h.text), ['Observer fixture', 'Sign in', 'Newsletter', 'Pictures']);
  assert.deepEqual(record.landmarks, { header: 1, nav: 1, main: 1, footer: 1, aside: 0, search: 1 });
  assert.deepEqual(record.accessibility, { images: 2, images_missing_alt: 1, buttons_without_name: 1, inputs_without_label: 1 });
  assert.deepEqual(record.responsive, { mobile_horizontal_overflow: true, mobile_nav_toggle: true });
  assert.deepEqual(record.page.third_party_hosts, ['cdn.fixture-cdn.example']);
  assert.equal(record.page.console_errors, 1, 'blocked requests are not counted as the page\'s errors');
  const menu = record.interactions.find((i) => i.action === 'open-menu');
  assert.match(menu.observed, /aria-expanded is now true\. 2 items became visible: Getting started, API reference/);
  assert.match(record.interactions.find((i) => i.action === 'focus-search').observed, /suggestion list or dialog appeared/);
  assert.equal(record.interactions.filter((i) => i.action === 'tab-order').length, 10);
  for (const shot of record.screenshots) {
    const bytes = readFileSync(join(out, shot.file));
    assert.equal(bytes.length, shot.bytes);
    assert.ok(bytes.length <= REA_WEB_SHOT_MAX_BYTES && bytes[0] === 0xff && bytes[1] === 0xd8);
  }
  assert.deepEqual(record.screenshots.map((s) => [s.file, s.width, s.height]), [['desktop.jpg', 1280, 800], ['mobile.jpg', 390, 844]]);
  assert.ok(statSync(join(out, 'summary.json')).size <= 64 * 1024);
});

test('robots.txt, bot checks and sign-in walls stop the observation with a refusal', { skip: E2E, timeout: 120_000 }, async () => {
  const robots = await observeFixture('/private/page');
  assert.equal(robots.record.state, 'refused');
  assert.match(robots.record.error, /robots\.txt .*Disallow: \/private\//);
  assert.equal(robots.log.some((e) => e.path === '/private/page'), false, 'the page itself was never requested');
  const challenge = await observeFixture('/challenge');
  assert.equal(challenge.record.state, 'refused');
  assert.match(challenge.record.error, /bot check \(HTTP 403\)\. CHE does not bypass sign-ins or bot protection\./);
  assert.deepEqual(challenge.record.screenshots, []);
  assert.equal(challenge.record.page.title, '', 'nothing from the challenge page is recorded');
  const members = await observeFixture('/members');
  assert.equal(members.record.state, 'refused');
  assert.match(members.record.error, /needs a sign-in \(HTTP 401\)/);
  for (const run of [robots, challenge, members]) assert.equal(validateWebSummary(run.record).ok, true);
});

test('Codex #324: a redirect into a path robots.txt disallows is refused before that page is requested', { skip: E2E, timeout: 120_000 }, async () => {
  const moved = await observeFixture('/moved');
  assert.equal(moved.record.state, 'refused');
  assert.match(moved.record.error, /robots\.txt .*Disallow: \/private\//);
  assert.equal(moved.log.some((e) => e.path === '/private/page'), false, 'the disallowed destination was never requested');
  assert.equal(validateWebSummary(moved.record).ok, true);
});

test('Codex #324: nothing but GET and HEAD leaves the browser, even before the page has loaded', { skip: E2E, timeout: 120_000 }, async () => {
  const early = await observeFixture('/early-post');
  assert.equal(early.record.state, 'complete');
  assert.deepEqual(early.log.filter((e) => !['GET', 'HEAD', 'CONNECT'].includes(e.method)), [], 'no POST or beacon reached the network');
});
