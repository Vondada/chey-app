// CHE Music catalog and curator (owner, 2026-10-22). Builds on music_rights.js and music_audio.js;
// songs, EPs and albums are ordinary CHE projects (data.projects), never a second database.
//
// Purpose of every upload. The owner's own label always wins; CHE may suggest one from the owner's
// words, and asks when unsure. Audio similarity is evidence about sound, never about ownership:
// nothing here moves a file into the owner's catalog because it sounds like the owner.
//
// Curating uses measurements from music_audio.js (loudness, tempo, brightness, loudness range,
// duration). Every reason given names the measurement behind it; anything subjective (hooks, lyrics,
// song strength) is not claimed until there is real evidence for it.

import { releaseReadiness } from './music_rights.js';

export const PURPOSES = Object.freeze({
  MY_SONG: 'My song', MY_VOCALS: 'My vocals', MY_BEAT: 'My beat', MY_STEM: 'My stem',
  COLLABORATION: 'Collaboration', REFERENCE_TRACK: 'Reference track', SAMPLE: 'Sample', LOOP_SOUND: 'Loop / sound', UNKNOWN: 'Unknown',
});
// Only these belong in MY CATALOG. A collaboration joins only when the owner says it belongs there.
const CATALOG_PURPOSES = new Set(['MY_SONG']);

/// A purpose suggested from the owner's own words, or null with a question when unsure.
export function suggestPurpose(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(?:as a )?reference\b|\bsound like this\b/.test(t)) return { purpose: 'REFERENCE_TRACK', certain: true };
  if (/\b(?:i want to |let me |to )?sample (?:this|it)\b|\bas a sample\b/.test(t)) return { purpose: 'SAMPLE', certain: true };
  if (/\bmy vocals?\b|\bacapella\b|\bmy verse\b/.test(t)) return { purpose: 'MY_VOCALS', certain: true };
  if (/\bmy beat\b|\binstrumental i made\b/.test(t)) return { purpose: 'MY_BEAT', certain: true };
  if (/\bstems?\b/.test(t) && /\bmy\b/.test(t)) return { purpose: 'MY_STEM', certain: true };
  if (/\b(?:collab|collaboration|feature|featuring|ft\.)\b/.test(t)) return { purpose: 'COLLABORATION', certain: false, ask: 'Is this a collaboration you want in your catalog, or someone else\'s song?' };
  if (/\b(?:my (?:song|songs|catalog|music|track|tracks)|add (?:this|these) to my catalog|these are my songs)\b/.test(t)) return { purpose: 'MY_SONG', certain: true };
  if (/\bloop\b|\bsound ?pack\b|\bone[- ]shot\b/.test(t)) return { purpose: 'LOOP_SOUND', certain: true };
  return { purpose: 'UNKNOWN', certain: false, ask: 'What is this? My song, my vocals, a reference, a sample, or something else?' };
}

/// Stores the purpose on an asset. An explicit owner label replaces any suggestion and is kept.
export function classifyAsset(asset, purpose, { byOwner = false } = {}) {
  if (!Object.hasOwn(PURPOSES, purpose)) throw new Error(`Unknown purpose ${purpose}`);
  if (asset.purpose_by_owner && !byOwner) return asset; // a suggestion never overrides the owner
  return { ...asset, purpose, purpose_by_owner: byOwner || false };
}

/// The owner's catalog: songs he labelled as his (or collaborations he placed there). References,
/// samples, loops and unknown files are separate libraries and never appear here.
export function myCatalog(projects = []) {
  return projects.filter((p) => p && p.type === 'music' && (CATALOG_PURPOSES.has(p.music?.purpose) || (p.music?.purpose === 'COLLABORATION' && p.music?.in_catalog === true && p.music?.purpose_by_owner)));
}

export function library(projects = [], purpose) {
  return projects.filter((p) => p && p.type === 'music' && (p.music?.purpose || 'UNKNOWN') === purpose);
}

// ─── Versions of one song ─────────────────────────────────────────────────

const VERSION_WORDS = /\s*[([\-–_]*\s*\b(master(?:ed)?|mix|mixdown|instrumental|inst|clean|explicit|dirty|acapella|a cappella|radio edit|original|final|demo|rough|bounce|v(?:er(?:sion)?)?\s*\d+|\d+)\b\s*[)\]]*/gi;

