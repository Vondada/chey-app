#!/usr/bin/env node
// Helper for .github/workflows/che-rea-web.yml. It opens one public page once, in a headless
// Chromium with no sign-in and no stored state, and writes one bounded che.rea-web.v1 record
// plus up to two viewport screenshots. It never types, never submits a form, never downloads,
// never follows a link away from the page, and never sends a request to a private or local
// address. The record passes the Worker's own validator (rea_web_evidence.js) before it is
// written, so the runner and CHE agree on one format. Everything else fails closed.
//
//   validate [--out dir]                            check the job inputs from the environment
//   observe --job id --url url --out dir [--reason text]   observe the page, write summary.json

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { cleanText, REA_JOB_ID } from '../../../server/cloudflare/rea_evidence.js';
import { readCapped } from '../../../server/cloudflare/plugin_runtime.js';
import {
  REA_WEB_SCHEMA, REA_WEB_PIN, REA_WEB_ANALYSIS, REA_WEB_SHOT_MAX_BYTES, REA_WEB_LIMITS,
  validateWebSummary, webTargetProblem,
} from '../../../server/cloudflare/rea_web_evidence.js';
import { blockedHost, privateAddress, robotsVerdict } from './policy.mjs';

const NAV_TIMEOUT_MS = 25_000;
const BUDGET_MS = 90_000;
const FILE_BUDGET = 60 * 1024;
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
const ROBOTS_AGENT = 'CHE-REA-web/1.0 (robots.txt check)';
const CONTEXT = {
  acceptDownloads: false, serviceWorkers: 'block', ignoreHTTPSErrors: false, javaScriptEnabled: true,
  locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'reduce',
};
const LAUNCH_ARGS = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
const CHALLENGE = /just a moment|cf-chl|captcha|verify (?:that )?you are (?:a )?human|checking (?:your browser|if the site connection is secure)|attention required|are you a robot|unusual traffic|bot protection|ddos-guard|access denied/i;
const CHALLENGE_TITLE = /^(?:just a moment|attention required|verify you are human|are you a robot|access denied|one more step)/i;
const SIGN_IN_PATH = /(?:^|[/._-])(?:log-?in|sign-?in|sso|auth|authenticate|session)(?:[/._?-]|$)/i;
const NO_BYPASS = 'CHE does not bypass sign-ins or bot protection. Nothing was recorded from the page.';
const ONLY_PUBLIC = 'CHE observes only public web pages: no private networks, local devices or signed-in areas.';
const STANDARD_LIMITATIONS = [
  'Observed once, as an anonymous visitor in a headless browser. Signed-in areas, personalised content and later changes are not covered.',
  'Accessible names and roles are approximate, worked out from the page markup.',
  'Nothing was typed, no form was submitted, no file was downloaded, and only menu buttons in the header or navigation were pressed.',
];

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1] ?? '';
  return out;
}

const short = (error) => cleanText(String(error?.message || error).split('\n')[0], 160);

