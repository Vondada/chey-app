// Website observation records (che.rea-web.v1). A GitHub runner opens one public page once
// in an isolated browser (.github/workflows/che-rea-web.yml, tools/rea/web/observe.mjs) and
// publishes one record to che-mailbox. Everything in it came from the page, so it is
// untrusted data, never instructions: validateWebSummary rebuilds the record from the known
// fields only, cleans and caps every string, and refuses a record with a bad job id, schema,
// screenshot name or size. The runner and the Worker both use it. Pure: no network, no storage.

import { cleanText, REA_JOB_ID } from './rea_evidence.js';
import { readablePublicUrl } from './library.js';

export const REA_WEB_SCHEMA = 'che.rea-web.v1';
export const REA_WEB_PIN = Object.freeze({ package: 'playwright-core', version: '1.56.1', browser: 'chromium' });
export const REA_WEB_ANALYSIS = 'public page observed in an isolated browser; no sign-in, no form submitted';
export const REA_WEB_MAX_BYTES = 64 * 1024;
export const REA_WEB_SHOT_MAX_BYTES = 400 * 1024;
export const REA_WEB_LIMITS = Object.freeze({
  headings: 30, nav_links: 40, interactive: 80, forms: 10, fields: 20, interactions: 16,
  framework_hints: 12, third_party_hosts: 20, limitations: 12,
});

const STATES = new Set(['complete', 'failed', 'refused']);
const ACTIONS = new Set(['open-menu', 'focus-search', 'tab-order']);
const METHODS = new Set(['get', 'post', 'dialog']);
const SHOT_FILES = Object.freeze({ desktop: 'desktop.jpg', mobile: 'mobile.jpg' });
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const TOKEN = /^[a-z][a-z0-9-]{0,29}$/;
const LANG = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;
// Direction overrides can make page text read differently from what it says.
const BIDI = /[‪-‮⁦-⁩﻿]/g;

export function cleanWebText(value, max = 300) {
  return cleanText(String(value ?? '').replace(BIDI, ''), max).replace(/[\ud800-\udbff]$/, '');
}

const byteLength = (text) => new TextEncoder().encode(text).length;
const count = (value, max = 1_000_000) => (Number.isInteger(value) && value >= 0 && value <= max ? value : null);
const flag = (value) => (typeof value === 'boolean' ? value : null);
const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);
const unique = (items) => [...new Set(items.filter(Boolean))];

// The same rule as the Worker's page reader (readablePublicUrl), with the reason spelled out.
export function webTargetProblem(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 2048) return 'Give one public web address, for example https://example.org/.';
  let u;
  try { u = new URL(raw); } catch (_) { return 'That is not a valid web address.'; }
  if (!/^https?:$/.test(u.protocol)) return 'Only http and https web pages can be observed.';
  if (u.username || u.password) return 'A web address with a user name or password is refused. CHE does not sign in.';
  if (u.port) return 'A web address with a port number is refused. CHE observes public sites on their standard port.';
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host.startsWith('[') || host.includes(':') || /^[\d.]+$/.test(host) || /^0x/i.test(host)) {
    return 'IP addresses and single-word host names are refused. Use the site\'s public name.';
  }
  if (/(?:^|\.)(?:localhost|local|internal|lan|home|arpa|workers\.dev)$/.test(host)) {
    return 'Local network names (localhost, .local, .internal, .lan, .home, .arpa) and workers.dev are refused.';
  }
  return readablePublicUrl(u.href) ? '' : 'Only public web pages can be observed.';
}

// A web address from the page or the job, or '' when it is not a plain http(s) link.
function webUrl(value, max = 2048) {
  const raw = String(value ?? '');
  if (!raw || raw.length > max) return '';
  let u;
  try { u = new URL(raw); } catch (_) { return ''; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.href.length > max) return '';
  return u.href;
}

function hostName(value) {
  const host = String(value ?? '').toLowerCase().replace(/\.$/, '');
  return HOST.test(host) ? host : '';
}

