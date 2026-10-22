import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSample, evaluateSample, validateSplits, releaseReadiness, defensibility, speakReadiness, RISK,
} from './music_rights.js';
import { specialtyFrom } from './office_workforce.js';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const sha = 'a'.repeat(64);

function song(overrides = {}) {
  return {
    id: 'p1', type: 'music', title: 'Midnight',
    music: {
      versions: [
        { id: 'v1', kind: 'original', label: 'Original', sha256: 'b'.repeat(64), inputs: [{ provenance: 'OWNER_ORIGINAL' }] },
        { id: 'v3', kind: 'master', label: 'Master v1', sha256: sha, inputs: [{ provenance: 'OWNER_ORIGINAL' }, { provenance: 'CHE_GENERATED' }] },
      ],
      artwork: 'art/midnight.png',
      metadata: { artist: 'Owner', title: 'Midnight', genre: 'Hip-Hop', explicit: false },
      splits: [
        { group: 'songwriting', name: 'Owner', percent: 100, agreement: 'signed' },
      ],
      samples: [],
      ...overrides,
    },
  };
}

test('an external sample starts unresolved; nothing found online is assumed free', () => {
  const s = normalizeSample({ name: 'Soul vocal', provenance: 'LICENSED', source: 'a website' });
  const e = evaluateSample(s, NOW);
  assert.equal(e.state, 'unresolved');
  assert.deepEqual(e.missing, ['the licence type', 'the licence text, link or proof of purchase', 'whether commercial use is allowed']);
  assert.equal(evaluateSample(normalizeSample({ name: 'mystery loop' }), NOW).state, 'unresolved', 'unknown origin stays unresolved');
});

test('attaching a valid licence documents the sample; the state follows the record', () => {
  const s = normalizeSample({
    name: 'Soul vocal', provenance: 'LICENSED', source: 'Example Sounds pack', source_url: 'https://example.com/pack',
    license_type: 'Royalty-free pack licence', license_ref: 'https://example.com/licence', commercial_use: true,
    attribution_required: false, proof_ref: 'invoice 1042',
  });
  assert.equal(evaluateSample(s, NOW).state, 'documented');
});

test('licences that do not cover a release are blocked, with the reason', () => {
  const nc = normalizeSample({ name: 'Rain', provenance: 'LICENSED', source: 'freesound', license_type: 'CC BY-NC 4.0', license_ref: 'https://creativecommons.org/licenses/by-nc/4.0/', commercial_use: false });
  assert.equal(evaluateSample(nc, NOW).state, 'blocked');
  assert.match(evaluateSample(nc, NOW).problems.join(' '), /commercial use/);
  const nd = normalizeSample({ name: 'Choir', provenance: 'LICENSED', source: 's', license_type: 'CC BY-ND 4.0', license_ref: 'x', commercial_use: true, modified: true, attribution_required: true, attribution_text: 'Choir by X' });
  assert.match(evaluateSample(nd, NOW).problems.join(' '), /does not allow changes/);
  const expired = normalizeSample({ name: 'Old loop', provenance: 'LICENSED', source: 's', license_type: 'pack', license_ref: 'x', commercial_use: true, expires_at: '2025-01-01' });
  assert.match(evaluateSample(expired, NOW).problems.join(' '), /expired on 2025-01-01/);
  const credit = normalizeSample({ name: 'Bell', provenance: 'LICENSED', source: 's', license_type: 'CC BY 4.0', license_ref: 'x', commercial_use: true, attribution_required: true });
  assert.ok(evaluateSample(credit, NOW).missing.includes('the required credit text'));
});

test('a copyrighted reference track never becomes part of a master by default', () => {
  const ref = normalizeSample({ name: 'Reference song', provenance: 'REFERENCE_ONLY' });
  assert.equal(evaluateSample(ref, NOW).state, 'blocked', 'used_in_master defaults to true, so it must be marked out explicitly');
  assert.equal(evaluateSample({ ...ref, used_in_master: false }, NOW).state, 'reference');
});

