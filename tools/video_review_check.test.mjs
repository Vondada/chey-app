// Tests for the Video Review record check (owner, 2026-10-28). Each test changes the record and checks the verdict.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkRecord } from './video_review_check.mjs';

const HEADER = '| id | video | timestamp | evidence | observed | expected | root_cause | files | status | pr_commit | receipts | blockers |\n|---|---|---|---|---|---|---|---|---|---|---|---|';
const row = (over = {}) => {
  const base = { id: 'VR-001', video: 'clip-a.mp4', timestamp: '00:42', evidence: 'ChatGPT written observation', observed: 'Save does nothing', expected: 'Save persists', root_cause: 'unverified', files: 'lib/x.dart', status: 'open', pr_commit: '—', receipts: '—', blockers: 'none' };
  const merged = { ...base, ...over };
  return `| ${Object.values(merged).join(' | ')} |`;
};
const doc = (...rows) => `# record\n\n${HEADER}\n${rows.join('\n')}\n`;

test('the committed record is valid and holds no unsupported completion', () => {
  const { problems } = checkRecord(readFileSync(new URL('../docs/CHE_VIDEO_REVIEW.md', import.meta.url), 'utf8'));
  assert.deepEqual(problems, []);
});

test('an open task with no receipts is valid', () => {
  assert.deepEqual(checkRecord(doc(row())).problems, []);
});

test('a verified or done task without receipts is refused', () => {
  const verdict = checkRecord(doc(row({ status: 'verified', pr_commit: '#739 (abc1234)', receipts: '—' })));
  assert.match(verdict.problems.join(' '), /needs receipts/);
  assert.match(checkRecord(doc(row({ status: 'done', pr_commit: '—', receipts: 'suite 4689/4680' }))).problems.join(' '), /needs a PR number or commit/);
});

test('a verified task with receipts and a PR is accepted', () => {
  assert.deepEqual(checkRecord(doc(row({ status: 'verified', pr_commit: '#739 (abc1234)', receipts: 'suite 4689/4680 pass, exit 0' }))).problems, []);
});

test('an unknown status is refused, and so is a missing column', () => {
  assert.match(checkRecord(doc(row({ status: 'maybe done' }))).problems.join(' '), /not one of/);
  const withoutBlockers = '| id | video | timestamp | evidence | observed | expected | root_cause | files | status | pr_commit | receipts |\n|---|---|---|---|---|---|---|---|---|---|---|\n| VR-1 | a | b | c | d | e | f | g | open | — | — |';
  assert.match(checkRecord(withoutBlockers).problems.join(' '), /"blockers" column/);
});

test('a record with no table is refused, never silently passed', () => {
  assert.match(checkRecord('# nothing here').problems.join(' '), /header is missing/);
});
