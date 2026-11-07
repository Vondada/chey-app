import assert from 'node:assert/strict';
import test from 'node:test';
import { CREW_BIBLE, CREW_LOOKS, lookText, officeCast } from './film_cast.js';
import { workshopAvatar } from './workshop.js';

test('the crew as a cast: CHE first, active members only, each with the Office look and the owner\'s words first', () => {
  const data = { team: [{ id: '5f0c-uuid', name: 'Knox', role: 'Security' }, { id: 'old', name: 'Gone', retired: true }] };
  assert.equal(workshopAvatar(data, 'Knox', { description: '  man   in his 30s ', hair: 'locs', nonsense: 'x' }).appearance.description, 'man in his 30s');
  const cast = officeCast(data);
  assert.deepEqual(cast.map((c) => c.id), ['che', 'knox']);
  assert.match(cast[1].look, /^man in his 30s, .*locs/);
  assert.deepEqual(officeCast(data), cast, 'the same Office gives the same looks every time');
  assert.equal(lookText({ outfit: 'suit', accessory: 'glasses' }).endsWith('wearing a tailored suit and glasses'), true);
});

test('the owner\'s CHE OFFICE poster is each member\'s look until the owner saves their own words', () => {
  const data = { team: [{ id: 'u1', name: 'Knox', role: 'Security' }, { id: 'u2', name: 'Lyra', role: 'Music' }, { id: 'u3', name: 'Juno', role: 'Builder' }] };
  const cast = officeCast(data);
  assert.equal(cast[0].look, CREW_LOOKS.che);
  assert.match(cast.find((c) => c.id === 'lyra').look, /platinum-blonde braids, purple-lit headphones/);
  assert.match(CREW_LOOKS.sage, /^Black man/, 'the poster: Sage, Atlas, Orion and Vale are men');
  assert.match(CREW_LOOKS.vale, /^Black man/);
  assert.match(CREW_LOOKS.knox, /eye patch/, 'the owner: "give one of the dudes an eye patch"');
  // Everyone is told apart by one signature, and the writer gets their personality, tells and catchphrase.
  assert.equal(new Set(Object.values(CREW_BIBLE).map((b) => b.signature)).size, Object.keys(CREW_BIBLE).length);
  const lyra = cast.find((c) => c.id === 'lyra');
  assert.match(lyra.personality, /dreamy until the beat drops/);
  assert.equal(lyra.catchphrase, 'I make it feel.');
  // A Crew Creator edit wins over the Workshop and the design.
  const edited = officeCast(data, { lyra: { look: 'woman with silver braids', personality: 'loud and proud' } }).find((c) => c.id === 'lyra');
  assert.equal(edited.look, 'woman with silver braids');
  assert.equal(edited.personality, 'loud and proud');
  assert.match(edited.tells, /taps rhythms/, 'fields the owner did not edit keep the design');
  for (const look of Object.values(CREW_LOOKS)) assert.doesNotMatch(look, /crop top|cleavage|tight|curv/i, 'neutral words only (error 3030)');
  assert.match(cast.find((c) => c.id === 'juno').look, /build, .* face/, 'someone not on the poster keeps the Office look');
  workshopAvatar(data, 'Knox', { description: 'man in his 40s with a grey beard' });
  assert.match(officeCast(data).find((c) => c.id === 'knox').look, /^man in his 40s with a grey beard, /);
  for (const look of Object.values(CREW_LOOKS)) assert.ok(look.length <= 160, look);
});