test('splits: shares are checked per group and never invented', () => {
  const short = validateSplits([
    { group: 'songwriting', name: 'Owner', percent: 60, agreement: 'signed' },
    { group: 'songwriting', name: 'Feature', percent: 30, agreement: 'signed' },
  ]);
  assert.equal(short.ok, false);
  assert.ok(short.issues.includes('Songwriting shares total 90%, not 100%.'));
  const missing = validateSplits([
    { group: 'master', name: 'Owner', percent: 50, agreement: 'signed' },
    { group: 'master', name: 'Producer', agreement: 'pending' },
  ]);
  assert.ok(missing.issues.some((i) => /no share recorded for Producer/.test(i)));
  assert.ok(!missing.issues.some((i) => /total 50%/.test(i)), 'a missing share is reported as missing, not as a wrong total');
  assert.ok(missing.issues.some((i) => /no signed agreement on file for Producer/.test(i)));
  assert.deepEqual(validateSplits([]).issues, ['No collaborators or splits are recorded.']);
  assert.equal(validateSplits([{ group: 'songwriting', name: 'Owner', percent: 100, agreement: 'signed' }]).ok, true);
});

test('release readiness blocks an unresolved sample and names the next step', () => {
  const p = song({ samples: [normalizeSample({ name: 'Soul vocal', provenance: 'LICENSED', source: 'site' })] });
  const r = releaseReadiness(p, NOW);
  assert.equal(r.status, 'NOT READY');
  assert.equal(r.items.find((i) => i.id === 'samples').ok, false);
  assert.equal(r.primary_action, 'Resolve sample');
  const spoken = speakReadiness(r, 'Midnight');
  assert.match(spoken, /not ready to release/);
  assert.match(spoken, /Soul vocal/);
  assert.doesNotMatch(spoken, /\bsafe\b|guarantee|cannot be sued|legally protected|copyright-proof/i);
});

test('after the licence is attached the song is READY, and the release still waits for the owner', () => {
  const licensed = normalizeSample({ name: 'Soul vocal', provenance: 'LICENSED', source: 'pack', license_type: 'Royalty-free', license_ref: 'invoice 1042', commercial_use: true });
  const r = releaseReadiness(song({ samples: [licensed] }), NOW);
  assert.equal(r.status, 'READY');
  assert.equal(r.needs_owner_approval, true);
  assert.equal(r.primary_action, 'Approve release');
  assert.match(speakReadiness(r, 'Midnight'), /Nothing is released until you approve it/);
});

test('readiness: no master file, missing metadata and unknown-origin master inputs each block', () => {
  const noMaster = releaseReadiness(song({ versions: [{ id: 'v1', kind: 'original', sha256: sha }] }), NOW);
  assert.equal(noMaster.items.find((i) => i.id === 'master').ok, false);
  const meta = releaseReadiness(song({ metadata: { artist: 'Owner', title: 'Midnight' } }), NOW);
  assert.match(meta.items.find((i) => i.id === 'metadata').detail, /genre, explicit/);
  const unknown = releaseReadiness(song({ versions: [{ id: 'm', kind: 'master', sha256: sha, inputs: [{ provenance: 'UNKNOWN' }] }] }), NOW);
  assert.equal(unknown.items.find((i) => i.id === 'inputs').ok, false);
});

test('"can we defend this?" is a risk class from the records, never a predicted outcome', () => {
  assert.equal(defensibility(song(), NOW).risk, RISK.lower);
  const unresolved = defensibility(song({ samples: [normalizeSample({ name: 'loop' })] }), NOW);
  assert.equal(unresolved.risk, RISK.higher);
  const blocked = defensibility(song({ samples: [normalizeSample({ name: 'ref', provenance: 'REFERENCE_ONLY' })] }), NOW);
  assert.equal(blocked.risk, RISK.attorney);
  assert.match(blocked.note, /licensed attorney/);
  assert.equal(defensibility(song({ versions: [] }), NOW).risk, RISK.unclear);
  for (const d of [unresolved, blocked]) assert.doesNotMatch(`${d.note} ${d.factors.join(' ')}`, /will win|cannot be sued|guarantee/i);
});

