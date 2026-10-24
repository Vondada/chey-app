// Character Studio by voice: owner sentences become settings patches, upgrade requests or an open-screen route,
// never a tool grant; unrelated sentences are not studio requests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleStudio, studioIntent } from './character_studio.js';

test('spoken animation requests become per-agent settings patches', () => {
  const walk = studioIntent('CHE, make your walking more natural.');
  assert.equal(walk.kind, 'patch'); assert.equal(walk.agent, 'che');
  assert.equal(walk.patch.walk, 'graceful'); assert.ok(walk.patch.fluidity > 0);
  const less = studioIntent('Atlas, gesture less when you talk');
  assert.equal(less.agent, 'atlas'); assert.ok(less.patch.gesture < 0);
  const preset = studioIntent('use the professional preset');
  assert.equal(preset.patch.preset, 'professional');
  const stiff = studioIntent('you look stiff and robotic, be smoother');
  assert.ok(stiff.patch.fluidity > 0, 'smoother wins over the stiffness complaint');
  const slow = studioIntent('move a bit slower');
  assert.ok(slow.patch.speed < 0);
  const eyes = studioIntent('Nova, make more eye contact');
  assert.equal(eyes.agent, 'nova'); assert.ok(eyes.patch.eyeContact > 0);
});

test('a look that needs new assets is an upgrade request, and unrelated sentences are not studio requests', async () => {
  const up = studioIntent('give Mira a new outfit');
  assert.equal(up.kind, 'upgrade'); assert.equal(up.agent, 'mira');
  const filed = await handleStudio(up, { queueUpgrade: async () => ({ id: 'job-12345678' }) });
  assert.match(filed.text, /upgrade job job-1234/); assert.match(filed.text, /nothing has changed yet/i);
  const none = await handleStudio(up, {});
  assert.equal(none.ok, false); assert.match(none.text, /Nothing has changed/);
  for (const s of ['what is the weather', 'walk me through the trading plan', 'open the office', 'be honest with me', 'make the report more natural sounding']) {
    assert.equal(studioIntent(s), null, s);
  }
  assert.equal(studioIntent('open character studio').kind, 'open');
});

test('the reply names what changed and the fields carry only presentation settings', async () => {
  const out = await handleStudio(studioIntent('CHE, be more expressive and gesture more'));
  assert.match(out.text, /facial expressiveness up/); assert.match(out.text, /gesture intensity up/);
  assert.equal(out.fields.source, 'che_character_studio');
  assert.deepEqual(Object.keys(out.fields.studio_patch).sort(), ['expressiveness', 'gesture']);
  assert.ok(!('permissions' in out.fields) && !('tools' in out.fields));
});
