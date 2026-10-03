// Truth layer regression suite: CHE may only state what receipts prove.
// Reproduces the 2026-10-02 22:20 incident (Study 1 and 2 → "Okay" → "tell me
// when you are ready" → paste-the-source request → "work with Claude") and
// the owner's required cases.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { guardOwnerReply, verifiedState, verifiedStatusText } from './truth_layer.js';
import { collaborationIntent, parallelPreference, statusIntent } from './collaboration.js';

const generated = new URL('./.truth_layer.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

const NONE = verifiedState([], [], {});
const sent = (peer, id = 'm-1') => ({ kind: 'mail_sent', peer, message_id: id, at: new Date().toISOString() });
const received = (peer, id = 'r-1') => ({ kind: 'mail_received', peer, message_id: id, text: 'Here is my review.', at: new Date(Date.now() + 1000).toISOString() });

// ─── Unit: the claim guard ───────────────────────────────────────────────────

test('4: "I contacted Claude" is removed without an outbound mailbox receipt, kept with one', () => {
  const reply = 'I have opened your Flagstaff mailbox to coordinate with Claude. The weather is fine.';
  assert.doesNotMatch(guardOwnerReply(reply, NONE).text, /Claude/);
  const withReceipt = verifiedState([sent('claude')], [], {});
  assert.match(guardOwnerReply('I sent Claude the request.', withReceipt).text, /sent Claude/);
});

test('5: "Claude replied / is working" needs a real inbound Claude message', () => {
  const onlySent = verifiedState([sent('claude')], [], {});
  for (const claim of ['Claude and I are currently reading the session notes.', 'Claude is working on it.', 'Claude replied with a plan.']) {
    assert.equal(guardOwnerReply(claim, onlySent).text, '', claim);
  }
  const replied = verifiedState([sent('claude'), received('claude')], [], {});
  assert.match(guardOwnerReply('Claude replied with a plan.', replied).text, /Claude replied/);
});

test('3 + 14: "I am analyzing" / "I fixed it" / "my analysis confirms" need a real job or result', () => {
  for (const claim of ['I am currently analyzing how to integrate the agency-agent architecture.', 'I have mapped out the necessary modifications.', 'My analysis confirms I can integrate it.', 'I fixed it.', 'The agents are working on it.']) {
    assert.equal(guardOwnerReply(claim, NONE).text, '', claim);
  }
  const running = verifiedState([], [{ id: 'job12345', kind: 'self_development', status: 'running', title: 'x' }], {});
  assert.match(guardOwnerReply('I am working on it now.', running).text, /working/);
});

test('15: PR, ready-for-PR, merge, deploy and tests claims need GitHub/deploy receipts', () => {
  const claims = ['I am ready to create the pull request now.', 'I created the PR.', 'I merged it.', 'It is deployed and production is running it.', 'Tests passed.'];
  for (const claim of claims) assert.equal(guardOwnerReply(claim, NONE).text, '', claim);
  const proven = verifiedState([
    { kind: 'pr_opened', number: 9, at: new Date().toISOString() },
    { kind: 'merged', number: 9, sha: 'abc', at: new Date().toISOString() },
    { kind: 'deployed', at: new Date().toISOString() },
    { kind: 'ci_passed', number: 9, at: new Date().toISOString() },
  ], [], { pendingProposal: { files: [] } });
  for (const claim of claims) assert.notEqual(guardOwnerReply(claim, proven).text, '', claim);
});

test('8: a model asking the owner to paste repository code is caught as owner homework', () => {
  const out = guardOwnerReply('Please paste the relevant code from server/cloudflare/self_development.js so I can review it.', NONE, { repoAvailable: true });
  assert.equal(out.homework, true);
  assert.equal(out.text, '');
});

test('6: verified status says "sent, no reply yet" — never "working together"', () => {
  const text = verifiedStatusText(verifiedState([sent('claude', 'abcdef123')], [], {}));
  assert.match(text, /sent Claude the request \(message abcdef12\); no reply yet/);
  assert.doesNotMatch(text, /working (?:with|together)/i);
  assert.match(verifiedStatusText(NONE), /Nothing is running/);
});

test('intents: collaboration, batch and status phrases are recognised; ordinary chat is not', () => {
  assert.deepEqual(collaborationIntent('Work with Claude who is already working in the repo')?.peers, ['claude']);
  assert.deepEqual(collaborationIntent('Batch it fast and use the other AIs')?.peers.sort(), ['chatgpt', 'claude']);
  assert.equal(parallelPreference('batch this and do it fast'), true);
  assert.equal(statusIntent('Just tell me when you are ready to create the pr')?.kind, 'status');
  assert.equal(statusIntent('Okay')?.kind, 'ack');
  assert.equal(statusIntent('did Claude reply?')?.kind, 'status');
  assert.equal(collaborationIntent('What is the weather?'), null);
  assert.equal(statusIntent('Tell me a joke'), null);
});

// ─── Integration: the recorded incident, end to end ──────────────────────────

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

function fakeGitHub(log) {
  const threads = new Map();
  return async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
    const path = u.replace('https://api.github.com/repos/Vondada/chey-app', '');
    if (method === 'GET' && path === '') return reply({ default_branch: 'main', permissions: { push: true } });
    if (path.startsWith('/git/ref/heads/main')) return reply({ object: { sha: 'mainsha1234567' } });
    if (path.startsWith('/git/ref/heads/che-mailbox')) return reply({ object: { sha: 'mb' } });
    const thread = /^\/contents\/mailbox\/(\w+)\.jsonl/.exec(path);
    if (thread && method === 'GET') {
      const body = threads.get(thread[1]);
      return body ? reply({ sha: 's', content: Buffer.from(body).toString('base64') }) : reply({}, 404);
    }
    if (thread && method === 'PUT') {
      const data = JSON.parse(init.body);
      threads.set(thread[1], Buffer.from(data.content, 'base64').toString());
      log.push({ peer: thread[1], content: threads.get(thread[1]) });
      return reply({ content: {} }, 200);
    }
    if (u.startsWith('https://api.github.com/repos/') && /\/readme/.test(u)) return reply({ content: Buffer.from('# Agency agents\nSpecialist agent personalities and workflows.').toString('base64') });
    if (u.startsWith('https://api.github.com/repos/') && /\/contents\?ref=/.test(u)) return reply([{ path: 'README.md' }, { path: 'agents' }]);
    const meta = /^https:\/\/api\.github\.com\/repos\/([\w.-]+\/[\w.-]+)$/.exec(u);
    if (meta) return reply({ full_name: meta[1], default_branch: 'main', license: meta[1].startsWith('msitarzewski') ? { spdx_id: 'MIT', name: 'MIT License' } : null, description: 'ref', stargazers_count: 100 });
    return reply({ message: 'Not Found' }, 404);
  };
}

