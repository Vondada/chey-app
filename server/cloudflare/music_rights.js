// Music rights: the Rights part of CHE's Music Studio (owner, 2026-10-22). A song is an ordinary
// CHE project (data.projects, type 'music'); its rights live on that same record under
// `project.music`, so Projects and Music read one record.
//
// What this module decides, from stored facts only:
//   - where every audio input came from (provenance), and whether a sample's licence is documented;
//   - whether collaborator splits reconcile, without ever inventing a percentage;
//   - a release-readiness checklist, and a risk class for "can we defend this?".
// It never says a sample is safe, that no claim will be filed, or that a work is legally protected:
// it reports the evidence on file, what is missing, and when a licensed attorney should look.
// No model call. Nothing here releases, distributes, signs, pays or transfers rights.

export const PROVENANCE = Object.freeze(['OWNER_ORIGINAL', 'CHE_GENERATED', 'LICENSED', 'PUBLIC_DOMAIN', 'REFERENCE_ONLY', 'UNKNOWN']);

// Sample states, in the owner's words.
export const SAMPLE_STATES = Object.freeze({
  documented: 'licence documented',
  owner: 'owner original',
  generated: 'CHE generated',
  unresolved: 'rights not verified',
  blocked: 'not usable in a release',
  reference: 'reference only',
});

const nonEmpty = (x) => typeof x === 'string' && x.trim().length > 0;
const isCC = (type) => /^cc[\s-]/i.test(String(type || '')) || /creative commons/i.test(String(type || ''));

/// One sample or audio input, normalised. Unknown fields stay unknown: nothing is assumed.
export function normalizeSample(input = {}, now = new Date().toISOString()) {
  const provenance = PROVENANCE.includes(input.provenance) ? input.provenance : 'UNKNOWN';
  const pick = (k) => (nonEmpty(input[k]) ? input[k].trim() : null);
  const flag = (k) => (input[k] === true ? true : input[k] === false ? false : null);
  return {
    id: pick('id') || `smp_${Math.random().toString(36).slice(2, 10)}`,
    name: pick('name') || 'Untitled sample',
    provenance,
    source: pick('source'),
    creator: pick('creator'),
    source_url: pick('source_url'),
    license_type: pick('license_type'),
    license_ref: pick('license_ref'),          // licence text, its URL, or an invoice/receipt reference
    commercial_use: flag('commercial_use'),
    attribution_required: flag('attribution_required'),
    attribution_text: pick('attribution_text'),
    modification_allowed: flag('modification_allowed'),
    modified: input.modified === true,
    territory: pick('territory'),
    expires_at: pick('expires_at'),
    proof_ref: pick('proof_ref'),
    used_in_master: input.used_in_master !== false,
    checked_at: pick('checked_at') || now,
  };
}

/// What the stored record supports. `missing` lists exactly what would be needed to document it.
export function evaluateSample(sample, now = Date.now()) {
  const s = sample;
  const missing = [];
  const problems = [];
  if (s.provenance === 'OWNER_ORIGINAL') return { state: 'owner', missing, problems };
  if (s.provenance === 'CHE_GENERATED') return { state: 'generated', missing, problems };
  if (s.provenance === 'REFERENCE_ONLY') {
    return s.used_in_master
      ? { state: 'blocked', missing, problems: ['A reference track is inside the master. References are for listening and analysis only.'] }
      : { state: 'reference', missing, problems };
  }
  if (s.provenance === 'UNKNOWN') {
    return { state: 'unresolved', missing: ['where it came from', 'a licence'], problems: ['The source and the licence of this audio are unknown.'] };
  }
  if (!s.source && !s.source_url) missing.push('the source');
  if (s.provenance === 'PUBLIC_DOMAIN') {
    if (!s.license_ref) missing.push('a record of why it is public domain');
    return { state: missing.length ? 'unresolved' : 'documented', missing, problems };
  }
  // LICENSED, including Creative Commons and royalty-free packs.
  if (!s.license_type) missing.push('the licence type');
  if (!s.license_ref) missing.push('the licence text, link or proof of purchase');
  if (s.commercial_use === null) missing.push('whether commercial use is allowed');
  if (s.commercial_use === false || (isCC(s.license_type) && /\bNC\b|noncommercial|non-commercial/i.test(s.license_type))) {
    problems.push('The licence does not allow commercial use.');
  }
  if (s.modified && (s.modification_allowed === false || (isCC(s.license_type) && /\bND\b|no ?deriv/i.test(s.license_type)))) {
    problems.push('The audio was changed, and the licence does not allow changes.');
  }
  if (s.attribution_required && !s.attribution_text) missing.push('the required credit text');
  if (s.expires_at && Date.parse(s.expires_at) < now) problems.push(`The licence expired on ${s.expires_at.slice(0, 10)}.`);
  if (problems.length) return { state: 'blocked', missing, problems };
  return { state: missing.length ? 'unresolved' : 'documented', missing, problems };
}

