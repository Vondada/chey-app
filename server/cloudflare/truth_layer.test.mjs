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
    if (method === 'GET' && path.startsWith('/contents/mailbox?ref=')) return reply([...threads.keys()].map((peer) => ({ name: `${peer}.jsonl` })));
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

// The ONE mailbox is GitHub: read what the fake GitHub mailbox holds.
function githubMailbox(log) {
  const latest = new Map();
  for (const entry of log) latest.set(entry.peer, entry.content);
  return [...latest.values()].flatMap((content) => content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)));
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
    assert.equal(saved.get('web_mailbox'), undefined, 'no second local mailbox');
    const box = githubMailbox(log);
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
    assert.equal(githubMailbox(log).filter((m) => m.from === 'che' && m.to === 'claude').length, 1);
    assert.match(again.text, /did not send it again/);

    // Before any reply: status is "sent, no reply yet".
    assert.match((await chat('did Claude reply?')).text, /sent Claude the request \(message [0-9a-f]{8}\); no reply yet/);

    // 7: a real Claude message arrives → CHE may say Claude replied.
    await state.replyToFlagstaffMessage({ id: 'claude-reply-1', from: 'claude', to: 'che', text: 'Reviewed: the delegation change looks right.', reply_to: packet.id });
    assert.match((await chat('did Claude reply?')).text, /Claude replied \(message claude-r\)/);
  } finally { globalThis.fetch = original; }
});

test('10: "batch it fast and use the other AIs" creates a real batch: packets to Claude and ChatGPT plus CHE\'s own job', async () => {
  const log = [];
  const original = globalThis.fetch;
  globalThis.fetch = fakeGitHub(log);
  try {
    const { saved, chat } = await setup();
    saved.set('che_last_engineering_request', { request: 'speed up Office task hand-off', integrate: true });
    const out = await chat('Batch it fast and use the other AIs');
    const box = githubMailbox(log);
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

test('one mailbox: Flagstaff and GitHub are the same store; undelivered mail is queued, never claimed sent', async () => {
  const { postWebMail, readWebMail, flushOutbox } = await import('./web_mailbox.js');
  const saved = new Map();
  const storage = storageFor(saved);
  const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'Vondada/chey-app' };
  const log = [];
  let githubDown = true;
  const gh = fakeGitHub(log);
  const fetcher = async (url, init = {}) => (githubDown && (init.method || 'GET') === 'PUT' ? new Response('{}', { status: 503 }) : gh(url, init));
  const queued = await postWebMail(storage, { from: 'che', to: 'claude', text: 'Packet one' }, env, fetcher);
  assert.equal(queued.status, 202);
  assert.equal(queued.delivered, false);
  assert.equal(saved.get('web_mailbox'), undefined, 'no local copy that could become a second mailbox');
  const board = await readWebMail(storage, 50, env, fetcher);
  assert.equal(board.find((m) => m.id === queued.message.id)?.pending, true, 'shown as still sending');
  githubDown = false;
  assert.deepEqual(await flushOutbox(storage, env, fetcher), { sent: 1, pending: 0 });
  const after = await readWebMail(storage, 50, env, fetcher);
  const delivered = after.filter((m) => m.id === queued.message.id);
  assert.equal(delivered.length, 1, 'exactly one copy, now in GitHub');
  assert.equal(delivered[0].pending, undefined);
  // Messages posted straight into GitHub by an AI are on the board too.
  const direct = await postWebMail(storage, { from: 'grok', to: 'che', text: 'Hello from the web link' }, env, fetcher);
  assert.equal(direct.status, 200);
  assert.ok(githubMailbox(log).some((m) => m.id === direct.message.id));
});

test('one mailbox: a legacy local board message that never reached GitHub is moved there, then the local board is removed', async () => {
  const { flushOutbox } = await import('./web_mailbox.js');
  const saved = new Map([['web_mailbox', [{ id: 'old-1', at: new Date().toISOString(), from: 'chatgpt', to: 'che', text: 'Only on the old board', reply_to: '' }]]]);
  const log = [];
  const out = await flushOutbox(storageFor(saved), { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'Vondada/chey-app' }, fakeGitHub(log));
  assert.equal(out.sent, 1);
  assert.equal(saved.get('web_mailbox'), undefined);
  assert.ok(githubMailbox(log).some((m) => m.id === 'old-1'));
});

test('skills: the report says exactly which agent has which skill — or that none were given', async () => {
  const { chat, saved } = await setup();
  const none = await chat('Which skills did you give your office agents? How did you implement the agency-agents repo?');
  assert.match(none.text, /I have not implemented msitarzewski\/agency-agents/);
  assert.match(none.text, /I have not given any Office agent a skill yet/);
  assert.match(none.text, /Knox/);
  const data = saved.get('che');
  data.office_skills = [{ id: 's1', name: 'Frontend build checklist', trigger: 'building UI', steps: ['plan', 'build'], assigned_agents: ['Knox'], source: { repo: 'msitarzewski/agency-agents', path: 'engineering/engineering-frontend-developer.md', license: 'MIT' } }];
  data.team.find((a) => a.name === 'Knox').skill_ids = ['s1'];
  saved.set('che', data);
  const some = await chat('Which skills did you give your agents from the agency-agents repo?');
  assert.match(some.text, /Knox: Frontend build checklist/);
  assert.match(some.text, /Knox \(Engineering \/ Codex jobs\): assigned Frontend build checklist/);
  assert.match(some.text, /have no skills yet/);
});

test('skills: "give your office agents skills from agency-agents" runs a real license-checked import with per-agent skills', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const ok = (d) => new Response(JSON.stringify(d), { status: 200 });
    if (u === 'https://api.github.com/repos/msitarzewski/agency-agents') return ok({ default_branch: 'main', license: { spdx_id: 'MIT' } });
    if (u.includes('/git/trees/')) return ok({ tree: [
      { type: 'blob', path: 'engineering/engineering-frontend-developer.md' },
      { type: 'blob', path: 'marketing/marketing-growth-hacker.md' },
      { type: 'blob', path: 'README.md' },
    ] });
    const m = /\/contents\/(.+)\?ref=/.exec(u);
    if (m) return ok({ content: Buffer.from(`# ${decodeURIComponent(m[1])}\n## Process\n- Understand the goal clearly\n- Build the first version carefully\n## When to activate\n- New UI work\n`).toString('base64') });
    return new Response('{}', { status: 404 });
  };
  try {
    const { chat, saved, state } = await setup({ aiReply: 'not json' });
    const out = await chat('Give your office agents skills from the agency-agents repo');
    const job = saved.get('che').jobs.find((j) => j.kind === 'office_skill_import');
    assert.ok(job && out.text.includes(job.id.slice(0, 8)));
    job.retry_at = 0; const d = saved.get('che'); d.jobs = d.jobs.map((j) => (j.id === job.id ? job : j)); saved.set('che', d);
    await state.processJobs();
    const done = saved.get('che').jobs.find((j) => j.id === job.id);
    assert.equal(done.status, 'complete', done.error);
    assert.match(done.owner_message, /Knox got/);
    assert.match(done.owner_message, /Lyra got/);
    const skills = saved.get('che').office_skills;
    assert.ok(skills.every((s) => s.source?.repo === 'msitarzewski/agency-agents' && s.source.license === 'MIT'));
    assert.ok(saved.get('che').team.find((a) => a.name === 'Knox').skill_ids.length >= 1);
  } finally { globalThis.fetch = original; }
});