async function setup({ aiReply = 'Sure, sir.' } = {}) {
  const saved = new Map();
  const aiCalls = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'Vondada/chey-app', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_m, input) => {
      aiCalls.push(input);
      const system = String(input.messages?.[0]?.content || '');
      if (system.includes('architecture analyst')) {
        return { response: JSON.stringify({ findings: [{ capability: 'agent personas', verdict: 'KEEP', why: 'CHE Office already has them', source_repo: 'msitarzewski/agency-agents' }, { capability: 'task delegation board', verdict: 'IMPROVE', why: 'faster hand-off', source_repo: 'msitarzewski/agency-agents' }], implementation_request: 'Speed up Office task hand-off.' }) };
      }
      return { response: typeof aiReply === 'function' ? aiReply(input) : aiReply };
    } },
  };
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const chat = async (message) => {
    const res = await send('/api/chat', { message }, token);
    const raw = await res.text();
    const lines = raw.trim().split('\n').map((line) => { try { return JSON.parse(line); } catch (_) { return { type: 'raw', raw: line }; } });
    return { text: lines.filter((l) => l.type === 'delta').map((l) => l.delta).join('') || raw, meta: lines.find((l) => l.type === 'done') || {} };
  };
  return { saved, state, chat, aiCalls };
}

const STARRED = [
  { full_name: 'msitarzewski/agency-agents', license: 'mit', license_name: 'MIT License', reusable: true },
  { full_name: 'codecrafters-io/build-your-own-x', license: '', license_name: 'No license detected', reusable: false },
];

