// Security Room visibility: every count on the Security page opens exactly the entries that produced it.
//
// One function builds each category's items from CHE's real registries (access principals, the Office team,
// capability registry, command catalog, connectors, paired devices, Face ID sessions, security events and audit,
// recorded checks). A category's count is ALWAYS items.length of that same array, so a count and its list can
// never disagree. Nothing here holds or returns a secret: devices and sessions carry metadata only (name, scopes,
// created, last used), never a token or credential value.
//
// Unknown is shown as unknown: a check that never ran is "not checked", a system the server cannot see is
// "unknown", and zero findings never reads as "all clear" unless every check actually ran.

import { physicalView } from './security_core/physical.js';

export const VISIBILITY_CATEGORIES = Object.freeze([
  { id: 'agents', title: 'Agents' },
  { id: 'tools', title: 'Tools' },
  { id: 'apps', title: 'Apps' },
  { id: 'devices', title: 'Devices' },
  { id: 'sessions', title: 'Sessions' },
  { id: 'permissions', title: 'Permissions' },
  { id: 'threats', title: 'Threats' },
  { id: 'history', title: 'History' },
]);

// Words that explain a scope to the owner. Unknown scopes are shown as written.
const SCOPE_WORDS = [
  [/^\*$/, 'everything (wildcard)'],
  [/^chat$/, 'talk with you'],
  [/^memory$/, 'read and save memories'],
  [/^apps:granted$/, 'open apps you granted'],
  [/^money:ask_first$/, 'money actions, only after asking you'],
  [/^delete:ask_first$/, 'delete things, only after asking you'],
  [/^security:read$/, 'read security status'],
  [/^sessions:revoke$/, 'end Face ID sessions'],
  [/^lockdown:preview$/, 'preview a lockdown (you confirm it)'],
  [/^incidents:manage$/, 'manage security incidents'],
  [/^code:repository$/, 'change code in the repository'],
  [/^github:pull_requests$/, 'open and update pull requests'],
  [/^network:(.+)$/, (m) => `reach ${m[1] === '*' ? 'any website' : m[1]}`],
  [/^credentials:(.+)$/, (m) => `use the ${m[1] === '*' ? 'any stored' : m[1]} credential`],
  [/^action:(.+)$/, (m) => `perform "${m[1]}"`],
  [/^files:(.+)$/, (m) => `files: ${m[1]}`],
  [/^open$/, 'open the app'],
  [/^act_with_permission$/, 'act in the app after you allow it'],
  [/^owner$/, 'full owner access'],
  [/^private$/, 'private (non-owner) access'],
  [/^office:assigned_jobs$/, 'work on jobs CHE assigns'],
  [/^connector:(.+)$/, (m) => `use the ${m[1]} connection`],
  [/^session:(.+)$/, (m) => `${m[1].replace(/_/g, ' ')} (Face ID session)`],
];

export function scopeWords(scope) {
  for (const [re, w] of SCOPE_WORDS) {
    const m = re.exec(scope);
    if (m) return typeof w === 'function' ? w(m) : w;
  }
  return String(scope);
}

// A scope that gives more than any single job needs.
const BROAD = /^(?:\*|network:\*|credentials:\*|delete:\*|money:\*|payments?:\*|files:\*)$/;

/** Plain-language least-privilege explanation for one holder of access. */
export function leastPrivilege({ name, kind, scopes = [], last_used_at = null, status = 'active' }, now = Date.now()) {
  const broad = scopes.filter((s) => BROAD.test(s));
  const stale = scopes.length > 0 && last_used_at && now - Date.parse(last_used_at) > 30 * 86_400_000;
  const can = scopes.length ? scopes.map(scopeWords).join('; ') : 'nothing';
  let verdict = 'appropriate';
  let why = 'Each permission matches a job it does.';
  if (status === 'revoked' || status === 'inactive') { verdict = 'not in use'; why = `It is ${status}, so it cannot use these permissions now.`; }
  else if (broad.length) { verdict = 'excessive'; why = `${broad.map(scopeWords).join(' and ')} is wider than any one job needs; narrow it to the specific ${broad.some((s) => s.startsWith('network')) ? 'sites' : 'items'} it uses.`; }
  else if (stale) { verdict = 'review'; why = 'It has not used these permissions in over 30 days; remove what it no longer needs.'; }
  return { verdict, plain: `${name} (${kind}) can: ${can}. ${why}`, broad };
}

