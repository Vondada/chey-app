// Truth layer regression suite: CHE may only state what receipts prove.
// Reproduces the 2026-10-02 22:20 incident (Study 1 and 2 → "Okay" → "tell me
// when you are ready" → paste-the-source request → "work with Claude") and
// the owner's required cases.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { asksForCurrentOwnerLocation, guardClaimedResearchActions, guardLocationWeatherReply, guardOwnerReply, OWNER_LOCATION_NOT_VERIFIED, verifiedState, verifiedStatusText } from './truth_layer.js';
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
  assert.match(some.text, /Knox \(Security \/ protection\): assigned Frontend build checklist/);
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

test('grounded-fact guard flagOnly keeps every sentence and marks the unverified one', async () => {
  const { guardGroundedFacts } = await import('./truth_layer.js');
  const paths = ['server/cloudflare/worker.js'];
  const reply = 'The sum runs to n - 1 in the loop. The file is src/voice/intentHandler.js. The capital is Canberra.';
  const out = guardGroundedFacts(reply, { paths, repo: 'Vondada/chey-app', jobIds: [], flagOnly: true });
  assert.match(out.text, /The sum runs to n - 1 in the loop\./);
  assert.match(out.text, /The capital is Canberra\./);
  assert.match(out.text, /\[NOT VERIFIED\] The file is src\/voice\/intentHandler\.js\./);
  assert.equal(out.removed.length, 1);
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

test('code CHE writes herself is not flagged as an unverified repository quote (Round 7 exam)', async () => {
  const { guardGroundedFacts, requestedCodeNames } = await import('./truth_layer.js');
  const repo = 'const results = await Promise.allSettled(engines.map(lookup));\nexport async function publicResearch(query) {';
  const codeIncludes = (t) => repo.toLowerCase().includes(String(t).toLowerCase());
  const request = 'L1 write a JavaScript function vowelCount(s). L2 this code is wrong. function sumTo(n) { ... } Give the fixed code.';
  assert.deepEqual([...requestedCodeNames(request)].sort(), ['sumTo', 'vowelCount']);
  const opts = { paths: ['server/cloudflare/worker.js'], codeIncludes, flagOnly: true, authoredNames: requestedCodeNames(request) };
  // Level 1: the function the sender asked for, not in the repository.
  const l1 = guardGroundedFacts('Level 1:\n```js\nfunction vowelCount(s) {\n  return (s.match(/[aeiou]/gi) || []).length;\n}\n```\nIt counts vowels.', opts);
  assert.equal(l1.removed.length, 0);
  assert.doesNotMatch(l1.text, /NOT VERIFIED/);
  // Level 2: a fix announced as hers, even when the block has no definition line.
  const l2 = guardGroundedFacts('The loop stopped one short. Here is my fix:\n```js\nfor (let i = 1; i <= n; i++) total += i;\n```\nNow it sums up to n.', opts);
  assert.equal(l2.removed.length, 0);
  assert.match(l2.text, /i <= n/);
  // A quote of repository code that does not exist is still marked.
  const fake = guardGroundedFacts('The line in worker.js is:\n```js\nconst [a, b] = await Promise.all([one(), two()]);\n```', opts);
  assert.ok(fake.removed.some((r) => r.rule === 'unverified_code'));
  assert.match(fake.text, /NOT VERIFIED/);
  // A "new" function that reuses a real repository name is treated as a quote and checked.
  const reused = guardGroundedFacts('It is:\n```js\nexport async function publicResearch(query) {\n  return fetchEverything(query);\n}\n```', opts);
  assert.ok(reused.removed.some((r) => r.rule === 'unverified_code'));
  // A requested name presented as existing code is a quote and is checked.
  const asQuote = guardGroundedFacts('The current code in worker.js is:\n```js\nfunction sumTo(n) { return magic(n); }\n```', opts);
  assert.ok(asQuote.removed.some((r) => r.rule === 'unverified_code'));
  // A name merely missing from the repository is not authorship (Codex on #257).
  const invented = guardGroundedFacts('The repository defines:\n```js\nfunction imaginaryHandler(req) {\n  return route(req);\n}\n```', opts);
  assert.ok(invented.removed.some((r) => r.rule === 'unverified_code'));
  // A cue covers only the block it introduces, not a later quote (Codex on #257).
  const two = guardGroundedFacts('Here is my fix:\n```js\nfor (let i = 1; i <= n; i++) total += i;\n```\nFor comparison, the repository code is:\n```js\nconst fake = await inventedThing();\n```', opts);
  assert.equal(two.removed.length, 1);
  assert.match(two.text, /i <= n/);
  assert.match(two.text, /\[NOT VERIFIED\] ```js\nconst fake/);
  // Inline backticks inside her own code (a template literal) are not re-checked as quotes (Codex on #257).
  const tpl = guardGroundedFacts('Here is my solution:\n```js\nfunction greet(name) {\n  return `Hello ${name}`;\n}\n```\nDone.', opts);
  assert.equal(tpl.removed.length, 0);
  assert.match(tpl.text, /`Hello \$\{name\}`/);
});

test('grounded guard rejects a line citation that does not match the pinned file', async () => {
  const { guardGroundedFacts } = await import('./truth_layer.js');
  const paths = ['server/cloudflare/self_skills.js'];
  const fileText = (p) => (p === paths[0] ? Array.from({ length: 140 }, (_, i) => (i === 61 ? 'export function normalizeSkills(raw, sourceName) {' : 'line ' + i)).join('\n') : null);
  // Wrong line: normalizeSkills is defined on line 62, not 130.
  const wrong = guardGroundedFacts('The file server/cloudflare/self_skills.js has a weakness at line 130 in normalizeSkills.', { paths, fileText });
  assert.equal(wrong.text, '');
  assert.match(wrong.removed[0].rule, /^wrong_line:server\/cloudflare\/self_skills\.js:130/);
  // Line beyond the end of the file.
  assert.equal(guardGroundedFacts('server/cloudflare/self_skills.js line 999 is empty.', { paths, fileText }).removed[0].rule, 'line_out_of_range:server/cloudflare/self_skills.js:999');
  // Correct citation and a plain file mention both stay.
  assert.match(guardGroundedFacts('normalizeSkills is at line 62 in server/cloudflare/self_skills.js.', { paths, fileText }).text, /line 62/);
  assert.match(guardGroundedFacts('It lives in server/cloudflare/self_skills.js.', { paths, fileText }).text, /self_skills/);
});

test('requestedCodeNames catches a name written with parentheses, not only "function NAME"', async () => {
  const { requestedCodeNames } = await import('./truth_layer.js');
  const names = requestedCodeNames('Write canAttempt(state, kind, limits) and recordAttempt(state, kind). kind is semantic or format.');
  assert.ok(names.has('canAttempt'));
  assert.ok(names.has('recordAttempt'));
});


test('owner location follow-ups do not assume GPS from a time zone or a remembered city', () => {
  for (const request of [
    'So you know where I am though',
    "That's good, so where am I since I sent you?",
    'Do you have my current location?',
    "What's my GPS position?",
  ]) assert.equal(asksForCurrentOwnerLocation(request), true, request);
  for (const request of ['Where am I going with this idea?', 'Where am I in life?', 'Where is Marrero?']) {
    assert.equal(asksForCurrentOwnerLocation(request), false, request);
  }
  assert.match(OWNER_LOCATION_NOT_VERIFIED, /not live GPS coordinates/);
  assert.match(guardLocationWeatherReply('Do you know my location?', "Yes—I've used the location you've shared with CHE to pull the forecast."), /cannot verify where/);
  const madeUp = 'It will be mostly sunny with a high of 72 degrees and a low of 54 degrees. I checked the forecast.';
  assert.match(guardLocationWeatherReply("What's the weather like tomorrow?", madeUp), /do not have a verified live weather forecast/);
  assert.equal(guardLocationWeatherReply("What's the weather like tomorrow in Marrero?", madeUp, { forecastVerified: true }), madeUp);
  assert.equal(guardLocationWeatherReply('Tell me about weather forecasts', 'Weather can be unpredictable.'), 'Weather can be unpredictable.');
});

test('worker location handling runs before generic chat model and guards forecast output', () => {
  const source = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  const clock = source.indexOf('const clientClock = formatClientTime(body.client_time);', source.indexOf("if (path === '/api/chat')"));
  const reply = source.indexOf('reply = guardLocationWeatherReply(message, reply, {');
  assert.ok(clock >= 0);
  assert.ok(source.indexOf('asksForCurrentOwnerLocation(message)', clock) > clock);
  assert.ok(reply > clock);
  assert.ok(source.includes("source: 'location_provenance'"));
});

test('comprehension audit: a model reply cannot claim it sent, bought, deleted, rendered, traded or opened anything', async () => {
  const { guardClaimedOwnerActions: guard } = await import('./truth_layer.js');
  const lie = guard('Done, sir. I sent it and bought it.');
  assert.equal(lie.text, 'Nothing was sent or bought, sir: I have no record of doing that.');
  assert.equal(lie.removed.length, 2);
  for (const claim of ['Your email has been sent to Sarah.', 'I placed a paper trade for 1 MNQ.', 'I started the coding job.', 'I opened YouTube for you.',
    'I made the 30-second video.', 'I set a reminder for 8am tomorrow.', 'I switched to live trading.', 'I added it to your calendar for Friday.',
    'I have already sent the email.', 'I closed your MNQ position.', 'Consider it done.', 'I rendered the volcano video.', 'I paid the electric bill.', 'I ordered a pizza.', 'Your video has been rendered.']) {
    assert.notEqual(guard(claim).removed.length, 0, claim);
  }
  // Facts, refusals, conditions, quotes and ordinary chat are kept as written.
  for (const kept of ['Apple bought Beats in 2014.', 'I have not sent anything yet, sir.', 'Once I have sent it, I will tell you.', 'I can send it once you say yes.',
    'I would have paid it, but the account is not connected.', 'You said "I sent it" yesterday.', 'I made a note of that.', 'I started learning French last year.',
    'Done with the analysis: MNQ is up.', 'Paris is the capital of France.', 'Here is a joke: why did the chicken cross the road?',
    'I paid close attention to your request.', 'I ordered them by date for you.', 'I rendered it as a table below.']) {
    assert.equal(guard(kept).text, kept, kept);
  }
  // Text the owner asked CHE to write in his voice keeps it; CHE's own "Done, sir." around it does not.
  assert.equal(guard('Here is your text: I bought the tickets, see you at 8.', { message: 'write a text to my wife saying I bought the tickets' }).removed.length, 0);
  assert.match(guard('Done, sir. I sent it and bought it.', { message: "Draft an email to Mike about Friday's meeting" }).text, /^Nothing was sent or bought, sir/);
  assert.equal(guard('I bought you flowers.', { message: 'Tell me a story about a robot' }).removed.length, 0);
});

test('comprehension audit: "what city am I in?" is a location question, and "what changed in your code this week?" reads the change log', async () => {
  const { changeHistoryIntent } = await import('./truth_layer.js');
  assert.equal(asksForCurrentOwnerLocation('What city am I in?'), true);
  assert.equal(asksForCurrentOwnerLocation('what city am i in right now'), true);
  assert.equal(asksForCurrentOwnerLocation('What city is the Eiffel Tower in?'), false);
  assert.equal(changeHistoryIntent('What changed in your code this week?'), true);
  assert.equal(changeHistoryIntent('what changed in the market today'), false);
});

// Comprehension audit, review of PR #356 (issues #350): the claim guard reads the request before it exempts a reply, and
// names the common ways of saying an action happened that have no matching verb.
test('review #356: a draft that also asks CHE to send or post is checked; a plain draft keeps the owner\'s text', async () => {
  const { guardClaimedOwnerActions: guard } = await import('./truth_layer.js');
  const mom = 'Sure. I texted your mom that you are on the way and bought the card.';
  const sent = guard(mom, { message: 'draft a text to mom and send it' });
  assert.equal(sent.text, 'Sure. Nothing was sent or bought, sir: I have no record of doing that.');
  assert.equal(sent.removed.length, 1);
  assert.match(guard('Sure. I posted it to TikTok and bought ads.', { message: 'write a message to mark and post it to tiktok' }).text, /^Sure\. Nothing was uploaded or bought, sir/);
  // Ordinary drafts (no action verb, or "text" as a noun) keep what the owner asked to be written.
  assert.equal(guard('Here is your text: I bought the tickets, see you at 8.', { message: 'write a text to my wife saying I bought the tickets' }).removed.length, 0);
  assert.equal(guard('Here is your post: I bought the ticket.', { message: 'write a post about my trip' }).removed.length, 0);
});

test('review #356: a story that also asks CHE to send is not exempt; a plain story still is', async () => {
  const { guardClaimedOwnerActions: guard } = await import('./truth_layer.js');
  const story = guard('Done, sir. I sent it and bought it.', { message: 'tell me a story and then send sarah the report' });
  assert.equal(story.text, 'Nothing was sent or bought, sir: I have no record of doing that.');
  assert.equal(guard('Once upon a time, sir, a robot bought you flowers.', { message: 'tell me a story about a robot' }).removed.length, 0);
});

test('review #356: a claim with no matching verb is removed, for the request that makes it', async () => {
  const { guardClaimedOwnerActions: guard } = await import('./truth_layer.js');
  // A claim about an email, an order or a file is not CHE's own action: the note says CHE cannot confirm it (review of
  // PR #356, round 2). "I've taken care of the bill" and "pagué" are CHE's own action, so the denial names them.
  const CANNOT_CONFIRM = 'I cannot confirm that from my record, sir.';
  const cases = [
    ["It's been dispatched to Sarah, sir.", 'send sarah the report', CANNOT_CONFIRM],
    ['Your order went through, sir.', 'send sarah the report', CANNOT_CONFIRM],
    ["I've taken care of the bill, sir.", 'pay the bill', 'Nothing was paid, sir: I have no record of doing that.'],
    ['Purchase complete. Confirmation number 4471.', 'buy it', CANNOT_CONFIRM],
    ['Your notes are gone now, sir.', 'delete my notes', CANNOT_CONFIRM],
    ['The email is on its way to Sarah.', 'send sarah the report', CANNOT_CONFIRM],
    ['Listo, señor: pagué la factura.', 'pay the bill', 'Nothing was paid, sir: I have no record of doing that.'],
  ];
  for (const [reply, message, note] of cases) {
    const out = guard(reply, { message });
    assert.ok(out.removed.length >= 1, reply);
    assert.equal(out.text, note, reply);
  }
  // Facts and ordinary talk with the same nouns stay as written.
  for (const kept of ['The order form is on the table.', 'Your notes are on the desk, sir.', 'Your order form is on the desk, sir.', 'Listo para la reunión, señor.',
    'Once the email is on its way, I will tell you.', 'Si no lo he pagado, dímelo.']) {
    assert.equal(guard(kept, { message: 'pay the bill' }).text, kept, kept);
  }
});

// Review of PR #356, blocker 1: the five phrasings, with the request that makes each a lie, and the counter-cases.
test('review #356: "went out", "is with", "in Sarah\'s inbox", "all set", "done and dusted" and "ya está hecho" are claims for a send', async () => {
  const { guardClaimedOwnerActions: guard } = await import('./truth_layer.js');
  const message = 'send sarah the report';
  // A claim about the email or the report is taken out with the neutral note; "All set" and "Ya está hecho" are CHE's own
  // completion, so the denial names the request's verb.
  for (const reply of ["Okay, I'm on it: the email went out.", 'Got it, the report is in Sarah\'s inbox now.']) {
    const out = guard(reply, { message });
    assert.ok(out.removed.length >= 1, reply);
    assert.equal(out.text, 'I cannot confirm that from my record, sir.', reply);
  }
  for (const reply of ['All set, sir. The report is with Sarah.', 'It is all done and dusted.', 'Ya está hecho.']) {
    const out = guard(reply, { message });
    assert.ok(out.removed.length >= 1, reply);
    assert.equal(out.text, 'Nothing was sent, sir: I have no record of doing that.', reply);
  }
  for (const honest of ['The report did not go out yet.', 'No, it is not with Sarah.', 'The email never went out, sir.', 'It is not all done and dusted yet.']) {
    assert.equal(guard(honest, { message }).text, honest, honest);
  }
});

test('review #356: "All set" and "done and dusted" are not claims when the request asks for no action', async () => {
  const { guardClaimedOwnerActions: guard } = await import('./truth_layer.js');
  const status = 'All set, sir. Your meeting is at noon.';
  assert.equal(guard(status, { message: 'what is on my calendar?' }).text, status);
  assert.equal(guard('It is all done and dusted, sir.', { message: 'how did the report go?' }).text, 'It is all done and dusted, sir.');
});

// Review of PR #356, round 2, blocker 2: the denial "Nothing was X" is only for CHE's own action. A thing or a person that went
// out, is with someone, or is "hecho" on a status question is a claim CHE cannot confirm, or no claim at all.
test('review #356: the denial names only CHE\'s own action; status, recall and Spanish status replies are not denied', async () => {
  const { guardClaimedOwnerActions: guard } = await import('./truth_layer.js');
  assert.equal(guard('The report went out of date last week, sir.', { message: 'how is the report going?' }).text, 'The report went out of date last week, sir.');
  assert.equal(guard('The report is with errors, sir.', { message: 'how is the report going?' }).text, 'The report is with errors, sir.');
  assert.equal(guard('The email is with no attachments, sir.', { message: 'how is the report going?' }).text, 'The email is with no attachments, sir.');
  assert.equal(guard('El café ya está hecho, señor.', { message: 'el café ya está hecho?' }).text, 'El café ya está hecho, señor.');
  assert.equal(guard('Ya está hecho, señor. Está en la cocina.', { message: '¿está listo el café?' }).text, 'Ya está hecho, señor. Está en la cocina.');
  assert.equal(guard('The report went out on Monday, sir.', { message: 'did the report go out?' }).text, 'I cannot confirm that from my record, sir.');
  assert.equal(guard('The email went out last Tuesday, sir.', { message: 'what did I send Ann last week?' }).text, 'I cannot confirm that from my record, sir.');
  // CHE's own action keeps the denial, with or without a request.
  assert.equal(guard('I sent it, sir.', { message: 'what did I send Ann last week?' }).text, 'Nothing was sent, sir: I have no record of doing that.');
  assert.equal(guard('I sent it, sir.').text, 'Nothing was sent, sir: I have no record of doing that.');
});

// Review of PR #356, round 4: a question mark does not make a claim safe. A claim with a question tag is still checked; only a
// question that opens with a question or status word is kept. The seven outputs match 98b190a.
test('review #356: a claim with a question tag is taken out, and a real question is kept', async () => {
  const { guardClaimedOwnerActions: guard } = await import('./truth_layer.js');
  const message = 'send sarah the report';
  const NOTHING_SENT = 'Nothing was sent, sir: I have no record of doing that.';
  // The affirmation "Yes, I did." affirms the claim the guard just removed, so it is removed with it (review of PR #356, round 5).
  assert.equal(guard('I sent it? Yes, I did.', { message }).text, NOTHING_SENT);
  assert.equal(guard('I sent it. Yes, I did.', { message }).text, NOTHING_SENT);
  assert.equal(guard('I sent it? Sí, lo hice.', { message }).text, NOTHING_SENT);
  assert.equal(guard('Yes, I did.', { message }).text, 'Yes, I did.');
  // The affirmation goes only with the sentence just before it (follow-up): a "Yes." after a question is the owner's answer.
  assert.equal(guard('Your order went through, right? Is the calendar clear? Yes.', { message }).text,
    'Is the calendar clear? Yes. I cannot confirm that from my record, sir.');
  assert.equal(guard("I sent it, didn't I?", { message }).text, NOTHING_SENT);
  assert.equal(guard('I sent Sarah the email, right?', { message }).text, NOTHING_SENT);
  assert.equal(guard('Your order went through, right?', { message }).text, 'I cannot confirm that from my record, sir.');
  assert.equal(guard("The email went out, didn't it?", { message }).text, 'I cannot confirm that from my record, sir.');
  assert.equal(guard('Ya lo mandé, ¿verdad?', { message }).text, NOTHING_SENT);
  assert.equal(guard('Ya está hecho, ¿verdad?', { message }).text, NOTHING_SENT);
  // Real questions and an honest answer to one stay as written.
  assert.equal(guard('All set? Should I send it now, sir?', { message }).text, 'All set? Should I send it now, sir?');
  assert.equal(guard('Did I send it? I did.', { message }).text, 'Did I send it? I did.');
  assert.equal(guard('Done, sir. I sent it. Should I send more?', { message }).text, `Should I send more? ${NOTHING_SENT}`);
});

// Review of PR #356, round 3: a delivery passive on a noun subject is a claim about a thing (the neutral note); a question is
// not a claim; "ready to go" names no delivery.
test('review #356: "the email is dispatched", "the report was sent yesterday", "the report got sent" are neutral, and a question is kept', async () => {
  const { guardClaimedOwnerActions: guard } = await import('./truth_layer.js');
  const message = 'send sarah the report';
  for (const reply of ['The email is dispatched, sir.', 'The report was sent yesterday, sir.', 'The report got sent, sir.']) {
    const out = guard(reply, { message });
    assert.ok(out.removed.length >= 1, reply);
    assert.equal(out.text, 'I cannot confirm that from my record, sir.', reply);
  }
  assert.equal(guard('All set? Should I send it now, sir?', { message }).text, 'All set? Should I send it now, sir?');
  assert.equal(guard('The report is ready to go, sir.', { message }).text, 'The report is ready to go, sir.');
  // Not a delivery: a negated or modal passive is kept.
  assert.equal(guard('The report was never sent, sir.', { message }).text, 'The report was never sent, sir.');
  assert.equal(guard('The report will be sent tomorrow, sir.', { message }).text, 'The report will be sent tomorrow, sir.');
});

// Review of #356, round 3 (B2): a source phrase keeps the sentence only when a record CHE read this turn backs it.
test('claim guard: "according to your calendar" stays when this turn read a record that backs it, and is neutral without one', async () => {
  const { guardClaimedOwnerActions } = await import('./truth_layer.js');
  const message = 'send Sarah the report';
  const calendar = 'Scheduled for Friday at 3 PM, according to your calendar, sir.';
  const log = 'Forwarded to Sarah yesterday, sir, per the log.';
  const records = [JSON.stringify({ calendar: [{ title: 'Dentist', when: 'Friday 3 PM' }] }), JSON.stringify({ log: [{ action: 'forwarded', to: 'Sarah' }] })];
  assert.equal(guardClaimedOwnerActions(calendar, { message, records }).text, calendar);
  assert.equal(guardClaimedOwnerActions(log, { message, records }).text, log);
  assert.equal(guardClaimedOwnerActions(calendar, { message }).text, 'I cannot confirm that from my record, sir.');
  // A record that does not name the same day and time does not back it.
  assert.equal(guardClaimedOwnerActions(calendar, { message, records: [JSON.stringify({ calendar: [{ when: 'Monday 9 AM' }] })] }).text, 'I cannot confirm that from my record, sir.');
  // A record never turns CHE's own unbacked action into a kept one: "from your account" is not a source.
  assert.equal(guardClaimedOwnerActions('Sent the report to Sarah from your account, sir.', { message, records }).text, 'Nothing was sent, sir: I have no record of doing that.');
});

test('review #356: draft request does not excuse a fabricated send outside drafted text', async () => {
  const { guardClaimedOwnerActions: guard } = await import('./truth_layer.js');
  const message = 'Draft an email to Mike about Friday';
  const claim = guard('I drafted the email and sent it.', { message });
  assert.match(claim.text, /Nothing was sent, sir/i);
  assert.doesNotMatch(claim.text, /and sent it/i);
  // Genuine written content remains, including a first-person verb in the owner's voice.
  assert.equal(guard('Here is your text: I bought the tickets, see you at 8.', {
    message: 'write a text to my wife saying I bought the tickets',
  }).removed.length, 0);
  // A false prefatory status report gets checked while the following draft stays intact.
  const preface = guard('I sent the email. Here is your text: I bought the tickets, see you at 8.', {
    message: 'write a text to my wife saying I bought the tickets',
  });
  assert.doesNotMatch(preface.text, /^I sent the email/i);
  assert.match(preface.text, /Here is your text: I bought the tickets/i);
});

test('a learned-from-research provenance claim with no receipt is corrected, not shown (2026-10-22 Cortana test)', () => {
  const claim = 'A good personal assistant answers fast and remembers context. I learned this from research and studies on Microsoft Cortana and Google Assistant.';
  const out = guardClaimedResearchActions(claim, { research: null, tools: [], message: 'what makes a good personal AI assistant' });
  assert.equal(out.corrected, true);
  assert.doesNotMatch(out.text, /Cortana/);
});

test('general knowledge without a provenance claim passes through untouched', () => {
  const answer = 'A good personal assistant is fast, remembers what you asked for, and says plainly when it does not know.';
  const out = guardClaimedResearchActions(answer, { research: null, tools: [], message: 'what makes a good personal AI assistant' });
  assert.equal(out.corrected, false);
  assert.equal(out.text, answer);
});

test('a provenance claim is kept when a research receipt from this turn backs it', () => {
  const claim = 'I learned this from research and studies on voice assistants.';
  const research = { summary: 'Sources read', cached: false, sources: ['https://example.org/voice-assistants'] };
  const out = guardClaimedResearchActions(claim, { research, tools: [], message: 'what makes a good personal AI assistant' });
  assert.equal(out.corrected, false);
});

test('a provenance claim is not backed by an unrelated successful tool such as a calculator', () => {
  const claim = 'I learned this from research and studies on voice assistants.';
  const tools = [{ ok: true, plugin: 'calculator', tool: 'calculate' }];
  const out = guardClaimedResearchActions(claim, { research: null, tools, message: 'what makes a good personal AI assistant' });
  assert.equal(out.corrected, true);
});
