// CHE World population (world_population.js): records are deterministic seeded descriptions stored as a range; every
// record maps to one of 288 shared base-model buckets; only buckets get generated models, queued through the existing
// person_model job; the Worker never claims an active-character count.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUCKET_COUNT, BUCKETS_KEY, DEFAULT_WORLD, MAX_PAGE, SCHEMA_VERSION, SKIN_TONES, WORLD_KEY, bucketAt, bucketIndex, bucketPreset,
  expandRecord, populationAnswer, recordPreset, worldPopulationIntent, worldRoute,
} from './world_population.js';
import { FACE_TARGETS, HAIR_STYLES, STYLES, skinOk, validate } from './avatar_identity.js';
import { CHARACTER_VOICES, CreationStudio, describePerson, shapeErrors } from './creation_studio.js';

function memStorage() {
  const m = new Map();
  return { m, get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async (k) => m.delete(k) };
}
function setup() {
  const storage = memStorage();
  const t = Date.parse('2026-10-25T12:00:00Z');
  const makeStudio = () => new CreationStudio(storage, () => t, { env: {}, fetcher: async () => new Response('{}', { status: 404 }) });
  const call = async (path, method = 'GET', body) => {
    const req = new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await worldRoute({ storage, makeStudio }, path.split('?')[0], req, body || {});
    return { status: res.status, body: await res.json() };
  };
  return { storage, makeStudio, call };
}

test('same seed and schema give the identical record; neighbouring seeds differ', () => {
  const a = expandRecord(12345); const b = expandRecord(12345);
  assert.deepEqual(a, b);
  assert.equal(a.schema_version, SCHEMA_VERSION);
  assert.notDeepEqual(expandRecord(1), expandRecord(2));
  // A fixed golden so a silent change to the generator (without a schema bump) fails here.
  const g = expandRecord(1);
  assert.deepEqual({ name: g.name, style: g.style, bucket: g.bucket.key, skin: g.skin.tone, voice: g.voice.name },
    { name: 'Kadan', style: 'hybrid', bucket: 'hybrid.masculine_slim.bun_high.jacket', skin: '#a06a44', voice: 'American Masculine — Michael' },
    'seed 1 changed: bump SCHEMA_VERSION and update this golden');
  assert.throws(() => expandRecord(-1)); assert.throws(() => expandRecord(2 ** 32)); assert.throws(() => expandRecord(1.5));
});

test('every expanded record is a valid identity preset within the schema ranges', () => {
  const sliders = new Map(FACE_TARGETS.map(([k, , neg]) => [k, neg === null ? 0 : -1]));
  for (let s = 0; s < 3000; s += 1) {
    const r = expandRecord(s * 7919 + 3);
    assert.deepEqual(validate(recordPreset(r)), [], `seed ${r.seed}`);
    assert.ok(STYLES.includes(r.style) && HAIR_STYLES.includes(r.hair.style));
    for (const [k, v] of Object.entries(r.face)) assert.ok(v >= sliders.get(k) && v <= 1, `${k}=${v}`);
    assert.ok(r.body.age >= 0 && r.body.age <= 0.3 && r.body.sex >= 0 && r.body.sex <= 1);
    assert.ok(Math.abs(Object.values(r.body.race).reduce((x, y) => x + y, 0) - 1) < 0.011);
    assert.ok(r.body.height_scale >= 0.92 && r.body.height_scale <= 1.08);
    // Create Person's character voices (CHARACTER_VOICES); voice 0 stays CHE's own; masculine bodies get masculine voices.
    const v = CHARACTER_VOICES.find((x) => x.id === r.voice.id);
    assert.ok(v && v.id !== 0 && v.name === r.voice.name && v.speaker === r.voice.speaker && r.voice.catalog === 'character_voices');
    assert.match(v.name, r.body.sex < 0.5 ? /Feminine/ : /Masculine/);
    assert.deepEqual(shapeErrors(r.shape), [], `shape ${JSON.stringify(r.shape)}`);
    assert.equal(bucketIndex(r.bucket.key), r.bucket.index);
  }
  assert.ok(SKIN_TONES.length >= 8 && SKIN_TONES.every(([, h]) => skinOk(h)));
});