const iso = (v) => (v == null ? null : typeof v === 'number' ? new Date(v).toISOString() : String(v));

function item(category, { id, name, type, permissions = [], source, last_activity = null, status, detail = '', severity = null, evidence = null, recommendation = '', plain = '', verdict = null }) {
  return { id: `${category}:${id}`, category, name: String(name || id), type, permissions, permission_words: permissions.map(scopeWords), source, last_activity: iso(last_activity), status, detail, severity, evidence, recommendation, plain, verdict };
}

/**
 * The full visibility model. Inputs are the already-loaded real state; nothing is fetched here.
 * @returns {{categories: Array<{id,title,count,items}>, findings: Array, coverage: object, physical: object}}
 */
export function securityVisibility({ principals = [], review = { findings: [] }, team = [], commands = [], connectors = {}, sessions = [], events = [], audit = [], checks = [], advisoriesChecked = false, deployChecked = false, physicalDevices = [], now = Date.now() } = {}) {
  const lp = (p) => leastPrivilege({ name: p.name, kind: p.kind, scopes: p.scopes, last_used_at: p.last_used_at, status: p.status }, now);

  const agents = [
    ...principals.filter((p) => p.kind === 'agent').map((p) => { const l = lp(p); return item('agents', { id: p.id, name: p.name, type: 'AI agent', permissions: p.scopes, source: 'Security Core access registry', last_activity: p.last_used_at, status: p.status, detail: p.note, plain: l.plain, verdict: l.verdict }); }),
    // An Office agent who is also a security principal (Knox, the Security Chief) is one entry, not two.
    ...team.filter((a) => a && !a.retired && !principals.some((p) => p.kind === 'agent' && String(p.name).toLowerCase() === String(a.name || '').toLowerCase())).map((a) => {
      const scopes = ['office:assigned_jobs'];
      const l = leastPrivilege({ name: a.name, kind: 'office worker', scopes, last_used_at: a.last_active_at || null }, now);
      return item('agents', { id: `office:${a.id}`, name: a.name || a.id, type: `Office worker${a.role ? ` · ${a.role}` : ''}`, permissions: scopes, source: 'Office team', last_activity: a.last_active_at || null, status: a.runtime_status || 'idle', detail: `AI provider: ${a.provider_preference || 'auto'}`, plain: l.plain, verdict: l.verdict });
    }),
  ];

  const tools = [
    ...principals.filter((p) => p.kind === 'tool').map((p) => { const l = lp(p); return item('tools', { id: p.id, name: p.name, type: 'Internal tool', permissions: p.scopes, source: 'Capability registry', last_activity: p.last_used_at, status: p.status, plain: l.plain, verdict: l.verdict }); }),
    ...commands.map((c) => item('tools', { id: `command:${c.id}`, name: `/${c.id}`, type: `Command · ${c.mode || 'command'}`, permissions: (c.needs || []).map((n) => `connector:${n}`), source: 'Command catalog', status: c.status || 'unknown', detail: c.summary || '', plain: `/${c.id} ${c.approval?.required ? 'asks you first, then ' : ''}${(c.does || c.summary || '').replace(/\.$/, '')}.` })),
  ];

  const apps = [
    ...principals.filter((p) => p.kind === 'app').map((p) => { const l = lp(p); return item('apps', { id: p.id, name: p.name, type: 'App you granted', permissions: p.scopes, source: 'App permissions', last_activity: p.last_used_at, status: p.status, plain: l.plain, verdict: l.verdict }); }),
    ...Object.entries(connectors).map(([id, c]) => item('apps', { id: `connector:${id}`, name: c.label || id, type: 'Connection', permissions: [`connector:${id}`], source: 'Connections', status: c.state || 'unknown', detail: c.detail || '' })),
  ];

  const devices = principals.filter((p) => p.kind === 'device').map((p) => { const l = lp(p); return item('devices', { id: p.id, name: p.name, type: p.scopes.includes('owner') ? 'Owner device' : 'Paired device', permissions: p.scopes, source: 'Paired devices', last_activity: p.last_used_at, status: p.status, plain: l.plain, verdict: l.verdict }); });

  // Face ID sessions: scopes, factors and expiry only. No session id or token is ever returned.
  const sessionItems = sessions.map((s, i) => item('sessions', {
    id: `session:${i}`, name: s.this_device ? 'This iPhone · Face ID session' : 'Face ID session', type: 'Face ID session',
    permissions: (s.scopes || []).map((x) => `session:${x}`), source: 'Security Intelligence sessions',
    last_activity: s.created_at || null, status: 'active', detail: `expires ${iso(s.expires_at)}`,
  }));

  // Every granted scope is one permission entry, so "Permissions (n)" lists exactly n grants.
  const permissions = [];
  for (const p of principals) {
    for (const s of p.scopes) {
      const broad = BROAD.test(s);
      permissions.push(item('permissions', { id: `${p.id}:${s}`, name: `${p.name}: ${scopeWords(s)}`, type: `${p.kind} grant`, permissions: [s], source: 'Security Core access registry', last_activity: p.last_used_at, status: p.status, severity: broad ? 'high' : null, plain: `${p.name} ${broad ? 'holds a broad grant: ' : 'can '}${scopeWords(s)}.${broad ? ' That is more than any one job needs.' : ''}`, verdict: broad ? 'excessive' : 'appropriate' }));
    }
  }

  const findings = [
    ...review.findings.map((f, i) => {
      const p = principals.find((x) => x.id === f.id);
      const l = p ? lp(p) : { plain: '' };
      return item('threats', {
        id: `access:${i}:${f.id}`, name: `${p?.name || f.id}: ${f.issue}`, type: 'Least-privilege finding', permissions: p?.scopes || [], source: 'Access review',
        last_activity: p?.last_used_at || null, status: 'open', severity: f.severity, evidence: { principal: f.id, kind: f.kind, issue: f.issue, scopes: p?.scopes || [] },
        recommendation: f.severity === 'low' ? `Remove permissions ${p?.name || f.id} no longer uses. CHE asks you before removing anything.` : `Narrow ${p?.name || f.id}'s access to only what it uses. CHE asks you before changing or removing access.`,
        plain: l.plain,
      });
    }),
    ...events.filter((e) => e.verification !== 'simulation' && /threat|pairing|unknown_token|error_spike|unexpected_deploy|revoked|secret|malware|quarantine|dependency/.test(e.event_type || '')).map((e) => item('threats', {
      id: `event:${e.event_id}`, name: e.summary || e.event_type, type: 'Security event', source: e.source || 'Security Core', last_activity: e.timestamp, status: e.status || 'open', severity: e.severity || 'info',
      evidence: { event_id: e.event_id, event_type: e.event_type, affected_resource: e.affected_resource || '', evidence_refs: e.evidence_refs || [], actions_taken: e.actions_taken || [], verification: e.verification || 'unverified', confidence: e.confidence ?? null },
      recommendation: ['high', 'critical'].includes(e.severity) ? 'Open the incident and follow its steps; lockdown is available and needs your confirmation.' : 'Review the evidence; no automatic change was made.',
      detail: e.affected_resource || '',
    })),
  ];

  const history = [
    ...audit.map((a, i) => item('history', { id: `audit:${i}`, name: a.action || a.type || 'Security action', type: 'Audit', source: 'Security audit log', last_activity: a.at, status: a.ok === false ? 'failed' : 'recorded', detail: a.detail || '' })),
    ...checks.map((c, i) => item('history', { id: `check:${i}`, name: 'Security check', type: 'Check', source: 'Security Core checks', last_activity: c.at, status: 'completed', detail: `${c.findings ?? 0} finding${c.findings === 1 ? '' : 's'}${c.advisories == null ? ', dependencies not checked' : `, ${c.advisories} dependency advisor${c.advisories === 1 ? 'y' : 'ies'}`}` })),
  ].sort((a, b) => String(b.last_activity || '').localeCompare(String(a.last_activity || '')));

  const lists = { agents, tools, apps, devices, sessions: sessionItems, permissions, threats: findings, history };
  const categories = VISIBILITY_CATEGORIES.map((c) => ({ ...c, count: lists[c.id].length, items: lists[c.id] }));

  return { categories, findings, coverage: coverage({ checks, advisoriesChecked, deployChecked, findings: findings.length, now }), physical: physicalPage(physicalDevices) };
}

