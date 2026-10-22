import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEAM_ROSTER, HARD_RULES } from './team_roster.js';

const FOUR_HARD_RULES = [
  "send money without the owner's yes",
  "send sensitive data out without the owner's permission",
  "post or publish publicly without the owner's yes",
  "act to the owner's detriment",
];

const sentenceCount = (text) => text.trim().split(/(?<=[.!?])\s+/).length;

test('roster has 6 to 8 entries with the required roles', () => {
  assert.ok(TEAM_ROSTER.length >= 6 && TEAM_ROSTER.length <= 8, `got ${TEAM_ROSTER.length}`);
  const roles = TEAM_ROSTER.map((e) => e.role);
  for (const role of ['Security Chief', 'Trading Analyst', 'Content Strategist', 'Offers and Services Scout', 'Skeptic', 'Finance Guard', 'Builder']) {
    assert.ok(roles.includes(role), `missing role ${role}`);
  }
});

test('every entry has the required fields with the right types', () => {
  for (const e of TEAM_ROSTER) {
    assert.equal(typeof e.id, 'string', e.id);
    assert.ok(e.id.length > 0, 'id is empty');
    assert.equal(typeof e.role, 'string', e.id);
    assert.equal(typeof e.goal, 'string', e.id);
    assert.ok(e.goal.length > 0, `${e.id} goal empty`);
    assert.equal(typeof e.personality, 'string', e.id);
    const n = sentenceCount(e.personality);
    assert.ok(n >= 2 && n <= 3, `${e.id} personality has ${n} sentences`);
    assert.ok(Array.isArray(e.can_propose) && e.can_propose.length > 0, `${e.id} can_propose`);
    assert.ok(Array.isArray(e.cannot) && e.cannot.length > 0, `${e.id} cannot`);
    assert.equal(typeof e.speaks_as_self, 'boolean', `${e.id} speaks_as_self`);
  }
});

test('the Security Chief has no name, speaks as no one, and cannot be overruled', () => {
  const chief = TEAM_ROSTER.find((e) => e.role === 'Security Chief');
  assert.ok(chief, 'Security Chief missing');
  assert.equal(Object.hasOwn(chief, 'name'), false);
  assert.equal(chief.speaks_as_self, false);
  assert.ok(chief.cannot.includes('be overruled by any other agent'));
  assert.ok(chief.can_propose.some((p) => /block any outbound action/.test(p)));
});

test('every cannot list includes the four hard rules', () => {
  assert.deepEqual([...HARD_RULES], FOUR_HARD_RULES);
  for (const e of TEAM_ROSTER) {
    for (const rule of FOUR_HARD_RULES) {
      assert.ok(e.cannot.includes(rule), `${e.id} cannot is missing: ${rule}`);
    }
  }
});

test('no two entries share an id', () => {
  const ids = TEAM_ROSTER.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids in ${ids.join(', ')}`);
});
