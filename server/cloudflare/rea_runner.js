// CHE's reverse-engineering route (REA). REA is a local, MIT-licensed tool that runs on
// Node, so it cannot run inside this Worker or on the iPhone. CHE dispatches one pinned
// GitHub Actions run (.github/workflows/che-rea-analysis.yml) that reads one public npm
// package at an exact version, reduces REA's evidence, and writes the summary to the
// che-mailbox branch. CHE answers from that summary only.
//
// Permission rules, enforced here in code (not left to the model):
//  - Inspect, debug, explain and compare are read-only. They dispatch analysis, never a
//    coding job, never a commit, never a deploy.
//  - Rebuild only writes a plan from evidence already recorded. Building needs the owner's
//    separate yes through CHE's existing build route (che-build), which has its own gate.
//  - Only public npm packages at an exact version are accepted. Private files, URLs, device
//    targets and version ranges are refused with the reason.
//  - Native binaries and runtime capture are reported as unavailable, honestly.
//
// REA 2.0 adds investigations of other public targets through the same job log:
// a public GitHub repository (read at its exact commit), a public web page (read
// once, robots.txt respected, plus an isolated browser run on GitHub Actions), an
// App Store listing, and an honest answer for apps CHE cannot reach. Each
// investigation moves through fixed stages with evidence, is compared with CHE's
// live repository on request, and is planned and built only through CHE's
// existing self-development job (a draft pull request; never a merge).

import { gh } from './coding_runtime.js';
import {
  REA_PIN, REA_JOB_ID, NPM_NAME, EXACT_VERSION, NPM_INTEGRITY, cleanText, validateReaSummary,
} from './rea_evidence.js';
import {
  identifyTarget, inspectGithubRepo, inspectWebsite, lookupAppStore, searchPublicRepos,
  PRIVATE_APP_ALTERNATIVES, PRIVATE_APP_LIMITS,
} from './rea_targets.js';
import {
  browserFeatures, buildFeatureMap, buildRequestFor, compareWithChe, pickFeatures, planFor, proposeImprovements, verifyBuild,
} from './rea_features.js';
import { validateWebSummary } from './rea_web_evidence.js';
import { withoutProhibitions } from './owner_action_gate.js';

export const REA_WORKFLOW = 'che-rea-analysis.yml';
export const REA_WORKFLOW_REF = 'main';
export const REA_RESULTS_REF = 'che-mailbox';
export const REA_RESULT_PREFIX = 'mailbox/rea';
export const REA_JOBS_KEY = 'rea_jobs';
export const REA_WEB_WORKFLOW = 'che-rea-web.yml';
// One investigation's full record lives under its own key; the job log above
// keeps only the light entry, so the log never nears a storage value limit.
export const REA_DETAIL_PREFIX = 'rea_inv:';
const JOB_LOG_LIMIT = 30;
const STALLED_AFTER_MS = 2 * 60 * 60_000;
const VERIFIED_STATES = ['passed', 'failed'];
const VERIFY_RECHECK_MS = 2 * 60_000;

const VERBS = { inspect: 'inspect', 'reverse engineer': 'inspect', 'reverse-engineer': 'inspect', analyze: 'inspect', analyse: 'inspect', explain: 'explain', debug: 'debug', compare: 'compare' };
const TITLES = { inspect: 'inspection', explain: 'explanation', debug: 'debug review', compare: 'comparison', rebuild: 'rebuild plan' };

export function reaConfigured(env = {}) {
  return Boolean(String(env.CHE_GITHUB_TOKEN || '').trim()) && /^[\w.-]+\/[\w.-]+$/.test(String(env.CHE_GITHUB_REPO || '').trim());
}

