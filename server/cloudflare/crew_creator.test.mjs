// Crew Creator (crew_creator.js). Offline; synthetic bytes stand in for the owner's pictures, which are never in the
// repository.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CREW_IDS, MAX_REFS, MAX_REF_BYTES, addReference, crewIntent, crewProfiles, crewTurn, crewRoute, loadProfile, ownerPortrait, referenceFromMedia, removeReference, revertProfile, setPrimary, speakCrew, allProfiles, updateProfile } from './crew_creator.js';
import { CREW_BIBLE } from './film_cast.js';

function memory() {
  const kv = new Map();
  return { kv, get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : undefined), put: async (k, v) => { kv.set(k, structuredClone(v)); }, delete: async (k) => kv.delete(k) };
}
function bucket() {
  const objects = new Map();
  return { objects,
    put: async (k, v) => { objects.set(k, new Uint8Array(v)); },
    get: async (k) => (objects.has(k) ? { size: objects.get(k).length, httpMetadata: {}, arrayBuffer: async () => objects.get(k).slice().buffer } : null),
    head: async (k) => (objects.has(k) ? { size: objects.get(k).length, httpMetadata: {} } : null),
    delete: async (k) => objects.delete(k) };
}
const jpeg = (n = 0) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, ...new Array(64).fill(n), 0xff, 0xd9]);
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(32).fill(1)]);
const NOW = Date.parse('2026-11-07T19:00:00Z');

test('every crew member starts from the owner\'s blended design, with "Add the reference picture"', async () => {
  const storage = memory();
  const all = await allProfiles(storage);
  assert.deepEqual(all.map((p) => p.id), [...CREW_IDS]);
  assert.equal(CREW_IDS.length, 10);
  for (const p of all) {
    assert.equal(p.look, CREW_BIBLE[p.id].look);
    assert.ok(p.personality && p.catchphrase && p.tells && p.voice, p.id);
  }
  assert.match(speakCrew(all), /^0 of 10 crew have their reference picture\. Still to add: CHE, Nova/);
  assert.deepEqual(await crewProfiles(storage), {}, 'nothing edited yet, so films follow the design');
});

test('pictures: JPEG or PNG only, at most 8 MB and six each; the first is the face; undo and revert never lose one', async () => {
  const storage = memory(); const env = { CHE_DATA_BUCKET: bucket() };
  const one = await addReference(env, storage, 'nova', { bytes: jpeg(1), label: 'poster' }, NOW);
  assert.equal(one.ok, true);
  assert.equal(one.profile.has_reference, true);
  assert.match(one.said, /Every new film draws her face from it/);
  assert.match((await addReference(env, storage, 'knox', { bytes: jpeg(9) }, NOW)).said, /draws his face/);
  assert.equal((await addReference(env, storage, 'nova', { bytes: new Uint8Array([1, 2, 3, 4]) }, NOW)).status, 415);
  assert.equal((await addReference(env, storage, 'nova', { bytes: new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]) }, NOW)).status, 415, 'HEIC is named and refused');
  assert.equal((await addReference(env, storage, 'nova', { bytes: new Uint8Array(MAX_REF_BYTES + 1).fill(0xff) }, NOW)).status, 413);
  assert.equal((await addReference(env, storage, 'nobody', { bytes: jpeg() }, NOW)).status, 404);
  const second = await addReference(env, storage, 'nova', { bytes: png() }, NOW);
  assert.equal(second.profile.primary, one.profile.primary, 'a second picture does not replace the face unless asked');
  assert.equal(second.profile.references.find((r) => r.content_type === 'image/png').primary, false);
  assert.equal((await addReference(env, storage, 'nova', { bytes: jpeg(1) }, NOW)).changed, false, 'the same picture twice is kept once');
  for (let i = 2; i < 2 + MAX_REFS - 2; i += 1) assert.equal((await addReference(env, storage, 'nova', { bytes: jpeg(i) }, NOW)).ok, true);
  assert.equal((await addReference(env, storage, 'nova', { bytes: jpeg(99) }, NOW)).status, 409, 'six at most');
  const pngSha = second.profile.references.find((r) => r.content_type === 'image/png').sha256;
  assert.equal((await setPrimary(storage, 'nova', pngSha, NOW)).profile.primary, pngSha);
  const removed = await removeReference(storage, 'nova', pngSha, NOW);
  assert.notEqual(removed.profile.primary, pngSha);
  const undone = await revertProfile(storage, 'nova', null, NOW);
  assert.equal(undone.profile.primary, pngSha, 'undo brings the picture back as the face');
  assert.equal(undone.profile.version, removed.profile.version + 1, 'undo is itself a version');
  assert.equal((await revertProfile(storage, 'nova', 1, NOW)).profile.references.length, 1, 'revert to version 1: the first picture only');
  assert.equal((await revertProfile(storage, 'nova', 999, NOW)).status, 404);
});