test('the engineering playbook is built into every coding-team agent and readable on request', async () => {
  const { ENGINEERING_PLAYBOOK, playbookIntent } = await import('./engineering_playbook.js');
  const { prepareSelfUpdate } = await import('./self_development.js');
  const systems = [];
  const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r', AI: { run: async (_m, input) => { systems.push(input.messages[0].content); return { response: '{}' }; } } };
  await prepareSelfUpdate(env, 'improve the banner', async () => new Response('{}', { status: 503 }), null).catch(() => null);
  const fetcher = async (url) => {
    const u = String(url);
    const ok = (d) => new Response(JSON.stringify(d), { status: 200 });
    if (u.endsWith('/o/r')) return ok({ default_branch: 'main' });
    if (u.includes('/git/ref/')) return ok({ object: { sha: 'a' } });
    if (u.includes('/git/trees/')) return ok({ tree: [{ type: 'blob', path: 'lib/main.dart' }] });
    if (u.includes('/contents/')) return ok({ sha: 'b', content: Buffer.from("class A { String s = 'Ready'; }\n").toString('base64') });
    return ok({ items: [] });
  };
  await prepareSelfUpdate(env, 'improve the banner', fetcher, null);
  assert.ok(systems.length > 0 && systems.every((system) => system.includes(ENGINEERING_PLAYBOOK)), 'every agent call carries the playbook');
  assert.equal(playbookIntent("What's your engineering playbook?"), true);
  assert.equal(playbookIntent('Read me the coding handoff'), true);
  const { chat, aiCalls } = await setup();
  const out = await chat("What's your engineering playbook?");
  assert.match(out.text, /I read my real code on GitHub first/);
  assert.equal(aiCalls.length, 0);
});

test('configuration/creation claims about code need real evidence too', () => {
  for (const claim of [
    'I have finalized the configuration for the workflow by creating the .github/workflows/che-autopilot.yml file.',
    'I have integrated the coding runtime into the self-development path.',
    'I have enabled the auto-merge policy for the repo.',
  ]) assert.equal(guardOwnerReply(claim, NONE).text, '', claim);
  assert.equal(guardOwnerReply('I have set a reminder for 5 pm.', NONE).text, 'I have set a reminder for 5 pm.');
});

