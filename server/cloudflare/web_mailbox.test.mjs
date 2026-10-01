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
  assert.match(link, /\/flagstaff\/[a-z0-9]{8}$/);
  const posted = await handleWebMailbox(new Request(`${link}?from=ChatGPT&text=${encodeURIComponent('Hi CHE, try caching voices.')}`), s);
  assert.equal(posted.status, 200);
  assert.match(await posted.text(), /SENT[\s\S]*chatgpt -> che: Hi CHE, try caching voices\./);
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

test('lock hands back the session and wipes the board; the same link works again after unlock', async () => {
  const { lockMailbox, openMailbox, transcript, isOpen } = await import('./web_mailbox.js');
  const s = store();
  const code = await mailboxCode(s);
  await handleWebMailbox(new Request(`https://x/flagstaff369/${code}?from=grok&text=idea`), s);
  const kept = await lockMailbox(s);
  assert.equal(kept.length, 1);
  assert.match(transcript(kept), /grok → che: idea/);
  assert.equal(await isOpen(s), false);
  assert.equal((await handleWebMailbox(new Request(`https://x/flagstaff369/${code}`), s)).status, 423);
  const same = await openMailbox(s);
  assert.equal(same, code, 'the link survives lock/unlock');
  assert.equal((await readWebMail(s)).length, 0);
  assert.equal((await handleWebMailbox(new Request(`https://x/flagstaff369/${same}`), s)).status, 200);
});

test('locking keeps a private archive of the full session', async () => {
  const { lockMailbox, readArchive } = await import('./web_mailbox.js');
  const s = store();
  const code = await mailboxCode(s);
  await handleWebMailbox(new Request(`https://x/flagstaff/${code}?from=chatgpt&text=hello%20che`), s);
  await lockMailbox(s);
  const archive = await readArchive(s);
  assert.equal(archive.length, 1);
  assert.equal(archive[0].messages[0].text, 'hello che');
});

test('unread counts only incoming messages, not CHE\'s own, until marked seen', async () => {
  const { unreadIncoming, markOwnerSeen } = await import('./web_mailbox.js');
  const s = store();
  const code = await mailboxCode(s);
  await handleWebMailbox(new Request(`https://x/flagstaff/${code}?from=grok&text=one`), s);
  await handleWebMailbox(new Request(`https://x/flagstaff/${code}?from=chatgpt&text=two`), s);
  const { postWebMail } = await import('./web_mailbox.js');
  await postWebMail(s, { from: 'che', to: 'grok', text: 'my own reply' });
  assert.equal((await unreadIncoming(s)).count, 2, 'CHE\'s own message is not counted');
  await markOwnerSeen(s);
  assert.equal((await unreadIncoming(s)).count, 0);
  await handleWebMailbox(new Request(`https://x/flagstaff/${code}?from=grok&text=three`), s);
  assert.equal((await unreadIncoming(s)).count, 1);
});

test('Flagstaff 369 and the GitHub che-mailbox are one mailbox', async () => {
  const { postWebMail, unreadIncoming } = await import('./web_mailbox.js');
  const files = new Map([['claude.jsonl', JSON.stringify({ id: 'c1', at: '2026-09-30T10:00:00.000Z', from: 'claude', to: 'che', text: 'from the repo' }) + '\n']]);
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    const reply = (status, data) => new Response(JSON.stringify(data), { status });
    if (u.pathname.endsWith('/git/ref/heads/che-mailbox')) return reply(200, { object: { sha: 'x' } });
    if (u.pathname.endsWith('/contents/mailbox')) return reply(200, [...files.keys()].map((name) => ({ name })));
    const m = /\/contents\/mailbox\/([a-z0-9-]+\.jsonl)$/.exec(u.pathname);
    if (m && (init.method || 'GET') === 'GET') return files.has(m[1]) ? reply(200, { content: btoa(files.get(m[1])), sha: 's' }) : reply(404, {});
    if (m && init.method === 'PUT') { files.set(m[1], atob(JSON.parse(init.body).content)); return reply(200, {}); }
    return reply(404, {});
  };
  const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'me/che' };
  const s = store();
  const code = await mailboxCode(s);
  const page = await (await handleWebMailbox(new Request(`https://x/flagstaff/${code}`), s, env, fetcher)).text();
  assert.match(page, /claude -> che: from the repo/, 'repo messages show on the web board');
  assert.match(page, /branch che-mailbox/);
  const sent = await postWebMail(s, { from: 'gemini', text: 'hi from the link' }, env, fetcher);
  assert.equal(sent.github, 'saved');
  assert.match(files.get('gemini.jsonl'), /hi from the link/, 'web posts land in the GitHub mailbox');
  const board = await readWebMail(s, 50, env, fetcher);
  assert.equal(board.filter((m) => m.text === 'hi from the link').length, 1, 'no duplicate copies');
  assert.equal((await unreadIncoming(s, env, fetcher)).count, 2);
});
