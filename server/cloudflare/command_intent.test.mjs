// Owner commands are never mistaken for a save (owner, 2026-10-28: "why is coding autonomy paused … resume the
// authorized coding jobs" was saved as an "Untitled" library page). Autonomy, coding-job and status questions are
// routed to their own handlers, and a real save is still saved, with a real name.
import assert from 'node:assert/strict';
import test from 'node:test';
import { libraryIntent } from './library.js';

const LINK = 'https://github.com/Vondada/chey-app/pull/736';

test('an autonomy question with a link and "keep this" is not a library save', () => {
  assert.equal(libraryIntent(`CHE, why is coding autonomy paused? Keep this in mind and resume the authorized coding jobs for ${LINK}`), null);
});

test('a question about a saved job is not a save: job ids and "why is" questions go to their own handlers', () => {
  assert.equal(libraryIntent('CHE, why is job 563823dd paused? Remember it for the crew.'), null);
  assert.equal(libraryIntent(`Save this link and check the coding job status: ${LINK}`), null, 'a control word stops a save');
});

test('a message that only asks about saving is not a save', () => {
  assert.equal(libraryIntent('CHE, did you save my last message?'), null);
});

test('a real save command still saves the page it names', () => {
  assert.deepEqual(libraryIntent('CHE, remember this page https://example.com/article'), { url: 'https://example.com/article', text: '', title: '' });
  assert.equal(libraryIntent('memorize this page https://example.com/article').url, 'https://example.com/article');
});

test('a pasted text to store is still stored', () => {
  const scene = 'Scene one. '.repeat(30);
  const got = libraryIntent(`store this script: ${scene}`);
  assert.ok(got && got.text.startsWith('Scene one.'));
});