function redact(value) {
  try {
    const u = new URL(String(value ?? '').trim());
    u.username = '';
    u.password = '';
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch (_) {
    return '';
  }
}

function header(jobId, url) {
  const href = redact(url);
  return {
    schema: REA_WEB_SCHEMA,
    job_id: jobId,
    state: 'failed',
    tool: { name: 'playwright', version: REA_WEB_PIN.version, browser: REA_WEB_PIN.browser, analysis: REA_WEB_ANALYSIS },
    target: { url: href, final_url: '', status: 0, host: href ? new URL(href).hostname : '' },
    observed_at: new Date().toISOString(),
    screenshots: [],
    limitations: [],
  };
}

// The longest lists are halved until the file fits, and the record says so.
function fit(summary) {
  const size = () => Buffer.byteLength(JSON.stringify(summary, null, 1));
  if (size() <= FILE_BUDGET) return summary;
  while (size() > FILE_BUDGET) {
    const key = ['interactive', 'nav_links', 'forms', 'headings', 'interactions']
      .filter((name) => summary[name].length > 1)
      .sort((a, b) => JSON.stringify(summary[b]).length - JSON.stringify(summary[a]).length)[0];
    if (!key) break;
    summary[key] = summary[key].slice(0, Math.floor(summary[key].length / 2));
  }
  summary.limitations = [...summary.limitations.slice(0, REA_WEB_LIMITS.limitations - 1), 'Some lists were shortened to keep the record under 64 KB.'];
  return summary;
}

function writeRecord(out, record, shots = []) {
  let checked = validateWebSummary(record);
  if (checked.ok) checked = validateWebSummary(fit(checked.summary));
  if (!checked.ok) {
    const reason = checked.reason;
    checked = validateWebSummary({ ...header(record.job_id, record.target?.url), error: `The observation record did not pass CHE's checks (${reason}).` });
    if (!checked.ok) fail(`The observation record could not be written (${checked.reason}).`);
    shots = [];
  }
  const summary = checked.summary;
  mkdirSync(out, { recursive: true });
  const listed = new Set(summary.screenshots.map((shot) => shot.file));
  for (const shot of shots) if (listed.has(shot.file)) writeFileSync(join(out, shot.file), shot.buffer);
  const text = JSON.stringify(summary, null, 1);
  writeFileSync(join(out, 'summary.json'), `${text}\n`);
  const line = `REA web ${summary.state}: ${summary.target.final_url || summary.target.url || '(no address)'}${summary.error ? ` (${summary.error})` : ''}`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  process.stderr.write(`${line} [${Buffer.byteLength(text)} bytes, ${summary.screenshots.length} screenshots]\n`);
  return summary;
}

// Robots rules for the '*' group. A robots.txt that cannot be read allows the page, and the
// record says it could not be read.
async function robotsCheck(url) {
  const target = new URL(url);
  let address = `${target.origin}/robots.txt`;
  for (let hop = 0; hop <= 5; hop++) {
    if (webTargetProblem(address) || (await resolvesPrivate(new URL(address).hostname))) {
      return { allowed: true, note: 'robots.txt redirected to an address that is not public, so it was not read.' };
    }
    let response;
    try {
      response = await fetch(address, { redirect: 'manual', headers: { 'user-agent': ROBOTS_AGENT }, signal: AbortSignal.timeout(10_000) });
    } catch (_) {
      return { allowed: true, note: 'robots.txt could not be reached, so it was treated as allowing this page.' };
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      response.body?.cancel().catch(() => {});
      try { address = new URL(response.headers.get('location') || '', address).href; } catch (_) { break; }
      continue;
    }
    if (response.status >= 400 && response.status < 500) {
      response.body?.cancel().catch(() => {});
      return { allowed: true, note: '' };
    }
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      return { allowed: true, note: `robots.txt answered HTTP ${response.status}, so it was treated as allowing this page.` };
    }
    const verdict = robotsVerdict(await readCapped(response, 512 * 1024), `${target.pathname}${target.search}`);
    return { ...verdict, note: '' };
  }
  return { allowed: true, note: 'robots.txt kept redirecting, so it was treated as allowing this page.' };
}

// The redirect chain, followed here before the browser opens anything, so every hop is
// checked (public address, robots.txt) before it is requested. Returns the address to open.
const REDIRECT = [301, 302, 303, 307, 308];
async function resolveNavigation(url) {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    const host = new URL(current).hostname;
    if (webTargetProblem(current) || (await resolvesPrivate(host))) return { refused: 'The page moved to an address that is not a public web page, so CHE stopped.' };
    const robots = await robotsCheck(current);
    if (!robots.allowed) return { refused: `The page moved to an address on ${host} whose robots.txt asks automated visitors not to open it (${robots.rule}). CHE respects it.` };
    let response;
    try {
      response = await fetch(current, { redirect: 'manual', headers: { 'user-agent': ROBOTS_AGENT }, signal: AbortSignal.timeout(15_000) });
    } catch (_) {
      return { url: current }; // The browser reports the failure in its own words.
    }
    response.body?.cancel().catch(() => {});
    if (!REDIRECT.includes(response.status)) return { url: current };
    try { current = new URL(response.headers.get('location') || '', current).href; } catch (_) { return { refused: 'The page redirected to an address that is not valid, so CHE stopped.' }; }
  }
  return { refused: 'The page kept redirecting, so CHE stopped.' };
}

// Refuse hostnames that resolve privately, fail to resolve, or time out. Never
// cache a public verdict for the whole observation: DNS can change during a
// page load. The kernel egress firewall separately enforces the socket target.
const answers = new Map();
function resolvesPrivate(host) {
  if (!host || isIP(host.replace(/^\[|\]$/g, ''))) return Promise.resolve(false);
  const now = Date.now();
  const recent = answers.get(host);
  if (recent && recent.until > now) return recent.pending;
  const pending = new Promise((resolve) => {
    let finished = false;
    const finish = (blocked) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve(blocked);
    };
    const timeout = setTimeout(() => finish(true), 3000);
    timeout.unref();
    lookup(host, { all: true }).then(
      (list) => finish(!list.length || list.some((item) => privateAddress(item.address))),
      () => finish(true),
    );
  });
  answers.set(host, { until: now + 1000, pending });
  return pending;
}