/**
 * What was checked, when, and what was not. "all_checked" is true only when every check has a recorded run in
 * the last day; the vault and physical devices are outside the server's view and stay "unknown"/"not monitored".
 */
export function coverage({ checks = [], advisoriesChecked = false, deployChecked = false, findings = 0, now = Date.now() } = {}) {
  const last = checks[0]?.at || null;
  const fresh = last && now - Date.parse(last) < 86_400_000;
  const ran = (at) => (at ? { state: 'checked', at } : { state: 'not_checked', at: null });
  const list = [
    { id: 'security_check', label: 'Threat and access check', ...ran(last), stale: Boolean(last && !fresh) },
    { id: 'dependencies', label: 'Dependency advisories', ...(advisoriesChecked || checks[0]?.advisories != null ? ran(last) : { state: 'not_checked', at: null }) },
    { id: 'deploy', label: 'Deployment matches the repository', ...(deployChecked ? ran(last) : { state: 'not_checked', at: null }) },
    { id: 'devices', label: 'Paired device review', ...ran(last) },
    { id: 'vault', label: 'Password vault', state: 'unknown', at: null, why: 'It lives only on your iPhone; the server never sees it.' },
    { id: 'phone_secret_scan', label: 'On-phone secret scan', state: 'unknown', at: null, why: 'Runs on the phone; its results are not reported to the server.' },
    { id: 'physical', label: 'Cameras, locks, alarms and sensors', state: 'not_monitored', at: null, why: 'No physical security integration is connected.' },
  ];
  const checked = list.filter((c) => c.state === 'checked' && !c.stale);
  const all = list.every((c) => c.state === 'checked' && !c.stale);
  return {
    checks: list,
    checked: checked.length,
    not_checked: list.filter((c) => c.state === 'not_checked' || c.stale).length,
    unknown: list.filter((c) => c.state === 'unknown' || c.state === 'not_monitored').length,
    all_checked: all,
    summary: findings === 0
      ? (all ? 'No findings, and every check ran in the last day.' : `No findings from the ${checked.length} check${checked.length === 1 ? '' : 's'} that ran. ${list.length - checked.length} area${list.length - checked.length === 1 ? ' was' : 's were'} not checked or cannot be seen, so this is not an all-clear.`)
      : `${findings} finding${findings === 1 ? '' : 's'} from ${checked.length} check${checked.length === 1 ? '' : 's'}; ${list.length - checked.length} area${list.length - checked.length === 1 ? '' : 's'} not checked or not visible.`,
  };
}