test('a record\'s description reads back through Create Person (describePerson) to the same look', () => {
  for (let s = 1; s <= 400; s += 1) {
    const r = expandRecord(s * 104729);
    const d = describePerson(r.description);
    assert.equal(d.ok, true, r.description);
    assert.equal(d.style, r.style, r.description);
    assert.equal(d.params.body.sex, r.body.sex < 0.5 ? 0 : 1, r.description);
    assert.equal(d.params.hair.style, r.hair.style, r.description);
    assert.equal(d.params.hair.color, r.hair.color, r.description);
    assert.equal(d.params.skin.tone, r.skin.tone, r.description);
    assert.equal(d.params.eyes.iris, r.eyes.iris, r.description);
    assert.equal(d.params.outfit.color, r.outfit.color, r.description);
    assert.deepEqual(d.unused, [], r.description);
  }
});

test('buckets are bounded (288), round-trip, and records spread across them', () => {
  assert.equal(BUCKET_COUNT, 288);
  for (let i = 0; i < BUCKET_COUNT; i += 1) {
    const k = bucketAt(i); assert.equal(bucketIndex(k), i);
    const b = bucketPreset(k); assert.deepEqual(validate(b.preset), [], k);
  }
  assert.equal(bucketAt(288), null); assert.equal(bucketIndex('photoreal.x.long_wavy.jacket'), -1); assert.equal(bucketPreset('nope'), null);
  const seen = new Set(); for (let s = 1; s <= 20000; s += 1) seen.add(expandRecord(s).bucket.index);
  assert.ok(seen.size > 280, `20,000 records use ${seen.size} buckets`);
});

test('a population is a range: one small stored value no matter the count', async () => {
  const { storage, call } = setup();
  const set = await call('/api/world/population', 'POST', { world: 'che_world', seed_start: 1, count: 1_000_000_000 });
  assert.equal(set.status, 200);
  assert.ok(JSON.stringify(storage.m.get(WORLD_KEY)).length < 200, 'stored as a range, not a list');
  assert.match(set.body.spoken, /1,000,000,000 character records\. Records are descriptions only; no model was built/);
  assert.equal((await call('/api/world/population', 'POST', { seed_start: 2 ** 32 - 1, count: 2 })).status, 422);
  const page = await call('/api/world/population?offset=999999990&limit=5');
  assert.equal(page.body.records.length, 5);
  assert.equal(page.body.records[0].seed, 999999991);
  assert.deepEqual(page.body.records[0], (await call('/api/world/population?offset=999999990&limit=1')).body.records[0], 'expanded on read, identical each time');
  assert.equal((await call(`/api/world/population?limit=${MAX_PAGE + 50}`)).body.records.length, MAX_PAGE);
});

test('counts keep records, generated models and active characters apart', async () => {
  const { call } = setup();
  const r = await call('/api/world/population?limit=2');
  assert.equal(r.status, 200);
  assert.equal(r.body.counts.records, DEFAULT_WORLD.count);
  assert.equal(r.body.counts.buckets_total, 288);
  assert.equal(r.body.counts.models_generated, 0);
  assert.equal(r.body.counts.active, null, 'the Worker never claims an active count');
  assert.match(r.body.spoken, /100,000 character records: seeded descriptions, not built models\. 0 of 288 shared base models are generated/);
  assert.match(r.body.spoken, /known only while the world viewer is open/);
});

