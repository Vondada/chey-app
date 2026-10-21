import test from 'node:test';
import assert from 'node:assert/strict';
import { packText, unpackText, savePackedJson, loadPackedJson } from './prompt_compaction.js';

test('lossless prompt compression round-trips every character', async () => {
  const original = ('Rule: keep every number, URL, exception, and newline.\nhttps://example.com/a?b=1\n').repeat(80);
  const packed = await packText(original, { minBytes: 1 });
  assert.equal(await unpackText(packed), original);
  assert.equal(typeof packed.sha256, 'string');
});

test('small prompts stay plain instead of wasting storage', async () => {
  const packed = await packText('keep me exact', { minBytes: 1000 });
  assert.equal(packed.codec, 'plain-v1');
  assert.equal(await unpackText(packed), 'keep me exact');
});

test('packed JSON storage is transparent to callers', async () => {
  const map = new Map();
  const storage = {
    async get(k){ return map.get(k); },
    async put(k,v){ map.set(k,v); },
    async delete(k){ if (Array.isArray(k)) k.forEach((x)=>map.delete(x)); else map.delete(k); },
  };
  const value = { prompt: 'Do not drop anything. '.repeat(200), nested: { n: 42, ok: true } };
  const info = await savePackedJson(storage, 'p', value);
  assert.ok(['gzip-v1','plain-v1'].includes(info.codec));
  assert.deepEqual(await loadPackedJson(storage, 'p'), value);
});

test('plain compaction records reject changed content instead of ignoring their integrity digest', async () => {
  const packed = await packText('Willo, Friday 16:45. Do not publish.', { minBytes: 1000 });
  await assert.rejects(unpackText({ ...packed, text: 'Willo, Friday 16:45. Publish now.' }), /integrity check failed/);
});

test('Unicode and transitions between compressed and plain JSON stay exact', async () => {
  const saved = new Map();
  const storage = { get: async (k) => saved.get(k), put: async (k, v) => saved.set(k, structuredClone(v)), delete: async (k) => saved.delete(k) };
  const values = [{ text: 'CHE 🧠 — Chay\nWillo: $25,000; 16:45; https://example.com/A?B=2\n'.repeat(200) }, { text: 'Small 🧠' }];
  for (const value of [...values, values[0]]) {
    await savePackedJson(storage, 'context', value);
    assert.deepEqual(await loadPackedJson(storage, 'context'), value);
    assert.equal(saved.has('context') && saved.has('context:gz'), false, 'no duplicate representation remains');
  }
});