test('status is about now: old merges are not "updated", a merged PR is not "open", and a failed job never reads as the waiting change', () => {
  const old = new Date(Date.now() - 48 * 3600_000).toISOString();
  const now = new Date().toISOString();
  const stale = verifiedStatusText(verifiedState([
    { kind: 'merged', number: 3, sha: 'aaa1111', at: old },
    { kind: 'deployed', at: old },
  ], [], {}));
  assert.doesNotMatch(stale, /merged|deployed/);
  const mergedSince = verifiedStatusText(verifiedState([
    { kind: 'pr_opened', number: 9, at: now },
    { kind: 'merged', number: 9, sha: 'bbb2222', at: now },
  ], [], {}));
  assert.doesNotMatch(mergedSince, /PR #9 is open/);
  assert.match(mergedSince, /PR #9 was merged/);
  const both = verifiedStatusText(verifiedState([], [
    { id: 'job12345678', kind: 'self_development', status: 'failed', updated_at: now, owner_message: "Coding job job12345 stopped: my engineers' edits did not match the current source. Nothing was changed." },
  ], { pendingProposal: { summary: 'War Room table pulse', files: [] } }));
  assert.match(both, /Nothing was changed\..*Separately, an earlier reviewed change \(War Room table pulse\) is still waiting/);
  assert.doesNotMatch(both, /complete|repository (?:was|is) updated/i);
});

test('grounded-fact guard: invented files, foreign PR links and unknown job ids never reach another AI', async () => {
  const { guardGroundedFacts } = await import('./truth_layer.js');
  const paths = ['server/cloudflare/worker.js', 'server/cloudflare/objective_graph.js', 'lib/main.dart'];
  // The real 2026-10-08 Flagstaff replies that invented work.
  const invented = 'The file is src/voice/intentHandler.js and the function is processMissionStatus. I have verified the file contents directly within the repository. I cannot start a real coding job from this message.';
  const out = guardGroundedFacts(invented, { paths, repo: 'Vondada/chey-app', jobIds: [] });
  assert.doesNotMatch(out.text, /intentHandler|verified the file/);
  assert.match(out.text, /cannot start a real coding job/);
  assert.equal(out.removed[0].rule, 'unknown_file:src/voice/intentHandler.js');
  const fakePr = guardGroundedFacts('I have resumed the job under ID 20261008-01-RECOVERY. Draft PR URL https://github.com/owner-repo/pull/42. No phone restart is required.', { paths, repo: 'Vondada/chey-app', jobIds: ['abc-real'] });
  assert.equal(fakePr.text, 'No phone restart is required.');
  assert.equal(guardGroundedFacts('Job ID: 20261008-01-RECOVERY. Done.', { paths, repo: 'Vondada/chey-app', jobIds: ['abc-real'] }).removed[0]?.rule, 'unknown_job:20261008-01-RECOVERY');
  assert.equal(guardGroundedFacts('Job #abc-real-1234 is running.', { paths, jobIds: ['abc-real-1234'] }).removed.length, 0);
  // Real files, real repo links and product names stay.
  const real = guardGroundedFacts('It lives in server/cloudflare/worker.js and objective_graph.js. See https://github.com/Vondada/chey-app/pull/203. It runs on Node.js.', { paths, repo: 'Vondada/chey-app' });
  assert.equal(real.removed.length, 0);
});

test('quoted code that is not in the repository is removed (live test Q3 invented a Promise.all line)', async () => {
  const { guardGroundedFacts } = await import('./truth_layer.js');
  const repo = 'const results = await Promise.allSettled(engines.map(lookup));\nexport async function publicResearch(query) {';
  const codeIncludes = (t) => repo.toLowerCase().includes(String(t).toLowerCase());
  const invented = 'It queries two engines at the same time. The line is:\n```js\nconst [searchResult, knowledgeResult] = await Promise.all([searchEngine(query), knowledgeEngine(query)]);\n```\nIt calls `searchEngine` first.';
  const out = guardGroundedFacts(invented, { paths: ['server/cloudflare/worker.js'], codeIncludes });
  assert.doesNotMatch(out.text, /searchResult|searchEngine/);
  assert.ok(out.removed.some((r) => r.rule === 'unverified_code'));
  const real = guardGroundedFacts('The line is:\n```js\nconst results = await Promise.allSettled(engines.map(lookup));\n```\nSee `publicResearch`.', { paths: ['server/cloudflare/worker.js'], codeIncludes });
  assert.equal(real.removed.length, 0);
  assert.match(real.text, /allSettled/);
  // A block of only short invented statements is checked too (Codex on #247).
  const short = guardGroundedFacts('Like this:\n```js\nhack();\nship();\n}\n```\nDone.', { paths: [], codeIncludes });
  assert.doesNotMatch(short.text, /hack|ship/);
  assert.ok(short.removed.some((r) => r.rule === 'unverified_code'));
});