test('1 + 2 + incident: "Study 1 and 2" saves BOTH listed repos and starts a real study job; "Okay" reports the real job state', async () => {
  const log = [];
  const original = globalThis.fetch;
  globalThis.fetch = fakeGitHub(log);
  try {
    const { saved, chat, state } = await setup();
    saved.set('code_scout_last', STARRED);
    saved.set('che_last_engineering_request', { request: 'find the two repos and implement them into yourself', integrate: true });
    const study = await chat('Study 1 and 2');
    assert.match(study.text, /msitarzewski\/agency-agents and codecrafters-io\/build-your-own-x/);
    assert.match(study.text, /started repository study job [0-9a-f]{8}/);
    assert.doesNotMatch(study.text, /analy[sz]ing/i);
    const job = saved.get('che').jobs.find((j) => j.kind === 'repo_study');
    assert.ok(job && study.text.includes(job.id.slice(0, 8)), 'the id CHE quotes is the real job id');

    const okay = await chat('Okay');
    assert.match(okay.text, new RegExp(`Repository study ${job.id.slice(0, 8)} is queued`));

    // The job really runs: it reads both repos (license-aware) and records findings.
    job.retry_at = 0; const d = saved.get('che'); d.jobs = d.jobs.map((j) => (j.id === job.id ? job : j)); saved.set('che', d);
    await state.processJobs();
    const done = saved.get('che').jobs.find((j) => j.id === job.id);
    assert.equal(done.status, 'complete', done.error);
    assert.match(done.owner_message, /read msitarzewski\/agency-agents and codecrafters-io\/build-your-own-x/);
    assert.ok(saved.get('code_scout_study_report').repos.find((r) => r.full_name.startsWith('codecrafters')).reusable === false);
    assert.ok(saved.get('che').jobs.some((j) => j.kind === 'self_development'), 'implementation was requested, so a real coding job follows the study');
  } finally { globalThis.fetch = original; }
});

test('incident: "tell me when you are ready to create the PR" gets verified state, not an invented "ready"', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = fakeGitHub([]);
  try {
    const { chat, aiCalls } = await setup({ aiReply: 'I am ready to create the pull request now, sir.' });
    const out = await chat('Just tell me when you are ready to create the pr');
    assert.doesNotMatch(out.text, /ready to create the pull request/i);
    assert.match(out.text, /Nothing is running right now/);
    assert.equal(aiCalls.length, 0, 'status is answered from receipts without a model');
  } finally { globalThis.fetch = original; }
});

test('8 + incident: model asks the owner to paste self_development.js → CHE fetches it herself via a real coding job', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = fakeGitHub([]);
  try {
    const { saved, chat } = await setup({ aiReply: 'I have mapped out the modifications. Please paste the relevant code from server/cloudflare/self_development.js so I can review it and draft the pull request.' });
    saved.set('che_last_engineering_request', { request: 'implement the agency-agents delegation into yourself', integrate: true });
    const out = await chat('What do you need from me for the repo upgrade plan?');
    assert.doesNotMatch(out.text, /paste|mapped out/i);
    const job = saved.get('che').jobs.find((j) => j.kind === 'self_development');
    assert.ok(job, 'a real coding job was started instead');
    assert.match(out.text, new RegExp(`Coding job ${job.id.slice(0, 8)}`));
  } finally { globalThis.fetch = original; }
});