// Runs in every page before the page's own scripts: no form can be submitted, by CHE or by the
// page, and once the observer locks the page it cannot leave. The request guard below still
// stops any navigation that gets past this.
function pageRules() {
  window.addEventListener('submit', (event) => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
  HTMLFormElement.prototype.submit = function submit() {};
  HTMLFormElement.prototype.requestSubmit = function requestSubmit() {};
  window.navigation?.addEventListener('navigate', (event) => {
    if (window[Symbol.for('che-rea-locked')] && event.cancelable && !event.destination.sameDocument) event.preventDefault();
  });
}

// Every request is checked before it leaves the browser. Nothing but GET and HEAD is ever
// sent. Each hop of the main page's navigation, redirects included, is checked against its
// robots.txt before it is requested; once the page has loaded, the main frame may not navigate.
async function guard(context, net) {
  let locked = false;
  const verdicts = new Map();
  const hostOf = (url) => { try { return new URL(url).hostname; } catch (_) { return ''; } };
  await context.addInitScript(pageRules);
  await context.route('**/*', async (route) => {
    try {
      const request = route.request();
      const host = hostOf(request.url());
      if (blockedHost(host) || (await resolvesPrivate(host))) {
        net.blocked += 1;
        return await route.abort('blockedbyclient');
      }
      let mainFrame = false;
      try { mainFrame = request.isNavigationRequest() && !request.frame().parentFrame(); } catch (_) { mainFrame = false; }
      if (!['GET', 'HEAD'].includes(request.method()) || (locked && mainFrame)) {
        net.held += 1;
        return await route.abort('blockedbyclient');
      }
      if (mainFrame) {
        const target = request.url();
        if (!verdicts.has(target)) verdicts.set(target, await robotsCheck(target));
        const verdict = verdicts.get(target);
        if (!verdict.allowed) {
          net.refused = { host, rule: verdict.rule };
          return await route.abort('blockedbyclient');
        }
        // The browser does not route the hops of a redirect it follows itself, so a redirect
        // seen here (one the check above did not get, e.g. for the browser only) stops the run.
        const response = await route.fetch({ maxRedirects: 0, timeout: NAV_TIMEOUT_MS });
        if (REDIRECT.includes(response.status())) {
          net.redirected = true;
          return await route.abort('blockedbyclient');
        }
        return await route.fulfill({ response });
      }
      if (request.resourceType() === 'script') net.scripts.add(host);
      return await route.continue();
    } catch (_) {
      // The page closed while the request was in flight.
    }
  });
  // Even a public WebSocket can carry state-changing client frames.
  // Refuse the connection before the page can forward any messages.
  await context.routeWebSocket(/.*/, (ws) => {
    net.blocked += 1;
    return ws.close();
  });
  context.on('page', (page) => {
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
    if (context.pages()[0] !== page) page.close().catch(() => {});
  });
  return async (page) => {
    locked = true;
    await page.evaluate(() => { window[Symbol.for('che-rea-locked')] = true; }).catch(() => {});
  };
}

// Runs inside the page. Self-contained: Playwright sends its source to the page. It reads the
// DOM only; field values are never read.
function inPage([op, arg]) {
  const clip = (value, max = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  // Prototype calls, because a form field named "querySelectorAll" or "getAttribute" shadows the method.
  const q = (root, selector) => [...(root === document ? Document : Element).prototype.querySelectorAll.call(root, selector)];
  const all = (selector) => q(document, selector);
  const attr = (el, name) => Element.prototype.getAttribute.call(el, name) || '';
  const visible = (el) => {
    if (el.closest('[aria-hidden="true"], [inert]')) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button', color: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
  };
  const INTERACTIVE = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'combobox', 'listbox', 'searchbox', 'textbox', 'slider', 'spinbutton']);
  const FROM_CONTENT = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
    'heading', 'switch', 'checkbox', 'radio', 'treeitem']);
  const typeOf = (el) => String(el.type || el.tagName).toLowerCase();
  const role = (el) => {
    const explicit = attr(el, 'role').trim().split(/\s+/)[0].toLowerCase();
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = typeOf(el);
      if (type === 'hidden') return '';
      if (el.hasAttribute('list') && ['text', 'search', 'email', 'tel', 'url'].includes(type)) return 'combobox';
      return INPUT_ROLES[type] || 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return el.isContentEditable ? 'textbox' : '';
  };
  const byIds = (el, name) => attr(el, name).split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent || '').join(' ');
  // A label's own words only: a control inside it (a select's chosen option, a textarea) is left out.
  const labelText = (label) => {
    const copy = label.cloneNode(true);
    for (const control of q(copy, 'input, select, textarea, button')) control.remove();
    return copy.textContent;
  };
  const ownText = (el) => {
    const text = clip(el.innerText ?? el.textContent);
    if (text) return text;
    const inner = el.querySelector('img[alt], [aria-label], svg title');
    return inner ? clip(inner.getAttribute('alt') || inner.getAttribute('aria-label') || inner.textContent) : '';
  };
  // aria-labelledby, aria-label, <label>, alt, a button's own caption, content for roles named
  // from content, then title, then placeholder when allowed.
  const name = (el, placeholder = true) => {
    const control = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
    const type = el.tagName === 'INPUT' ? typeOf(el) : '';
    const steps = [
      () => byIds(el, 'aria-labelledby'),
      () => attr(el, 'aria-label'),
      () => (control && el.labels ? [...el.labels].map(labelText).join(' ') : ''),
      () => (el.tagName === 'IMG' || type === 'image' ? attr(el, 'alt') : ''),
      () => (['button', 'submit', 'reset'].includes(type) ? attr(el, 'value') || { submit: 'Submit', reset: 'Reset' }[type] || '' : ''),
      () => (!control && FROM_CONTENT.has(role(el)) ? ownText(el) : ''),
      () => attr(el, 'title'),
      () => (placeholder ? attr(el, 'placeholder') : ''),
    ];
    for (const step of steps) {
      const value = clip(step());
      if (value) return value;
    }
    return '';
  };
  const NOT_FIELDS = ['hidden', 'submit', 'button', 'reset', 'image'];
  const NAV = ':is(header, nav, [role=banner], [role=navigation])';

  if (op === 'probe') {
    return {
      title: clip(document.title, 300),
      text: clip(document.body?.innerText, 4000),
      html: document.documentElement.outerHTML.slice(0, 200_000),
      password: !!document.querySelector('input[type=password]'),
    };
  }
  if (op === 'collect') {
    const limits = arg;
    const meta = (key) => clip(document.querySelector(`meta[name="${key}" i]`)?.getAttribute('content'), 500);
    const top = (el) => !el.parentElement?.closest('article, aside, main, nav, section');
    const landmarks = {
      header: all('header, [role=banner]').filter((el) => el.matches('[role=banner]') || (!el.hasAttribute('role') && top(el))).length,
      nav: all('nav, [role=navigation]').length,
      main: all('main, [role=main]').length,
      footer: all('footer, [role=contentinfo]').filter((el) => el.matches('[role=contentinfo]') || (!el.hasAttribute('role') && top(el))).length,
      aside: all('aside, [role=complementary]').length,
      search: all('search, [role=search]').length,
    };
    const headings = [];
    for (const el of all('h1, h2, h3, h4, h5, h6, [role=heading]')) {
      if (headings.length >= limits.headings) break;
      if (!visible(el)) continue;
      const text = clip(el.innerText || el.textContent, 200);
      const level = Number(attr(el, 'aria-level')) || Number(el.tagName.slice(1)) || 2;
      if (text) headings.push({ level: Math.min(6, Math.max(1, level)), text });
    }
    const navLinks = [];
    const seen = new Set();
    const anchors = all('nav a[href], [role=navigation] a[href]');
    for (const a of anchors.length ? anchors : all('header a[href], [role=banner] a[href]')) {
      if (navLinks.length >= limits.nav_links) break;
      const text = clip(name(a), 120);
      const href = typeof a.href === 'string' && /^https?:/i.test(a.href) ? a.href : '';
      const key = `${text}\n${href}`;
      if ((!text && !href) || seen.has(key)) continue;
      seen.add(key);
      navLinks.push({ text, href });
    }
    const interactive = [];
    let links = 0;
    for (const el of all('a[href], button, input, select, textarea, summary, [role], [contenteditable]')) {
      if (interactive.length >= limits.interactive) break;
      const r = role(el);
      if (!INTERACTIVE.has(r) || !visible(el)) continue;
      if (r === 'link' && ++links > 50) continue;
      const item = { role: r, name: clip(name(el), 120) };
      if (el.tagName === 'INPUT') item.type = typeOf(el);
      interactive.push(item);
    }
    const purpose = (form, fields) => {
      const hint = ['role', 'aria-label', 'id', 'name', 'class', 'action'].map((key) => attr(form, key)).join(' ').toLowerCase();
      const types = fields.map((field) => field.type);
      if (types.includes('password')) {
        return types.filter((t) => t === 'password').length > 1 || /sign.?up|register|join|create/.test(hint) ? 'sign-up' : 'sign-in';
      }
      if (/search/.test(hint) || types.includes('search')) return 'search';
      if (/newsletter|subscribe/.test(hint)) return 'newsletter';
      if (/log.?in|sign.?in/.test(hint)) return 'sign-in';
      if (/contact|message|feedback/.test(hint) || types.includes('textarea')) return 'contact';
      return types.length === 1 && types[0] === 'email' ? 'newsletter' : 'other';
    };
    const forms = all('form').slice(0, limits.forms).map((form) => {
      const fields = q(form, 'input, select, textarea')
        .filter((el) => !NOT_FIELDS.includes(typeOf(el)))
        .slice(0, limits.fields)
        .map((el) => ({
          type: typeOf(el),
          label: name(el, false) || clip(attr(el, 'placeholder'), 120),
          required: el.required === true || attr(el, 'aria-required') === 'true',
        }));
      return { purpose_hint: purpose(form, fields), method: (attr(form, 'method') || 'get').toLowerCase(), fields };
    });
    const images = all('img');
    const accessibility = {
      images: images.length,
      images_missing_alt: images.filter((img) => !img.hasAttribute('alt') && !attr(img, 'aria-label') && !attr(img, 'aria-labelledby')
        && !['presentation', 'none'].includes(attr(img, 'role')) && attr(img, 'aria-hidden') !== 'true').length,
      buttons_without_name: all('button, [role=button], input[type=button], input[type=submit], input[type=reset], input[type=image]')
        .filter(visible).filter((el) => !name(el)).length,
      inputs_without_label: all('input, select, textarea').filter((el) => !NOT_FIELDS.includes(typeOf(el)))
        .filter(visible).filter((el) => !name(el, false)).length,
    };
    const hints = [];
    const hint = (test) => {
      try {
        const label = test();
        if (label) hints.push(clip(label, 60));
      } catch (_) {
        // A page getter threw: no hint.
      }
    };
    const w = window;
    const reactKey = (el) => !!el && Object.keys(el).some((key) => key.startsWith('__reactContainer$') || key.startsWith('__reactFiber$') || key === '_reactRootContainer');
    hint(() => (w.__NEXT_DATA__ || document.getElementById('__NEXT_DATA__') || w.__next_f) && 'Next.js');
    hint(() => (w.__NUXT__ || w.__NUXT_DATA__ || document.getElementById('__NUXT_DATA__') || document.getElementById('__nuxt')) && 'Nuxt');
    hint(() => (document.querySelector('[data-reactroot]')
      || [document.getElementById('root'), document.getElementById('__next'), document.getElementById('app'), ...(document.body?.children || [])].some(reactKey)) && 'React');
    hint(() => document.querySelector('[ng-version]') && `Angular ${attr(document.querySelector('[ng-version]'), 'ng-version')}`);
    hint(() => w.angular?.version?.full && `AngularJS ${w.angular.version.full}`);
    hint(() => (w.__VUE__ || document.querySelector('[data-v-app]') || document.getElementById('app')?.__vue_app__) && 'Vue');
    hint(() => (w.__svelte || document.querySelector('[class*="svelte-"]')) && 'Svelte');
    hint(() => Object.keys(w).some((key) => key.startsWith('__sveltekit')) && 'SvelteKit');
    hint(() => document.querySelector('astro-island') && 'Astro');
    hint(() => document.getElementById('___gatsby') && 'Gatsby');
    hint(() => w.__remixContext && 'Remix');
    hint(() => all('script[src], link[href], img[src]').some((el) => /\/wp-(?:content|includes)\//.test(attr(el, 'src') || attr(el, 'href'))) && 'WordPress');
    hint(() => w.Drupal && 'Drupal');
    hint(() => w.Shopify && 'Shopify');
    hint(() => w.jQuery?.fn?.jquery && `jQuery ${w.jQuery.fn.jquery}`);
    const generator = meta('generator');
    if (generator) hints.push(clip(`generator: ${generator}`, 60));
    const timing = performance.getEntriesByType('navigation')[0];
    return {
      page: {
        title: clip(document.title, 300),
        lang: clip(attr(document.documentElement, 'lang'), 35),
        description: meta('description'),
        generator: clip(generator, 120),
        viewport_meta: !!document.querySelector('meta[name="viewport" i]'),
        load_ms: timing && timing.loadEventEnd > 0 ? Math.round(timing.loadEventEnd) : null,
        framework_hints: hints,
      },
      script_hosts: all('script[src]').map((el) => { try { return new URL(el.src, location.href).hostname; } catch (_) { return ''; } }),
      landmarks, headings, nav_links: navLinks, interactive, forms, accessibility,
    };
  }
  if (op === 'focus-start') {
    document.activeElement?.blur?.();
    if (document.body) {
      document.body.setAttribute('tabindex', '-1');
      document.body.focus({ preventScroll: true });
      document.body.removeAttribute('tabindex');
    }
    return true;
  }
  if (op === 'active') {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body || el === document.documentElement) return '';
    return clip(`${role(el) || el.tagName.toLowerCase()} "${name(el)}"`, 120);
  }
  if (op === 'search') {
    const el = all('input[type=search], [role=searchbox], input[name=q], input[name=query], input[name=search], input[name=s], input[placeholder*=search i], input[aria-label*=search i]')
      .find((item) => visible(item) && typeOf(item) !== 'password' && !item.disabled && !item.readOnly);
    if (!el) return null;
    el.setAttribute('data-che-rea', 'search');
    return { tag: 'search', name: clip(name(el), 80) };
  }
  if (op === 'menus') {
    const found = [];
    for (const el of all(`${NAV} :is(button, [role=button], summary, a[href^="#"])[aria-expanded="false"]`)) {
      if (found.length >= 3) break;
      if (!visible(el) || el.closest('a[href]:not([href^="#"])')) continue;
      if (el.form && typeOf(el) === 'submit') continue;
      const tag = `menu-${found.length}`;
      el.setAttribute('data-che-rea', tag);
      found.push({ tag, name: clip(name(el), 80) });
    }
    return found;
  }
  if (op === 'expanded') return attr(document.querySelector(`[data-che-rea="${arg}"]`) || document.body, 'aria-expanded');
  if (op === 'shown') {
    return all('a[href], button, [role=menuitem], [role=link], [role=button], [role=option], [role=tab]')
      .filter(visible).map((el) => clip(name(el), 60)).filter(Boolean).slice(0, 3000);
  }
  if (op === 'popups') return all('[role=listbox], [role=dialog], [role=menu], dialog[open], [aria-modal=true]').filter(visible).length;
  if (op === 'mobile') {
    const root = document.documentElement;
    const toggle = all('button, [role=button], summary, a[href^="#"]').filter(visible).find((el) =>
      (el.closest(NAV) && (el.hasAttribute('aria-expanded') || el.hasAttribute('aria-controls')))
      || /menu|navigation|\bnav\b|hamburger|burger/i.test(`${name(el)} ${attr(el, 'class')} ${attr(el, 'id')}`));
    return { overflow: root.scrollWidth > (root.clientWidth || window.innerWidth) + 1, toggle: !!toggle };
  }
  return null;
}

