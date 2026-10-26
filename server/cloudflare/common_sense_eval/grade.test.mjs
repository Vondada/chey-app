// The grader's own tests: it must pass a correct reply and fail a wrong or empty one, so the eval means something.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { grade } from './grade.mjs';

const cases = JSON.parse(readFileSync(fileURLToPath(new URL('./cases.json', import.meta.url)), 'utf8'));
const byId = Object.fromEntries(cases.map((c) => [c.id, c]));

test('every case has at least one required fact and only lowercase phrases', () => {
  for (const c of cases) {
    assert.ok(c.must_include.length > 0, c.id);
    assert.ok([...c.must_include, ...c.must_not_include].every((p) => p === p.toLowerCase()), c.id);
  }
});

test('a correct, plain reply passes', () => {
  assert.equal(grade(byId['spider-legs'], 'A spider has eight legs.').pass, true);
  assert.equal(grade(byId['percent'], '15 percent of 200 is 30.').pass, true);
});

test('a wrong reply fails and names the wrong part', () => {
  const r = grade(byId['spider-legs'], 'A spider has six legs.');
  assert.equal(r.pass, false);
  assert.ok(r.forbidden.includes('six'));
});

test('matching is on whole words: 8 does not pass inside 18, and 30 does not pass inside 130', () => {
  assert.equal(grade(byId['spider-legs'], 'It has 18 legs.').pass, false);
  assert.equal(grade(byId['percent'], 'About 130 units.').pass, false);
});

test('an empty reply fails', () => {
  assert.equal(grade(byId['sun-star'], '   ').pass, false);
});