test('6 + 7 + 11 + incident: "work with Claude" sends a real packet, says "no reply yet", dedupes, and reports a real reply truthfully', async () => {
  const log = [];
  const original = globalThis.fetch;
  globalThis.fetch = fakeGitHub(log);
  try {
    const { saved, chat, state } = await setup();
    saved.set('che_last_engineering_request', { request: 'find the two repos and implement them into yourself', integrate: true });
    const out = await chat("Work with Claude who is already working in the repo and compare progress without stumbling over each other's work then tell me when you are ready");
    const box = saved.get('web_mailbox') || [];
    const packet = box.find((m) => m.from === 'che' && m.to === 'claude');
    assert.ok(packet, 'a real message to Claude exists');
    assert.match(packet.text, /Owner request \(verbatim\): find the two repos and implement them into yourself/);
    assert.match(packet.text, /mainsha1234567/);
    assert.ok(log.some((entry) => entry.peer === 'claude' && entry.content.includes(packet.id)), 'mirrored to the GitHub mailbox');
    assert.match(out.text, new RegExp(`Sent to Claude, message ${packet.id.slice(0, 8)}`));
    assert.match(out.text, /No reply from Claude yet/);
    assert.doesNotMatch(out.text, /Claude and I are|working together|Claude is (?:working|reading)/i);
    const job = saved.get('che').jobs.find((j) => j.kind === 'self_development');
    assert.ok(job && out.text.includes(job.id.slice(0, 8)));

    // 11: the same request again does not resend.
    const again = await chat("Work with Claude who is already working in the repo and compare progress without stumbling over each other's work then tell me when you are ready");
    assert.equal((saved.get('web_mailbox') || []).filter((m) => m.from === 'che' && m.to === 'claude').length, 1);
    assert.match(again.text, /did not send it again/);

    // Before any reply: status is "sent, no reply yet".
    assert.match((await chat('did Claude reply?')).text, /sent Claude the request \(message [0-9a-f]{8}\); no reply yet/);

    // 7: a real Claude message arrives → CHE may say Claude replied.
    await state.replyToFlagstaffMessage({ id: 'claude-reply-1', from: 'claude', to: 'che', text: 'Reviewed: the delegation change looks right.', reply_to: packet.id });
    assert.match((await chat('did Claude reply?')).text, /Claude replied \(message claude-r\)/);
  } finally { globalThis.fetch = original; }
});

test('10: "batch it fast and use the other AIs" creates a real batch: packets to Claude and ChatGPT plus CHE\'s own job', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = fakeGitHub([]);
  try {
    const { saved, chat } = await setup();
    saved.set('che_last_engineering_request', { request: 'speed up Office task hand-off', integrate: true });
    const out = await chat('Batch it fast and use the other AIs');
    const box = saved.get('web_mailbox') || [];
    assert.ok(box.some((m) => m.to === 'claude') && box.some((m) => m.to === 'chatgpt'));
    assert.match(out.text, /Batch [0-9a-f]{8}/);
    const session = Object.values(saved.get('che_collaboration_sessions'))[0];
    assert.equal(session.batch, true);
    assert.ok(session.lanes.length >= 3);
    assert.equal(saved.get('che').jobs.filter((j) => j.kind === 'self_development').length, 1);
  } finally { globalThis.fetch = original; }
});

test('12: the same mailbox message delivered twice records one receipt and one AI cycle', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = fakeGitHub([]);
  try {
    const { saved, state, aiCalls } = await setup({ aiReply: 'Thanks, noted.' });
    const msg = { id: 'dup-1', from: 'claude', to: 'che', text: 'Status update for CHE.' };
    await state.replyToFlagstaffMessage(msg);
    await state.replyToFlagstaffMessage(msg);
    assert.equal((saved.get('che_receipts') || []).filter((r) => r.kind === 'mail_received' && r.message_id === 'dup-1').length, 1);
    assert.equal(aiCalls.length, 1);
  } finally { globalThis.fetch = original; }
});

test('16 + 17: voice-first and money/delete authorization rules are still in force', async () => {
  const router = readFileSync(new URL('./ai_router.js', import.meta.url), 'utf8');
  assert.match(router, /Never say \\"tap here\\"/);
  assert.match(router, /Ask first ONLY before spending money/);
  const workerSource = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  assert.match(workerSource, /ask first only when something costs money/);
});