function wallReason(status, probe, requested, final) {
  const text = `${probe.title}\n${probe.text}\n${probe.html}`;
  if (status === 401 || status === 407) return `The page needs a sign-in (HTTP ${status}).`;
  if (status === 403 || status === 429) {
    return CHALLENGE.test(text) ? `The site showed a bot check (HTTP ${status}).` : `The site refused an automated visitor (HTTP ${status}).`;
  }
  if (status === 503 && CHALLENGE.test(text)) return `The site showed a bot check (HTTP ${status}).`;
  if (CHALLENGE_TITLE.test(probe.title.trim())) return 'The site showed a bot check instead of the page.';
  if (probe.password && SIGN_IN_PATH.test(new URL(final).pathname) && !SIGN_IN_PATH.test(new URL(requested).pathname)) {
    return 'The page sent CHE to a sign-in form.';
  }
  return '';
}

function navigationFailure(error, expired) {
  const text = String(error?.message || error);
  if (/Download is starting/i.test(text)) return { state: 'refused', error: 'That address starts a file download, not a page. CHE does not download files.' };
  if (/ERR_BLOCKED_BY_CLIENT/.test(text)) return { state: 'refused', error: 'That address leads to a private or local network address, which CHE never opens.' };
  if (expired || /Timeout \d+ms exceeded/i.test(text)) return { state: 'failed', error: `The page did not start loading within ${NAV_TIMEOUT_MS / 1000} seconds.` };
  const code = text.match(/net::(ERR_[A-Z_]+)/)?.[1];
  return { state: 'failed', error: code ? `The page could not be opened (${code}).` : 'The page could not be opened.' };
}

