import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { encodeWav, analyzeWav, gainMatch } from './music_audio.js';
import {
  suggestPurpose, classifyAsset, myCatalog, library, groupVersions, songKey, features, proposeCollection, saveCollection,
  reorder, transitionPreview, consistencyCheck, collectionReadiness, redundantPairs,
} from './music_catalog.js';

const FS = 22050;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// A synthetic song: a kick-like click at `bpm` over a tone whose pitch sets the brightness, at `amp` level.
function songWav({ bpm, amp = 0.3, tone = 220, seconds = 12 }) {
  const n = seconds * FS;
  const x = new Float32Array(n);
  const period = Math.round((60 / bpm) * FS);
  for (let i = 0; i < n; i++) x[i] = amp * 0.25 * Math.sin((2 * Math.PI * tone * i) / FS);
  for (let s = 0; s < n; s += period) for (let i = 0; i < 300 && s + i < n; i++) x[s + i] += amp * Math.exp(-i / 60) * Math.sin(i / 3);
  return encodeWav([x, x], FS);
}

function songProject(id, title, spec, purpose = 'MY_SONG') {
  const wav = songWav(spec);
  return {
    id, type: 'music', title,
    music: {
      purpose, purpose_by_owner: true,
      versions: [{ id: `${id}-m`, kind: 'master', label: 'Master v1', sha256: sha(wav), analysis: analyzeWav(wav) }],
      samples: [], splits: [{ group: 'songwriting', name: 'Owner', percent: 100, agreement: 'signed' }],
      metadata: { artist: 'Owner', title, genre: 'Hip-Hop', explicit: false }, artwork: 'art.png',
    },
    _wav: wav,
  };
}

test('every upload keeps its purpose; references, samples and loops never enter MY CATALOG', () => {
  const projects = [
    songProject('s1', 'Midnight', { bpm: 140 }),
    songProject('r1', 'Famous Reference', { bpm: 140 }, 'REFERENCE_TRACK'),
    songProject('x1', 'Soul Chop', { bpm: 90 }, 'SAMPLE'),
    songProject('l1', 'Drum Loop', { bpm: 90 }, 'LOOP_SOUND'),
    songProject('c1', 'Feature With Erica', { bpm: 120 }, 'COLLABORATION'),
  ];
  assert.deepEqual(myCatalog(projects).map((p) => p.id), ['s1']);
  assert.deepEqual(library(projects, 'REFERENCE_TRACK').map((p) => p.id), ['r1']);
  assert.deepEqual(library(projects, 'SAMPLE').map((p) => p.id), ['x1']);
  // A collaboration joins the catalog only when the owner places it there.
  projects[4].music.in_catalog = true;
  assert.ok(myCatalog(projects).some((p) => p.id === 'c1'));
});

test('purpose from the owner\'s words; uncertain means a question, and an owner label is never overridden', () => {
  assert.equal(suggestPurpose('CHE, add this to my catalog').purpose, 'MY_SONG');
  assert.equal(suggestPurpose('Use this as a reference').purpose, 'REFERENCE_TRACK');
  assert.equal(suggestPurpose('I want to sample this').purpose, 'SAMPLE');
  assert.equal(suggestPurpose('these are my vocals').purpose, 'MY_VOCALS');
  const unsure = suggestPurpose('here is a file');
  assert.equal(unsure.purpose, 'UNKNOWN');
  assert.match(unsure.ask, /What is this\?/);
  assert.ok(suggestPurpose('a feature I did').ask, 'collaborations are asked about, not assumed');
  const labelled = classifyAsset({ id: 'a' }, 'REFERENCE_TRACK', { byOwner: true });
  assert.equal(classifyAsset(labelled, 'MY_SONG').purpose, 'REFERENCE_TRACK', 'a later suggestion cannot turn a reference into the owner\'s song');
  assert.equal(classifyAsset(labelled, 'MY_SONG', { byOwner: true }).purpose, 'MY_SONG', 'the owner can change his own label');
});