test('words: look, personality, catchphrase, colours; bounded; the film cast gets only what the owner edited', async () => {
  const storage = memory();
  const out = await updateProfile(storage, 'mira', { personality: 'x'.repeat(500), catchphrase: 'Numbers don\'t lie.', colours: ['white', 'blue', 7, '', 'a', 'b', 'c', 'd', 'e'], nonsense: 'ignored' }, NOW);
  assert.equal(out.ok, true);
  assert.equal(out.profile.personality.length, 160);
  assert.equal(out.profile.colours.length, 6);
  assert.equal(out.profile.nonsense, undefined);
  assert.equal((await updateProfile(storage, 'mira', { catchphrase: 'Numbers don\'t lie.' }, NOW)).changed, false);
  const edits = await crewProfiles(storage);
  assert.deepEqual(Object.keys(edits), ['mira']);
  assert.equal(edits.mira.catchphrase, 'Numbers don\'t lie.');
  assert.equal(edits.mira.look, CREW_BIBLE.mira.look, 'unedited fields carry the design');
  const first = await revertProfile(storage, 'mira', null, NOW);
  assert.equal(first.profile.catchphrase, CREW_BIBLE.mira.catchphrase, 'undoing the first change goes back to the design');
});

test('voice: open it, edit a member, use the newest library picture; other words are left to the rest of CHE', () => {
  assert.deepEqual(crewIntent('Open the crew creator'), { kind: 'open', member: null });
  assert.deepEqual(crewIntent('Che, show crew creator for Nova'), { kind: 'open', member: 'nova' });
  assert.deepEqual(crewIntent("Edit Nova's look"), { kind: 'edit', member: 'nova' });
  assert.deepEqual(crewIntent('change knox outfit'), { kind: 'edit', member: 'knox' });
  assert.deepEqual(crewIntent('Use this picture for Nova'), { kind: 'use_latest', member: 'nova' });
  assert.deepEqual(crewIntent("Use this as Lyra's reference"), { kind: 'use_latest', member: 'lyra' });
  assert.deepEqual(crewIntent('Who still needs a reference picture?'), { kind: 'status', member: null });
  assert.deepEqual(crewIntent("Use Nova's picture 2 as the face"), { kind: 'primary', member: 'nova', n: 2 });
  assert.deepEqual(crewIntent('use picture two as Knox\'s face'), { kind: 'primary', member: 'knox', n: 2 });
  assert.deepEqual(crewIntent("Remove Lyra's picture 3"), { kind: 'remove', member: 'lyra', n: 3 });
  assert.deepEqual(crewIntent('Go back to version 4 for Iris'), { kind: 'revert', member: 'iris', n: 4 });
  assert.deepEqual(crewIntent('revert Sage to version two'), { kind: 'revert', member: 'sage', n: 2 });
  assert.deepEqual(crewIntent("Read Vale's pictures"), { kind: 'list_pictures', member: 'vale' });
  assert.deepEqual(crewIntent('read the versions for Mira'), { kind: 'list_versions', member: 'mira' });
  assert.equal(crewIntent('remove picture 2'), null, 'no member named: the open Crew Creator takes it for the member on screen');
  for (const other of ['Nova, check the news', 'Make a short story about the office', 'Use this picture for my wallpaper', "Edit the film's look", 'Make Nova walk in and sit down']) assert.equal(crewIntent(other), null, other);
});

test('a library picture becomes a reference; the film copies the face into its own files', async () => {
  const storage = memory(); const env = { CHE_DATA_BUCKET: bucket() };
  assert.equal((await referenceFromMedia(env, storage, 'iris', '', NOW)).status, 404);
  const bytes = jpeg(5);
  env.CHE_DATA_BUCKET.objects.set('media/m1.jpg', bytes);
  await storage.put('media_index', [{ id: 'm1', type: 'image', mime_type: 'image/jpeg', blob: 'r2', blob_key: 'media/m1.jpg', title: 'Iris sheet' }]);
  const used = await referenceFromMedia(env, storage, 'iris', '', NOW);
  assert.equal(used.ok, true, JSON.stringify(used));
  assert.equal(used.profile.references[0].label, 'Iris sheet');
  const media = { put: async (k, v) => { env.CHE_DATA_BUCKET.objects.set(k, v); return { ok: true }; } };
  const portrait = await ownerPortrait(env, storage, media, 'film_0123456789abcdef', 'iris');
  assert.deepEqual(portrait, { done: true, key: 'film/film_0123456789abcdef/cast/iris.jpg', content_type: 'image/jpeg', owner_ref: true, sha256: used.profile.primary });
  assert.deepEqual(env.CHE_DATA_BUCKET.objects.get(portrait.key), bytes);
  assert.equal(await ownerPortrait(env, storage, media, 'film_0123456789abcdef', 'mara'), null, 'someone not in the crew: made from words');
  assert.equal(await ownerPortrait(env, storage, media, 'film_0123456789abcdef', 'sage'), null, 'no picture yet: made from words');
});

