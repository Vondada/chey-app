import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCorrections, correctionsContext, detectCorrection, learnCorrection, loadCorrections } from './speech_learning.js';

function store() { const m = new Map(); return { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) }; }

test('detects the ways the owner corrects a mishearing', () => {
  const prev = 'Ask ChatGPT rock and Claude how to code yourself into fix';
  assert.deepEqual(detectCorrection('I meant Grok', prev), { heard: 'rock', meant: 'Grok' });
  assert.deepEqual(detectCorrection('Grok, not rock'), { heard: 'rock', meant: 'Grok' });
  assert.deepEqual(detectCorrection('no, not rock, Grok'), { heard: 'rock', meant: 'Grok' });
  assert.deepEqual(detectCorrection('when I say rock I mean Grok'), { heard: 'rock', meant: 'Grok' });
  assert.equal(detectCorrection('Good afternoon', prev), null);
});

test('rejecting an answer is not a word correction, and a word the previous turn never contained is not re-run', () => {
  // Subject-loss audit (2026-10-24): these were learned as heard→meant pairs and replayed the previous request unchanged.
  assert.equal(detectCorrection("That's not what I meant", 'Analyze the NQ chart'), null);
  assert.equal(detectCorrection('No, not that one', 'Coding status'), null);
  assert.equal(detectCorrection('not that, this', 'Open the chart'), null);
  // A real correction of a word the previous turn does not contain corrects nothing there.
  assert.equal(detectCorrection('Grok, not rock', 'Analyze the NQ chart'), null);
  assert.equal(detectCorrection('strawberry Sprite, not Sprite', "What's my favorite drink?"), null);
  // The same words with the misheard word present still correct it.
  assert.deepEqual(detectCorrection('Grok, not rock', 'Ask rock how to code'), { heard: 'rock', meant: 'Grok' });
});

test('learned corrections apply in matching context only', async () => {
  const s = store();
  const prev = 'Ask ChatGPT rock and Claude how to code yourself into fix';
  await learnCorrection(s, detectCorrection('I meant Grok', prev), prev);
  const corrections = await loadCorrections(s);
  assert.equal(applyCorrections('ask rock and Claude about voices', corrections), 'ask Grok and Claude about voices');
  assert.equal(applyCorrections('play some rock music', corrections), 'play some rock music');
  assert.match(correctionsContext(corrections), /"rock" usually means "Grok"/);
});