/// The song a file belongs to, from its title with version words removed ("Pressure (Master v3)" → "pressure").
export function songKey(title) {
  return String(title || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(VERSION_WORDS, ' ').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
}

export function versionKind(title) {
  const t = String(title || '').toLowerCase();
  if (/instrumental|\binst\b/.test(t)) return 'instrumental';
  if (/acapella|a cappella/.test(t)) return 'acapella';
  if (/\bclean\b|radio edit/.test(t)) return 'clean';
  if (/master/.test(t)) return 'master';
  if (/\bmix|mixdown/.test(t)) return 'mix';
  if (/demo|rough/.test(t)) return 'demo';
  return 'original';
}

/// Groups uploads under one song instead of showing five projects for five versions. Exact duplicate
/// files (same checksum) are reported, never deleted.
export function groupVersions(files = []) {
  const songs = new Map();
  const seen = new Map();
  const duplicates = [];
  for (const f of files) {
    if (f.sha256 && seen.has(f.sha256)) { duplicates.push({ file: f.title, same_as: seen.get(f.sha256) }); continue; }
    if (f.sha256) seen.set(f.sha256, f.title);
    const key = songKey(f.title);
    if (!songs.has(key)) songs.set(key, { key, title: f.title, versions: [] });
    songs.get(key).versions.push({ ...f, kind: versionKind(f.title) });
  }
  for (const s of songs.values()) {
    const order = ['master', 'mix', 'clean', 'instrumental', 'acapella', 'original', 'demo'];
    s.versions.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || String(b.uploaded_at || '').localeCompare(String(a.uploaded_at || '')));
    s.title = s.versions[0].title.replace(VERSION_WORDS, ' ').replace(/\s+/g, ' ').replace(/\.[a-z0-9]{2,4}$/i, '').trim();
  }
  return { songs: [...songs.values()], duplicates };
}

// ─── Measured features and the curator ────────────────────────────────────

/// The analysed numbers of a song's best version (master, else mix, else original).
export function features(project) {
  const versions = project?.music?.versions || [];
  const pick = ['master', 'mix', 'original'].map((k) => versions.find((v) => v.kind === k && v.analysis?.analysed)).find(Boolean);
  if (!pick) return null;
  const a = pick.analysis;
  return { id: project.id, title: project.title, lufs: a.loudness_lufs, bpm: a.tempo_bpm, bpm_confidence: a.tempo_confidence, brightness: a.brightness_hz, lra: a.loudness_range_lu, seconds: a.duration_s, sample_rate: a.sample_rate, version: pick.label || pick.kind };
}

// Tempo distance that treats half and double time as close (70 and 140 BPM share a groove).
function bpmDistance(a, b) {
  if (!a || !b) return 0.5;
  const r = Math.max(a, b) / Math.min(a, b);
  const folded = Math.min(Math.abs(Math.log2(r)), Math.abs(Math.log2(r) - 1));
  return Math.min(1, folded / 0.25);
}

/// How different two songs measure, 0 (same) to about 1. Every part is a stored measurement.
export function distance(a, b) {
  const loud = Math.min(1, Math.abs((a.lufs ?? -14) - (b.lufs ?? -14)) / 6);
  const bright = Math.min(1, Math.abs(Math.log2((a.brightness || 2000) / (b.brightness || 2000))) / 1);
  const dyn = Math.min(1, Math.abs((a.lra ?? 6) - (b.lra ?? 6)) / 8);
  return 0.35 * bpmDistance(a.bpm, b.bpm) + 0.25 * bright + 0.2 * loud + 0.2 * dyn;
}

/// Energy for sequencing: louder, brighter, faster songs sit higher. A measurement, not a quality judgment.
export function energy(f) {
  const loud = ((f.lufs ?? -14) + 24) / 18;
  const bright = Math.log2((f.brightness || 2000) / 500) / 4;
  const pace = ((f.bpm || 100) - 70) / 110;
  return Math.round((0.45 * loud + 0.3 * bright + 0.25 * pace) * 100) / 100;
}

/// The most cohesive group of `size` songs: start from the song closest to all others, then add the
/// nearest to the group. Songs with no analysis are left out and listed.
export function cohesiveSet(projects, size) {
  const feats = projects.map(features);
  const ok = feats.filter(Boolean);
  const missing = projects.filter((_, i) => !feats[i]).map((p) => p.title);
  if (ok.length < size) return { chosen: [], missing, why: `Only ${ok.length} analysed song${ok.length === 1 ? '' : 's'}; ${size} are needed.` };
  const avgTo = (f, set) => set.reduce((s, g) => s + distance(f, g), 0) / Math.max(1, set.length);
  const seed = ok.slice().sort((a, b) => avgTo(a, ok) - avgTo(b, ok))[0];
  const chosen = [seed];
  while (chosen.length < size) {
    const next = ok.filter((f) => !chosen.includes(f)).sort((a, b) => avgTo(a, chosen) - avgTo(b, chosen))[0];
    chosen.push(next);
  }
  const left = ok.filter((f) => !chosen.includes(f));
  return { chosen, left, missing };
}

