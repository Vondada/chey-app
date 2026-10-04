import assert from 'node:assert/strict';
import test from 'node:test';
import { changeHistoryIntent, loadChangeHistory, recordReceipt, speakChangeHistory } from './truth_layer.js';

const memory = () => {
  const m = new Map();
  return { get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); } };
};

test('change history is built from real receipts only, one entry per update', async () => {
  const storage = memory();
  await recordReceipt(storage, { kind: 'pr_opened', key: 'pr:5', number: 5, url: 'u5', sha: 'abc', summary: 'Bigger banner', files: ['lib/main.dart'] });
  await recordReceipt(storage, { kind: 'merged', key: 'merged:5', number: 5, sha: 'm5' });
  await recordReceipt(storage, { kind: 'pr_opened', key: 'pr:6', number: 6, summary: 'Faster replies' });
  await recordReceipt(storage, { kind: 'mail_sent', key: 'mail:1', peer: 'claude' });
  const list = await loadChangeHistory(storage);
  assert.equal(list.length, 2);
  assert.equal(list[0].merge_commit, 'm5');
  assert.deepEqual(list[0].files, ['lib/main.dart']);
  const spoken = speakChangeHistory(list);
  assert.match(spoken, /1\. Pull request 6: Faster replies\. Opened, not merged\./);
  assert.match(spoken, /2\. Pull request 5: Bigger banner\. Merged on \d{4}-\d{2}-\d{2}\./);
  assert.match(speakChangeHistory([]), /no recorded updates/);
});

test('change history phrases', () => {
  for (const phrase of ['What changed?', 'what did you change', 'show me your change history', 'update log', 'Che, what have you changed lately?']) {
    assert.ok(changeHistoryIntent(phrase), phrase);
  }
  for (const phrase of ['what changed in the stock market today and why', 'change the banner', 'show me the code']) {
    assert.ok(!changeHistoryIntent(phrase), phrase);
  }
});
