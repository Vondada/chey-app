import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWebMailbox, mailboxCode, mailboxLink, readWebMail, rotateMailboxCode } from './web_mailbox.js';
import { mailboxIntent } from './mailbox.js';

function store() {
  const m = new Map();
  return { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v), delete: async (k) => m.delete(k) };
}

test('Flagstaff 369: any AI posts and reads with the secret link, no account', async () => {
  const s = store();
  const code = await mailboxCode(s);
  const link = mailboxLink('https://che.example', code);
  assert.match(link, /\/flagstaff369\/[a-z0-9]{24}$/);
  const posted = await handleWebMailbox(new Request(`${link}?from=ChatGPT&text=${encodeURIComponent('Hi CHE, try caching voices.')}`), s);
  assert.equal(posted.status, 200);
  assert.match(await posted.text(), /SENT[\s\S]*chatgpt → che: Hi CHE, try caching voices\./);
  const viaPost = await handleWebMailbox(new Request(link, { method: 'POST', body: JSON.stringify({ from: 'gemini', text: 'Hello' }) }), s);
  assert.equal(viaPost.status, 200);
  assert.deepEqual((await readWebMail(s)).map((m) => m.from), ['chatgpt', 'gemini']);
});

test('Flagstaff 369 hides from wrong codes, rotates, and ignores other paths', async () => {
  const s = store();
  const code = await mailboxCode(s);
  assert.equal((await handleWebMailbox(new Request('https://x/flagstaff369/aaaaaaaaaaaaaaaaaaaaaaaa'), s)).status, 404);
  assert.equal(await handleWebMailbox(new Request('https://x/api/state'), s), null);
  const fresh = await rotateMailboxCode(s);
  assert.notEqual(fresh, code);
  assert.equal((await handleWebMailbox(new Request(`https://x/flagstaff369/${code}`), s)).status, 404);
  assert.equal((await handleWebMailbox(new Request(`https://x/flagstaff369/${fresh}?from=x&text=${'github_pat_' + 'abc'}`), s)).status, 400);
});

test('owner can ask CHE to check Flagstaff', () => {
  assert.equal(mailboxIntent('CHE, check Flagstaff 369').kind, 'read');
});
