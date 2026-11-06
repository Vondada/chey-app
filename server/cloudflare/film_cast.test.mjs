import assert from 'node:assert/strict';
import test from 'node:test';
import { lookText, officeCast } from './film_cast.js';
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