test('versions group under one song; exact duplicates are reported, not deleted', () => {
  const g = groupVersions([
    { title: 'Pressure (Master v3).wav', sha256: 'a' },
    { title: 'Pressure mix 4.wav', sha256: 'b' },
    { title: 'Pressure - Instrumental.wav', sha256: 'c' },
    { title: 'Pressure (Clean).wav', sha256: 'd' },
    { title: 'Pressure.wav', sha256: 'e' },
    { title: 'Pressure copy.wav', sha256: 'e' },
    { title: 'Midnight.wav', sha256: 'f' },
  ]);
  const pressure = g.songs.find((s) => s.key === 'pressure');
  assert.equal(g.songs.length, 2, 'two songs, not six projects');
  assert.deepEqual(pressure.versions.map((v) => v.kind), ['master', 'mix', 'clean', 'instrumental', 'original']);
  assert.deepEqual(g.duplicates, [{ file: 'Pressure copy.wav', same_as: 'Pressure.wav' }]);
  assert.equal(songKey('No Sleep (Final Mix v2).wav'), 'no sleep');
});

// Twenty owner songs: two groups that measure differently, plus one reference that would fit perfectly.
function catalogOf20() {
  const projects = [];
  for (let i = 0; i < 12; i++) projects.push(songProject(`d${i}`, `Dark ${i + 1}`, { bpm: 140 + (i % 4), amp: 0.28 + (i % 3) * 0.02, tone: 110 + i * 3 }));
  for (let i = 0; i < 8; i++) projects.push(songProject(`b${i}`, `Bright ${i + 1}`, { bpm: 96 + (i % 3) * 2, amp: 0.5, tone: 1800 + i * 40 }));
  projects.push(songProject('ref', 'Perfect Reference', { bpm: 141, amp: 0.3, tone: 120 }, 'REFERENCE_TRACK'));
  return projects;
}

test('every song in the catalog is analysed from its audio, not its name', () => {
  const projects = catalogOf20();
  for (const p of myCatalog(projects)) {
    const f = features(p);
    assert.ok(f, p.title);
    assert.ok(Number.isFinite(f.lufs));
    assert.ok(f.bpm, `${p.title} has a measured tempo`);
  }
  const dark = features(projects[0]);
  const bright = features(projects[12]);
  assert.ok(Math.abs(dark.bpm - 140) <= 3, `measured ${dark.bpm}`);
  assert.ok(bright.brightness > dark.brightness, 'the bright group measures brighter');
});

test('a 5-track EP is a cohesive group from the catalog only, sequenced as an arc, with measured reasons', () => {
  const projects = catalogOf20();
  const ep = proposeCollection(projects, { kind: 'EP', size: 5 });
  assert.equal(ep.ok, true);
  assert.equal(ep.tracks.length, 5);
  assert.ok(!ep.tracks.some((t) => t.id === 'ref'), 'a reference never becomes an EP track');
  const groups = new Set(ep.tracks.map((t) => t.id[0]));
  assert.equal(groups.size, 1, `one sonic group, not a mix of both (${[...groups]})`);
  assert.ok(ep.reasons.some((r) => /BPM/.test(r)));
  assert.equal(ep.flow.length, 4);
  assert.match(ep.note, /not judged yet/);
  const energies = ep.tracks.map((t) => t.energy);
  assert.notDeepEqual(energies, energies.slice().sort((a, b) => b - a), 'not a plain score sort');
});