// Physical security platforms with an official, documented developer API. Researched candidates only: none is
// integrated, so every one is "Unsupported" until an adapter with a real handshake exists in physical.js.
export const PHYSICAL_CANDIDATES = Object.freeze([
  { id: 'google_nest', name: 'Google Nest (cameras, doorbells, thermostats)', api: 'Smart Device Management API (Device Access program)', source: 'https://developers.google.com/nest/device-access', classes: ['camera'] },
  { id: 'smartthings', name: 'Samsung SmartThings (locks, sensors, alarms)', api: 'SmartThings REST API', source: 'https://developer.smartthings.com/docs/api/public', classes: ['door_lock', 'motion_sensor', 'contact_sensor', 'alarm'] },
  { id: 'home_assistant', name: 'Home Assistant (hub for many brands)', api: 'Home Assistant REST and WebSocket API', source: 'https://developers.home-assistant.io/docs/api/rest/', classes: ['camera', 'door_lock', 'alarm', 'motion_sensor', 'contact_sensor', 'smoke_detector'] },
  { id: 'apple_homekit', name: 'Apple Home (HomeKit accessories)', api: 'HomeKit framework (on the iPhone)', source: 'https://developer.apple.com/documentation/homekit', classes: ['camera', 'door_lock', 'alarm', 'motion_sensor', 'contact_sensor'] },
]);