const ALIASES = { investigate: 'inspect', map: 'features', architecture: 'explain', gap: 'compare', plan: 'rebuild', history: 'status' };
const EXPLICIT = /^(?:che[,:]?\s+)?rea\b\s*(inspect|investigate|discover|map|features|architecture|explain|debug|compare|gap|rebuild|plan|build|verify|status|history|capabilities)\b\s*[:\-–]?\s*([\s\S]*)$/i;
const INVESTIGATE = /\b(?:investigate|study|analy[sz]e|inspect|reverse[- ]engineer|examine|look into|dig into|break down|figure out how)\b/i;
const HOW_IT_WORKS = /\bhow\b[\s\S]{0,30}\b(?:its|their|it'?s|the app'?s|this app'?s)?\s*(?:interface|features?|ui|screens?|navigation|architecture)\b[\s\S]{0,20}\bworks?\b|\bhow (?:it|this|that)(?: app| website| site)? works\b/i;
const GAP = /\b(?:which|what)\b[\s\S]{0,40}\bfeatures?\b[\s\S]{0,60}\b(?:improve|help|add|missing|useful|worth|lack|don'?t have|could use)\b|\bfeatures?\b[\s\S]{0,30}\b(?:you(?:'re| are)|che(?: is)?|we(?:'re| are)) (?:missing|lacking)\b|\bcompare (?:it|that|them|those|this|that app|the app)\b[\s\S]{0,20}\b(?:with|to|against) (?:you|yourself|che|your)/i;
const BUILD_THOSE = /\b(?:build|add|implement|put|integrate)\b\s+(?:those|these|them|it|that|the (?:approved|recommended|proposed|planned|missing)|all (?:of )?(?:those|these|the))\b[\s\S]{0,60}\b(?:into|in|to)\s+(?:yourself|your (?:app|code|system)|che)\b/i;
const BUILD_NAMED = /\b(?:add|build|implement)\b\s+(?:the\s+|that\s+)?([\w\s-]{3,40}?)\s+feature\b[\s\S]{0,50}\b(?:we|you)\s+(?:discussed|found|looked at|talked about|investigated|studied|mentioned)\b/i;
const RECALL = /\bremember (?:that|the) (?:app|website|site|repo(?:sitory)?|package|project)\b[\s\S]{0,40}\b(?:we|you) (?:looked at|investigated|studied|checked|analy[sz]ed|researched)\b/i;
const PRONOUN_TARGET = /\b(?:this|that|the) (?:app|application|website|site|web ?app|repo(?:sitory)?|project|software|tool)\b/i;
const NOT_REA = /\b(?:seo|audit|summari[sz]e|remember (?:this|that) (?:page|link)|save (?:this|that)|memori[sz]e|my (?:website|site|app)|your (?:own )?(?:code|app|website|repo))\b/i;
const NO_CODE_CHANGE = /\b(?:do\s+not|don['’]t|never|without)\s+(?:modify\w*|chang\w*|touch\w*|edit\w*|writ\w*|open\w*)\s+(?:your|the|any|a)?\s*(?:code|pull request|pr)\b|\b(?:chat|conversation)[- ]only\b|\banswer (?:only )?in (?:this )?chat\b/i;
const SELF_REA = /\b(?:your|che['’]?s|the|my)\s+(?:own\s+)?rea\b/i;
const SELF_REA_READ = /\b(?:what|which|explain|describe|tell|show|list|status|history|latest|last|most\s+recent|recent|capabilit\w*|evidence)\b/i;
const OWN_AREAS = /^(?:office|workshop|command center|commands?|brain|mailbox|connections?|trading(?: desk)?|studio|che|chey|keys|settings)$/i;

// `REA inspect: npm:semver@7.7.2`, `REA rebuild: a copy of the search box`, `REA status`.
// Natural phrasing is accepted only when it names a target REA can read (or refers
// to an earlier investigation), so ordinary chat is never taken over by this route.
export function parseReaRequest(message, { history = [] } = {}) {
  const text = String(message || '').trim();
  const explicit = text.match(EXPLICIT);
  if (explicit) {
    const verb = explicit[1].toLowerCase();
    return { command: ALIASES[verb] || verb, input: explicit[2].trim() };
  }
  const natural = parseNaturalRea(text, { history });
  if (natural) return natural;
  // "Explain what your REA system can do right now, show your most recent verified investigation ... Do not
  // start a new investigation": CHE's own REA, read only. Checked last, so a named target, a comparison or
  // an earlier investigation keeps its own route.
  const target = identifyTarget(text);
  if (text.length <= 600 && SELF_REA.test(text) && SELF_REA_READ.test(text)
    && !(target && !['app_name', 'private_app'].includes(target.kind))
    && !(INVESTIGATE.test(withoutProhibitions(text)) && target)) {
    return {
      command: 'status', input: '', natural: true,
      capabilities: /\b(?:can|capab\w*|able|do\s+right\s+now|what\s+(?:is|does)\b)/i.test(text),
      // "your most recent verified investigation": the newest one that finished with evidence, not the newest job.
      verified: /\b(?:verified|successful(?:ly)?|succeeded|evidence)\b/i.test(text),
    };
  }
  return null;
}

function parseNaturalRea(text, { history = [] } = {}) {
  const npmNatural = text.match(/\b(reverse[- ]engineer|analy[sz]e|inspect|explain|debug|compare)\b[\s\S]{0,80}\b(?:npm package\b|npm:)/i);
  if (npmNatural) return { command: VERBS[npmNatural[1].toLowerCase().replace(/\s+/g, ' ')] || 'inspect', input: text };
  if (text.length > 600) return null;
  // Follow-ups about an earlier investigation; handleReaRequest drops them when there is none.
  const named = text.match(BUILD_NAMED);
  if (RECALL.test(text) || named || BUILD_THOSE.test(text)) {
    return { command: named || BUILD_THOSE.test(text) ? 'build' : 'recall', input: named ? named[1].trim() : '', natural: true, followup: true };
  }
  const wantsGap = GAP.test(text);
  const investigating = INVESTIGATE.test(text) || HOW_IT_WORKS.test(text);
  if (!investigating) return wantsGap ? { command: 'compare', input: '', natural: true, followup: true } : null;
  if (NOT_REA.test(text)) return null;
  const target = identifyTarget(text);
  const strongCue = wantsGap || HOW_IT_WORKS.test(text) || /\breverse[- ]engineer/i.test(text);
  const kindWord = /\b(?:app|application|website|site|web ?app|repo(?:sitory)?|software|project)\b/i.test(text);
  if (target && target.kind !== 'app_name' && target.kind !== 'private_app') return { command: 'inspect', input: text, natural: true, gap: wantsGap };
  if (target && (target.kind === 'private_app' || ((kindWord || strongCue) && !OWN_AREAS.test(target.name)))) {
    return { command: 'inspect', input: text, natural: true, gap: wantsGap };
  }
  if (PRONOUN_TARGET.test(text) || /\b(?:it|this|that)\b/i.test(text)) {
    const earlier = [...(Array.isArray(history) ? history : [])].reverse().filter((h) => h?.role === 'user').slice(0, 8)
      .map((h) => identifyTarget(String(h.content || ''))).find((t) => t && !['app_name', 'private_app'].includes(t.kind));
    if (earlier) return { command: 'inspect', input: earlier.url || (earlier.kind === 'npm' ? `npm:${earlier.name}@${earlier.version}` : ''), natural: true, gap: wantsGap, from_history: true };
    if (PRONOUN_TARGET.test(text) && (strongCue || /\bfeatures?\b/i.test(text))) return { command: 'inspect', input: '', natural: true, gap: wantsGap, ask: true };
  }
  return null;
}

// Public npm packages at one exact version only. Ranges and tags would let the bytes change.
export function parseReaTarget(text) {
  const value = String(text || '');
  const found = value.match(/\bnpm:\s*((?:@[^\s@/]+\/)?[^\s@/]+)@(\S+)/i)
    || value.match(/\bnpm\s+(?:package\s+)?((?:@[^\s@/]+\/)?[a-z0-9][\w.~@/-]*)\s+(?:version\s+|v)?(\S+)/i);
  if (!found) {
    return { ok: false, reason: 'Name one public npm package and its exact version, for example: REA inspect: npm:semver@7.7.2. Private files, links, devices and version ranges are not accepted in this version.' };
  }
  const name = found[1].toLowerCase();
  const version = found[2].replace(/[.,;:!?)]+$/, '');
  if (!NPM_NAME.test(name) || name.length > 214) return { ok: false, reason: `"${cleanText(name, 80)}" is not a valid npm package name.` };
  if (!EXACT_VERSION.test(version)) return { ok: false, reason: `Give one exact version of ${name}, such as ${name}@1.2.3. Ranges and tags are refused so the same bytes are always read.` };
  return { ok: true, kind: 'npm', name, version };
}

// The registry gives the sha512 of the exact tarball. The runner checks the download against it.
export async function resolveNpmPackage(name, version, fetcher = fetch) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  let response;
  try {
    response = await fetcher(url, { headers: { Accept: 'application/json', 'User-Agent': 'CHE-REA' } });
  } catch (_) {
    return { ok: false, reason: 'The npm registry did not answer, so nothing was analyzed.' };
  }
  if (!response.ok) {
    return { ok: false, reason: response.status === 404 ? `npm has no ${name}@${version}.` : 'The npm registry refused the lookup, so nothing was analyzed.' };
  }
  const data = await response.json().catch(() => null);
  const integrity = String(data?.dist?.integrity || '');
  if (!NPM_NAME.test(String(data?.name || '')) || !NPM_INTEGRITY.test(integrity)) {
    return { ok: false, reason: 'npm did not return a sha512 checksum for this version, so it cannot be verified.' };
  }
  return { ok: true, name: data.name, version: String(data.version || version), integrity, license: cleanText(data.license || 'license not stated', 60) };
}

export function reaCapabilities(env = {}) {
  const ready = reaConfigured(env);
  const github = ready ? '' : 'The GitHub connection (CHE_GITHUB_TOKEN and CHE_GITHUB_REPO) on the Worker.';
  return [
    { id: 'static_javascript', label: 'Static JavaScript and Electron analysis of public npm packages (REA 6.5.0)', available: ready, needs: github },
    { id: 'public_repositories', label: 'Public GitHub repositories: structure, frameworks, navigation, licence and features, cited by file and line (web, Flutter, Android and iOS source included)', available: true, needs: ready ? '' : 'Works without a connection at GitHub\'s low anonymous limit; code search needs the GitHub connection.' },
    { id: 'websites', label: 'Public web pages: layout, navigation, forms, accessibility and page markers (robots.txt respected; no sign-ins)', available: true, needs: '' },
    { id: 'website_browser', label: 'An isolated browser run of a public page: screenshots, menus, phone layout (GitHub Actions)', available: ready, needs: github },
    { id: 'app_store_listings', label: 'Public App Store listings: version, description and advertised features', available: true, needs: '' },
    // Comparing reads CHE's public tree, so it needs only the repository name; the token adds code search.
    { id: 'compare_with_che', label: 'Comparing findings with CHE\'s live repository and command catalog', available: /^[\w.-]+\/[\w.-]+$/.test(String(env.CHE_GITHUB_REPO || '').trim()), needs: /^[\w.-]+\/[\w.-]+$/.test(String(env.CHE_GITHUB_REPO || '').trim()) ? (ready ? '' : 'Works without a token; features whose names match no CHE file stay "not checked" until CHE_GITHUB_TOKEN enables code search.') : 'The repository name (CHE_GITHUB_REPO) on the Worker.' },
    { id: 'build_from_plan', label: 'Building an approved plan through CHE\'s coding job as a draft pull request', available: ready, needs: github },
    { id: 'native_binaries', label: 'Native binaries (Ghidra)', available: false, needs: 'An external analysis host with Ghidra and Java. None is set up, so nothing is run.' },
    { id: 'android_packages', label: 'Android APK files (apktool or jadx)', available: false, needs: 'A host with apktool or jadx. None is set up, so APKs are not opened.' },
    { id: 'ios_apps', label: 'Installed or downloaded iOS apps (IPA)', available: false, needs: 'App Store apps are encrypted per device; CHE does not decrypt them, and no macOS build host is set up.' },
    { id: 'runtime_capture', label: 'Running or watching installed software', available: false, needs: 'Not built. Each target would need your approval first.' },
    { id: 'owner_evidence', label: 'Screenshots or recordings you send', available: false, needs: 'Not built into REA yet; describe them in words or send a public link instead.' },
    { id: 'private_targets', label: 'Private repositories, sign-in pages and private files', available: false, needs: 'Refused: REA reads only what is public.' },
  ];
}

function newJobId(random = () => crypto.getRandomValues(new Uint8Array(4))) {
  const bytes = random();
  return `rea-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function decodeContent(encoded) {
  const binary = atob(String(encoded || '').replace(/\s+/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}

// Reads any finished record from the mailbox. A job with no record is still queued or running.
export async function refreshReaJobs(storage, env, now = Date.now(), fetcher = fetch) {
  const jobs = (await storage.get(REA_JOBS_KEY)) || [];
  let changed = false;
  for (const job of jobs) {
    if (job.state !== 'queued') continue;
    const found = await gh(env, 'GET', `/contents/${REA_RESULT_PREFIX}/${job.id}.json?ref=${encodeURIComponent(REA_RESULTS_REF)}`, null, fetcher);
    if (!found.ok) {
      if (found.status === 404 && now - Date.parse(job.created_at) > STALLED_AFTER_MS) {
        Object.assign(job, { state: 'stalled', error: 'No result after two hours. Check the GitHub Actions run for this job.', updated_at: new Date(now).toISOString() });
        changed = true;
      }
      continue;
    }
    let parsed = null;
    try { parsed = JSON.parse(decodeContent(found.data?.content)); } catch (_) { parsed = null; }
    const checked = validateReaSummary(parsed);
    if (!checked.ok || checked.summary.job_id !== job.id) {
      Object.assign(job, { state: 'failed', error: 'The result record did not pass the check, so it was not used.', updated_at: new Date(now).toISOString() });
      changed = true;
      continue;
    }
    if (checked.summary.state === 'complete') Object.assign(job, { state: 'complete', summary: checked.summary });
    else Object.assign(job, { state: 'failed', error: checked.summary.error });
    job.updated_at = new Date(now).toISOString();
    changed = true;
  }
  if (changed) await storage.put(REA_JOBS_KEY, jobs);
  return jobs;
}

const list = (items) => items.map((item, i) => `${i + 1}. ${item}`).join('\n');

function countsLine(s) {
  const n = (x) => (x == null ? 'not reported' : String(x));
  const c = s.coverage;
  const kinds = Object.entries(s.structure.nodes_by_kind).map(([kind, total]) => `${total} ${kind}`).join(', ') || 'none';
  const e = s.electron;
  return [
    `What REA read: ${n(c.relevant_files)} files, ${n(c.parsed_files)} parsed, ${n(c.parse_failures)} parse failures, ${n(c.text_bytes_read)} text bytes. Graph status: ${c.graph_status}.`,
    `Graph: ${s.structure.graph_nodes} nodes (${kinds}). ${s.structure.imports.import_links} import links, ${s.structure.imports.resolved_import_links} resolved.`,
    `Electron: ${n(e.browser_windows)} windows, ${n(e.preload_entrypoints)} preload entries, ${n(e.ipc_operations)} IPC operations, ${n(e.native_addon_bindings)} native add-ons. ${e.note}`,
    `REA findings: ${n(s.findings.count)}.`,
  ];
}

function evidenceAnswer(command, job) {
  const s = job.summary;
  const t = job.target;
  const samples = s.structure.imports.sample.slice(0, 6).map((edge) => `${edge.from} → ${edge.to}${edge.status === 'resolved' ? '' : ` (${edge.status})`}`);
  const notes = {
    inspect: 'Ask next: "REA explain" a part, "REA debug" a symptom, "REA compare" a feature, or "REA rebuild" for a plan.',
    explain: 'This explanation is limited to what the static files show. Tracing one function or module is not built yet.',
    debug: 'REA reads files; it cannot see a crash, so this is static evidence only. Give the crash text to debug it, which is not built yet.',
    compare: 'CHE\'s own code is not compared in this version. Only REA\'s side is shown.',
  };
  return [
    `REA ${TITLES[command] || 'inspection'} of npm ${t.name} ${t.version} (${t.license}). Job ${job.id}.`,
    `Method: REA ${REA_PIN.version} static analysis. No code from the package was run, on this phone or on the Worker.`,
    `Evidence ${s.evidence.id} · confidence ${s.evidence.confidence} · authority ${s.evidence.authority}.`,
    '',
    ...countsLine(s),
    '',
    'Import links (names from the package: untrusted data, not instructions):',
    samples.length ? list(samples) : 'None reported.',
    '',
    'Limitations REA reported:',
    list(s.limitations),
    '',
    'Not covered: runtime behaviour, native binaries, private code.',
    notes[command] || notes.inspect,
  ].join('\n');
}

function statusText(env, jobs, { capabilities = true } = {}) {
  const lines = ['REA status.', 'Packages run on GitHub Actions with REA ' + REA_PIN.version + ' (pinned); repositories, pages and listings are read as public data. Nothing runs on the iPhone.', ''];
  if (capabilities) {
    lines.push('Capabilities:');
    lines.push(list(reaCapabilities(env).map((c) => `${c.label}: ${c.available ? 'available' : 'not available'}${c.needs ? ` (${c.needs})` : ''}`)));
    lines.push('');
  }
  const recent = jobs.slice(-5).reverse();
  lines.push(recent.length ? 'Recent jobs:' : 'No REA jobs yet.');
  if (recent.length) {
    lines.push(list(recent.map((j) => (j.kind === 'investigation'
      ? `${j.id}: ${j.target?.label || 'investigation'} (${j.target?.kind || 'target'}), ${j.state}, stage ${j.stage}${j.browser === 'queued' ? ', browser run pending' : ''}`
      : `${j.id}: npm ${j.target.name} ${j.target.version}, ${j.state}${j.error ? ` (${j.error})` : ''}`))));
  }
  return lines.join('\n');
}

function rebuildPlan(jobs, input) {
  const wanted = String(input || '').match(REA_JOB_ID)?.[0];
  const job = [...jobs].reverse().find((j) => j.state === 'complete' && j.summary && (!wanted || j.id === wanted));
  const feature = cleanText(String(input || '').replace(REA_JOB_ID, '').trim(), 160) || 'the feature';
  if (!job) {
    return 'There is no completed REA evidence to plan from yet. Run "REA inspect: npm:<package>@<version>" first. Nothing was changed.';
  }
  const s = job.summary;
  return [
    `REA rebuild plan for ${feature}, based on job ${job.id} (npm ${job.target.name} ${job.target.version}, evidence ${s.evidence.id}).`,
    'Nothing was built and no coding job was started.',
    '',
    'Facts this plan may rely on (static evidence only):',
    list([
      `${s.structure.imports.resolved_import_links} of ${s.structure.imports.import_links} import links resolved.`,
      `${s.coverage.parsed_files ?? 'unknown'} files parsed, ${s.coverage.parse_failures ?? 'unknown'} parse failures.`,
    ]),
    '',
    'Plan:',
    list([
      'Write down each behaviour you want, and cite the REA fact it depends on.',
      'Write an original implementation. Do not copy the package\'s source.',
      'Write tests for each behaviour before merging, and confirm them at runtime, which REA does not do.',
    ]),
    '',
    `To build it, say: CHE, build ${feature} using REA job ${job.id}. That is a separate build step and needs your yes first. Merging and deploying need another yes.`,
  ].join('\n');
}

// ─── REA 2.0 investigations ──────────────────────────────────────────────

export const STAGES = Object.freeze([
  ['understand', 'Understand the target'], ['discover', 'Discover sources'], ['inspect', 'Inspect'], ['map', 'Map behaviour'],
  ['architecture', 'Analyze architecture'], ['compare', 'Compare with CHE'], ['plan', 'Plan'], ['build', 'Build'], ['test', 'Test'],
  ['review', 'Review'], ['integrate', 'Integrate'], ['verify', 'Verify'], ['remember', 'Remember'],
]);
const STAGE_IDS = STAGES.map(([id]) => id);
const DETAIL_LIMIT = 100_000;
const FOLLOWUP_WINDOW_MS = 6 * 3600_000;

const detailKey = (id) => `${REA_DETAIL_PREFIX}${id}`;
const iso = (now) => new Date(now).toISOString();
const linkOf = (label, url) => ({ label: cleanText(label, 160), url: String(url || '').slice(0, 500) });

function freshStages() {
  return STAGES.map(([id, label]) => ({ id, label, state: 'pending', note: '' }));
}

function setStage(inv, id, state, note = '', now = Date.now()) {
  const stage = inv.stages.find((s) => s.id === id);
  if (!stage) return;
  stage.state = state;
  stage.note = cleanText(note, 300);
  inv.stage = id;
  inv.updated_at = iso(now);
}

export async function loadInvestigation(storage, id) {
  if (!REA_JOB_ID.test(String(id || ''))) return null;
  return (await storage.get(detailKey(id))) || null;
}

async function saveInvestigation(storage, inv) {
  // Trim the largest lists until the record fits one storage value.
  let record = inv;
  for (let i = 0; JSON.stringify(record).length > DETAIL_LIMIT && i < 4; i++) {
    record = { ...record, features: record.features.slice(0, Math.max(4, record.features.length - 4)).map((f) => ({ ...f, evidence: f.evidence.slice(0, 3) })), architecture: record.architecture.slice(0, 12), facts: undefined };
  }
  await storage.put(detailKey(record.id), record);
  const jobs = (await storage.get(REA_JOBS_KEY)) || [];
  const entry = {
    id: record.id, kind: 'investigation', command: 'inspect', target: record.target, state: record.state, stage: record.stage,
    cache_key: record.cache_key, created_at: record.created_at, updated_at: record.updated_at,
    ...(record.browser?.state === 'queued' ? { browser: 'queued' } : {}),
    ...(record.build?.job_id && !['complete', 'failed'].includes(record.build.state) && !VERIFIED_STATES.includes(record.verification?.state) ? { build_pending: true } : {}),
  };
  const next = jobs.filter((j) => j.id !== record.id);
  next.push(entry);
  await storage.put(REA_JOBS_KEY, next.slice(-JOB_LOG_LIMIT));
  return record;
}

// The investigation the owner means: an explicit job id, a target name, or the latest.
async function resolveInvestigation(storage, jobs, input = '') {
  const wanted = String(input || '').match(/rea-[0-9a-f]{8}/)?.[0];
  const list = [...jobs].reverse().filter((j) => j.kind === 'investigation');
  const words = String(input || '').toLowerCase().replace(/rea-[0-9a-f]{8}/, '').split(/[^a-z0-9.]+/).filter((w) => w.length >= 3);
  const pick = wanted ? list.find((j) => j.id === wanted)
    : list.find((j) => words.some((w) => String(j.target?.label || '').toLowerCase().includes(w))) || list[0];
  return pick ? loadInvestigation(storage, pick.id) : null;
}

function targetLabel(target, facts = {}) {
  if (target.kind === 'github') return facts.full_name || target.full_name;
  if (target.kind === 'website') return facts.host || (() => { try { return new URL(target.url).host; } catch (_) { return target.url; } })();
  if (target.kind === 'app_store') return facts.listing?.name || `App Store app ${target.id}`;
  if (target.kind === 'private_app') return target.name ? `${target.name} (${target.platform === 'android' ? 'Android' : 'iOS'} app)` : 'a private app';
  return target.name || target.url || 'the target';
}

function newInvestigation(id, target, now) {
  return {
    id, target: { kind: target.kind, label: targetLabel(target), url: target.url || '', version: '', ...(target.kind === 'app_name' ? { requested: String(target.name || '').slice(0, 80) } : {}) },
    state: 'running', stage: 'understand', stages: freshStages(), created_at: iso(now), updated_at: iso(now),
    sources: [], screenshots: [], features: [], architecture: [], comparison: null, proposals: [], plan: null,
    build: null, verification: null, limitations: [], cache_key: '', browser: null, attempts: 1,
  };
}

const transient = (status) => !status || status >= 500 || status === 429 || status === 403;

// Discover and inspect one target. Returns the stored investigation.
async function runInvestigation(storage, env, inv, target, { fetcher, now, feature = '' }) {
  setStage(inv, 'understand', 'done', `Target: ${inv.target.label} (${target.kind}).`, now);
  let facts = null;
  // Discover: a bare name is matched to a public repository and App Store listing.
  if (target.kind === 'app_name' || target.kind === 'private_app') {
    const [repos, store] = await Promise.all([
      searchPublicRepos(env, target.name, fetcher).catch(() => ({ ok: false, repos: [] })),
      lookupAppStore({ name: target.name }, fetcher).catch(() => ({ ok: false })),
    ]);
    if (store.ok) inv.sources.push(linkOf(`App Store: ${store.listing.name} by ${store.listing.seller}`, store.listing.url));
    // Only a repository named exactly like the app is taken as it: a similar name is often an
    // unrelated project, so it is offered as a numbered choice and never picked silently.
    const repo = repos.repos?.find((r) => r.exact) || null;
    const similar = (repos.repos || []).filter((r) => !r.exact).slice(0, 4);
    if (target.kind === 'private_app') {
      inv.state = 'limited';
      inv.limitations.push(...PRIVATE_APP_LIMITS);
      inv.alternatives = [...PRIVATE_APP_ALTERNATIVES];
      if (store.ok) {
        facts = { kind: 'app_store', listing: store.listing };
        inv.target.version = store.listing.version;
      }
      if (repo && repo.exact) inv.alternatives.push(`A public repository with the same name exists (${repo.full_name}); say "investigate the GitHub repository ${repo.full_name}" if it is the same app.`);
      for (const l of (store.candidates || []).slice(0, 2)) inv.alternatives.push(`The App Store has ${cleanText(l.name, 60)} by ${cleanText(l.seller, 40)}, a similar name that is not confirmed to be this app: ${l.url}`);
      setStage(inv, 'discover', store.ok ? 'done' : 'blocked', store.ok ? 'Public App Store listing found; the app itself is not reachable.' : store.candidates?.length ? 'No App Store listing has exactly this name; similar ones are listed, not used. The app itself is not reachable.' : 'No public listing found; the app itself is not reachable.', now);
      setStage(inv, 'inspect', 'blocked', 'The binary, source, private APIs and sandbox data are not accessible to CHE.', now);
    } else if (repo) {
      inv.sources.push(linkOf(`GitHub: ${repo.full_name} (${repo.stars} stars)`, `https://github.com/${repo.full_name}`));
      if (repo.homepage) inv.sources.push(linkOf(`Website: ${repo.homepage}`, repo.homepage));
      inv.candidates = (repos.repos || []).slice(0, 4).map((r) => `${r.full_name} (${r.stars} stars)`);
      target = { kind: 'github', full_name: repo.full_name, url: `https://github.com/${repo.full_name}` };
      inv.target = { ...inv.target, kind: 'github', url: target.url };
      setStage(inv, 'discover', 'done', `Matched to the public repository ${repo.full_name}.`, now);
    } else if (store.ok) {
      target = { kind: 'app_store', id: store.listing.id, url: store.listing.url };
      inv.target = { ...inv.target, kind: 'app_store', url: store.listing.url };
      if (similar.length) inv.alternatives = similar.map((r) => `${r.full_name} (${r.stars} stars) has a similar name but is not confirmed to be this app; say "investigate the GitHub repository ${r.full_name}" if it is.`);
      setStage(inv, 'discover', 'done', 'No public repository has this exact name; the public App Store listing is the source.', now);
    } else if (similar.length || store.candidates?.length) {
      inv.state = 'needs_choice';
      const choices = [
        ...similar.map((r) => ({ label: `GitHub repository ${r.full_name} (${r.stars} stars)`, url: `https://github.com/${r.full_name}` })),
        ...(store.candidates || []).map((l) => ({ label: `App Store: ${cleanText(l.name, 60)} by ${cleanText(l.seller, 40)}`, url: l.url })),
      ].filter((c) => c.url).slice(0, 4);
      inv.candidates = choices.map((c) => c.label);
      inv.candidate_targets = choices.map((c) => c.url);
      setStage(inv, 'discover', 'blocked', `No public repository or App Store listing is named exactly "${cleanText(target.name, 60)}", so none was picked.`, now);
      return saveInvestigation(storage, inv);
    } else {
      inv.state = 'failed';
      const why = repos.ok === false && repos.status ? `GitHub search answered ${repos.status}` : 'no public repository or App Store listing matched';
      setStage(inv, 'discover', 'failed', `Could not identify "${cleanText(target.name, 60)}": ${why}. Give me a link or a repository name.`, now);
      inv.retryable = transient(repos.status);
      return saveInvestigation(storage, inv);
    }
  } else {
    if (target.url) inv.sources.push(linkOf(target.kind === 'github' ? `GitHub: ${target.full_name}` : target.url, target.url));
    setStage(inv, 'discover', 'done', 'The target is a public link.', now);
  }

  if (inv.state !== 'limited') {
    if (target.kind === 'github') facts = await inspectGithubRepo(env, target.full_name, { feature }, fetcher);
    else if (target.kind === 'website') facts = await inspectWebsite(target.url, fetcher);
    else if (target.kind === 'app_store') {
      const store = await lookupAppStore({ id: target.id }, fetcher);
      facts = store.ok ? { ok: true, kind: 'app_store', listing: store.listing } : { ok: false, reason: store.reason };
    } else if (target.kind === 'play_store') {
      facts = { ok: false, refused: true, reason: 'Google Play listings are not read yet. Give me the app\'s website or its public source repository instead.' };
    }
    if (!facts?.ok) {
      inv.state = facts?.refused ? 'limited' : 'failed';
      inv.retryable = !facts?.refused && transient(facts?.status);
      inv.limitations.push(cleanText(facts?.reason || 'Nothing could be read.', 300));
      setStage(inv, 'inspect', facts?.refused ? 'blocked' : 'failed', facts?.reason || 'Nothing could be read.', now);
      return saveInvestigation(storage, inv);
    }
    inv.target.version = facts.sha || facts.listing?.version || (facts.content_sha256 ? `page ${facts.content_sha256.slice(0, 12)}` : '');
    inv.target.label = targetLabel(target, facts);
    if (facts.kind === 'github') {
      inv.cache_key = `github:${facts.full_name.toLowerCase()}@${facts.sha}`;
      if (facts.homepage && !inv.sources.some((x) => x.url === facts.homepage)) inv.sources.push(linkOf(`Website: ${facts.homepage}`, facts.homepage));
      setStage(inv, 'inspect', 'done', `Read ${facts.full_name} at ${facts.sha.slice(0, 12)}: ${facts.file_count} files listed, ${facts.reads} read.`, now);
    } else if (facts.kind === 'website') {
      inv.cache_key = `website:${facts.final_url}#${facts.content_sha256}`;
      setStage(inv, 'inspect', 'done', `Read ${facts.final_url} once (${facts.bytes} bytes).`, now);
    } else {
      inv.cache_key = `app_store:${facts.listing.id}@${facts.listing.version}`;
      inv.sources.push(linkOf(`App Store: ${facts.listing.name}`, facts.listing.url));
      setStage(inv, 'inspect', 'done', 'Read the public App Store listing.', now);
    }
  }
  if (facts?.kind || facts?.listing) {
    const map = buildFeatureMap(facts.kind ? facts : { kind: 'app_store', ...facts }, { feature });
    inv.features = map.features;
    inv.architecture = map.architecture;
    inv.limitations.push(...map.limitations);
    setStage(inv, 'map', 'done', `${map.features.length} features mapped, each with its evidence.`, now);
    setStage(inv, 'architecture', 'done', `${map.architecture.filter((a) => a.kind === 'observed').length} observed, ${map.architecture.filter((a) => a.kind === 'inferred').length} inferred, ${map.architecture.filter((a) => a.kind === 'unknown').length} unknown.`, now);
  }
  if (inv.state === 'running') inv.state = 'complete';
  // The isolated browser run adds screenshots and interactions for a web page.
  if (target.kind === 'website' && inv.state === 'complete' && reaConfigured(env)) {
    const sent = await gh(env, 'POST', `/actions/workflows/${encodeURIComponent(REA_WEB_WORKFLOW)}/dispatches`, { ref: REA_WORKFLOW_REF, inputs: { job_id: inv.id, url: facts.final_url } }, fetcher);
    inv.browser = sent.ok ? { state: 'queued', requested_at: iso(now) } : { state: 'failed', error: `GitHub did not start the browser run (status ${sent.status || 'none'}${sent.data?.message ? `: ${cleanText(sent.data.message, 120)}` : ''}).` };
    // A browser run that never started is said, never left as a silent wait for screenshots.
    if (!sent.ok) inv.limitations.push(`Browser run: ${inv.browser.error}`);
  }
  setStage(inv, 'remember', 'done', 'Saved to the investigation log and CHE\'s memory.', now);
  inv.stage = 'architecture';
  return saveInvestigation(storage, inv);
}

// A finished browser run is folded into its investigation once.
async function refreshBrowser(storage, env, inv, fetcher, now) {
  if (inv?.browser?.state !== 'queued') return inv;
  const found = await gh(env, 'GET', `/contents/${REA_RESULT_PREFIX}/${inv.id}.json?ref=${encodeURIComponent(REA_RESULTS_REF)}`, null, fetcher);
  if (!found.ok) {
    if (found.status === 404 && now - Date.parse(inv.browser.requested_at) > STALLED_AFTER_MS) {
      inv.browser = { state: 'stalled', error: 'The browser run published nothing within two hours.' };
      return saveInvestigation(storage, inv);
    }
    return inv;
  }
  let parsed = null;
  try { parsed = JSON.parse(decodeContent(found.data?.content)); } catch (_) { parsed = null; }
  const checked = validateWebSummary(parsed);
  if (!checked.ok || checked.summary.job_id !== inv.id) {
    inv.browser = { state: 'failed', error: 'The browser record did not pass the check, so it was not used.' };
    return saveInvestigation(storage, inv);
  }
  const w = checked.summary;
  if (w.state !== 'complete') {
    inv.browser = { state: w.state === 'refused' ? 'refused' : 'failed', error: cleanText(w.error || 'The browser run did not finish.', 300) };
    inv.limitations.push(`Browser run: ${inv.browser.error}`);
    return saveInvestigation(storage, inv);
  }
  inv.browser = { state: 'complete', observed_at: w.observed_at };
  inv.screenshots = (w.screenshots || []).map((x) => ({ label: x.label === 'mobile' ? 'Phone width (390 px)' : 'Desktop width (1280 px)', file: x.file }));
  for (const step of (w.interactions || []).slice(0, 5)) {
    inv.architecture.push({ label: `Browser: ${cleanText(step.action, 30)}`, detail: cleanText(`${step.target}: ${step.observed}`, 300), kind: 'observed', evidence: [linkOf(w.target?.final_url || inv.target.url, w.target?.final_url || inv.target.url)] });
  }
  if (w.responsive) inv.architecture.push({ label: 'Phone layout (browser run)', detail: `${w.responsive.mobile_horizontal_overflow ? 'Scrolls sideways at 390 px' : 'Fits 390 px'}; ${w.responsive.mobile_nav_toggle ? 'has a menu toggle' : 'no menu toggle'}.`, kind: 'observed', evidence: [] });
  if (w.page?.load_ms != null) inv.architecture.push({ label: 'Load time (browser run)', detail: `${w.page.load_ms} ms on a GitHub runner, ${w.page.console_errors ?? 0} console errors.`, kind: 'observed', evidence: [] });
  // What only the browser saw joins the feature map: new features get the next ids (earlier
  // ids, and the plans that name them, stay valid) and known ones gain the browser evidence.
  let added = 0;
  for (const f of browserFeatures(w)) {
    const known = inv.features.find((x) => x.kind === f.kind);
    if (known) {
      for (const e of f.evidence) if (known.evidence.length < 6 && !known.evidence.some((x) => x.label === e.label)) known.evidence.push(e);
    } else if (inv.features.length < 16) {
      const next = Math.max(0, ...inv.features.map((x) => Number(String(x.id).slice(1)) || 0)) + 1;
      inv.features.push({ ...f, id: `f${next}` });
      added += 1;
    }
  }
  if (added && inv.comparison) inv.limitations.push(`The browser run found ${added} more ${added === 1 ? 'feature' : 'features'} after the comparison; ask "REA compare" to check ${added === 1 ? 'it' : 'them'} against CHE.`);
  inv.limitations.push(...(w.limitations || []).slice(0, 4).map((l) => `Browser run: ${l}`));
  return saveInvestigation(storage, inv);
}

// A build's coding job and pull request, read from CHE's own job log and GitHub.
// Background reads (the investigations list and detail) leave a finished verification alone
// and re-read a pending one at most every VERIFY_RECHECK_MS; "REA verify" (force) always reads.
async function refreshBuild(storage, env, inv, { jobLookup, fetcher, now, force = false }) {
  if (!inv?.build?.job_id) return inv;
  const checked = Date.parse(inv.verification?.checked_at || '') || 0;
  if (!force && (VERIFIED_STATES.includes(inv.verification?.state) || (checked && now - checked < VERIFY_RECHECK_MS))) return inv;
  const job = jobLookup ? await Promise.resolve(jobLookup(inv.build.job_id)).catch(() => null) : null;
  if (job) {
    const text = `${job.result || ''} ${job.owner_message || ''}`;
    const pr = Number(text.match(/\/pull\/(\d+)/)?.[1] || text.match(/(?:pull request|PR)\s*#?(\d+)/i)?.[1] || 0);
    inv.build.state = job.status === 'complete' ? (pr ? 'pr_open' : 'complete') : job.status === 'failed' || job.dead_letter ? 'failed' : job.status;
    if (pr) Object.assign(inv.build, { pr_number: pr, pr_url: `https://github.com/${env.CHE_GITHUB_REPO}/pull/${pr}` });
    inv.build.note = cleanText(job.error || job.owner_message || job.result || '', 300);
    setStage(inv, 'build', inv.build.state === 'failed' ? 'failed' : pr || job.status === 'complete' ? 'done' : 'running', inv.build.note || `Coding job ${String(inv.build.job_id).slice(0, 8)} is ${job.status}.`, now);
    if (job.status === 'complete' && pr) setStage(inv, 'review', 'done', 'CHE\'s coding job reviewed the change before opening the pull request.', now);
  }
  if (inv.build.pr_number) {
    const result = await verifyBuild(env, inv.build.pr_number, fetcher);
    inv.verification = { state: result.state, checks: result.checks, note: result.note, checked_at: new Date(now).toISOString() };
    setStage(inv, 'test', result.state === 'passed' ? 'done' : result.state === 'failed' ? 'failed' : 'running', result.note, now);
    setStage(inv, 'integrate', 'pending', 'Merging and deploying need your separate yes.', now);
    setStage(inv, 'verify', result.state === 'passed' ? 'done' : result.state === 'failed' ? 'failed' : 'running', 'Checked against the pull request\'s CI and changed tests; not verified on the iPhone.', now);
  }
  return saveInvestigation(storage, inv);
}

export async function refreshInvestigations(storage, env, { fetcher = fetch, now = Date.now(), jobLookup = null } = {}) {
  const jobs = (await storage.get(REA_JOBS_KEY)) || [];
  for (const entry of jobs.filter((j) => j.kind === 'investigation' && (j.browser === 'queued' || j.build_pending)).slice(-5)) {
    let inv = await loadInvestigation(storage, entry.id);
    if (!inv) continue;
    if (inv.browser?.state === 'queued' && reaConfigured(env)) inv = await refreshBrowser(storage, env, inv, fetcher, now);
    if (inv.build?.job_id) await refreshBuild(storage, env, inv, { jobLookup, fetcher, now });
  }
}

// ─── Views (the iPhone REA screen reads these) ───────────────────────────

function npmView(job) {
  const s = job.summary;
  const map = s ? buildFeatureMap({ kind: 'npm', name: job.target.name, version: job.target.version, license: job.target.license, summary: s }) : { architecture: [], limitations: [] };
  const done = job.state === 'complete';
  return {
    id: job.id, target: { kind: 'npm', label: `npm ${job.target.name} ${job.target.version}`, url: `https://www.npmjs.com/package/${job.target.name}/v/${job.target.version}`, version: job.target.version },
    state: job.state === 'queued' ? 'queued' : job.state, stage: done ? 'architecture' : 'inspect',
    stages: STAGES.map(([id, label], i) => ({ id, label, state: done ? (i <= 4 ? 'done' : 'pending') : i < 2 ? 'done' : i === 2 ? (job.state === 'queued' ? 'running' : 'failed') : 'pending', note: i === 2 && job.error ? cleanText(job.error, 200) : '' })),
    created_at: job.created_at, updated_at: job.updated_at || job.created_at,
    sources: [linkOf(`npm ${job.target.name}@${job.target.version}`, `https://www.npmjs.com/package/${job.target.name}/v/${job.target.version}`)],
    screenshots: [], features: [], architecture: map.architecture, comparison: null, proposals: [], plan: null, build: null, verification: null,
    limitations: done ? map.limitations : job.error ? [cleanText(job.error, 300)] : [],
  };
}

export function investigationView(inv) {
  if (!inv) return null;
  const pick = (f) => ({
    id: f.id, name: f.name, purpose: f.purpose, user_sees: f.user_sees, operated_by: f.operated_by, inputs: f.inputs || [], outputs: f.outputs || [],
    components: f.components || [], dependencies: f.dependencies || [], evidence: f.evidence || [], unknowns: f.unknowns || [],
    complexity: f.complexity, cost: f.cost, che: { status: f.che?.status || 'unknown', evidence: f.che?.evidence || [] }, feasible: f.feasible || { ok: false, note: '' },
  });
  return {
    id: inv.id, target: inv.target, state: inv.state, stage: inv.stage, stages: inv.stages, created_at: inv.created_at, updated_at: inv.updated_at,
    sources: inv.sources, screenshots: inv.screenshots || [], features: (inv.features || []).map(pick), architecture: inv.architecture || [],
    comparison: inv.comparison, proposals: inv.proposals || [], plan: inv.plan ? { features: inv.plan.features, steps: inv.plan.steps, acceptance: inv.plan.acceptance, approved: Boolean(inv.plan.approved) } : null,
    build: inv.build ? { job_id: inv.build.job_id, state: inv.build.state, pr_number: inv.build.pr_number || null, pr_url: inv.build.pr_url || '', note: inv.build.note || '' } : null,
    verification: inv.verification, limitations: [...new Set(inv.limitations || [])].slice(0, 12), alternatives: inv.alternatives || [],
    browser: inv.browser ? { state: inv.browser.state, error: inv.browser.error || '' } : null,
    // A name with no exact match: the numbered sources the owner can choose from (state needs_choice).
    choices: inv.state === 'needs_choice' ? (inv.candidates || []).map((label, i) => ({ number: i + 1, label, url: inv.candidate_targets?.[i] || '' })).filter((c) => c.url) : [],
  };
}

export async function reaInvestigations(storage, env, opts = {}) {
  await refreshReaJobs(storage, env, opts.now, opts.fetcher).catch(() => null);
  await refreshInvestigations(storage, env, opts).catch(() => null);
  const jobs = (await storage.get(REA_JOBS_KEY)) || [];
  const out = [];
  for (const job of [...jobs].reverse()) {
    if (job.kind === 'investigation') {
      const view = investigationView(await loadInvestigation(storage, job.id));
      if (view) out.push(view);
    } else if (job.target?.name) out.push(npmView(job));
  }
  return { investigations: out, capabilities: reaCapabilities(env) };
}

export async function reaInvestigationDetail(storage, env, id, opts = {}) {
  const all = await reaInvestigations(storage, env, opts);
  return all.investigations.find((i) => i.id === id) || null;
}

// ─── Spoken answers ──────────────────────────────────────────────────────

const statusWord = { has: 'CHE has it', partial: 'CHE partly has it', missing: 'CHE lacks it', unknown: 'not checked' };

function investigationAnswer(inv, { reused = false } = {}) {
  const lines = [];
  if (inv.state === 'limited') {
    lines.push(`I can't inspect ${inv.target.label} itself, sir. Investigation ${inv.id}.`, '', 'What is not available to me:', list(inv.limitations.slice(0, 5)));
    if (inv.features.length) lines.push('', `What its public listing shows (${inv.features.length}):`, list(inv.features.slice(0, 6).map((f) => `${f.name}: ${f.evidence[0]?.label || 'listing'}`)));
    if (inv.alternatives?.length) lines.push('', 'What I can do instead:', list(inv.alternatives));
    lines.push('', 'I did not claim anything about its internals.');
    return lines.join('\n');
  }
  if (inv.state === 'needs_choice') {
    return [
      `No public repository or App Store listing is named exactly "${inv.target.label}", so I did not guess which one you mean, sir. Investigation ${inv.id}.`,
      'Sources with similar names:', list(inv.candidates || []),
      'Say the number of the one you mean, or give me its link. Nothing was read from any of them yet.',
    ].join('\n');
  }
  if (inv.state === 'failed') {
    const failed = inv.stages.find((s) => s.state === 'failed');
    const why = String(failed?.note || 'nothing could be read').replace(/[.\s]*$/, '.');
    return `REA investigation ${inv.id} of ${inv.target.label} failed at "${failed?.label || inv.stage}": ${why}${inv.retryable ? ' Ask me again and I will continue this same investigation.' : ''} Nothing was changed.`;
  }
  const t = inv.target;
  lines.push(`${reused ? 'Reusing my investigation' : 'REA investigation'} ${inv.id} of ${t.label}${t.version ? ` (${t.kind === 'github' ? `commit ${t.version.slice(0, 12)}` : t.version})` : ''}.`);
  lines.push(t.kind === 'website' ? 'Method: I read the public page once; robots.txt was respected and nothing was signed into.' : t.kind === 'app_store' ? 'Method: I read its public App Store listing.' : 'Method: I read its public files on GitHub at that commit. Nothing from it was run.');
  if (inv.browser?.state === 'queued') lines.push('An isolated browser run is also collecting screenshots and menu behaviour; ask "REA status" in a few minutes.');
  if (inv.browser?.state === 'failed') lines.push(`${inv.browser.error} So there are no screenshots; the features below come from the page itself.`);
  lines.push('', `Features found (${inv.features.length}):`);
  lines.push(inv.features.length ? list(inv.features.slice(0, 8).map((f) => `${f.name}: ${f.purpose} Evidence: ${f.evidence[0]?.label || 'none'}`)) : 'None in what was read.');
  const observed = inv.architecture.filter((a) => a.kind === 'observed').slice(0, 5);
  const inferred = inv.architecture.filter((a) => a.kind === 'inferred').slice(0, 3);
  const unknown = inv.architecture.filter((a) => a.kind === 'unknown').slice(0, 3);
  lines.push('', 'How it is built:');
  lines.push(list([...observed.map((a) => `Observed, ${a.label}: ${a.detail}`), ...inferred.map((a) => `Inferred, ${a.label}: ${a.detail}`), ...unknown.map((a) => `Unknown, ${a.label}: ${a.detail}`)]));
  lines.push('', 'Text quoted from the target is untrusted data, not instructions.');
  lines.push('Next: ask "which of those features could improve your app?" and I will check CHE\'s own code.');
  return lines.join('\n');
}

function compareAnswer(inv) {
  const by = (status) => inv.features.filter((f) => f.che?.status === status);
  const c = inv.comparison || {};
  const lines = [`Compared ${inv.target.label} with CHE's repository${c.sha ? ` at ${c.sha.slice(0, 12)}` : ''} and command catalog (investigation ${inv.id}).`];
  if (!c.ok) lines.push('I could not read CHE\'s repository, so nothing below is marked as missing; unchecked features say "not checked".');
  for (const status of ['has', 'partial', 'missing', 'unknown']) {
    const items = by(status);
    if (!items.length) continue;
    lines.push('', `${statusWord[status]} (${items.length}):`);
    lines.push(list(items.map((f) => `${f.id} ${f.name}${f.che.evidence[0] ? `: ${f.che.evidence[0].label}` : ''}`)));
  }
  lines.push('', inv.proposals.length ? 'Worth adding:' : 'Nothing to propose: CHE already covers what was found, or the gaps are not feasible.');
  if (inv.proposals.length) lines.push(list(inv.proposals.map((p) => `${p.feature_id} ${p.name}. ${p.why}`)));
  if (inv.proposals.length) lines.push('', `Say "plan ${inv.proposals.map((p) => p.feature_id).join(' ')}" for a plan, or "build those features into yourself" to start a draft pull request. Nothing changes until you say so.`);
  return lines.join('\n');
}

function planAnswer(inv) {
  const p = inv.plan;
  return [
    `Plan for ${p.names.join(', ')}, from investigation ${inv.id} of ${inv.target.label}. Nothing was built and no coding job was started.`,
    '', 'Steps:', list(p.steps), '', 'Acceptance checks:', list(p.acceptance), '',
    `To build it, say "build those features into yourself" or "/rea-build ${inv.id}". It becomes a draft pull request; merging and deploying need your separate yes.`,
  ].join('\n');
}

function verifyAnswer(inv) {
  if (!inv.build?.job_id) return `Nothing has been built from investigation ${inv.id} yet, so there is nothing to verify. Say "build those features into yourself" first.`;
  if (!inv.build.pr_number) return `Coding job ${String(inv.build.job_id).slice(0, 8)} for investigation ${inv.id} is ${inv.build.state}, and it has not opened a pull request yet, so nothing is verified.${inv.build.note ? ` Latest: ${inv.build.note}` : ''}`;
  const v = inv.verification || { state: 'pending', checks: [], note: '' };
  return [
    `Verification of ${inv.plan?.names?.join(', ') || 'the build'} (investigation ${inv.id}): ${v.state}.`, v.note,
    v.checks.length ? list(v.checks.map((x) => `${x.name}: ${x.state}`)) : '',
    'Acceptance checks to confirm:', list(inv.plan?.acceptance || []),
  ].filter(Boolean).join('\n');
}

function capabilitiesText(env) {
  return ['What REA can and cannot analyze right now:', list(reaCapabilities(env).map((c) => `${c.label}: ${c.available ? 'available' : 'not available'}${c.needs ? ` (${c.needs})` : ''}`))].join('\n');
}

async function rememberInvestigation(remember, inv) {
  if (!remember || inv.state === 'failed') return;
  const body = [
    `REA investigation ${inv.id} of ${inv.target.label} (${inv.target.kind}${inv.target.version ? `, ${inv.target.version.slice(0, 40)}` : ''}) on ${inv.created_at.slice(0, 10)}.`,
    `Sources: ${inv.sources.map((s) => s.url).filter(Boolean).slice(0, 4).join(', ') || 'none'}.`,
    `Features: ${inv.features.map((f) => `${f.id} ${f.name}${f.che?.status && f.che.status !== 'unknown' ? ` (${f.che.status} in CHE)` : ''}`).join('; ') || 'none found'}.`,
    inv.plan ? `Plan: ${inv.plan.names.join(', ')}.` : '',
    inv.build?.pr_number ? `Build: pull request #${inv.build.pr_number}.` : inv.build?.job_id ? `Build: coding job ${String(inv.build.job_id).slice(0, 8)}.` : '',
    `Limitations: ${(inv.limitations || []).slice(0, 2).join(' ')}`,
  ].filter(Boolean).join('\n');
  await Promise.resolve(remember({ id: `rea:${inv.id}`, kind: 'rea_investigation', title: `REA: ${inv.target.label}`, body, at: inv.created_at })).catch(() => null);
}

// Is a recorded investigation still the current version of its target?
async function stillCurrent(env, inv, fetcher) {
  if (inv.target.kind !== 'github' || !/^[0-9a-f]{40}$/.test(inv.target.version)) return { current: true, note: '' };
  const full = inv.target.label;
  try {
    const head = await fetcher(`https://api.github.com/repos/${full}/commits/HEAD`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CHE-REA', ...(env.CHE_GITHUB_TOKEN ? { Authorization: `Bearer ${env.CHE_GITHUB_TOKEN}` } : {}) } }).then((r) => (r.ok ? r.json() : null));
    if (!head?.sha) return { current: true, note: 'I could not check whether it changed since.' };
    return head.sha === inv.target.version ? { current: true, note: `${full} has not changed since (${head.sha.slice(0, 7)}).` } : { current: false, note: `${full} has new commits since (now ${head.sha.slice(0, 7)}); the findings are from ${inv.target.version.slice(0, 7)}.` };
  } catch (_) {
    return { current: true, note: 'I could not check whether it changed since.' };
  }
}

async function startOrReuse(storage, env, jobs, target, opts) {
  const { fetcher, now, random, feature } = opts;
  // A failed investigation of the same target continues under its own id.
  const sameTarget = [...jobs].reverse().find((j) => j.kind === 'investigation' && (j.target?.url || '') === (target.url || '') && String(j.target?.label || '').toLowerCase() === String(targetLabel(target)).toLowerCase());
  const earlier = sameTarget ? await loadInvestigation(storage, sameTarget.id) : null;
  if (earlier && earlier.state === 'failed' && earlier.retryable) {
    earlier.attempts = Number(earlier.attempts || 1) + 1;
    earlier.state = 'running';
    for (const st of earlier.stages) if (st.state === 'failed') { st.state = 'pending'; st.note = `Retry ${earlier.attempts}.`; }
    earlier.limitations = [];
    return { inv: await runInvestigation(storage, env, earlier, target, { fetcher, now, feature }), resumed: true };
  }
  // GitHub targets are reused when the commit is the same, so no file is read twice. An app
  // name that an earlier investigation resolved to a repository is the same target: one HEAD
  // read, instead of the search and the whole repository again.
  const headOf = (full) => fetcher(`https://api.github.com/repos/${full}/commits/HEAD`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CHE-REA', ...(env.CHE_GITHUB_TOKEN ? { Authorization: `Bearer ${env.CHE_GITHUB_TOKEN}` } : {}) } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const full = target.kind === 'github' ? target.full_name.toLowerCase()
    : target.kind === 'app_name' ? ([...jobs].reverse().find((j) => j.kind === 'investigation' && j.state === 'complete' && String(j.target?.requested || '').toLowerCase() === String(target.name || '').toLowerCase() && j.cache_key?.startsWith('github:'))?.cache_key || '').slice('github:'.length).split('@')[0]
      : '';
  if (full && !feature) {
    const recent = [...jobs].reverse().filter((j) => j.kind === 'investigation' && j.state === 'complete' && j.cache_key?.startsWith(`github:${full}@`));
    if (recent.length) {
      const head = await headOf(full);
      const hit = head?.sha && recent.find((j) => j.cache_key === `github:${full}@${head.sha}`);
      if (hit) return { inv: await loadInvestigation(storage, hit.id), reused: true };
    }
  }
  if (target.kind === 'website') {
    const fresh = [...jobs].reverse().find((j) => j.kind === 'investigation' && j.state === 'complete' && j.target?.url === target.url && now - Date.parse(j.updated_at || 0) < 24 * 3600_000);
    if (fresh) return { inv: await loadInvestigation(storage, fresh.id), reused: true };
  }
  const inv = newInvestigation(newJobId(random), target, now);
  return { inv: await runInvestigation(storage, env, inv, target, { fetcher, now, feature }) };
}

async function compareInvestigation(storage, env, inv, fetcher, now) {
  setStage(inv, 'compare', 'running', 'Checking CHE\'s repository.', now);
  const result = await compareWithChe(env, inv.features, fetcher);
  inv.comparison = { ...result.counts, ok: result.ok, sha: result.sha };
  inv.proposals = proposeImprovements(inv.features);
  setStage(inv, 'compare', result.ok ? 'done' : 'failed', result.ok ? `CHE has ${result.counts.has}, partly ${result.counts.partial}, lacks ${result.counts.missing}.` : 'CHE\'s repository could not be read; nothing was marked missing.', now);
  return saveInvestigation(storage, inv);
}

async function buildInvestigation(storage, env, inv, { build, owner, wanted, now }) {
  if (!owner) return { ok: false, text: 'Only the CHE owner can ask me to build features into myself. Nothing was started.' };
  if (inv.build?.job_id && !['failed'].includes(inv.build.state)) {
    return { ok: true, text: `Investigation ${inv.id} is already being built: coding job ${String(inv.build.job_id).slice(0, 8)} is ${inv.build.state}${inv.build.pr_number ? `, pull request #${inv.build.pr_number}` : ''}. I did not start a second one.` };
  }
  let chosen = wanted.length ? pickFeatures(inv.features, wanted) : [];
  if (!chosen.length && inv.plan?.features?.length) chosen = inv.features.filter((f) => inv.plan.features.includes(f.id));
  if (!chosen.length && inv.proposals?.length) chosen = inv.features.filter((f) => inv.proposals.some((p) => p.feature_id === f.id));
  if (!chosen.length) {
    return { ok: false, text: inv.comparison ? `There is no proposed feature to build from investigation ${inv.id}. Name one, for example "build ${inv.features[0]?.id || 'f1'} into yourself".` : `I have not compared investigation ${inv.id} with my own code yet, so I don't know which features I lack. Ask "which of those features could improve your app?" first.` };
  }
  if (!build) return { ok: false, text: 'My coding team is not reachable from here, so nothing was started.' };
  if (!reaConfigured(env)) return { ok: false, text: 'Building needs my GitHub connection (CHE_GITHUB_TOKEN and CHE_GITHUB_REPO), which is not set. Nothing was started.' };
  inv.plan = { ...planFor(inv, chosen), approved: true, approved_at: iso(now) };
  setStage(inv, 'plan', 'done', `Planned and approved by you: ${inv.plan.names.join(', ')}.`, now);
  const request = buildRequestFor(inv);
  const queued = await Promise.resolve(build(request)).catch((error) => ({ error: String(error?.message || error).slice(0, 200) }));
  if (!queued?.job?.id) {
    setStage(inv, 'build', 'failed', `The coding job was not accepted: ${queued?.error || 'no job id'}.`, now);
    inv.build = { job_id: '', state: 'failed', note: queued?.error || 'not accepted' };
    await saveInvestigation(storage, inv);
    return { ok: false, text: `I could not start the coding job for ${inv.plan.names.join(', ')}: ${queued?.error || 'it was not accepted'}. Nothing was changed.` };
  }
  inv.build = { job_id: queued.job.id, state: 'queued', requested_at: iso(now), note: queued.deduplicated ? 'The same request was already queued, so it was not started twice.' : '' };
  setStage(inv, 'build', 'running', `Coding job ${queued.job.id.slice(0, 8)} accepted${queued.paused ? ' (autonomy is paused; it will still run because you asked)' : ''}.`, now);
  await saveInvestigation(storage, inv);
  return {
    ok: true,
    build_job_id: queued.job.id,
    text: [
      `Building ${inv.plan.names.join(', ')} into myself as original code, from investigation ${inv.id}. Coding job ${queued.job.id.slice(0, 8)} is ${queued.deduplicated ? 'already queued' : 'queued'}.`,
      'My team writes it, tests it and reviews it, then opens a draft pull request. Nothing merges or deploys without your separate yes.',
      'Acceptance checks:', list(inv.plan.acceptance),
      'Ask "REA verify" for the pull request and its test results.',
    ].join('\n'),
  };
}

// Returns null for any message that is not a REA request, so the caller carries on unchanged.
// "Number two" right after CHE read out similar repositories picks that repository.
const PICK = /^(?:(?:investigate|use|pick|choose|take)\s+)?(?:(?:number|option|choice)\s+)?(one|two|three|four|first|second|third|fourth|[1-4])(?:st|nd|rd|th)?(?:\s+one)?[\s.!]*$/i;
const PICK_WORDS = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4 };
async function pickedCandidate(storage, message, history) {
  const word = String(message || '').trim().match(PICK)?.[1]?.toLowerCase();
  if (!word) return '';
  const lastReply = [...(Array.isArray(history) ? history : [])].reverse().find((h) => h?.role === 'assistant');
  const id = String(lastReply?.content || '').match(/\brea-[0-9a-f]{8}\b/)?.[0];
  const inv = id ? await loadInvestigation(storage, id) : null;
  if (inv?.state !== 'needs_choice') return '';
  return inv.candidate_targets?.[(PICK_WORDS[word] || Number(word)) - 1] || '';
}

export async function handleReaRequest(storage, env, message, { fetcher = fetch, now = Date.now(), random, history = [], build = null, jobLookup = null, remember = null, owner = true, codingBlocked = false } = {}) {
  const picked = await pickedCandidate(storage, message, history).catch(() => '');
  if (picked) message = `Investigate ${picked}`;
  const request = parseReaRequest(message, { history });
  if (!request) return null;
  const jobs = await refreshReaJobs(storage, env, now, fetcher);
  const hasInvestigations = jobs.some((j) => j.kind === 'investigation');
  if (request.followup && !hasInvestigations) return null;
  const opts = { fetcher, now, random, jobLookup };
  if (hasInvestigations) await refreshInvestigations(storage, env, opts).catch(() => null);

  if (request.command === 'capabilities') return { ok: true, text: capabilitiesText(env) };
  if (request.command === 'status') {
    const head = request.capabilities ? `REA is my reverse-engineering and investigation system. ${capabilitiesText(env)}\n\n` : '';
    if (request.verified) {
      // The newest job that completed with evidence; a newer pending or failed job is named, not shown as the result.
      const newest = jobs[jobs.length - 1];
      const done = [...jobs].reverse().find((j) => j.state === 'complete');
      const status = statusText(env, jobs, { capabilities: !request.capabilities });
      if (!done) {
        return { ok: true, text: `${head}${status}\n\nNo REA job has completed with evidence yet, so there is no verified investigation to show. Nothing was started.`.trim() };
      }
      const newer = newest && newest.id !== done.id ? `The newest job, ${newest.id}, is ${newest.state}, so it is not the result below. ` : '';
      const inv = done.kind === 'investigation' ? await loadInvestigation(storage, done.id) : null;
      const answer = inv ? investigationAnswer(inv) : done.kind !== 'investigation' && done.summary ? evidenceAnswer(done.command, done)
        : 'Its evidence record could not be read, so its evidence is UNVERIFIED.';
      return { ok: true, ...(inv ? { investigation_id: done.id } : {}), text: `${head}${status}\n\n${newer}Most recent completed job: ${done.id}.\n${answer}\nNothing was started.`.trim() };
    }
    const latest = jobs[jobs.length - 1];
    if (latest?.kind === 'investigation') {
      const inv = await loadInvestigation(storage, latest.id);
      return { ok: true, investigation_id: latest.id, text: `${head}${statusText(env, jobs)}\n\n${inv ? investigationAnswer(inv) : ''}`.trim() };
    }
    const result = latest?.state === 'complete' ? `\n\n${evidenceAnswer(latest.command, latest)}` : '';
    return { ok: true, text: `${head}${statusText(env, jobs)}${result}` };
  }

  const target = request.command === 'inspect' || request.command === 'discover' || ['explain', 'debug', 'compare', 'rebuild'].includes(request.command)
    ? identifyTarget(request.input) : null;
  // npm packages keep the pinned REA workflow, unchanged.
  if (target?.kind === 'npm' || (['inspect', 'explain', 'debug', 'compare'].includes(request.command) && /\bnpm\b/i.test(request.input))) {
    return npmRequest(storage, env, jobs, request, { fetcher, now, random });
  }
  if (request.command === 'rebuild' && !jobs.some((j) => j.kind === 'investigation') && !/\bf\d{1,2}\b/.test(request.input)) {
    return { ok: true, text: rebuildPlan(jobs, request.input) };
  }

  if (request.command === 'inspect' || request.command === 'discover') {
    if (request.ask || (!target && !request.input)) {
      return { ok: false, text: 'Which app should I investigate, sir? Give me its name, a public link, a GitHub repository (owner/name), or an npm package with its exact version.' };
    }
    if (!target) return { ok: false, text: 'I could not tell which software that is. Give me its name followed by "app" or "website", a public link, a GitHub repository (owner/name), or npm:name@version.' };
    if (request.command === 'discover') return discoverAnswer(env, target, fetcher);
    const feature = (request.input.match(/\b(?:its|their|the)\s+([\w\s-]{3,30}?)\s+feature\b/i)?.[1] || '').trim();
    const { inv, reused, resumed } = await startOrReuse(storage, env, jobs, target, { fetcher, now, random, feature });
    let current = inv;
    if (request.gap && current.state === 'complete' && current.features.length) current = await compareInvestigation(storage, env, current, fetcher, now);
    await rememberInvestigation(remember, current);
    const text = request.gap && current.comparison ? `${investigationAnswer(current, { reused })}\n\n${compareAnswer(current)}` : investigationAnswer(current, { reused });
    return { ok: current.state === 'complete' || current.state === 'limited', investigation_id: current.id, reused: reused ? current.id : undefined, resumed: Boolean(resumed), text };
  }

  const inv = await resolveInvestigation(storage, jobs, request.input);
  if (!inv) return request.followup ? null : { ok: false, text: 'There is no REA investigation to use yet. Say "investigate" with an app name, a public link or a repository first. Nothing was run.' };
  // "Build those into yourself" belongs to an investigation only while it is the
  // conversation's subject: the last reply was REA's, or it was worked on in
  // the last six hours. "Remember that app…" names it, so it always applies.
  if (request.followup && request.command !== 'recall' && !(request.command === 'build' && RECALL.test(message))) {
    const lastReply = [...(Array.isArray(history) ? history : [])].reverse().find((h) => h?.role === 'assistant');
    const reaReply = /\brea-[0-9a-f]{8}\b/.test(String(lastReply?.content || ''));
    const recent = now - Date.parse(inv.updated_at || 0) < FOLLOWUP_WINDOW_MS;
    if (!reaReply && !(recent && !lastReply)) return null;
  }

  if (request.command === 'recall') {
    const check = await stillCurrent(env, inv, fetcher);
    return { ok: true, investigation_id: inv.id, text: `Yes: ${inv.target.label}, investigation ${inv.id} from ${inv.created_at.slice(0, 10)}, now at stage "${inv.stages.find((s) => s.id === inv.stage)?.label || inv.stage}". ${check.note}\n\n${investigationAnswer(inv)}` };
  }
  if (request.command === 'features') {
    if (!inv.features.length) return { ok: false, investigation_id: inv.id, text: `Investigation ${inv.id} of ${inv.target.label} found no features in what it could read.` };
    return {
      ok: true, investigation_id: inv.id,
      text: [`Feature map of ${inv.target.label} (investigation ${inv.id}):`, list(inv.features.map((f) => `${f.id} ${f.name}. ${f.purpose} You see: ${f.user_sees} Used by: ${f.operated_by} Effort: ${f.complexity}. Evidence: ${f.evidence.map((e) => e.label).slice(0, 2).join('; ') || 'none'}. Unknown: ${f.unknowns[0] || 'nothing listed'}.`))].join('\n'),
    };
  }
  if (request.command === 'explain' || request.command === 'debug') {
    const groups = ['observed', 'inferred', 'unknown'].map((kind) => [kind, inv.architecture.filter((a) => a.kind === kind)]);
    return { ok: true, investigation_id: inv.id, text: [`Architecture of ${inv.target.label} (investigation ${inv.id}):`, ...groups.filter(([, items]) => items.length).flatMap(([kind, items]) => [`${kind[0].toUpperCase()}${kind.slice(1)}:`, list(items.map((a) => `${a.label}: ${a.detail}${a.evidence?.[0]?.url ? ` (${a.evidence[0].label})` : ''}`))]), request.command === 'debug' ? 'A crash cannot be seen from a static read; send the error text and I will look for it in the cited files.' : ''].filter(Boolean).join('\n') };
  }
  if (request.command === 'compare') {
    if (!inv.features.length) return { ok: false, investigation_id: inv.id, text: `Investigation ${inv.id} has no features to compare.` };
    if (!/^[\w.-]+\/[\w.-]+$/.test(String(env.CHE_GITHUB_REPO || '').trim())) return { ok: false, investigation_id: inv.id, text: 'Comparing needs my repository name (CHE_GITHUB_REPO), and it is not set. Nothing was marked missing.' };
    const done = await compareInvestigation(storage, env, inv, fetcher, now);
    await rememberInvestigation(remember, done);
    return { ok: true, investigation_id: inv.id, text: compareAnswer(done) };
  }
  if (request.command === 'rebuild') {
    const wanted = request.input.replace(/rea-[0-9a-f]{8}/, '').match(/\bf\d{1,2}\b/g) || (request.input.replace(/rea-[0-9a-f]{8}/, '').trim() ? [request.input.replace(/rea-[0-9a-f]{8}/, '').trim()] : []);
    const chosen = wanted.length ? pickFeatures(inv.features, wanted) : inv.features.filter((f) => inv.proposals.some((p) => p.feature_id === f.id));
    if (!chosen.length) return { ok: false, investigation_id: inv.id, text: `Which features should I plan? Investigation ${inv.id} has ${inv.features.map((f) => `${f.id} ${f.name}`).join(', ') || 'none'}.` };
    inv.plan = planFor(inv, chosen);
    setStage(inv, 'plan', 'done', `Planned ${inv.plan.names.join(', ')}; waiting for your build instruction.`, now);
    await saveInvestigation(storage, inv);
    await rememberInvestigation(remember, inv);
    return { ok: true, investigation_id: inv.id, text: planAnswer(inv) };
  }
  if (request.command === 'build') {
    const wanted = (request.input.replace(/rea-[0-9a-f]{8}/, '').match(/\bf\d{1,2}\b/g)) || (request.input.replace(/rea-[0-9a-f]{8}/, '').trim() ? [request.input.replace(/rea-[0-9a-f]{8}/, '').trim()] : []);
    if (request.followup && wanted.length && !pickFeatures(inv.features, wanted).length) return null;
    if (codingBlocked || NO_CODE_CHANGE.test(message)) {
      return { ok: false, investigation_id: inv.id, text: `You asked me not to change code or open a pull request in this message, so I did not start a build from investigation ${inv.id}. Nothing was changed. Say "build those features into yourself" on its own when you want it built.` };
    }
    const result = await buildInvestigation(storage, env, inv, { build, owner, wanted, now });
    await rememberInvestigation(remember, inv);
    return { ...result, investigation_id: inv.id };
  }
  if (request.command === 'verify') {
    const fresh = await refreshBuild(storage, env, inv, { jobLookup, fetcher, now, force: true });
    return { ok: fresh.verification?.state === 'passed', investigation_id: inv.id, text: verifyAnswer(fresh) };
  }
  return null;
}

async function discoverAnswer(env, target, fetcher) {
  const lines = [];
  if (target.kind === 'app_name' || target.kind === 'private_app') {
    const [repos, store] = await Promise.all([searchPublicRepos(env, target.name, fetcher).catch(() => ({ ok: false, repos: [] })), lookupAppStore({ name: target.name }, fetcher).catch(() => ({ ok: false }))]);
    lines.push(`Sources I found for "${cleanText(target.name, 60)}":`);
    const found = [
      ...(repos.repos || []).slice(0, 3).map((r) => `GitHub ${r.full_name}, ${r.stars} stars, licence ${r.license || 'none'}${r.exact ? ' (same name)' : ''}: https://github.com/${r.full_name}`),
      ...(store.ok ? [`App Store: ${store.listing.name} by ${store.listing.seller}, version ${store.listing.version}: ${store.listing.url}`] : []),
      ...(!store.ok ? (store.candidates || []).slice(0, 2).map((l) => `App Store: ${l.name} by ${l.seller} (similar name, not confirmed): ${l.url}`) : []),
    ];
    lines.push(found.length ? list(found) : 'None. Give me a link or a repository name.');
    if (target.kind === 'private_app') lines.push('', 'Not reachable:', list(PRIVATE_APP_LIMITS));
  } else {
    lines.push(`That is ${target.kind === 'github' ? `the public repository ${target.full_name}` : target.kind === 'website' ? `the web page ${target.url}` : target.kind === 'app_store' ? 'an App Store listing' : 'a Google Play listing'}.`);
  }
  lines.push('', 'Nothing was read in depth. Say "investigate" with the source to map its features.');
  return { ok: true, text: lines.join('\n') };
}

async function npmRequest(storage, env, jobs, request, { fetcher, now, random }) {
  if (request.command === 'rebuild') return { ok: true, text: rebuildPlan(jobs, request.input) };
  const parsed = parseReaTarget(request.input);
  if (!parsed.ok) return { ok: false, text: parsed.reason };
  const resolved = await resolveNpmPackage(parsed.name, parsed.version, fetcher);
  if (!resolved.ok) return { ok: false, text: resolved.reason };
  const target = { kind: 'npm', name: parsed.name, version: resolved.version, license: resolved.license };
  const cacheKey = `${REA_PIN.version}|npm:${parsed.name}@${parsed.version}|${resolved.integrity}`;
  const earlier = [...jobs].reverse().find((j) => j.cache_key === cacheKey && j.state === 'complete' && j.summary);
  if (earlier) return { ok: true, reused: earlier.id, text: evidenceAnswer(request.command, { ...earlier, target }) };

  if (!reaConfigured(env)) {
    return { ok: false, text: 'REA analysis runs on GitHub Actions, and CHE has no GitHub connection (CHE_GITHUB_TOKEN and CHE_GITHUB_REPO). Nothing was run.' };
  }
  const job = {
    id: newJobId(random), command: request.command, target, integrity: resolved.integrity, cache_key: cacheKey,
    state: 'queued', created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
  };
  const sent = await gh(env, 'POST', `/actions/workflows/${encodeURIComponent(REA_WORKFLOW)}/dispatches`, {
    ref: REA_WORKFLOW_REF,
    inputs: { job_id: job.id, target: `npm:${target.name}@${target.version}`, expected_integrity: resolved.integrity },
  }, fetcher);
  if (!sent.ok) {
    Object.assign(job, { state: 'failed', error: `GitHub did not start the run (status ${sent.status || 'none'}).` });
  }
  await storage.put(REA_JOBS_KEY, [...jobs, job].slice(-JOB_LOG_LIMIT));
  if (!sent.ok) return { ok: false, text: `REA could not start: GitHub did not start the analysis run (status ${sent.status || 'none'}). Nothing was analyzed.` };
  return {
    ok: true,
    text: [
      `REA ${TITLES[request.command] || 'inspection'} started for npm ${target.name} ${target.version} (${target.license}). Job ${job.id}.`,
      'It runs on GitHub Actions. Nothing from the package runs on this phone or on the Worker.',
      'Ask "REA status" for the result. It is usually ready in a few minutes.',
    ].join('\n'),
  };
}