test('Legal and Music Manager are Office roles CHE can staff', () => {
  assert.equal(specialtyFrom('hire a legal research agent for copyright and contracts'), 'legal');
  assert.equal(specialtyFrom('add a music manager to my team'), 'music_manager');
  assert.equal(specialtyFrom('hire a coding specialist'), 'coding');
  assert.equal(specialtyFrom('find me research on markets'), 'research');
});

// Review on #455 (Codex): unknown split groups, overlapping titles, recording versions, voice/typed writes.
import { applyRightsAction, songFor, musicRightsWriteIntent, applySpokenRightsWrite } from './music_rights.js';

test('a split row with an unrecognised group never passes as reconciled', () => {
  const r = validateSplits([{ group: 'songwritting', name: 'Owner', percent: 100, agreement: 'signed' }]);
  assert.equal(r.ok, false);
  assert.match(r.issues.join(' '), /no recognised group/);
});

test('the longest title the owner names wins ("Love Again" is never answered as "Love")', () => {
  const data = { projects: [{ id: 'a', type: 'music', title: 'Love' }, { id: 'b', type: 'music', title: 'Love Again' }] };
  assert.equal(songFor(data, 'Is Love Again ready to release?').id, 'b');
  assert.equal(songFor(data, 'Is Love ready to release?').id, 'a');
});

test('versions can be recorded (append only, with a checksum), so a song can reach its Master check', () => {
  const data = { projects: [] };
  const id = applyRightsAction(data, { action: 'create_song', title: 'Midnight' }).body.project.id;
  assert.equal(applyRightsAction(data, { action: 'add_version', project_id: id, version: { kind: 'master', sha256: 'nope' } }).status, 400);
  const v1 = applyRightsAction(data, { action: 'add_version', project_id: id, version: { kind: 'original', sha256: 'b'.repeat(64), inputs: [{ provenance: 'OWNER_ORIGINAL' }] } });
  const v2 = applyRightsAction(data, { action: 'add_version', project_id: id, version: { kind: 'master', label: 'Master v1', sha256: 'a'.repeat(64), inputs: [{ provenance: 'OWNER_ORIGINAL' }], derived_from: v1.body.version.id } });
  assert.equal(v2.status, 200);
  const r = releaseReadiness(data.projects[0], NOW);
  assert.equal(r.items.find((i) => i.id === 'master').ok, true);
  assert.equal(data.projects[0].music.versions.length, 2, 'the original is kept next to the master');
});

test('every rights write works by voice or typing, and says what is still missing', () => {
  const data = { projects: [] };
  const say = (t) => applySpokenRightsWrite(data, musicRightsWriteIntent(t), '2026-10-22T12:00:00Z');
  assert.match(say('CHE, add a song called Midnight').text, /Added the song Midnight/);
  const sample = say('Add a sample called Soul vocal to Midnight from Example Sounds');
  assert.match(sample.text, /not verified yet: it needs the licence type/);
  const splits = say('Set the splits for Midnight: Owner 60, Feature 30, all signed');
  assert.match(splits.text, /Songwriting shares total 90%, not 100%/);
  assert.match(say('Set the splits for Midnight: Owner 60, Feature 40, all signed').text, /reconcile and are signed/);
  const nc = say('Attach the licence for Soul vocal on Midnight: CC BY-NC 4.0 from freesound');
  assert.match(nc.text, /cannot go in a release: The licence does not allow commercial use/);
  const ok = say('Attach the licence for Soul vocal on Midnight: invoice 1042, royalty-free, commercial use allowed');
  assert.match(ok.text, /licence is now documented/);
  assert.match(say('Add a sample called X to Nowhere').text, /could not find a song called Nowhere.*Nothing was changed/);
  assert.equal(musicRightsWriteIntent('What time is it?'), null);
  // The same records drive readiness: add a master, artwork and metadata, and the song is READY.
  const song = data.projects[0];
  applyRightsAction(data, { action: 'add_version', project_id: song.id, version: { kind: 'master', sha256: 'c'.repeat(64), inputs: [{ provenance: 'OWNER_ORIGINAL' }] } });
  applyRightsAction(data, { action: 'set_metadata', project_id: song.id, metadata: { artist: 'Owner', genre: 'Hip-Hop', explicit: false }, artwork: 'art.png' });
  assert.equal(releaseReadiness(song, NOW).status, 'READY');
});
