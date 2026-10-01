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