function site(host) {
  const parts = host.split('.');
  const size = parts.length > 2 && /^(?:co|com|net|org|gov|edu|ac|ne|or|go)\.[a-z]{2}$/.test(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.slice(-size).join('.');
}

function thirdParty(hosts, own) {
  const mine = site(own);
  return [...new Set(hosts.map((host) => String(host).toLowerCase()).filter((host) => host && site(host) !== mine))]
    .sort().slice(0, REA_WEB_LIMITS.third_party_hosts);
}

// Viewport only, never the full page; the quality steps down until the file fits.
async function shoot(page, label, size, left) {
  for (const quality of [60, 45, 30]) {
    const buffer = await page.screenshot({ type: 'jpeg', quality, fullPage: false, animations: 'disabled', caret: 'hide', timeout: left(10_000) });
    if (buffer.length <= REA_WEB_SHOT_MAX_BYTES) return { label, file: `${label}.jpg`, width: size.width, height: size.height, bytes: buffer.length, buffer };
  }
  return null;
}

// Search first, before Tab has focused anything; then the Tab order from the top of the page;
// then menu buttons. Focus moves and buttons are pressed; nothing is typed.
async function interact(page, out) {
  const search = await page.evaluate(inPage, ['search']);
  if (search) {
    const before = await page.evaluate(inPage, ['popups']);
    await page.locator('[data-che-rea="search"]').focus({ timeout: 3000 });
    await page.waitForTimeout(600);
    const after = await page.evaluate(inPage, ['popups']);
    out.push({
      action: 'focus-search',
      target: search.name || 'search box',
      observed: `Focused the search box; ${after > before ? 'a suggestion list or dialog appeared' : 'nothing else appeared'}. Nothing was typed.`,
    });
    await page.keyboard.press('Escape');
  }
  await page.evaluate(inPage, ['focus-start']);
  for (let i = 1; i <= 10; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(inPage, ['active']);
    out.push({ action: 'tab-order', target: `Tab ${i}`, observed: stop || 'No element on the page had focus.' });
  }
  await page.evaluate(inPage, ['focus-start']);
  for (const menu of await page.evaluate(inPage, ['menus'])) {
    const address = page.url();
    const before = new Set(await page.evaluate(inPage, ['shown']));
    try {
      await page.locator(`[data-che-rea="${menu.tag}"]`).click({ timeout: 3000 });
    } catch (_) {
      out.push({ action: 'open-menu', target: menu.name || 'menu button', observed: 'It could not be pressed (covered by another element or not ready).' });
      continue;
    }
    await page.waitForTimeout(600);
    if (page.url() !== address) {
      out.push({ action: 'open-menu', target: menu.name || 'menu button', observed: 'Pressing it changed the page address, so CHE stopped pressing buttons.' });
      break;
    }
    const expanded = await page.evaluate(inPage, ['expanded', menu.tag]);
    const shown = [...new Set((await page.evaluate(inPage, ['shown'])).filter((item) => !before.has(item)))];
    const seen = shown.length ? `${shown.length} item${shown.length === 1 ? '' : 's'} became visible: ${shown.slice(0, 8).join(', ')}` : 'Nothing new became visible';
    out.push({ action: 'open-menu', target: menu.name || 'menu button', observed: `aria-expanded is now ${expanded || 'unset'}. ${seen}.` });
    await page.keyboard.press('Escape');
  }
}

async function runBrowser(url, base, limitations) {
  const deadline = Date.now() + BUDGET_MS;
  const left = (cap) => Math.max(1, Math.min(cap, deadline - Date.now()));
  const net = { blocked: 0, held: 0, scripts: new Set(), consoleErrors: 0 };
  const shots = [];
  let browser = null;
  let record = null;
  let facts = null;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    browser?.close().catch(() => {});
  }, BUDGET_MS);
  const phase = async (what, minimum, work) => {
    if (expired || deadline - Date.now() < minimum) {
      limitations.push(`Stopped at the ${BUDGET_MS / 1000} second limit; ${what} was not checked.`);
      return;
    }
    try {
      await work();
    } catch (error) {
      limitations.push(expired ? `Stopped at the ${BUDGET_MS / 1000} second limit while checking ${what}.` : `CHE could not check ${what} (${short(error)}).`);
    }
  };
  const finish = () => {
    record.page.console_errors = net.consoleErrors;
    record.page.third_party_hosts = thirdParty([...net.scripts, ...facts.script_hosts], record.target.host);
    record.screenshots = shots.map(({ buffer, ...shot }) => shot);
    if (net.blocked) limitations.push(`${net.blocked} request${net.blocked === 1 ? '' : 's'} to private or local network addresses ${net.blocked === 1 ? 'was' : 'were'} blocked.`);
    if (net.held) limitations.push(`${net.held} later request${net.held === 1 ? '' : 's'} that would have left the page or sent data ${net.held === 1 ? 'was' : 'were'} stopped.`);
    record.limitations = [...STANDARD_LIMITATIONS, ...limitations];
    return { record, shots };
  };
  try {
    const { chromium } = await import('playwright-core');
    // An explicit proxy (tests only; runners have none) also carries the navigation fetches above.
    const proxy = process.env.http_proxy || process.env.HTTP_PROXY || '';
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHE_REA_CHROMIUM || undefined, args: LAUNCH_ARGS, timeout: left(30_000), ...(proxy ? { proxy: { server: proxy } } : {}) });
    const desktop = await browser.newContext({ ...CONTEXT, viewport: DESKTOP });
    const lock = await guard(desktop, net);
    const page = await desktop.newPage();
    // Requests this observer blocked are not the page's own errors.
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('ERR_BLOCKED_BY_CLIENT')) net.consoleErrors += 1;
    });
    page.on('pageerror', () => { net.consoleErrors += 1; });
    page.setDefaultTimeout(5000);

    const start = await resolveNavigation(url);
    if (start.refused) return { record: { ...base, state: 'refused', error: start.refused, limitations } };
    let response;
    try {
      response = await page.goto(start.url, { waitUntil: 'domcontentloaded', timeout: left(NAV_TIMEOUT_MS) });
    } catch (error) {
      if (net.redirected) {
        return { record: { ...base, state: 'refused', error: 'The page redirected inside the browser to an address CHE had not checked against its robots.txt, so CHE stopped before opening it.', limitations } };
      }
      if (net.refused) {
        return { record: { ...base, state: 'refused', error: `The page moved to an address on ${net.refused.host} whose robots.txt asks automated visitors not to open it (${net.refused.rule}). CHE respects it.`, limitations } };
      }
      return { record: { ...base, ...navigationFailure(error, expired), limitations } };
    }
    await page.waitForLoadState('load', { timeout: left(15_000) })
      .catch(() => limitations.push('The page did not finish loading within 15 seconds; it was observed as it was.'));
    await page.waitForLoadState('networkidle', { timeout: left(4000) }).catch(() => {});
    await lock(page);

    const finalUrl = page.url();
    const status = response?.status() ?? 0;
    base.target = { ...base.target, final_url: redact(finalUrl), status, host: new URL(finalUrl).hostname };
    if (webTargetProblem(finalUrl)) {
      return { record: { ...base, state: 'refused', error: 'The page moved to an address that is not a public web page, so CHE stopped.', limitations: [ONLY_PUBLIC] } };
    }
    if (new URL(finalUrl).origin !== new URL(url).origin) {
      const robots = await robotsCheck(finalUrl);
      if (!robots.allowed) {
        return { record: { ...base, state: 'refused', error: `The page moved to ${new URL(finalUrl).hostname}, whose robots.txt asks automated visitors not to open it (${robots.rule}). CHE respects it.`, limitations } };
      }
      if (robots.note) limitations.push(robots.note);
    }
    const probe = await page.evaluate(inPage, ['probe']);
    const wall = wallReason(status, probe, url, finalUrl);
    if (wall) return { record: { ...base, state: 'refused', error: `${wall} CHE does not bypass sign-ins or bot protection.`, limitations: [NO_BYPASS] } };
    if (status >= 400) return { record: { ...base, state: 'failed', error: `The page answered HTTP ${status}.`, limitations } };

    facts = await page.evaluate(inPage, ['collect', REA_WEB_LIMITS]);
    record = {
      ...base,
      state: 'complete',
      page: { ...facts.page, console_errors: 0, third_party_hosts: [] },
      landmarks: facts.landmarks,
      headings: facts.headings,
      nav_links: facts.nav_links,
      interactive: facts.interactive,
      forms: facts.forms,
      interactions: [],
      responsive: { mobile_horizontal_overflow: null, mobile_nav_toggle: null },
      accessibility: facts.accessibility,
    };

    await phase('the desktop screenshot', 5000, async () => {
      const shot = await shoot(page, 'desktop', DESKTOP, left);
      if (shot) shots.push(shot);
      else limitations.push('The desktop screenshot was larger than 400 KB even at low quality, so it was left out.');
    });
    await phase('the keyboard, search and menu checks', 15_000, () => interact(page, record.interactions));
    await phase('the mobile view', 20_000, async () => {
      const mobile = await browser.newContext({ ...CONTEXT, viewport: MOBILE, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      const lockMobile = await guard(mobile, net);
      const small = await mobile.newPage();
      const answer = await small.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: left(NAV_TIMEOUT_MS) });
      await small.waitForLoadState('load', { timeout: left(10_000) }).catch(() => {});
      await lockMobile(small);
      if (webTargetProblem(small.url())) throw new Error('the mobile page moved to an address that is not public');
      if ((answer?.status() ?? 0) >= 400) throw new Error(`the mobile page answered HTTP ${answer.status()}`);
      const view = await small.evaluate(inPage, ['mobile']);
      record.responsive = { mobile_horizontal_overflow: view.overflow, mobile_nav_toggle: view.toggle };
      const shot = await shoot(small, 'mobile', MOBILE, left);
      if (shot) shots.push(shot);
      else limitations.push('The mobile screenshot was larger than 400 KB even at low quality, so it was left out.');
      await mobile.close();
    });
    return finish();
  } catch (error) {
    if (record) {
      limitations.push(expired ? `Stopped at the ${BUDGET_MS / 1000} second limit; the rest was not checked.` : `The observation stopped early (${short(error)}).`);
      return finish();
    }
    const reason = expired ? `The page was not observed within the ${BUDGET_MS / 1000} second limit.` : `The browser could not observe the page (${short(error)}).`;
    return { record: { ...base, state: 'failed', error: reason, limitations } };
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
  }
}

