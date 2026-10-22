// Security Core: target identity, least-privilege tool access, static malware inspection and dependency
// advisories. Portable: imports only other Security Core modules. Nothing it inspects is ever executed.
import { redact, scanSecrets } from './secrets.js';

const clip = (v, n) => String(v ?? '').slice(0, n);

// ─── Identity of the target: app, domain, account ───────────────────────────

function registrable(host) {
  const parts = String(host || '').toLowerCase().replace(/\.$/, '').split('.');
  const twoLevel = /^(?:co|com|org|net|gov|ac)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

/**
 * Before acting in an app, on a site or in an account, the target must be exactly the one the owner authorized.
 * Look-alike domains (punycode, extra labels such as paypal.com.evil.io, other registrable domains) and another
 * signed-in account stop the action.
 */
export function checkTargetIdentity({ expected = {}, actual = {} }) {
  const problems = [];
  if (expected.app && String(actual.app || '').toLowerCase() !== String(expected.app).toLowerCase()) problems.push(`the app is ${actual.app || 'unknown'}, not ${expected.app}`);
  if (expected.domain) {
    let host = '';
    try { host = new URL(String(actual.url || '')).hostname.toLowerCase(); } catch (_) { host = String(actual.domain || '').toLowerCase(); }
    const want = String(expected.domain).toLowerCase();
    if (!host) problems.push('the site address is unknown');
    else if (/(^|\.)xn--/.test(host)) problems.push(`${host} uses a look-alike (punycode) name`);
    else if (registrable(host) !== registrable(want) || !(host === want || host.endsWith(`.${want}`) || registrable(want) === want && host.endsWith(`.${want}`))) problems.push(`the site is ${host}, not ${want}`);
    if (actual.url && !/^https:/i.test(String(actual.url))) problems.push('the connection is not HTTPS');
  }
  if (expected.account && String(actual.account || '').toLowerCase() !== String(expected.account).toLowerCase()) problems.push('a different account is signed in');
  return problems.length ? { ok: false, problems } : { ok: true, problems: [] };
}

// ─── Internal tool permissions ──────────────────────────────────────────────

const ACCESS_KINDS = ['files', 'projects', 'network', 'credentials', 'devices', 'actions'];

/**
 * A capability may touch only what its `permissions` list names. An internally created tool starts with nothing, so
 * every file, project, host, credential, device or action it asks for must have been granted explicitly.
 */
export function checkToolAccess(cap, request = {}) {
  if (!cap) return { ok: false, denied: ['unknown tool'] };
  const perms = cap.permissions || {};
  const denied = [];
  for (const kind of ACCESS_KINDS) {
    const allowed = Array.isArray(perms[kind]) ? perms[kind] : [];
    for (const want of [].concat(request[kind] || [])) {
      const w = String(want);
      const ok = allowed.some((a) => {
        const g = String(a);
        if (kind === 'files' || kind === 'projects') return g.endsWith('/*') ? w.startsWith(g.slice(0, -1)) && !w.includes('..') : w === g;
        if (kind === 'network') { let host = w; try { host = new URL(w).hostname; } catch (_) {} return host === g; }
        return w === g;
      });
      if (!ok) denied.push(`${kind}: ${clip(redact(w).text, 80)}`);
    }
  }
  return denied.length ? { ok: false, denied } : { ok: true, denied: [] };
}

// ─── Malware and supply-chain safety ────────────────────────────────────────

export async function sha256(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

const BINARY_MAGIC = [
  ['ELF executable', [0x7f, 0x45, 0x4c, 0x46]], ['Windows executable', [0x4d, 0x5a]],
  ['Mach-O executable', [0xcf, 0xfa, 0xed, 0xfe]], ['Mach-O executable', [0xfe, 0xed, 0xfa, 0xcf]], ['Mach-O universal binary', [0xca, 0xfe, 0xba, 0xbe]],
  ['WebAssembly module', [0x00, 0x61, 0x73, 0x6d]], ['Java class', [0xca, 0xfe, 0xba, 0xbe]],
];
const PERMISSIVE = /\b(?:MIT|Apache[- ]2\.0|BSD|ISC|Zlib|Unlicense|CC0|MPL[- ]2\.0)\b/i;
const COPYLEFT = /\b(?:GPL|AGPL|LGPL)[- ]?v?\d/i;

/** Static inspection of one file. Nothing is executed. */
export function inspectFile({ path = '', text = null, bytes = null }) {
  const issues = [];
  const b = bytes instanceof Uint8Array ? bytes : text != null ? new TextEncoder().encode(String(text)) : new Uint8Array();
  for (const [label, magic] of BINARY_MAGIC) if (magic.every((x, i) => b[i] === x)) { issues.push({ severity: 'high', what: `${label} (${path}): never run in production` }); break; }
  const s = text != null ? String(text) : new TextDecoder('utf-8', { fatal: false }).decode(b.slice(0, 200_000));
  if (/package\.json$/.test(path)) {
    try {
      const pkg = JSON.parse(s);
      for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) if (pkg.scripts?.[hook]) issues.push({ severity: 'medium', what: `install script "${hook}" in ${path}` });
    } catch (_) { issues.push({ severity: 'low', what: `${path} is not valid JSON` }); }
  }
  if (/\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z)?sh\b/.test(s)) issues.push({ severity: 'high', what: `${path} pipes a download into a shell` });
  if (/\beval\s*\(\s*(?:atob|Buffer\.from|unescape|String\.fromCharCode)/.test(s) || /(?:\\x[0-9a-f]{2}){40,}/i.test(s)) issues.push({ severity: 'high', what: `${path} decodes and runs hidden code` });
  if (/[A-Za-z0-9+/]{2000,}={0,2}/.test(s) && !/\.(?:png|jpe?g|gif|woff2?|ttf|lock)$/i.test(path)) issues.push({ severity: 'medium', what: `${path} carries a large encoded blob` });
  if (/\b(?:xmrig|stratum\+tcp|coinhive|cryptonight)\b/i.test(s)) issues.push({ severity: 'high', what: `${path} references crypto-mining` });
  if (/(?:~\/\.ssh|id_rsa|\.aws\/credentials|keychain|process\.env)[\s\S]{0,200}(?:fetch|https?\.request|axios|XMLHttpRequest|curl)/i.test(s)) issues.push({ severity: 'high', what: `${path} reads credentials and sends network requests` });
  if (/child_process|subprocess\.Popen|os\.system|Runtime\.getRuntime\(\)\.exec/.test(s)) issues.push({ severity: 'low', what: `${path} starts processes` });
  if (/\b(?:fetch|axios|https?\.request|XMLHttpRequest|urllib|requests\.(?:get|post))\b/.test(s)) issues.push({ severity: 'info', what: `${path} makes network requests` });
  for (const f of scanSecrets(s)) issues.push({ severity: 'medium', what: `${path} contains a credential-shaped value (${f.kind})` });
  return issues;
}

/**
 * MALWARE SAFETY LOOP for a repository or file set: identity → hashes → static inspection → dependency review →
 * license review → verdict allow / quarantine / reject / owner_review. Nothing from the source is executed.
 */
export async function inspectArtifacts({ source = '', files = [], license = '', identity = {}, paths = [] } = {}) {
  const hashes = [];
  const issues = [];
  // Prebuilt executables in the file list are never trusted, read or not.
  const executables = paths.filter((p) => /\.(?:exe|dll|so|dylib|bin|jar|msi|apk|ipa|scr|bat|cmd|ps1)$/i.test(String(p))).slice(0, 10);
  if (executables.length) issues.push({ severity: 'medium', what: `prebuilt executable files (${executables.slice(0, 3).join(', ')}): never run in production` });
  for (const f of files.slice(0, 2000)) {
    const bytes = f.bytes instanceof Uint8Array ? f.bytes : new TextEncoder().encode(String(f.text ?? ''));
    hashes.push({ path: clip(f.path, 200), sha256: await sha256(bytes), size: bytes.length });
    issues.push(...inspectFile({ path: f.path, text: f.text ?? null, bytes: f.bytes ?? null }));
  }
  const licenseText = license || files.find((f) => /^(?:LICENSE|COPYING)(?:\.\w+)?$/i.test(String(f.path).split('/').pop()))?.text || '';
  const licenseKind = !licenseText ? 'none' : PERMISSIVE.test(licenseText) ? 'permissive' : COPYLEFT.test(licenseText) ? 'copyleft' : 'unknown';
  if (licenseKind === 'none') issues.push({ severity: 'medium', what: 'no license: the code may not be reused' });
  if (licenseKind === 'copyleft') issues.push({ severity: 'medium', what: 'copyleft license: reuse needs the owner\'s decision' });
  if (licenseKind === 'unknown') issues.push({ severity: 'medium', what: 'unrecognised license' });
  if (identity.expected && identity.actual && identity.expected !== identity.actual) issues.push({ severity: 'high', what: `the repository is ${identity.actual}, not ${identity.expected}` });
  const high = issues.filter((i) => i.severity === 'high').length;
  const medium = issues.filter((i) => i.severity === 'medium').length;
  const verdict = high >= 2 || issues.some((i) => /hidden code|pipes a download|crypto-mining|not .* expected|credentials and sends/.test(i.what) && i.severity === 'high') ? 'reject'
    : high ? 'quarantine'
      : medium ? 'owner_review'
        : 'allow';
  return { source: clip(source, 200), verdict, license: licenseKind, hashes: hashes.slice(0, 200), issues: issues.slice(0, 100), executed: false };
}

/** Unknown binaries and unreviewed code never run in CHE's production runtime; a sandbox run needs an allow verdict. */
export function mayExecute(report, environment = 'production') {
  if (!report || report.verdict !== 'allow') return { ok: false, reason: `the safety verdict is ${report?.verdict || 'missing'}` };
  if (environment === 'production' && report.issues.some((i) => /executable|binary|WebAssembly/.test(i.what))) return { ok: false, reason: 'unknown executables never run in production' };
  return { ok: true };
}

/** The registry's 'security' promotion check (capability_registry.recordCheck). */
export async function securityCheckForCapability(cap, files = []) {
  const report = await inspectArtifacts({ source: cap?.capability_id, files, license: cap?.license_profile || '' });
  const wide = cap ? [].concat(cap.permissions?.network || [], cap.permissions?.credentials || []) : [];
  const ok = Boolean(cap) && report.verdict === 'allow' && !wide.includes('*');
  return { ok, evidence: ok ? `static review clean (${report.hashes.length} file(s), ${report.license} license, no wildcard access)` : `verdict ${report.verdict}; ${report.issues.filter((i) => i.severity !== 'info').map((i) => i.what).slice(0, 3).join('; ') || 'wildcard network or credential access'}`, report };
}

/** Generated code reaches production only with clean checks, passing tests and the owner's review. */
export async function reviewGeneratedCode({ files = [], syntax_ok = false, tests_passed = false, owner_approved = false } = {}) {
  const report = await inspectArtifacts({ source: 'generated code', files, license: 'MIT (CHE original code)' });
  const blockers = [];
  if (!syntax_ok) blockers.push('syntax checks have not passed');
  if (!tests_passed) blockers.push('tests have not passed');
  if (report.verdict !== 'allow') blockers.push(`security review: ${report.verdict}`);
  if (!owner_approved) blockers.push('the owner has not approved it');
  return { may_enter_production: blockers.length === 0, blockers, report };
}

// Small vendored advisory list (checked without any network). It is not a full advisory database: the report says so.
export const ADVISORIES = Object.freeze([
  { ecosystem: 'npm', name: 'lodash', below: '4.17.21', id: 'CVE-2021-23337', severity: 'high' },
  { ecosystem: 'npm', name: 'minimist', below: '1.2.6', id: 'CVE-2021-44906', severity: 'high' },
  { ecosystem: 'npm', name: 'node-fetch', below: '2.6.7', id: 'CVE-2022-0235', severity: 'medium' },
  { ecosystem: 'npm', name: 'ws', below: '8.17.1', id: 'CVE-2024-37890', severity: 'high' },
  { ecosystem: 'npm', name: 'axios', below: '1.7.4', id: 'CVE-2024-39338', severity: 'high' },
  { ecosystem: 'npm', name: 'event-stream', exact: '3.3.6', id: 'malicious flatmap-stream', severity: 'critical' },
  { ecosystem: 'pub', name: 'http', below: '0.13.3', id: 'GHSA CRLF injection', severity: 'medium' },
]);

function semverLess(a, b) {
  const pa = String(a).replace(/^[^\d]*/, '').split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
}

/** Dependency advisories from package.json / package-lock / pubspec.lock content. */
export function dependencyAdvisories({ packageJson = '', pubspecLock = '' } = {}) {
  const deps = [];
  try {
    const pkg = JSON.parse(packageJson || '{}');
    for (const [name, v] of Object.entries({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })) deps.push({ ecosystem: 'npm', name, version: String(v) });
  } catch (_) {}
  for (const m of String(pubspecLock).matchAll(/^ {2}([a-z0-9_]+):\n(?:(?: {4}.*)\n)*? {4}version: "([^"]+)"/gm)) deps.push({ ecosystem: 'pub', name: m[1], version: m[2] });
  const hits = [];
  for (const d of deps) {
    for (const a of ADVISORIES) {
      if (a.ecosystem !== d.ecosystem || a.name !== d.name) continue;
      const v = d.version.replace(/^[\^~>=<\s]+/, '');
      if ((a.exact && v === a.exact) || (a.below && semverLess(v, a.below))) hits.push({ ...a, version: d.version });
    }
  }
  return { checked: deps.length, advisories: hits, coverage: `a small built-in list of ${ADVISORIES.length} known advisories, not a full database` };
}