/// An intentional arc, not a score sort: a strong opener, rising momentum, the peak around 60%,
/// a breathing moment after it, and a closer below the peak.
export function sequence(feats) {
  if (feats.length <= 2) return feats.slice().sort((a, b) => energy(b) - energy(a));
  const byEnergy = feats.slice().sort((a, b) => energy(b) - energy(a));
  const peak = byEnergy[0];
  const calm = byEnergy[byEnergy.length - 1];
  const rest = byEnergy.slice(1, -1);
  const opener = rest.shift();
  const closer = rest.length ? rest.splice(Math.floor(rest.length / 2), 1)[0] : null;
  const rising = rest.slice().sort((a, b) => energy(a) - energy(b));
  const peakAt = Math.max(0, Math.round(feats.length * 0.6) - 2);
  const before = rising.slice(0, peakAt);
  const after = rising.slice(peakAt);
  return [opener, ...before, peak, calm, ...after, closer].filter(Boolean);
}

/// What happens between two neighbours, from measurements. Flags are reasons to listen, not verdicts.
export function transition(a, b) {
  const notes = [];
  const dLoud = (b.lufs ?? 0) - (a.lufs ?? 0);
  if (Math.abs(dLoud) >= 2) notes.push(`${Math.abs(dLoud).toFixed(1)} dB ${dLoud > 0 ? 'louder' : 'quieter'}`);
  if (a.bpm && b.bpm && bpmDistance(a.bpm, b.bpm) >= 0.6) notes.push(`tempo jumps from ${Math.round(a.bpm)} to ${Math.round(b.bpm)} BPM`);
  const dE = energy(b) - energy(a);
  const direction = dE > 0.08 ? 'energy rises' : dE < -0.08 ? 'energy drops' : 'energy holds';
  const same = distance(a, b) < 0.08;
  if (same) notes.push('these two measure almost the same; they may compete for one slot');
  return { from: a.title, to: b.title, direction, notes, clash: Math.abs(dLoud) >= 3 || (a.bpm && b.bpm && bpmDistance(a.bpm, b.bpm) >= 0.9) };
}

/// Songs that measure nearly the same (likely to compete for one role). Similarity is about sound only.
export function redundantPairs(feats, threshold = 0.08) {
  const out = [];
  for (let i = 0; i < feats.length; i++) for (let j = i + 1; j < feats.length; j++) {
    const d = distance(feats[i], feats[j]);
    if (d < threshold) out.push({ a: feats[i].title, b: feats[j].title, distance: Math.round(d * 100) / 100 });
  }
  return out;
}

/// Before release: every master against the project's median. Each finding names its numbers.
export function consistencyCheck(feats) {
  const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const mLufs = median(feats.map((f) => f.lufs));
  const mBright = median(feats.map((f) => f.brightness));
  const rates = new Set(feats.map((f) => f.sample_rate));
  const findings = [];
  for (const [i, f] of feats.entries()) {
    const parts = [];
    if (Number.isFinite(f.lufs) && Math.abs(f.lufs - mLufs) >= 1.5) parts.push(`about ${Math.abs(f.lufs - mLufs).toFixed(1)} dB ${f.lufs > mLufs ? 'louder' : 'quieter'}`);
    if (f.brightness && mBright && Math.abs(Math.log2(f.brightness / mBright)) >= 0.25) parts.push(f.brightness > mBright ? 'noticeably brighter' : 'noticeably darker');
    if (parts.length) findings.push({ track: i + 1, title: f.title, text: `Track ${i + 1} (${f.title}) sounds ${parts.join(' and ')} than the rest of the project.` });
  }
  if (rates.size > 1) findings.push({ track: null, title: null, text: `The masters use different sample rates: ${[...rates].join(', ')} Hz.` });
  return { target_lufs: mLufs, findings, consistent: findings.length === 0 };
}

// ─── EP / album projects (ordinary projects) ──────────────────────────────

