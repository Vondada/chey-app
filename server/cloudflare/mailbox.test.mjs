import test from 'node:test';
import assert from 'node:assert/strict';
import { mailboxIntent, readThread, sendMail, listThreads } from './mailbox.js';

function fakeRepo() {
  const files = new Map();
  let branch = false;
  const ok = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });
  return async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    if (u.includes('/git/ref/heads/che-mailbox')) return branch ? ok({ object: { sha: 'm' } }) : ok({}, 404);
    if (u.endsWith('/o/r')) return ok({ default_branch: 'main' });
    if (u.includes('/git/ref/heads/main')) return ok({ object: { sha: 'x' } });
    if (u.endsWith('/git/refs') && method === 'POST') { branch = true; return ok({}, 201); }
    const dir = /\/contents\/mailbox\?ref=/.test(u);
    if (dir) return ok([...files.keys()].map((name) => ({ name })));
    const m = /\/contents\/mailbox\/([a-z0-9-]+\.jsonl)/.exec(u);
    if (m && method === 'GET') return files.has(m[1]) ? ok({ content: btoa(files.get(m[1]).text), sha: files.get(m[1]).sha }) : ok({}, 404);
    if (m && method === 'PUT') {
      const body = JSON.parse(init.body);
      files.set(m[1], { text: atob(body.content), sha: String(Math.random()) });
      return ok({}, 201);
    }
    return ok({}, 404);
  };
}

const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' };

test('owner phrases map to mailbox actions', () => {
  assert.deepEqual(mailboxIntent('Tell Claude the Ready banner looks great'), { kind: 'send', to: 'claude', text: 'the Ready banner looks great' });
  assert.equal(mailboxIntent('CHE, ask ChatGPT to review the voice code').to, 'chatgpt');
  assert.equal(mailboxIntent('check the mailbox').kind, 'read');
  assert.equal(mailboxIntent('any new messages from codex?').peer, 'codex');
  assert.equal(mailboxIntent('what is the weather'), null);
});

test('CHE and another AI can exchange messages on the mailbox branch', async () => {
  const fetcher = fakeRepo();
  assert.equal((await sendMail(env, { to: 'claude', text: 'Crew failed on banner' }, fetcher)).status, 200);
  assert.equal((await sendMail(env, { from: 'claude', to: 'che', text: 'Fixed, pull main.' }, fetcher)).status, 200);
  const thread = await readThread(env, 'claude', fetcher);
  assert.deepEqual(thread.messages.map((m) => m.from), ['che', 'claude']);
  const all = await listThreads(env, fetcher);
  assert.equal(all.threads[0].peer, 'claude');
});

test('mailbox refuses to send secrets', async () => {
  const out = await sendMail(env, { to: 'chatgpt', text: 'my token is github_pat_abc123' }, fakeRepo());
  assert.equal(out.status, 400);
});

test('CHE notices new Claude replies once, and only every few minutes', async () => {
  const { unseenReplies } = await import('./mailbox.js');
  const fetcher = fakeRepo();
  const mem = new Map();
  const storage = { get: async (k) => mem.get(k), put: async (k, v) => mem.set(k, v) };
  await sendMail(env, { from: 'claude', to: 'che', text: 'Voice fix pushed.' }, fetcher);
  assert.deepEqual((await unseenReplies(env, storage, 'claude', fetcher)).map((m) => m.text), ['Voice fix pushed.']);
  mem.set('mail_check_at:claude', 0);
  assert.equal((await unseenReplies(env, storage, 'claude', fetcher)).length, 0);
  await sendMail(env, { from: 'claude', to: 'che', text: 'Library sync live.' }, fetcher);
  assert.equal((await unseenReplies(env, storage, 'claude', fetcher)).length, 0, 'throttled');
  mem.set('mail_check_at:claude', 0);
  assert.deepEqual((await unseenReplies(env, storage, 'claude', fetcher)).map((m) => m.text), ['Library sync live.']);
});
