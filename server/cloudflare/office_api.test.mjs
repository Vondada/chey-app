import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { routingForAgent } from './agent_runtime.js';
import { resetRouterForTests, routeText } from './ai_router.js';
import { ensureLaAgenciaRoster, splitGoal } from './office_company.js';
import { matchOfficePhrase, speakOfficeBoard } from './office_phrases.js';
import { assertOwnerTalksToCheOnly } from './office_router.js';
import { verifyStripeSignature } from './stripe_webhooks.js';

// Same loader as worker.test.mjs, under its own file name so the two test
// files can run in parallel.
const generated = new URL('./.office_api.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let worker;
let CheState;
try {
  ({ default: worker, CheState } = await import(`${generated.href}?test=${Date.now()}`));
} finally {
  try { unlinkSync(generated); } catch (_) {}
}

const WEBHOOK_SECRET = 'whsec_test_only';

async function office(envExtra = {}) {
  const saved = new Map();
  const env = {
    CHE_PAIR_CODE: '123456',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    AI: { run: async () => ({ response: 'Done.' }) },
    ...envExtra,
  };
  const state = new CheState({ storage: {
    get: async (key) => (saved.has(key) ? JSON.parse(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, JSON.stringify(value)),
    delete: async (key) => saved.delete(key),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  } }, env);
  env.CHE_STATE = { getByName: () => state };
  const raw = (path, init) => worker.fetch(new Request(`https://che.example${path}`, init), env);
  const token = (await (await raw('/api/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '123456' }),
  })).json()).device_token;
  const send = (path, method = 'GET', body) => raw(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  // What CHE says back in chat (ndjson deltas joined).
  const say = async (message) => {
    const text = await (await send('/api/chat', 'POST', { message })).text();
    return text.trim().split('\n').map((line) => JSON.parse(line)).filter((e) => e.type === 'delta').map((e) => e.delta).join('');
  };
  const board = async () => { const j = await (await send('/api/office/today')).json(); if (!j.board) throw new Error(JSON.stringify(j)); return j.board; };
  return { env, state, saved, raw, send, say, board };
}

function signed(payload, secret = WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(payload);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return { body, header: `t=${t},v1=${v1}` };
}

test('Office voice phrases are recognized including Iris and Fiverr scout', () => {
  assert.deepEqual(matchOfficePhrase("What's happening in the Office?"), { type: 'happening' });
  assert.deepEqual(matchOfficePhrase('What did they build today?'), { type: 'builtToday' });
  assert.deepEqual(matchOfficePhrase('How much did we make today?'), { type: 'earnedToday' });
  assert.deepEqual(matchOfficePhrase('Read this Office to me'), { type: 'readOffice' });
  assert.deepEqual(matchOfficePhrase('What is Knox doing?'), { type: 'agentStatus', agentId: 'knox' });
  assert.deepEqual(matchOfficePhrase('What is Iris doing?'), { type: 'agentStatus', agentId: 'iris' });
  assert.deepEqual(matchOfficePhrase('Stand down'), { type: 'standDown' });
  assert.deepEqual(matchOfficePhrase('Chay, what’s happening in the office'), { type: 'happening' });
  assert.equal(matchOfficePhrase('hire Iris').type, 'hireIris');
  assert.equal(matchOfficePhrase('scout Fiverr for AI ad buyers').type, 'fiverrScout');
  assert.equal(matchOfficePhrase('draft tonight pack for Cafe Luna').type, 'goal');
  assert.equal(matchOfficePhrase('What is Bob doing?'), null, 'only the real roster has desks');
  assert.equal(matchOfficePhrase('Tell me a joke'), null);
  assert.equal(matchOfficePhrase('Tell the Office to research competitors in Houston').type, 'goal');
});

test('CHE speaks Office answers from the live board through /api/chat', async () => {
  const o = await office();
  // Opening the Office staffs the roster; Stripe is not connected.
  const empty = await o.board();
  assert.deepEqual(empty.agents.map((a) => a.name), ['Nova', 'Atlas', 'Mira', 'Knox', 'Sage', 'Lyra', 'Orion', 'Iris', 'Vale']);
  assert.equal(empty.stripe.connected, false);

  const happening = await o.say("What's happening in the Office?");
  assert.match(happening, /^CHE here\. 0 agents working\. Started today 0\. Finished today 0\. No blockers\./);

  const built = await o.say('What did they build today?');
  assert.equal(built, 'CHE here. Nothing finished yet today. Started today 0.');

  const money = await o.say('How much did we make today?');
  assert.equal(money, 'CHE here. Stripe not connected. Earned today $0.00.');

  // No provider credentials: Atlas's Codex tool (engineering) is honestly blocked.
  const atlasNow = await o.say('What is Atlas doing?');
  assert.equal(atlasNow, 'CHE here. Atlas — Blocked: tool not configured (Codex).');

  const full = await o.say('Read this Office to me');
  assert.match(full, /^CHE here\. Office board\./);
  assert.match(full, /Stripe not connected\. Earned today \$0\.00\./);
  for (const name of ['Nova', 'Atlas', 'Mira', 'Knox', 'Sage', 'Lyra', 'Orion', 'Iris', 'Vale']) assert.match(full, new RegExp(`\\d\\. ${name}: `));
  // Atlas (engineering) needs Codex; Sage's Stripe reports need Stripe, but Sage's analysis does not. The rest are auto → Idle is OK.
  assert.match(full, /Atlas: Blocked: tool not configured \(Codex\)/);
  assert.match(full, /Knox: Idle/);
  assert.match(full, /Sage: Idle/);
  assert.match(full, /Iris: Idle/);

  const standDown = await o.say('Stand down');
  assert.match(standDown, /^CHE here\. Office standing down\./);
  assert.equal(JSON.parse(o.saved.get('che')).autonomy, false, 'stand down really pauses queued work');
});

test('CHE splits an owner goal into persisted jobs; missing tools are blockers', async () => {
  assert.deepEqual(splitGoal('Research competitors in Houston and build a landing page, then post it on Instagram'), [
    { agent: 'Mira', task: 'Research competitors in Houston' },
    { agent: 'Atlas', task: 'Build a landing page' },
    { agent: 'Lyra', task: 'Post it on Instagram' },
  ]);

  assert.deepEqual(splitGoal('Draft a tonight pack of ad creatives for the cafe'), [
    { agent: 'Lyra', task: 'Draft a tonight pack of ad creatives for the cafe' },
  ]);

  const o = await office({ CHE_ALLOW_PAID_AI: '1', XAI_API_KEY: 'xai-test' });
  const reply = await o.say('Tell the Office to research competitors in Houston and build a landing page');
  assert.match(reply, /^CHE here\. I split that into 2 jobs\. 1\. Mira: Research competitors in Houston\. 2\. Atlas: Build a landing page — Blocked: tool not configured \(Codex\)\./);

  const stored = JSON.parse(o.saved.get('che'));
  const jobs = stored.team_tasks.filter((t) => t.source === 'owner_goal');
  assert.equal(jobs.length, 2);
  assert.equal(new Set(jobs.map((t) => t.job_id)).size, 1, 'jobs share the goal id');
  assert.equal(stored.office_goals.length, 1);
  assert.equal(jobs.find((t) => t.partner_name === 'Mira').status, 'queued');
  assert.equal(jobs.find((t) => t.partner_name === 'Atlas').status, 'blocked');

  const b = await o.board();
  assert.equal(b.started_today, 2);
  assert.equal(b.agents_working, 1);
  assert.equal(b.blockers[0].detail, 'Blocked: tool not configured (Codex)');
  assert.equal(b.agents.find((a) => a.name === 'Mira').status, 'Up next: Research competitors in Houston');
  assert.match(await o.say('What is Atlas doing?'), /Atlas — Blocked: tool not configured \(Codex\)/);
  assert.match(await o.say('What is Mira doing?'), /Mira — Up next: Research competitors in Houston/);

  // The runtime also refuses to run a La Agencia job whose tool is missing.
  const fresh = JSON.parse(o.saved.get('che'));
  const knox = fresh.team.find((a) => a.name === 'Atlas');
  fresh.team_tasks.push({ id: 'k2', partner_id: knox.id, partner_name: 'Atlas', task: 'Fix the checkout bug', status: 'queued', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  fresh.team_tasks = fresh.team_tasks.filter((t) => t.id === 'k2');
  o.saved.set('che', JSON.stringify(fresh));
  await o.state.alarm();
  const after = JSON.parse(o.saved.get('che')).team_tasks.find((t) => t.id === 'k2');
  assert.equal(after.status, 'blocked');
  assert.equal(after.error, 'Blocked: tool not configured (Codex)');
});

test('Stripe webhook: verified signature updates today immediately; bad or replayed events do not', async () => {
  const o = await office({ STRIPE_SECRET_KEY: 'sk_test_x' });
  const hook = (payload, header) => o.raw('/api/stripe/webhook', {
    method: 'POST', headers: { 'Stripe-Signature': header, 'Content-Type': 'application/json' }, body: payload,
  });

  const charge = signed({ id: 'evt_1', type: 'charge.succeeded', data: { object: { id: 'ch_1', amount: 5000, currency: 'usd' } } });
  assert.equal((await hook(charge.body, charge.header)).status, 200);
  // payment_intent.succeeded for the same payment is not counted twice.
  const twin = signed({ id: 'evt_2', type: 'payment_intent.succeeded', data: { object: { amount: 5000, currency: 'usd' } } });
  assert.equal((await hook(twin.body, twin.header)).status, 200);
  const refund = signed({ id: 'evt_3', type: 'charge.refunded', data: { object: { id: 'ch_1', amount: 5000, amount_refunded: 1250, currency: 'usd' } } });
  assert.equal((await hook(refund.body, refund.header)).status, 200);
  // Replay of the same event id is ignored.
  assert.deepEqual(await (await hook(refund.body, refund.header)).json(), { received: true, duplicate: true });

  const forged = signed({ id: 'evt_4', type: 'charge.succeeded', data: { object: { id: 'ch_2', amount: 999999, currency: 'usd' } } }, 'whsec_wrong');
  assert.equal((await hook(forged.body, forged.header)).status, 400);
  const stale = signed({ id: 'evt_5', type: 'charge.succeeded', data: { object: { id: 'ch_3', amount: 100, currency: 'usd' } } }, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600);
  assert.equal((await hook(stale.body, stale.header)).status, 400);

  const b = await o.board();
  assert.deepEqual(
    { c: b.stripe.charges_cents, r: b.stripe.refunds_cents, n: b.stripe.net_cents, src: b.stripe.source, e: b.earned_today_cents },
    { c: 5000, r: 1250, n: 3750, src: 'webhook', e: 3750 },
  );
  assert.equal(await o.say('How much did we make today?'), 'CHE here. Stripe today: charges $50.00, refunds $12.50, net $37.50.');

  const noSecret = await office({ STRIPE_WEBHOOK_SECRET: '' });
  const r = await noSecret.raw('/api/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': charge.header }, body: charge.body });
  assert.equal(r.status, 503);
  await assert.rejects(verifyStripeSignature('{}', 't=1,v1=abc', ''), /secret_missing/);
});

test('owner talks only to CHE; agents report only to CHE', async () => {
  assert.throws(() => assertOwnerTalksToCheOnly({ from: 'owner', to: 'knox' }), /owner_talks_to_che_only/);
  assert.throws(() => assertOwnerTalksToCheOnly({ from: 'knox', to: 'owner' }), /agents_report_to_che_only/);
  assert.deepEqual(assertOwnerTalksToCheOnly({ from: 'knox', to: 'che' }), { speaker: 'knox', target: 'che' });

  const o = await office();
  const post = (body) => o.send('/api/office/messages', 'POST', body);
  const toAgent = await post({ from: 'owner', to: 'nova', text: 'Hi Nova' });
  assert.equal(toAgent.status, 403);
  assert.equal((await toAgent.json()).detail, 'owner_talks_to_che_only');
  const toOwner = await post({ from: 'mira', to: 'owner', text: 'Hi boss' });
  assert.equal(toOwner.status, 403);
  assert.equal((await toOwner.json()).detail, 'agents_report_to_che_only');
  assert.equal((await post({ from: 'owner', to: 'che', text: 'Status please' })).status, 200);
  assert.equal((await post({ from: 'atlas', to: 'che', text: 'Research done' })).status, 200);
  const inbox = JSON.parse(o.saved.get('che')).office_inbox;
  assert.deepEqual(inbox.map((m) => `${m.from}->${m.to}`), ['owner->che', 'atlas->che']);
});

test('a long Office message keeps its start, its late "don\'t" and a visible marker; one too long is refused whole (issue #345)', async () => {
  const o = await office();
  const late = "but don't email Mark until Friday";
  const long = 'CHE, send the weekly report to the whole team with the charts from the dashboard, '
    + 'and add the summary of what changed in the review, '.repeat(100) + late;
  assert.ok(long.length > 5000 && long.length < 16000);
  const res = await o.send('/api/office/messages', 'POST', { from: 'owner', to: 'che', text: long });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.shortened.characters, long.length);
  const kept = JSON.parse(o.saved.get('che')).office_inbox.at(-1).text;
  assert.equal(body.shortened.kept, kept.length);
  assert.ok(kept.length <= 4100, `bounded for CHE's state record, got ${kept.length}`);
  assert.match(kept, /^CHE, send the weekly report/);
  assert.match(kept, / … \[\d+ characters not shown\] … /);
  assert.ok(kept.endsWith(late), 'the late limit is stored');
  // Short messages are stored exactly as sent.
  await o.send('/api/office/messages', 'POST', { from: 'owner', to: 'che', text: 'Status please.\nThen rest.' });
  assert.equal(JSON.parse(o.saved.get('che')).office_inbox.at(-1).text, 'Status please.\nThen rest.');
  const tooLong = await o.send('/api/office/messages', 'POST', { from: 'owner', to: 'che', text: 'x '.repeat(9000) + late });
  assert.equal(tooLong.status, 413);
  assert.match((await tooLong.json()).detail, /did nothing with it/);
  assert.equal(JSON.parse(o.saved.get('che')).office_inbox.length, 2, 'nothing is stored from a refused message');
});

test('Office Mira prefers auto; pinned xai still tags Grok with office/<agent>/<job> thread', async () => {
  const data = { team: [] };
  ensureLaAgenciaRoster(data);
  const atlas = data.team.find((a) => a.name === 'Mira');
  assert.equal(atlas.provider_preference, 'auto');
  const autoRouting = routingForAgent(atlas, data, { id: 'job-42', task: 'Research competitors' });
  assert.equal(autoRouting.che_agent_id, 'mira');
  assert.equal(autoRouting.che_thread_id, 'office/mira/job-42');
  assert.equal(autoRouting.che_provider, undefined);

  // Explicit xai pin (owner-set) still routes through CHE with Grok thread headers.
  atlas.provider_preference = 'xai';
  const routing = routingForAgent(atlas, data, { id: 'job-42', task: 'Research competitors' });
  assert.equal(routing.che_provider, 'xai');

  resetRouterForTests();
  const calls = [];
  const saved = new Map();
  const storage = { get: async (k) => saved.get(k), put: async (k, v) => saved.set(k, v) };
  const result = await routeText({ CHE_ALLOW_PAID_AI: '1', XAI_API_KEY: 'xai-test' }, '@cf/meta/llama-3.1-8b-instruct-fp8', {
    messages: [{ role: 'user', content: 'Research competitors' }], max_tokens: 200, ...routing, che_provider_strict: true,
  }, async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Found three.' } }] }), { status: 200 });
  }, storage);
  assert.equal(result.engine, 'xai');
  assert.equal(calls[0].url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(calls[0].headers['x-grok-conv-id'], 'office/mira/job-42');
  assert.equal(calls[0].body.user, 'office/mira/job-42');
  const audit = saved.get('ai_audit')[0];
  assert.equal(audit.agent_id, 'mira');
  assert.equal(audit.thread_id, 'office/mira/job-42');
  assert.ok(!JSON.stringify(audit).includes('xai-test'), 'the credential never enters the audit');
});

test('spoken board never invents money', () => {
  assert.equal(speakOfficeBoard({ stripe: { connected: false, net_cents: 5000 } }, { type: 'earnedToday' }),
    'CHE here. Stripe not connected. Earned today $0.00.');
});

test('hire Iris via chat staffs Ad Studio; Fiverr scout queues shortlist-only jobs', async () => {
  const o = await office({ CHE_ALLOW_PAID_AI: '1', XAI_API_KEY: 'xai-test' });
  const hired = await o.say('hire Iris');
  assert.match(hired, /Iris is on the roster — Experience \/ accessibility/i);
  const board = await o.board();
  assert.ok(board.agents.some((a) => a.name === 'Iris' && a.core === true));

  const pack = await o.say('draft tonight pack for Cafe Luna');
  assert.match(pack, /Lyra:/, 'ad creatives are Lyra\'s since the reorganisation');
  assert.match(pack, /tonight pack/i);

  const scout = await o.say('scout Fiverr for AI ad buyers');
  assert.match(scout, /Fiverr scout queued/i);
  assert.match(scout, /will not message, bid, or buy/i);
  const stored = JSON.parse(o.saved.get('che'));
  const scoutJobs = stored.team_tasks.filter((t) => t.source === 'fiverr_scout' || t.kind === 'fiverr_scout');
  assert.ok(scoutJobs.length >= 1, JSON.stringify(scoutJobs));
  for (const job of scoutJobs) {
    assert.equal(job.owner_confirm_required, true);
    assert.equal(job.outbound_allowed, false);
  }
  assert.ok(Array.isArray(stored.fiverr_scouts) && stored.fiverr_scouts.length >= 1);
  assert.equal(stored.fiverr_scouts[0].outbound_allowed, false);
  assert.equal(stored.fiverr_scouts[0].owner_confirm_required, true);
});

test('opportunity scout queues shortlist-only jobs (Pinterest); memory write-back distills notes', async () => {
  const o = await office({ CHE_ALLOW_PAID_AI: '1', XAI_API_KEY: 'xai-test' });
  await o.say('hire Iris');
  const scout = await o.say('scout Pinterest for printable planners');
  assert.match(scout, /Opportunity scout queued on pinterest/i);
  assert.match(scout, /will not auto-message/i);
  const stored = JSON.parse(o.saved.get('che'));
  const jobs = stored.team_tasks.filter((t) => t.kind === 'opportunity_scout' || t.source === 'opportunity_scout');
  assert.ok(jobs.length >= 1, JSON.stringify(jobs));
  for (const job of jobs) {
    assert.equal(job.owner_confirm_required, true);
    assert.equal(job.outbound_allowed, false);
  }
  assert.ok(Array.isArray(stored.opportunity_scouts) && stored.opportunity_scouts.length >= 1);
  assert.equal(stored.opportunity_scouts[0].channel, 'pinterest');
  assert.equal(stored.opportunity_scouts[0].spend_without_confirm, false);

  // Simulate completed Atlas scout → learning loop memory note
  const { writeResearchMemoryNote } = await import('./research_memory.js');
  const atlas = stored.team.find((a) => a.name === 'Atlas') || { name: 'Atlas', role: 'Research', memory_refs: [] };
  const written = writeResearchMemoryNote(stored, {
    result: [
      'Channel: pinterest',
      'Offer: printable planner pack',
      'Why: board demand for wedding planners',
      'URL: https://www.pinterest.com/search/pins/?q=planner',
    ].join('\n'),
    task: jobs[0],
    agent: atlas,
  });
  assert.equal(written.written, true);
  assert.ok(stored.memory_notes?.length >= 1);
  assert.equal(stored.memories?.some((m) => /Opportunity|pinterest|planner/i.test(m)), false, 'agent ideas must not become verified owner facts');
  assert.equal(stored.memory_notes[0].verification_status, 'unverified_research_lead');
});

// Owner master mission, Test E: a feature needing design, engineering, security and testing goes through Iris,
// Atlas, Knox and Vale with real recorded handoffs, coordinated by Nova, on the real Office runtime and CHE review.
test('Test E: a coordinated Office job runs Iris → Atlas → Knox → Vale through the job API and the runtime', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  t.after(() => { globalThis.fetch = realFetch; });
  const ai = {
    run: async (_model, input) => {
      const text = JSON.stringify(input?.messages || input?.prompt || '');
      // CHE's review of a delegated result comes first (its system prompt asks for a verdict on the work).
      if (/APPROVED|NEEDS[ _]WORK/.test(JSON.stringify(input?.messages?.[0] || ''))) return { response: 'APPROVED\nThe stage result answers its brief.' };
      if (/Independently verify the finished stages/.test(text)) return { response: 'VERDICT: PASS\n1. met: the recorded stages cover it.' };
      return { response: 'Stage result: plan written with files, tests and risks.' };
    },
  };
  const o = await office({ CODEX_OWNER_TOKEN: 'tok-test-only', AI: ai });
  const made = await (await o.send('/api/office/jobs', 'POST', { request: 'Improve the Trading Room chart with a cleaner layout, the engineering change, a security review and testing' })).json();
  assert.match(made.job.id, /^oj-[0-9a-f]{8}$/);
  assert.deepEqual(made.job.stages.map((s) => s.agent), ['Iris', 'Atlas', 'Knox', 'Vale']);
  assert.equal(made.job.accountable, 'Atlas');
  assert.equal(made.job.stages[0].status, 'running', 'Iris accepted the first handoff and has a task');
  for (let i = 0; i < 24; i++) {
    await o.state.alarm();
    const now = (await (await o.send(`/api/office/jobs/${made.job.id}`)).json()).job;
    if (now.status !== 'running') break;
  }
  const job = (await (await o.send(`/api/office/jobs/${made.job.id}`)).json()).job;
  assert.equal(job.status, 'verified', JSON.stringify(job.history.slice(-4)));
  assert.deepEqual(job.handoffs.map((h) => `${h.from_agent_name}->${h.to_agent_name}:${h.accepted}`), ['Nova->Iris:true', 'Iris->Atlas:true', 'Atlas->Knox:true', 'Knox->Vale:true']);
  const stored = JSON.parse(o.saved.get('che'));
  const stageTasks = stored.team_tasks.filter((x) => x.office_job_id === job.id);
  assert.deepEqual(stageTasks.map((x) => x.status), ['complete', 'complete', 'complete', 'complete']);
  assert.ok(stored.office_packets.some((p) => p.agent_id === 'atlas'), 'Atlas worked through the Codex desk');
  assert.equal(job.verification.by, 'Vale');
  // CHE reports it, by voice or typing.
  assert.match(await o.say('What is the status of the Office jobs?'), new RegExp(`^CHE here\\. Office job ${job.id}: verified\\.`));
});