test('one record reads in full; overrides are stored sparsely, re-validated and applied on read', async () => {
  const { storage, call } = setup();
  const one = await call('/api/world/record/42');
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.record, expandRecord(42));
  assert.equal(one.body.model.state, 'not_generated');
  assert.equal((await call('/api/world/record/0')).status, 404, 'seed 0 is outside the default range (starts at 1)');
  const bad = await call('/api/world/record/42', 'POST', { overrides: { skin: { tone: '#ffffff' } } });
  assert.equal(bad.status, 422);
  const ok = await call('/api/world/record/42', 'POST', { overrides: { name: 'Juno', hair: { style: 'afro' } } });
  assert.equal(ok.status, 200);
  assert.deepEqual(storage.m.get('world:overrides:che_world'), { 42: { name: 'Juno', hair: { style: 'afro' } } });
  const after = await call('/api/world/record/42');
  assert.equal(after.body.record.name, 'Juno');
  assert.equal(after.body.record.hair.style, 'afro');
  assert.match(after.body.record.bucket.key, /\.afro\./);
});

test('generate bucket queues the existing person_model job once, at normal priority, and counts only completed models', async () => {
  const { storage, makeStudio, call } = setup();
  const key = 'hybrid.masculine_full.long_wavy.hoodie';
  const g = await call(`/api/world/buckets/${key}/generate`, 'POST', {});
  assert.equal(g.status, 202, JSON.stringify(g.body));
  const jobs = await makeStudio().queue.jobs();
  const j = jobs.find((x) => x.id === g.body.job.id);
  assert.equal(j.kind, 'person_model'); assert.equal(j.priority, 'normal'); assert.equal(j.settings.STYLE, 'hybrid'); assert.equal(j.settings.HAIR_STYLE, 'long_wavy');
  assert.equal(j.queued_by, 'CHE World population');
  assert.equal(j.settings.BODY_WEIGHT, '0.65', 'full build: Create Person BODY_* settings');
  assert.equal(j.settings.OUTFIT_TOP, 'hoodie');
  const again = await call(`/api/world/buckets/${key}/generate`, 'POST', {});
  assert.equal(again.body.duplicate, true);
  assert.equal((await call('/api/world/buckets/not.a.bucket.key/generate', 'POST', {})).status, 404);
  const closeCrop = await call('/api/world/buckets/stylized.feminine_slim.afro.jacket/generate', 'POST', {});
  assert.match(closeCrop.body.spoken, /renders close-cropped/);
  let buckets = await call('/api/world/buckets');
  assert.equal(buckets.body.counts.building, 2); assert.equal(buckets.body.counts.generated, 0);
  // Mark the job completed with a model, as the queue does after the runner verified the GLB.
  const all = await makeStudio().queue.jobs();
  const done = all.find((x) => x.id === g.body.job.id); done.state = 'completed'; done.model = { key: 'gpu/models/x.glb', bytes: 1959512, sha256: 'a' };
  await makeStudio().queue.save(all);
  buckets = await call('/api/world/buckets');
  assert.equal(buckets.body.counts.generated, 1);
  assert.ok(storage.m.get(BUCKETS_KEY)[key].job_id);
  const ans = await populationAnswer(storage, makeStudio().queue);
  assert.match(ans.spoken, /1 of 288 shared base models are generated, 1 building/);
});

test('one resident becomes a Live Studio creation through describe-a-person, not built until asked', async () => {
  const { makeStudio, call } = setup();
  const out = await call('/api/world/record/7/create', 'POST', {});
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.description, expandRecord(7).description);
  assert.notEqual(out.body.generated, true);
  const list = await makeStudio().list();
  assert.equal(list.projects.length, 1);
  assert.equal(list.projects[0].title, expandRecord(7).name);
  assert.equal((await call('/api/world/record/0/create', 'POST', {})).status, 404);
});

test('spoken intent: how many characters live in CHE World', () => {
  for (const said of ['How many characters live in CHE World?', 'how many people are in Che world', 'CHE World population count', 'world population', 'Read the world population.']) {
    assert.deepEqual(worldPopulationIntent(said), { command: 'world-population' }, said);
  }
  for (const said of ['how many characters are in this book', 'open CHE World', 'what is the population of Phoenix']) assert.equal(worldPopulationIntent(said), null, said);
});