test('an album: arc sequence, flow between neighbours, transition previews, reorder, save as a project', () => {
  const projects = catalogOf20();
  const album = proposeCollection(projects, { kind: 'album', size: 12 });
  assert.equal(album.tracks.length, 12);
  for (const step of album.flow) assert.match(step.direction, /energy (rises|drops|holds)/);
  const data = { projects };
  const saved = saveCollection(data, album, { title: 'No Sleep' });
  assert.equal(saved.type, 'music_collection');
  assert.ok(data.projects.includes(saved), 'the album is an ordinary project in the same list');
  const [a, b] = saved.collection.track_ids.map((id) => projects.find((p) => p.id === id));
  const preview = transitionPreview(a, b, { tail: 15, head: 15, gap: 2 });
  assert.equal(preview.ok, true);
  assert.equal(preview.segments[1].silence_s, 2);
  assert.ok(preview.segments[0].to_s - preview.segments[0].from_s <= 15);
  const first = saved.collection.track_ids[0];
  assert.equal(reorder(saved, { type: 'move', id: first, direction: 'down' }, projects).ok, true);
  assert.equal(saved.collection.track_ids[1], first, 'Move Down works without dragging');
  assert.equal(reorder(saved, { type: 'move', id: saved.collection.track_ids[0], direction: 'up' }, projects).ok, false);
  const t3 = projects.find((p) => p.id === saved.collection.track_ids[3]).title;
  const t0 = projects.find((p) => p.id === saved.collection.track_ids[0]).title;
  assert.equal(reorder(saved, { type: 'after', track: t0, after: t3 }, projects).ok, true);
  assert.equal(saved.collection.track_ids[3], projects.find((p) => p.title === t0).id, `${t0} now follows ${t3}`);
  assert.equal(reorder(saved, { type: 'add', id: 'ref' }, projects).ok, false, 'a reference cannot be added to an album');
  assert.equal(reorder(saved, { type: 'remove', track: t3 }, projects).ok, true);
  assert.equal(saved.collection.track_ids.length, 11);
});

test('an inconsistent master is found by its numbers; matching makes a new version and keeps the original', () => {
  const projects = [0, 1, 2, 3].map((i) => songProject(`m${i}`, `Song ${i + 1}`, { bpm: 140, amp: 0.3, tone: 150 }));
  projects.push(songProject('loud', 'Too Hot', { bpm: 140, amp: 0.85, tone: 150 }));
  const feats = projects.map(features);
  const check = consistencyCheck(feats);
  assert.equal(check.consistent, false);
  const finding = check.findings.find((f) => f.title === 'Too Hot');
  assert.match(finding.text, /Track 5 \(Too Hot\) sounds about \d+\.\d dB louder/);
  const hot = projects[4];
  const before = hot.music.versions.slice();
  const original = Uint8Array.from(hot._wav);
  const r = gainMatch(hot._wav, check.target_lufs);
  hot.music.versions.push({ id: 'loud-am', kind: 'album_master', label: 'Album master v1', sha256: sha(r.wav), analysis: analyzeWav(r.wav), derived_from: before[0].id });
  assert.deepEqual(hot._wav, original, 'the source master bytes are unchanged');
  assert.equal(hot.music.versions[0].sha256, before[0].sha256, 'the original version record is unchanged');
  assert.notEqual(hot.music.versions.at(-1).sha256, before[0].sha256);
  assert.ok(Math.abs(hot.music.versions.at(-1).analysis.loudness_lufs - check.target_lufs) < 0.6, 'the new version sits at the project loudness');
});

test('an album carries every track\'s rights and metadata status into one release view', () => {
  const projects = [0, 1, 2].map((i) => songProject(`k${i}`, `Track ${i + 1}`, { bpm: 140 }));
  projects[1].music.samples = [{ id: 's', name: 'Soul vocal', provenance: 'LICENSED', source: 'site', used_in_master: true }];
  delete projects[2].music.metadata.genre;
  const data = { projects };
  const col = saveCollection(data, proposeCollection(projects, { kind: 'EP', size: 3 }), { title: 'Test EP' });
  const r = collectionReadiness(col, data.projects);
  assert.equal(r.ready, false);
  assert.ok(r.missing.some((m) => /Track 2: Resolve sample/.test(m)));
  assert.ok(r.missing.some((m) => /Track 3: Add metadata/.test(m)));
});

test('songs that measure the same are flagged as competing, as a sound measurement only', () => {
  const projects = [songProject('a', 'A', { bpm: 145, amp: 0.3, tone: 120 }), songProject('b', 'B', { bpm: 145, amp: 0.3, tone: 121 }), songProject('c', 'C', { bpm: 96, amp: 0.5, tone: 2000 })];
  const pairs = redundantPairs(projects.map(features));
  assert.deepEqual(pairs.map((p) => [p.a, p.b]), [['A', 'B']]);
});

test('too few analysed songs is said plainly', () => {
  const r = proposeCollection([songProject('a', 'A', { bpm: 140 })], { size: 5 });
  assert.equal(r.ok, false);
  assert.match(r.why, /Only 1 analysed song; 5 are needed/);
});