/// A proposed EP or album from the owner's catalog only. Nothing is saved until the owner keeps it.
export function proposeCollection(projects, { kind = 'EP', size = 5 } = {}) {
  const catalog = myCatalog(projects);
  const set = cohesiveSet(catalog, size);
  if (!set.chosen.length) return { ok: false, why: set.why, missing_analysis: set.missing };
  const order = sequence(set.chosen);
  const flow = order.slice(1).map((b, i) => transition(order[i], b));
  const bpms = order.map((f) => f.bpm).filter(Boolean);
  const lufs = order.map((f) => f.lufs).filter(Number.isFinite);
  const reasons = [
    bpms.length ? `Tempos ${Math.round(Math.min(...bpms))}–${Math.round(Math.max(...bpms))} BPM (half and double time counted as close)` : null,
    lufs.length ? `Loudness within ${(Math.max(...lufs) - Math.min(...lufs)).toFixed(1)} dB` : null,
    `Sequenced as an arc: opener, rising energy, peak near ${Math.round(order.length * 0.6)}, a breathing track, then the closer`,
  ].filter(Boolean);
  const seconds = order.reduce((s, f) => s + (f.seconds || 0), 0);
  return {
    ok: true, kind, tracks: order.map((f) => ({ id: f.id, title: f.title, seconds: f.seconds, bpm: f.bpm, lufs: f.lufs, energy: energy(f) })),
    total_seconds: Math.round(seconds), reasons, flow, redundant: redundantPairs(order), left_out: set.left.map((f) => f.title), missing_analysis: set.missing,
    note: 'Built from measured loudness, tempo, brightness and dynamics. Hooks, lyrics and song strength are not judged yet.',
  };
}

export function saveCollection(data, proposal, { title, now = new Date().toISOString() } = {}) {
  const project = {
    id: `collection_${crypto.randomUUID()}`, type: 'music_collection', title: title || `${proposal.kind} idea`, status: 'draft', created_at: now,
    brief: `${proposal.tracks.length} tracks, ${Math.floor(proposal.total_seconds / 60)}:${String(proposal.total_seconds % 60).padStart(2, '0')}`,
    collection: { kind: proposal.kind, track_ids: proposal.tracks.map((t) => t.id), transitions: {}, reasons: proposal.reasons },
  };
  data.projects = Array.isArray(data.projects) ? data.projects : [];
  data.projects.unshift(project);
  return project;
}

/// "Move Up / Move Down", "put Pressure after Midnight", "take that song out". Only catalog songs.
export function reorder(collection, op, projects) {
  const ids = collection.collection.track_ids.slice();
  const idOf = (title) => (projects.find((p) => p.type === 'music' && String(p.title).toLowerCase() === String(title).toLowerCase()) || {}).id;
  if (op.type === 'move') {
    const i = ids.indexOf(op.id); const j = i + (op.direction === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= ids.length) return { ok: false, why: 'That track cannot move further.' };
    [ids[i], ids[j]] = [ids[j], ids[i]];
  } else if (op.type === 'after') {
    const a = idOf(op.track); const b = idOf(op.after);
    if (!a || !b || !ids.includes(a) || !ids.includes(b)) return { ok: false, why: 'Both songs must already be on this project.' };
    ids.splice(ids.indexOf(a), 1); ids.splice(ids.indexOf(b) + 1, 0, a);
  } else if (op.type === 'remove') {
    const a = op.id || idOf(op.track);
    if (!ids.includes(a)) return { ok: false, why: 'That song is not on this project.' };
    ids.splice(ids.indexOf(a), 1);
  } else if (op.type === 'add') {
    const p = projects.find((x) => x.id === op.id);
    if (!p || !myCatalog([p]).length) return { ok: false, why: 'Only songs in your catalog can go on an EP or album; references and samples cannot.' };
    if (!ids.includes(p.id)) ids.push(p.id);
  } else return { ok: false, why: 'Unknown change.' };
  collection.collection.track_ids = ids;
  return { ok: true, track_ids: ids };
}

/// A transition preview plan: the last seconds of A, the gap, the first seconds of B. The masters are
/// read only; the gap belongs to the album project.
export function transitionPreview(a, b, { tail = 15, head = 15, gap = 2, style = 'gap' } = {}) {
  const fa = features(a); const fb = features(b);
  if (!fa || !fb) return { ok: false, why: 'Both songs need an analysed version first.' };
  return { ok: true, segments: [{ song: a.id, from_s: Math.max(0, fa.seconds - tail), to_s: fa.seconds }, { silence_s: style === 'gap' ? gap : 0 }, { song: b.id, from_s: 0, to_s: Math.min(head, fb.seconds) }], style };
}

/// One release view for an EP/album: every track's own readiness plus the project's consistency.
export function collectionReadiness(collection, projects, now = Date.now()) {
  const tracks = collection.collection.track_ids.map((id) => projects.find((p) => p.id === id)).filter(Boolean);
  const perTrack = tracks.map((p) => ({ title: p.title, ...releaseReadiness(p, now) }));
  const feats = tracks.map(features).filter(Boolean);
  const consistency = feats.length ? consistencyCheck(feats) : { consistent: false, findings: [{ text: 'No analysed masters yet.' }] };
  const open = perTrack.filter((t) => !t.ready);
  return { ready: !open.length && consistency.consistent, tracks: perTrack, consistency, missing: [...open.map((t) => `${t.title}: ${t.primary_action}`), ...consistency.findings.map((f) => f.text)] };
}