test('routes: list, one with history, update, picture, primary, remove, undo, revert; unknown paths are not taken', async () => {
  const storage = memory(); const env = { CHE_DATA_BUCKET: bucket() };
  assert.equal((await crewRoute(env, storage, '/api/crew', 'GET')).body.crew.length, 10);
  assert.equal((await crewRoute(env, storage, '/api/crew/nobody', 'GET')).status, 404);
  assert.equal(await crewRoute(env, storage, '/api/crewmate', 'GET'), null);
  const add = await crewRoute(env, storage, '/api/crew/atlas/reference', 'POST', { image_base64: Buffer.from(jpeg(3)).toString('base64') }, NOW);
  assert.equal(add.status, 200);
  const sha = add.body.profile.primary;
  const pic = await crewRoute(env, storage, `/api/crew/atlas/reference/${sha}`, 'GET');
  assert.deepEqual(pic.bytes, jpeg(3));
  assert.equal(pic.contentType, 'image/jpeg');
  assert.equal((await crewRoute(env, storage, '/api/crew/atlas', 'POST', { voice: 'deep and even' }, NOW)).body.profile.voice, 'deep and even');
  const one = (await crewRoute(env, storage, '/api/crew/atlas', 'GET')).body.profile;
  assert.deepEqual(one.history.map((h) => h.n), [2, 1]);
  assert.equal((await crewRoute(env, storage, '/api/crew/atlas/undo', 'POST', {}, NOW)).body.profile.voice, CREW_BIBLE.atlas.voice);
  assert.equal((await crewRoute(env, storage, '/api/crew/atlas/revert', 'POST', { version: 2 }, NOW)).body.profile.voice, 'deep and even');
  assert.equal((await crewRoute(env, storage, '/api/crew/atlas/remove-reference', 'POST', { sha256: sha }, NOW)).body.profile.has_reference, false);
  assert.equal((await crewRoute(env, storage, '/api/crew/atlas/primary', 'POST', { sha256: 'f'.repeat(64) }, NOW)).status, 404);
  assert.equal((await crewRoute(env, storage, '/api/crew/atlas/undo', 'GET')).status, 405);
  assert.equal((await loadProfile(storage, 'atlas')).history.length, 5);
});

test('spoken numbered commands: choose the face, read pictures and versions, revert; "remove" only asks, never removes', async () => {
  const storage = memory(); const env = { CHE_DATA_BUCKET: bucket() };
  await addReference(env, storage, 'nova', { bytes: jpeg(1), label: 'poster' }, NOW);
  await addReference(env, storage, 'nova', { bytes: jpeg(2), label: 'sheet' }, NOW);
  assert.match((await crewTurn(env, storage, crewIntent("Read Nova's pictures"))).said, /^Nova's pictures: 1\. poster \(the face in films\)\. 2\. sheet\.$/);
  const face = await crewTurn(env, storage, crewIntent("Use Nova's picture 2 as the face"));
  assert.match(face.said, /Nova's face now comes from that picture/);
  const after = await loadProfile(storage, 'nova');
  assert.equal(after.primary, after.refs[1].sha256);
  assert.match((await crewTurn(env, storage, crewIntent("Use Nova's picture 5 as the face"))).said, /^Nova has no picture 5\./);
  const ask = await crewTurn(env, storage, crewIntent("Remove Nova's picture 2"));
  assert.match(ask.said, /^Remove Nova's picture 2\? It is her face in films\. Say yes to remove it/);
  assert.deepEqual(ask.meta.crew_confirm, { action: 'remove', n: 2 });
  assert.equal((await loadProfile(storage, 'nova')).refs.length, 2, 'nothing removed until the owner says yes');
  assert.match((await crewTurn(env, storage, crewIntent('read the versions for Nova'))).said, /^Nova's versions, newest first: 3\. Chose a different reference picture as the face\./);
  assert.match((await crewTurn(env, storage, crewIntent('Go back to version 1 for Nova'))).said, /back to version 1/);
  assert.equal((await loadProfile(storage, 'nova')).refs.length, 1);
});
