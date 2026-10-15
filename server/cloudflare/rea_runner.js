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

import { gh } from './coding_runtime.js';
import {
  REA_PIN, REA_JOB_ID, NPM_NAME, EXACT_VERSION, NPM_INTEGRITY, cleanText, validateReaSummary,
} from './rea_evidence.js';

export const REA_WORKFLOW = 'che-rea-analysis.yml';
export const REA_WORKFLOW_REF = 'main';
export const REA_RESULTS_REF = 'che-mailbox';
export const REA_RESULT_PREFIX = 'mailbox/rea';
export const REA_JOBS_KEY = 'rea_jobs';
const JOB_LOG_LIMIT = 30;
const STALLED_AFTER_MS = 2 * 60 * 60_000;

const VERBS = { inspect: 'inspect', 'reverse engineer': 'inspect', 'reverse-engineer': 'inspect', analyze: 'inspect', analyse: 'inspect', explain: 'explain', debug: 'debug', compare: 'compare' };
const TITLES = { inspect: 'inspection', explain: 'explanation', debug: 'debug review', compare: 'comparison', rebuild: 'rebuild plan' };

export function reaConfigured(env = {}) {
  return Boolean(String(env.CHE_GITHUB_TOKEN || '').trim()) && /^[\w.-]+\/[\w.-]+$/.test(String(env.CHE_GITHUB_REPO || '').trim());
}

// `REA inspect: npm:semver@7.7.2`, `REA rebuild: a copy of the search box`, `REA status`.
// Natural phrasing is accepted only when it also names an npm package, so ordinary chat is
// never taken over by this route.
export function parseReaRequest(message) {
  const text = String(message || '').trim();
  const explicit = text.match(/^(?:che[,:]?\s+)?rea\b\s*(inspect|debug|explain|compare|rebuild|status|history)\b\s*[:\-–]?\s*([\s\S]*)$/i);
  if (explicit) return { command: explicit[1].toLowerCase(), input: explicit[2].trim() };
  const natural = text.match(/\b(reverse[- ]engineer|analy[sz]e|inspect|explain|debug|compare)\b[\s\S]{0,80}\b(?:npm package\b|npm:)/i);
  if (natural) return { command: VERBS[natural[1].toLowerCase().replace(/\s+/g, ' ')] || 'inspect', input: text };
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
  return [
    { id: 'static_javascript', label: 'Static JavaScript and Electron analysis of public npm packages', available: ready, needs: ready ? '' : 'The GitHub connection (CHE_GITHUB_TOKEN and CHE_GITHUB_REPO) on the Worker.' },
    { id: 'native_binaries', label: 'Native binaries (Ghidra)', available: false, needs: 'An external analysis host with Ghidra and Java. None is set up, so nothing is run.' },
    { id: 'runtime_capture', label: 'Running or watching software', available: false, needs: 'Not built. Each target would need your approval first.' },
    { id: 'private_targets', label: 'Private files, links and devices', available: false, needs: 'Refused in this version.' },
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

function statusText(env, jobs) {
  const lines = ['REA status.', 'Runs on GitHub Actions with REA ' + REA_PIN.version + ' (pinned). Not on the Worker or the iPhone.', ''];
  lines.push('Capabilities:');
  lines.push(list(reaCapabilities(env).map((c) => `${c.label}: ${c.available ? 'available' : 'not available'}${c.needs ? ` (${c.needs})` : ''}`)));
  lines.push('');
  const recent = jobs.slice(-5).reverse();
  lines.push(recent.length ? 'Recent jobs:' : 'No REA jobs yet.');
  if (recent.length) {
    lines.push(list(recent.map((j) => `${j.id}: npm ${j.target.name} ${j.target.version}, ${j.state}${j.error ? ` (${j.error})` : ''}`)));
  }
  return lines.join('\n');
}

function rebuildPlan(jobs, input) {
  const wanted = String(input || '').match(REA_JOB_ID)?.[0];
  const job = [...jobs].reverse().find((j) => j.state === 'complete' && (!wanted || j.id === wanted));
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

// Returns null for any message that is not a REA request, so the caller carries on unchanged.
export async function handleReaRequest(storage, env, message, { fetcher = fetch, now = Date.now(), random } = {}) {
  const request = parseReaRequest(message);
  if (!request) return null;
  const jobs = await refreshReaJobs(storage, env, now, fetcher);
  if (request.command === 'status' || request.command === 'history') {
    const latest = jobs[jobs.length - 1];
    const result = latest?.state === 'complete' ? `\n\n${evidenceAnswer(latest.command, latest)}` : '';
    return { ok: true, text: `${statusText(env, jobs)}${result}` };
  }
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
