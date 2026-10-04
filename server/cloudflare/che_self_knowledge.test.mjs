import test from 'node:test';
import assert from 'node:assert/strict';
import { CHE_SELF_BRIEF, starredFocus, studyLesson } from './che_self_knowledge.js';
import { STARRED_LIBRARY } from './topic_study.js';
import { loadLessons, recordLesson } from './self_development.js';

test('every starred repo has a self-improvement focus', () => {
  for (const repo of STARRED_LIBRARY) assert.ok(starredFocus(repo), repo);
  assert.equal(starredFocus('someone/unknown'), '');
});

test('self brief carries the owner rules and stays free of dynamic data', () => {
  assert.match(CHE_SELF_BRIEF, /voice/);
  assert.match(CHE_SELF_BRIEF, /spending money or deleting/);
  assert.match(CHE_SELF_BRIEF, /Keychain/);
  assert.doesNotMatch(CHE_SELF_BRIEF, /\d{4}-\d{2}-\d{2}/);
  assert.ok(CHE_SELF_BRIEF.length < 2000, 'brief stays small enough for every agent prompt');
});

test('studyLesson keeps useful techniques with their source and skips SKIP verdicts', () => {
  const lesson = studyLesson({ repo: 'donnemartin/system-design-primer', topic: 'Caching', lessons: ['Cache provider health for a short TTL instead of probing on each request.'], verdict: 'IMPROVE' });
  assert.match(lesson, /^Studied donnemartin\/system-design-primer, Caching: Cache provider health/);
  assert.equal(studyLesson({ repo: 'x/y', lessons: ['A real technique worth keeping.'], verdict: 'SKIP' }), '');
  assert.equal(studyLesson({ repo: 'x/y', lessons: [], verdict: 'ADD' }), '');
});

test('studied techniques are capped and never push out crew mistakes', async () => {
  const store = new Map();
  const memory = { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v); } };
  await recordLesson(memory, 'mistake', 'Copy edit find text exactly from the source.');
  for (let i = 0; i < 25; i += 1) await recordLesson(memory, 'technique', `Studied repo ${i}: technique number ${i}.`);
  const saved = store.get('che_team_lessons');
  const techniques = saved.filter((item) => item.kind === 'technique');
  assert.equal(techniques.length, 15);
  assert.match(techniques[0].text, /technique number 10\./);
  assert.ok(saved.some((item) => item.kind === 'mistake'));
  const loaded = await loadLessons(memory);
  assert.ok(loaded.some((item) => /technique number 24/.test(item.text)));
});