/** The Physical Security connections page: honest about what exists. */
export function physicalPage(devices = []) {
  const v = physicalView(devices);
  const statusWord = { unsupported: 'Unsupported', not_connected: 'Disconnected', error: 'Disconnected', connected: 'Verified connected' };
  return {
    ...v,
    headline: v.adapters.length ? `${v.adapters.length} supported integration${v.adapters.length === 1 ? '' : 's'}` : 'No supported integrations yet',
    devices: v.devices.map((d) => ({ ...d, status_word: d.connected ? 'Verified connected' : statusWord[d.status === 'connected' ? 'not_connected' : d.status] || 'Unsupported' })),
    candidates: PHYSICAL_CANDIDATES.map((c) => ({ ...c, status: v.adapters.includes(c.id) ? 'supported' : 'unsupported', status_word: v.adapters.includes(c.id) ? 'Supported' : 'Unsupported' })),
    rules: [
      'A device shows Verified connected only after an authorized handshake succeeds and is recorded.',
      'CHE may notify you and record events on its own.',
      'Unlocking, disarming, opening, or turning off power needs your confirmation with Face ID every time.',
      'CHE never blocks an alarm\'s own emergency behavior and never disables smoke or life-safety devices.',
    ],
  };
}

/** Whether a sensitive physical action may run. Delegates to the core rule; adds the per-action Face ID gate. */
export function physicalActionGate(action, { device = null, owner_confirmed = false, face_id = false } = {}, physicalResponse) {
  const r = physicalResponse(action, { owner_confirmed: owner_confirmed && face_id, device });
  if (!r.allowed && r.needs_owner) return { ...r, reason: 'This needs your confirmation with Face ID every time.' };
  return r;
}

/** Spoken answer for "open security access" / "show security findings": counts, then what is not covered. */
export function speakVisibility(vis, which = 'access') {
  const by = Object.fromEntries(vis.categories.map((c) => [c.id, c]));
  if (which === 'findings') {
    const f = by.threats.items;
    const head = f.length
      ? `${f.length} security finding${f.length === 1 ? '' : 's'}, sir: ${f.slice(0, 5).map((x, i) => `${i + 1}. ${x.name}, ${x.severity || 'info'}`).join('; ')}.`
      : 'No security findings recorded, sir.';
    return `Opening Security findings. ${head} ${vis.coverage.summary}`;
  }
  const parts = ['agents', 'tools', 'apps', 'devices', 'sessions', 'permissions'].map((id) => `${by[id].count} ${by[id].count === 1 ? id.replace(/s$/, '') : id}`);
  const excessive = by.permissions.items.filter((x) => x.verdict === 'excessive').length;
  return `Opening Security access, sir. ${parts.join(', ')}. ${excessive ? `${excessive} grant${excessive === 1 ? ' is' : 's are'} wider than needed.` : 'No grant is wider than needed.'} ${vis.coverage.summary}`;
}
