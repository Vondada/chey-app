// The Worker's identity lists must match the renderer's (tools/avatar_face/identity.py): which hair styles exist, which
// have real hair built (HAIR_BUILT decides NOHAIR in the job settings), the looks and the race mix. When the Python lane
// builds hair for another style, both lists change together or this test fails.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { HAIR_BUILT, HAIR_BUST_BUILT, HAIR_STYLES, RACES, STYLES } from './avatar_identity.js';

const py = readFileSync(new URL('../../tools/avatar_face/identity.py', import.meta.url), 'utf8');
const tuple = (name) => {
  const m = new RegExp(`^${name}\\s*=\\s*\\(([^)]*)\\)`, 'm').exec(py);
  assert.ok(m, `${name} is defined in identity.py`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};

test('hair styles, built hair, looks and races match tools/avatar_face/identity.py', () => {
  assert.deepEqual([...HAIR_STYLES], tuple('HAIR_STYLES'));
  assert.deepEqual([...HAIR_BUILT], tuple('HAIR_BUILT'));
  assert.deepEqual([...HAIR_BUST_BUILT], tuple('HAIR_BUST_BUILT'));
  assert.deepEqual([...STYLES], tuple('STYLES'));
  assert.deepEqual([...RACES], tuple('RACES'));
});