test('the Office organisation: Owner → CHE → nine heads, each with tools, permissions, queue and recorded performance', async () => {
  const o = await office();
  const { org } = await (await o.send('/api/office/org')).json();
  assert.equal(org.che.name, 'CHE');
  assert.deepEqual(org.heads.map((h) => `${h.name}:${h.department}`), ['Nova:operations', 'Atlas:engineering', 'Mira:research', 'Knox:security', 'Sage:intelligence', 'Lyra:creative', 'Orion:markets', 'Iris:experience', 'Vale:qa']);
  for (const head of org.heads) {
    assert.equal(head.reports_to, 'CHE');
    assert.ok(head.title && head.responsibilities.length && head.tools.length, head.name);
    assert.ok(head.tools.every((tool) => ['configured', 'not configured', 'not checked'].includes(tool.status)), 'a tool is never called verified here');
    assert.equal(head.permissions.can_merge_code, false);
    assert.equal(head.permissions.can_spend_money, false);
    assert.equal(head.performance.completed, null, 'no records, no numbers');
  }
  const knox = org.heads.find((h) => h.name === 'Knox');
  assert.equal(knox.specialists.filter((s) => s.kind === 'Security Core specialist').length, 8);
  assert.equal(org.heads.find((h) => h.name === 'Atlas').tools.find((tool) => tool.id === 'codex_desk').status, 'not configured');
  const one = await (await o.send('/api/office/org/knox')).json();
  assert.equal(one.head.name, 'Knox');
  assert.equal((await o.send('/api/office/org/bob')).status, 404);
  const said = await o.say('Who runs the Office departments?');
  assert.match(said, /^CHE here\. You lead; I report to you\. 9 department heads report to me: Nova, Chief Operations Officer; Atlas, Chief Technology Officer;/);
  assert.match(said, /Knox, Office Security Chief/);
  assert.equal(new Set(org.heads.map((h) => h.name)).size, 9, 'no duplicate agents');
});

test('"Have Nova coordinate …" by voice plans a real job; an ordinary sentence about Nova is not one', async () => {
  const o = await office();
  const reply = await o.say('Have Nova coordinate a cleaner Security Room layout with a security review and testing');
  assert.match(reply, /^CHE here\. Office job oj-[0-9a-f]{8}: running\. Nova coordinates;/);
  const stored = JSON.parse(o.saved.get('che'));
  const job = stored.office_goals.find((g) => g.coordinated);
  assert.deepEqual(job.stages.map((s) => s.agent), ['Iris', 'Knox', 'Vale']);
  assert.equal(matchOfficePhrase('Nova coordinated the launch last week, right?'), null);
  assert.equal(matchOfficePhrase('Who runs the country?'), null);
});