/// Splits per role group. Percentages are never filled in: a missing share is reported as missing.
export const SPLIT_GROUPS = Object.freeze({ songwriting: 'Songwriting', publishing: 'Publishing', master: 'Master recording' });

export function validateSplits(splits = []) {
  const issues = [];
  const totals = {};
  for (const [group, label] of Object.entries(SPLIT_GROUPS)) {
    const rows = splits.filter((r) => r && r.group === group);
    if (!rows.length) continue;
    const missing = rows.filter((r) => !Number.isFinite(Number(r.percent)) || r.percent === null || r.percent === '');
    for (const r of missing) issues.push(`${label}: no share recorded for ${r.name || 'an unnamed collaborator'}.`);
    const known = rows.filter((r) => !missing.includes(r));
    const total = Math.round(known.reduce((sum, r) => sum + Number(r.percent), 0) * 100) / 100;
    totals[group] = total;
    if (!missing.length && total !== 100) issues.push(`${label} shares total ${total}%, not 100%.`);
    if (known.some((r) => Number(r.percent) < 0)) issues.push(`${label}: a share is negative.`);
    const unsigned = rows.filter((r) => r.agreement !== 'signed');
    if (unsigned.length) issues.push(`${label}: no signed agreement on file for ${unsigned.map((r) => r.name || 'unnamed').join(', ')}.`);
  }
  if (!splits.length) issues.push('No collaborators or splits are recorded.');
  return { ok: issues.length === 0, issues, totals };
}

const REQUIRED_METADATA = Object.freeze(['artist', 'title', 'genre', 'explicit']);

/// One checklist for "is this ready to release?". Every line is backed by a stored record.
/// READY means the checks pass; the release itself still needs the owner's approval.
export function releaseReadiness(project, now = Date.now()) {
  const m = project?.music || {};
  const versions = Array.isArray(m.versions) ? m.versions : [];
  const master = versions.find((v) => v.kind === 'master' && nonEmpty(v.sha256));
  const meta = m.metadata || {};
  const missingMeta = REQUIRED_METADATA.filter((k) => meta[k] === undefined || meta[k] === null || meta[k] === '');
  const samples = (m.samples || []).map((s) => ({ s, e: evaluateSample(s, now) }));
  const openSamples = samples.filter(({ e }) => e.state === 'unresolved' || e.state === 'blocked');
  const splits = validateSplits(m.splits || []);
  const unknownInputs = versions.filter((v) => v.kind === 'master').flatMap((v) => (v.inputs || []).filter((i) => i.provenance === 'UNKNOWN' || !PROVENANCE.includes(i.provenance)));
  const items = [
    { id: 'master', label: 'Master', ok: Boolean(master), detail: master ? `${master.label || 'master'} (${master.sha256.slice(0, 12)})` : 'No mastered file on record.' },
    { id: 'artwork', label: 'Artwork', ok: nonEmpty(m.artwork), detail: nonEmpty(m.artwork) ? 'On file.' : 'No artwork on record.' },
    { id: 'metadata', label: 'Metadata', ok: missingMeta.length === 0, detail: missingMeta.length ? `Missing: ${missingMeta.join(', ')}.` : 'Complete.' },
    { id: 'splits', label: 'Splits', ok: splits.ok, detail: splits.ok ? 'Reconciled and signed.' : splits.issues.join(' ') },
    { id: 'samples', label: 'Sample rights', ok: openSamples.length === 0, detail: openSamples.length ? `${openSamples.length} unresolved: ${openSamples.map(({ s, e }) => `${s.name} (${[...e.problems, ...e.missing.map((x) => `needs ${x}`)].join('; ')})`).join('; ')}` : samples.length ? 'Every sample has a documented source.' : 'No external samples recorded.' },
    { id: 'inputs', label: 'Master inputs', ok: unknownInputs.length === 0, detail: unknownInputs.length ? `${unknownInputs.length} audio input${unknownInputs.length === 1 ? '' : 's'} of unknown origin in the master.` : 'Every master input has a recorded origin.' },
  ];
  const ready = items.every((i) => i.ok);
  const firstOpen = items.find((i) => !i.ok);
  const action = ready ? 'Approve release' : ({ samples: 'Resolve sample', splits: 'Fix splits', metadata: 'Add metadata', artwork: 'Add artwork', master: 'Master the song', inputs: 'Resolve audio origin' })[firstOpen.id];
  return { ready, status: ready ? 'READY' : 'NOT READY', items, primary_action: action, needs_owner_approval: true };
}

