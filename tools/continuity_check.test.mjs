// Tests for the continuity checks (owner, 2026-10-28). Each test changes a document and checks the verdict.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkAppendOnly, checkSnapshot, reconcileMain } from './continuity_check.mjs';

const snapshot = readFileSync(new URL('../docs/CHE_PROJECT_STATUS.md', import.meta.url), 'utf8');

test('the committed snapshot has every section and every fact carries a state', () => {
  assert.deepEqual(checkSnapshot(snapshot), []);
});

test('a missing section is refused', () => {
  const cut = snapshot.replace('## Current blockers', '## Blockers renamed');
  assert.match(checkSnapshot(cut).join(' '), /"## Current blockers" is missing/);
});

test('a fact with no state is refused, and so is a snapshot with no time', () => {
  const stateless = snapshot.replace('| Worker deploy of `74760ee3` succeeded | verified | 2026-10-28 ~03:00 UTC |', '| Worker deploy of `74760ee3` succeeded | 2026-10-28 ~03:00 UTC |');
  assert.match(checkSnapshot(stateless).join(' '), /a fact has no state/);
  assert.match(checkSnapshot(snapshot.replace(/Snapshot taken:.*\n/, '')).join(' '), /no "Snapshot taken"/);
});

test('history is append-only: a removed or changed line is reported, an added line is fine', () => {
  const base = '| 2026-10-03 | Master handoff | requirement |\n| 2026-10-11 | Owner rule | requirement |\n';
  assert.deepEqual(checkAppendOnly(base + '| 2026-10-28 | New | milestone |\n', base), []);
  assert.match(checkAppendOnly('| 2026-10-03 | Master handoff | requirement |\n', base).join(' '), /Removed or changed history line: \| 2026-10-11/);
  assert.match(checkAppendOnly(base.replace('Master handoff', 'Rewritten'), base).join(' '), /Removed or changed/);
});

test('reconcile: a stale main is reported, a matching one is not', () => {
  const claimed = /Latest verified main[\s\S]*?`([0-9a-f]{8})`/.exec(snapshot)[1];
  assert.equal(reconcileMain(snapshot, claimed + 'ffffffffffffffffffffffffffffffffffffffff').ok, true);
  const stale = reconcileMain(snapshot, 'aaaaaaaa'.padEnd(40, 'a'));
  assert.equal(stale.ok, false);
  assert.match(stale.detail, /Stale: the snapshot says/);
});
