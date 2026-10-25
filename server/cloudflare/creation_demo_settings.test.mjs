// Description -> job settings for the Create button (describePerson), and the Create Room demo built from exactly those
// settings. The first demo hand-wrote its settings: "warm brown skin, a woman in her thirties" was built with no hair
// style (a scalp cap that read as a helmet), age 27 (MATURE 0.05), and "terracotta" was not a colour, so the outfit
// silently took the next palette colour (olive). These tests pin what the description must turn into.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { COLOURS, EYE_COLOURS, SKIN_TONES, ageMacro, describePerson, personExtras, shapeSettings } from './creation_studio.js';
import { HAIR_BUILT, toSettings } from './avatar_identity.js';
import { demoBase } from '../../tools/demo/describe_settings.mjs';

const rgb = (hex) => [1, 3, 5].map((i) => String(parseInt(hex.slice(i, i + 2), 16))).join(',');
const settingsOf = (text, style = 'photoreal') => {
  const d = describePerson(text);
  assert.ok(d.ok, d.detail);
  return { d, s: { ...toSettings(d.params, style), ...shapeSettings(d.shape), ...personExtras({ params: d.params }) } };
};

test('the demo description maps skin tone, age, gender, hair, eyes and clothes', () => {
  const spec = JSON.parse(readFileSync(new URL('../../tools/demo/characters.json', import.meta.url), 'utf8'));
  const { d, s } = settingsOf(spec.description);
  assert.equal(s.TARGET_SRGB, rgb(SKIN_TONES.brown), 'warm brown skin -> the brown skin albedo');
  assert.equal(s.SEX, '0', 'a woman');
  assert.equal(s.BODY_AGE, String(ageMacro(35)), 'in her (early) thirties -> about 35, MakeHuman age macro');
  assert.ok(Number(s.BODY_AGE) > ageMacro(30), 'built older than 30, not the 27-year-old default');
  assert.ok(HAIR_BUILT.includes(s.HAIR_STYLE) && s.HAIR_STYLE !== 'close_crop', 'a built hair style, not the bare scalp cap');
  assert.equal(s.HAIR_SRGB, rgb(COLOURS['dark brown']));
  assert.equal(s.IRIS_SRGB, rgb(EYE_COLOURS['green-brown']), 'green-brown eyes');
  assert.equal(s.OUTFIT_SRGB, rgb(COLOURS.terracotta), 'terracotta is a colour, not the next palette entry');
  assert.equal(s.TROUSERS_SRGB, rgb(COLOURS.charcoal), 'charcoal trousers reach the job (TROUSERS_SRGB)');
  assert.match(s.FACE, /head\/head-round=0\.2/, 'a round face');
  assert.deepEqual(d.unsupported, []);
});

test("the demo's characters.json base is exactly what the Create button would queue for its description", () => {
  const spec = JSON.parse(readFileSync(new URL('../../tools/demo/characters.json', import.meta.url), 'utf8'));
  assert.deepEqual(spec.base, demoBase(spec.description), 'run: node tools/demo/describe_settings.mjs --write');
  for (const style of ['photoreal', 'hybrid', 'stylized']) assert.equal(spec.jobs[style].STYLE, style);
  assert.ok(!('MATURE' in spec.base) || Number(spec.base.BODY_AGE) > 0.55, 'the age comes from BODY_AGE');
});

test('other descriptions: man, older, dark skin, afro; pale woman with a bun; unknown colours never pick a random one', () => {
  let { s } = settingsOf('a man in his fifties with dark skin and an afro, navy hoodie, blue jeans');
  assert.equal(s.SEX, '1'); assert.equal(s.BODY_AGE, String(ageMacro(55))); assert.equal(s.TARGET_SRGB, rgb(SKIN_TONES.dark));
  assert.equal(s.HAIR_STYLE, 'afro'); assert.equal(s.OUTFIT_SRGB, rgb(COLOURS.navy)); assert.equal(s.TROUSERS_SRGB, rgb(COLOURS.blue));
  ({ s } = settingsOf('a woman aged 24, pale skin, blonde hair in a bun, olive jacket'));
  assert.equal(s.SEX, '0'); assert.equal(s.BODY_AGE, String(ageMacro(24))); assert.equal(s.TARGET_SRGB, rgb(SKIN_TONES.pale));
  assert.equal(s.HAIR_STYLE, 'bun_high'); assert.equal(s.HAIR_SRGB, rgb(COLOURS.blonde)); assert.equal(s.OUTFIT_SRGB, rgb(COLOURS.olive));
  ({ s } = settingsOf('a woman in a burgundy sweater, khaki trousers'));
  assert.equal(s.OUTFIT_SRGB, rgb(COLOURS.burgundy)); assert.equal(s.TROUSERS_SRGB, rgb(COLOURS.khaki)); assert.equal(s.OUTFIT_TOP, 'sweater');
});

test('the look is carried per job: three looks, one identity', () => {
  const spec = JSON.parse(readFileSync(new URL('../../tools/demo/characters.json', import.meta.url), 'utf8'));
  const looks = ['photoreal', 'hybrid', 'stylized'].map((st) => settingsOf(spec.description, st).s);
  assert.deepEqual(looks.map((x) => x.STYLE), ['photoreal', 'hybrid', 'stylized']);
  for (const x of looks) { assert.equal(x.TARGET_SRGB, looks[0].TARGET_SRGB); assert.equal(x.HAIR_STYLE, looks[0].HAIR_STYLE); }
});