/// "Can we defend this?" A risk class from the evidence on file, never a predicted outcome.
export const RISK = Object.freeze({ lower: 'LOWER RISK', unclear: 'UNCLEAR', higher: 'HIGHER RISK', attorney: 'ATTORNEY REVIEW RECOMMENDED' });

export function defensibility(project, now = Date.now()) {
  const m = project?.music || {};
  const factors = [];
  const samples = (m.samples || []).map((s) => evaluateSample(s, now));
  const blocked = samples.filter((e) => e.state === 'blocked').length;
  const unresolved = samples.filter((e) => e.state === 'unresolved').length;
  const versions = Array.isArray(m.versions) ? m.versions : [];
  const sourceFiles = versions.filter((v) => nonEmpty(v.sha256)).length;
  const splits = validateSplits(m.splits || []);
  if (sourceFiles) factors.push(`${sourceFiles} dated file version${sourceFiles === 1 ? '' : 's'} with checksums on record.`);
  else factors.push('No dated source files with checksums on record.');
  if (blocked) factors.push(`${blocked} sample${blocked === 1 ? '' : 's'} whose licence does not cover this use.`);
  if (unresolved) factors.push(`${unresolved} sample${unresolved === 1 ? '' : 's'} without a documented licence.`);
  if (!splits.ok) factors.push(...splits.issues);
  if (m.dispute) factors.push(`A known dispute: ${m.dispute}`);
  if (m.similarity_concern) factors.push(`A similarity concern: ${m.similarity_concern}`);
  let risk = RISK.lower;
  if (m.dispute || blocked) risk = RISK.attorney;
  else if (m.similarity_concern || unresolved) risk = RISK.higher;
  else if (!sourceFiles || !splits.ok) risk = RISK.unclear;
  const note = risk === RISK.attorney
    ? 'This looks important enough that I would want a licensed attorney to review the actual documents before you release or sign anything.'
    : 'This is a risk read from the records on file, not a prediction of what a court or a platform would decide.';
  return { risk, factors, note };
}

/// Spoken checklist: short, one line per item, then the one thing to do next.
export function speakReadiness(r, title = 'This song') {
  const lines = r.items.map((i) => `${i.label}: ${i.ok ? 'done' : i.detail}`);
  if (r.ready) return `${title} passes every release check. ${lines.join('. ')}. Nothing is released until you approve it.`;
  return `${title} is not ready to release. ${lines.join('. ')}. Next: ${r.primary_action}.`;
}