function validate(argv) {
  const f = flags(argv);
  const jobId = process.env.JOB_ID || '';
  const url = process.env.TARGET_URL || '';
  if (!REA_JOB_ID.test(jobId)) fail('Invalid REA job id.');
  const problem = webTargetProblem(url);
  if (problem) {
    if (f.out) writeRecord(f.out, { ...header(jobId, url), state: 'refused', error: problem, limitations: [ONLY_PUBLIC] });
    fail(problem);
  }
  const u = new URL(url.trim());
  // GITHUB_ENV lines, read by the later steps of the same job.
  console.log(`WEB_URL=${u.href}`);
  console.log(`WEB_HOST=${u.hostname}`);
}

async function observe(argv) {
  const f = flags(argv);
  if (!REA_JOB_ID.test(f.job || '')) fail('Invalid REA job id.');
  if (!f.out) fail('Give --out <folder>.');
  const base = header(f.job, f.url);
  if (f.reason) return writeRecord(f.out, { ...base, error: f.reason });
  const problem = webTargetProblem(f.url)
    || ((await resolvesPrivate(new URL(f.url).hostname)) ? 'That site name points to a private network address, which CHE never opens.' : '');
  if (problem) return writeRecord(f.out, { ...base, state: 'refused', error: problem, limitations: [ONLY_PUBLIC] });
  const robots = await robotsCheck(f.url);
  if (!robots.allowed) {
    return writeRecord(f.out, {
      ...base,
      state: 'refused',
      error: `The site's robots.txt asks automated visitors not to open this page (${robots.rule}). CHE respects it.`,
      limitations: ['Nothing was opened in the browser.'],
    });
  }
  const { record, shots = [] } = await runBrowser(f.url, base, robots.note ? [robots.note] : []);
  return writeRecord(f.out, record, shots);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'validate') validate(rest);
else if (command === 'observe') {
  await observe(rest).catch((error) => fail(`The observer stopped: ${short(error)}`));
  process.exit(0);
} else fail(`Unknown command: ${command || '(none)'}`);