function isoTime(value) {
  if (typeof value !== 'string' || value.length > 40) return '';
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

const refuse = (reason) => ({ ok: false, reason });

export function validateWebSummary(record) {
  const v = record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  if (!v) return refuse('not an object');
  let size;
  try { size = byteLength(JSON.stringify(v)); } catch (_) { return refuse('not plain JSON'); }
  if (size > REA_WEB_MAX_BYTES) return refuse('larger than 64 KB');
  if (v.schema !== REA_WEB_SCHEMA) return refuse('schema');
  if (typeof v.job_id !== 'string' || !REA_JOB_ID.test(v.job_id)) return refuse('job id');
  if (!STATES.has(v.state)) return refuse('state');
  if (v.tool?.version !== REA_WEB_PIN.version) return refuse('Playwright version');
  const observedAt = isoTime(v.observed_at);
  if (!observedAt) return refuse('observed_at');
  const complete = v.state === 'complete';
  const error = cleanWebText(v.error, 300);
  if (!complete && !error) return refuse('a failed or refused record needs its reason');

  const target = {
    url: webUrl(v.target?.url),
    final_url: webUrl(v.target?.final_url),
    status: count(v.target?.status, 999) ?? 0,
    host: hostName(v.target?.host),
  };
  if (complete && (!readablePublicUrl(target.url) || !readablePublicUrl(target.final_url))) return refuse('target url');

  if (Array.isArray(v.screenshots) && v.screenshots.length > 2) return refuse('more than two screenshots');
  const screenshots = [];
  for (const shot of list(v.screenshots, 2)) {
    const file = SHOT_FILES[shot?.label];
    if (!file || shot.file !== file) return refuse('screenshot file');
    if (screenshots.some((item) => item.label === shot.label)) return refuse('screenshot listed twice');
    const width = count(shot.width, 4096);
    const height = count(shot.height, 4096);
    const bytes = count(shot.bytes, REA_WEB_SHOT_MAX_BYTES);
    if (!width || !height) return refuse('screenshot size');
    if (!bytes) return refuse('screenshot larger than 400 KB');
    screenshots.push({ label: shot.label, file, width, height, bytes });
  }
  if (v.state === 'refused' && screenshots.length) return refuse('a refused record carries no screenshots');

  const L = REA_WEB_LIMITS;
  const p = v.page || {};
  const summary = {
    schema: REA_WEB_SCHEMA,
    job_id: v.job_id,
    state: v.state,
    ...(complete ? {} : { error }),
    tool: { name: 'playwright', version: REA_WEB_PIN.version, browser: REA_WEB_PIN.browser, analysis: REA_WEB_ANALYSIS },
    target,
    observed_at: observedAt,
    page: {
      title: cleanWebText(p.title, 300),
      lang: LANG.test(String(p.lang ?? '')) ? String(p.lang).slice(0, 35) : '',
      description: cleanWebText(p.description, 500),
      generator: cleanWebText(p.generator, 120),
      viewport_meta: flag(p.viewport_meta),
      load_ms: count(p.load_ms, 600_000),
      console_errors: count(p.console_errors, 100_000),
      framework_hints: unique(list(p.framework_hints, L.framework_hints).map((item) => cleanWebText(item, 60))),
      third_party_hosts: unique(list(p.third_party_hosts, L.third_party_hosts).map(hostName)),
    },
    landmarks: Object.fromEntries(['header', 'nav', 'main', 'footer', 'aside', 'search'].map((key) => [key, count(v.landmarks?.[key], 100_000)])),
    headings: list(v.headings, L.headings)
      .map((h) => ({ level: count(h?.level, 6) || 0, text: cleanWebText(h?.text, 200) }))
      .filter((h) => h.level >= 1 && h.text),
    nav_links: list(v.nav_links, L.nav_links)
      .map((link) => ({ text: cleanWebText(link?.text, 120), href: webUrl(link?.href, 500) }))
      .filter((link) => link.text || link.href),
    interactive: list(v.interactive, L.interactive)
      .filter((item) => TOKEN.test(String(item?.role ?? '')))
      .map((item) => ({
        role: item.role,
        name: cleanWebText(item.name, 120),
        ...(TOKEN.test(String(item.type ?? '')) ? { type: item.type } : {}),
      })),
    forms: list(v.forms, L.forms).map((form) => ({
      purpose_hint: cleanWebText(form?.purpose_hint, 60),
      method: METHODS.has(String(form?.method ?? '').toLowerCase()) ? String(form.method).toLowerCase() : '',
      fields: list(form?.fields, L.fields).map((field) => ({
        type: TOKEN.test(String(field?.type ?? '')) ? field.type : 'unknown',
        label: cleanWebText(field?.label, 120),
        required: field?.required === true,
      })),
    })),
    interactions: list(v.interactions, L.interactions)
      .filter((item) => ACTIONS.has(item?.action))
      .map((item) => ({ action: item.action, target: cleanWebText(item.target, 120), observed: cleanWebText(item.observed, 300) })),
    responsive: {
      mobile_horizontal_overflow: flag(v.responsive?.mobile_horizontal_overflow),
      mobile_nav_toggle: flag(v.responsive?.mobile_nav_toggle),
    },
    accessibility: Object.fromEntries(['images', 'images_missing_alt', 'buttons_without_name', 'inputs_without_label']
      .map((key) => [key, count(v.accessibility?.[key], 1_000_000)])),
    screenshots,
    limitations: unique(list(v.limitations, L.limitations).map((item) => cleanWebText(item, 400))),
  };
  if (byteLength(JSON.stringify(summary)) > REA_WEB_MAX_BYTES) return refuse('larger than 64 KB');
  return { ok: true, summary };
}

// ─── robots.txt (RFC 9309), shared by the Worker and the browser observer ─

// '*' matches any run of characters; a final '$' anchors the end. Greedy and linear, so a
// hostile robots.txt cannot make the match slow.
function ruleMatches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  if (!path.startsWith(parts[0])) return false;
  let at = parts[0].length;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (anchored && i === parts.length - 1) return path.length - part.length >= at && path.endsWith(part);
    const found = path.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  return anchored ? at === path.length : true;
}

export function robotsRules(text) {
  const groups = [];
  let current = null;
  let inAgents = false;
  for (const raw of String(text ?? '').slice(0, 512 * 1024).split(/\r\n|\r|\n/)) {
    const found = raw.replace(/#.*$/, '').trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!found) continue;
    const key = found[1].toLowerCase();
    const value = found[2].trim();
    if (key === 'user-agent') {
      if (!inAgents) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      inAgents = true;
    } else {
      inAgents = false;
      if ((key === 'allow' || key === 'disallow') && current) current.rules.push({ allow: key === 'allow', path: value.slice(0, 500) });
    }
  }
  return groups.filter((group) => group.agents.includes('*')).flatMap((group) => group.rules);
}

export function robotsVerdict(text, path) {
  const target = String(path || '/');
  if (target === '/robots.txt') return { allowed: true, rule: '' };
  let best = null;
  for (const rule of robotsRules(text)) {
    if (!rule.path || !ruleMatches(rule.path, target)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  if (!best) return { allowed: true, rule: '' };
  return { allowed: best.allow, rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}` };
}