/// One owner action on a song's rights, applied to the existing project list (data.projects).
/// Returns { status, body }. Every write is recorded on the project; nothing leaves CHE.
export function applyRightsAction(data, body = {}, now = new Date().toISOString()) {
  data.projects = Array.isArray(data.projects) ? data.projects : [];
  const action = String(body.action || 'read');
  if (action === 'create_song') {
    const title = String(body.title || '').trim();
    if (!title) return { status: 400, body: { detail: 'A song needs a title.' } };
    const project = { id: `song_${crypto.randomUUID()}`, type: 'music', title, status: 'new', brief: '', created_at: now, music: { versions: [], samples: [], splits: [], metadata: { title }, artwork: '' } };
    data.projects.unshift(project);
    return { status: 200, body: { project } };
  }
  const project = data.projects.find((p) => p && p.id === body.project_id && p.type === 'music');
  if (!project) return { status: 404, body: { detail: 'No song with that id.' } };
  project.music ||= { versions: [], samples: [], splits: [], metadata: {}, artwork: '' };
  const m = project.music;
  m.samples ||= []; m.splits ||= []; m.versions ||= []; m.metadata ||= {};
  if (action === 'add_sample') {
    const sample = normalizeSample(body.sample || {}, now);
    m.samples.push(sample);
    return { status: 200, body: { sample, evaluation: evaluateSample(sample, Date.parse(now)) } };
  }
  if (action === 'attach_license') {
    const i = m.samples.findIndex((s) => s.id === body.sample_id);
    if (i < 0) return { status: 404, body: { detail: 'No sample with that id on this song.' } };
    const sample = normalizeSample({ ...m.samples[i], ...(body.license || {}), id: m.samples[i].id, checked_at: now }, now);
    m.samples[i] = sample;
    return { status: 200, body: { sample, evaluation: evaluateSample(sample, Date.parse(now)) } };
  }
  if (action === 'set_splits') {
    if (!Array.isArray(body.splits)) return { status: 400, body: { detail: 'Splits must be a list.' } };
    m.splits = body.splits.map((r) => ({ group: r.group, name: String(r.name || '').trim(), role: r.role || '', percent: r.percent === undefined || r.percent === null || r.percent === '' ? null : Number(r.percent), agreement: r.agreement === 'signed' ? 'signed' : 'pending' }));
    return { status: 200, body: { splits: m.splits, check: validateSplits(m.splits) } };
  }
  if (action === 'set_metadata') {
    const allowed = ['artist', 'title', 'featured_artist', 'genre', 'explicit', 'release_date', 'isrc', 'upc', 'publisher', 'lyrics'];
    for (const k of allowed) if (k in (body.metadata || {})) m.metadata[k] = body.metadata[k];
    if (typeof body.artwork === 'string') m.artwork = body.artwork;
    return { status: 200, body: { metadata: m.metadata, artwork: m.artwork } };
  }
  if (action === 'readiness') {
    const r = releaseReadiness(project, Date.parse(now));
    return { status: 200, body: { readiness: r, speech: speakReadiness(r, project.title) } };
  }
  if (action === 'defend') return { status: 200, body: defensibility(project, Date.parse(now)) };
  if (action === 'read') return { status: 200, body: { project, readiness: releaseReadiness(project, Date.parse(now)) } };
  return { status: 400, body: { detail: 'Unknown action. Use create_song, add_sample, attach_license, set_splits, set_metadata, readiness, defend or read.' } };
}

/// "Is Midnight ready to release?", "check my samples and splits", "can we defend this song?".
export function musicRightsIntent(message) {
  const text = String(message || '');
  const music = /\b(?:song|track|beat|single|record|release|samples?|splits?|music)\b/i.test(text);
  if (!music) return null;
  if (/\b(?:can we defend|defensib|how risky|legal risk)\b/i.test(text)) return { kind: 'defend' };
  if (/\b(?:ready (?:to|for) release|release[- ]ready|release readiness|samples? and splits|splits and samples|(?:check|are) (?:my |the )?(?:samples?|splits)|can i release)\b/i.test(text)) return { kind: 'readiness' };
  return null;
}

/// The song a message is about: a title it names, else the newest music project.
export function songFor(data, message) {
  const songs = (data.projects || []).filter((p) => p && p.type === 'music');
  const lower = String(message || '').toLowerCase();
  return songs.find((p) => p.title && lower.includes(String(p.title).toLowerCase())) || songs[0] || null;
}
