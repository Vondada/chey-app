// CHE Command Center (owner mission 2026-10-14): one catalog of 71 commands
// over CHE's existing runtime. Everything here runs through the real Worker
// (/api/chat, /api/commands, the job queue and objective graph) offline.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import {
  CATEGORIES, COMMANDS, SUGGESTION_RULES, catalogView, commandById, commandStatus, connectorStatus,
  commandFromWords, describeWorkflow, dispatchPrompt, findSavedWorkflow, parseSlashCommand, readCommandSpeech, searchCommands, suggestCommands, workflowNodes,
} from './command_catalog.js';
import { advanceObjectives, approveNode, createObjective, retryNode } from './objective_graph.js';
import { classifyOwnerActions } from './owner_action_gate.js';
import { deskIntent } from './trading_desk.js';

// Offline, like CI's networked runner and this sandbox alike.
globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

const generated = new URL('./.command_center.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

// The owner's list, exactly as given.
const MISSION_IDS = {
  intelligence: ['che', 'che-explore', 'che-plan', 'che-build', 'che-research', 'che-verify', 'che-memory', 'che-brain-review', 'che-recover', 'che-status'],
  youtube: ['yt-ideas', 'yt-research', 'yt-script', 'yt-video', 'yt-voice', 'yt-thumbnail', 'yt-seo', 'yt-publish', 'yt-batch', 'yt-analytics', 'yt-grow'],
  // trade-connections reads the owner-only connections of #348 (issue #350).
  trading: ['trade-open', 'trade-chart', 'trade-setup', 'trade-liquidity', 'trade-risk', 'trade-backtest', 'trade-journal', 'trade-alert', 'trade-execute', 'trade-connections'],
  build: ['site-build', 'site-redesign', 'site-audit', 'site-publish', 'app-build', 'app-fix', 'ai-build', 'code-review', 'che-release', 'iphone-update', 'rea-inspect', 'rea-discover', 'rea-features', 'rea-explain', 'rea-debug', 'rea-compare', 'rea-rebuild', 'rea-build', 'rea-verify', 'rea-status'],
  money: ['money-dashboard', 'cashflow', 'budget', 'expenses', 'invoices', 'money-forecast', 'pricing', 'profit-report'],
  clients: ['lead-scout', 'lead-audit', 'lead-score', 'lead-match', 'lead-proposal', 'lead-outreach', 'lead-crm', 'lead-followup', 'client-deliver'],
  marketing: ['brand-build', 'marketing-plan', 'social-content', 'ads-plan', 'seo-growth', 'sales-funnel', 'business-launch'],
  office: ['office-status', 'office-delegate', 'warroom', 'automate', 'skill-learn', 'connect', 'voice-test', 'create-3d'],
  // Creator Studio (owner issue #347).
  studio: ['studio-bible', 'studio-pilot', 'studio-render', 'studio-export', 'studio-post', 'studio-growth'],
};

const SITE_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Joe\'s Barbershop</title></head><body><header><h1>Joe\'s Barbershop</h1></header><main><p>Classic cuts in Phoenix.</p><a href="#book">Book a cut</a></main><footer>Open daily</footer></body></html>';

// HTML only when CHE's site builder asks for a page; plain text otherwise.
const siteModel = (input) => (/website|web app|change the website|<html|html document/i.test(JSON.stringify(input.messages?.slice(-1) || '')) && /build|change|edit/i.test(JSON.stringify(input.messages?.slice(-1) || ''))
  ? SITE_HTML : 'Here is the answer, sir.');

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

const READY_ENV = {
  CHE_GITHUB_TOKEN: 'ghp_test_only', CHE_GITHUB_REPO: 'Vondada/chey-app', ELEVENLABS_API_KEY: 'el_test_only',
  STRIPE_SECRET_KEY: 'sk_test_only', TWILIO_ACCOUNT_SID: 'AC_test', TWILIO_AUTH_TOKEN: 'tw_test',
};

// A paired owner phone. `model` answers every model call; `inputs` keeps
// what each call was sent, so tests can see exactly what reached a model.
async function owner({ saved = new Map(), model = () => 'Here is the answer, sir.', env: extra = {} } = {}) {
  const inputs = [];
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', ...extra,
    AI: { run: async (_model, input) => { inputs.push(input); return { response: model(input) }; } },
  };
  let state;
  const connect = () => {
    state = new CheState({ storage: storageFor(saved), waitUntil: (p) => pending.push(p) }, env);
    env.CHE_STATE = { getByName: () => state };
    return state;
  };
  connect();
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const settle = async () => { while (pending.length) await pending.shift(); };
  const say = async (message, extra2 = {}) => {
    const before = inputs.length;
    const res = await send('/api/chat', { message, history: [], ...extra2 }, token);
    const raw = await res.text();
    await settle();
    let held = null;
    try { held = JSON.parse(raw); } catch (_) { held = null; }
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    const route = held?.held_for_owner ? 'held' : done.source || (done.office ? `office:${done.office}` : inputs.length > before ? 'model' : 'none');
    return { raw, events, done, held, route, reply: held?.message || replyFromNdjson(raw), modelCalls: inputs.length - before, status: res.status };
  };
  const get = async (path) => (await send(path, null, token, 'GET')).json();
  const post = async (path, body) => { const res = await send(path, body, token); return { status: res.status, body: await res.json() }; };
  return { say, get, post, send, token, saved, inputs, env, state: () => state, restart: connect, settle };
}

// ─── 1. Catalog identities ────────────────────────────────────────────────

test('1. the owner\'s 71 commands exist exactly as listed, plus ten REA and six Creator Studio commands, in 9 categories, each fully described', () => {
  assert.equal(COMMANDS.length, 89);
  assert.equal(new Set(COMMANDS.map((c) => c.id)).size, 89, 'ids are unique');
  assert.deepEqual(CATEGORIES.map((c) => c.id), Object.keys(MISSION_IDS));
  for (const [category, ids] of Object.entries(MISSION_IDS)) {
    assert.deepEqual(COMMANDS.filter((c) => c.category === category).map((c) => c.id), ids, category);
  }
  for (const c of COMMANDS) {
    assert.ok(c.summary.length >= 10 && c.summary.length <= 80, `${c.id} summary`);
    assert.ok(c.does.length >= 20, `${c.id} says what it can actually do`);
    assert.ok(['EXPLORE', 'PLAN', 'BUILD'].includes(c.mode), `${c.id} mode`);
    assert.ok(c.examples.length >= 1, `${c.id} has a voice example`);
    assert.ok(c.prompt && c.route && c.handler && c.evidence, `${c.id} dispatch metadata`);
    assert.ok(c.input === null || (c.input.hint && c.prompt.includes('{input}')), `${c.id} input matches its prompt`);
    // A PLAN or EXPLORE command never needs an approval. Of the BUILD ones,
    // only real money and the owner's YouTube channel ask first (owner rule,
    // September 28); the money, delete and app gates still apply to all.
    if (c.mode !== 'BUILD') assert.equal(c.confirm, '', `${c.id} is read-only`);
  }
  for (const id of ['yt-publish', 'trade-execute', 'studio-post']) {
    assert.ok(commandById(id).confirm, `${id} needs owner approval`);
  }
});

test('command requests never trip the money/delete gate by their own wording', () => {
  for (const c of COMMANDS) {
    const prompt = dispatchPrompt(c, c.input ? 'my web design business' : '');
    assert.deepEqual(classifyOwnerActions(prompt), [], `${c.id}: "${prompt}"`);
  }
});

// ─── 2. Availability and capability mapping ───────────────────────────────

test('2. availability comes from real configuration: ready, needs setup, unsupported or temporarily down', () => {
  const bare = connectorStatus({ AI: {} });
  assert.equal(bare.model.state, 'ready');
  for (const id of ['broker', 'youtube', 'stripe', 'sms', 'github', 'voice']) assert.equal(bare[id].state, 'not_connected', id);
  assert.equal(bare.bookkeeping.state, 'none');
  assert.equal(commandStatus(commandById('trade-execute'), bare).status, 'setup_required');
  assert.match(commandStatus(commandById('trade-execute'), bare).missing[0].setup, /CHE_TRADOVATE_OAUTH_CLIENT_ID/);
  assert.equal(commandStatus(commandById('trade-chart'), bare).status, 'available');
  assert.equal(commandStatus(commandById('voice-test'), bare).status, 'setup_required');
  // A connector CHE does not have is "unsupported", never "available".
  const books = { ...commandById('cashflow'), needs: ['bookkeeping'] };
  assert.equal(commandStatus(books, bare).status, 'unsupported');
  const down = connectorStatus({}, { runtime: { chat: false } });
  assert.equal(commandStatus(commandById('che-plan'), down).status, 'temporarily_unavailable');
  const ready = connectorStatus({ AI: {}, ...READY_ENV, CHE_TRADOVATE_OAUTH_CLIENT_ID: 'x', CHE_TRADOVATE_OAUTH_CLIENT_SECRET: 'y' },
    { broker: { connected: true }, youtube: { connected: true } });
  assert.equal(commandStatus(commandById('trade-execute'), ready).status, 'available');
  const expired = connectorStatus({ CHE_TRADOVATE_OAUTH_CLIENT_ID: 'x', CHE_TRADOVATE_OAUTH_CLIENT_SECRET: 'y' }, { broker: { expired: true } });
  assert.equal(expired.broker.state, 'needs_reconnect');
  const view = catalogView(bare);
  assert.equal(view.commands.length, 89);
  assert.ok(view.commands.every((c) => ['available', 'setup_required', 'unsupported', 'temporarily_unavailable'].includes(c.status)));
});

test('every available command reaches the existing handler it names (no fake routes)', async () => {
  const che = await owner({ model: siteModel, env: READY_ENV });
  // site-redesign edits the last site CHE built.
  await che.say('/site-build a barbershop in Phoenix');
  const view = await che.get('/api/commands');
  const unavailable = [];
  for (const c of COMMANDS) {
    const entry = view.commands.find((x) => x.id === c.id);
    const input = c.id === 'skill-learn' ? 'always check the NQ opening range before taking any entries in the morning' : 'Joe\'s Barbershop in Phoenix';
    const out = await che.say(`/${c.id}${c.input ? ` ${input}` : ''}`, { command_confirmed: true });
    if (entry.status !== 'available') {
      unavailable.push(c.id);
      assert.equal(out.route, 'che_command', `${c.id} not available → honest setup answer`);
      assert.equal(out.modelCalls, 0);
      assert.match(out.reply, /needs setup|not supported|temporarily unavailable/);
      continue;
    }
    assert.equal(out.route, c.route, `/${c.id} → ${out.route}: ${out.reply.slice(0, 120)}`);
  }
  // With these test secrets only the OAuth-backed ones need setup.
  assert.deepEqual(unavailable.sort(), ['trade-execute', 'yt-analytics', 'yt-publish']);
});

// ─── 3. Slash commands and natural-language equivalents ───────────────────

test('3. a slash command and its plain-English request reach the same handler', async () => {
  const che = await owner();
  const slash = await che.say('/trade-chart NQ');
  const plain = await che.say('Analyze the NQ chart');
  assert.equal(slash.route, 'che_trading');
  assert.equal(plain.route, 'che_trading');
  assert.equal(slash.modelCalls, 0);
  assert.equal((await che.say('/che-memory my business')).route, 'che_memory_provenance');
  assert.equal((await che.say('What have I told you about my business?')).route, 'che_memory_provenance');
  const review = await che.say('Read me my brain review');
  assert.equal(review.route, 'che_brain_review');
  assert.equal(review.modelCalls, 0);
  assert.match(review.reply, /no Brain review yet/i);
  assert.equal((await che.say('/che-brain-review')).route, 'che_brain_review');
  // A question about what the owner himself said is his memory question, even when it names the review.
  assert.equal((await che.say('What have I told you about my brain review?')).route, 'che_memory_provenance');
  assert.notEqual((await che.say('Did I ask you for a brain review yesterday?')).route, 'che_brain_review');
  assert.deepEqual(parseSlashCommand('/Trade-Chart  NQ please'), { name: 'trade-chart', command: commandById('trade-chart'), input: 'NQ please' });
  assert.equal(parseSlashCommand('Analyze the NQ chart'), null);
});

test('issue #350: /trade-connections and its plain question read the trading connections on the desk route; no command switches to live or orders', async () => {
  const c = commandById('trade-connections');
  assert.equal(c.route, 'che_trading_desk');
  assert.equal(c.mode, 'EXPLORE');
  assert.equal(c.confirm, '');
  assert.equal(commandStatus(c, connectorStatus({ AI: {} })).status, 'available', 'ready with nothing connected: it says what is not set up');
  const che = await owner();
  for (const said of ['/trade-connections', 'What are my trading connections?', 'what are my trading connections', 'Which brokers are connected?']) {
    const out = await che.say(said);
    assert.equal(out.route, 'che_trading_desk', said);
    assert.equal(out.modelCalls, 0, said);
    assert.match(out.reply, /^Your trading connections, sir: 1, CHE Paper: off\. 2, Tradovate \(NinjaTrader\): not set up\. 3, Alpaca \(stock paper\): not set up\. 4, FundYourEdge \(Rithmic\): not supported\. Trading mode: PAPER\. Live orders are off\.$/, said);
  }
  assert.notEqual((await che.say('My trading connection keeps dropping.')).route, 'che_trading_desk', 'a remark is not a request to read them');
  assert.equal((che.saved.get('trading_desk') || { mode: 'paper' }).mode, 'paper', 'reading changed no mode');
  // Only /trade-execute reaches an order, and it asks first; no catalog request switches to live.
  for (const cmd of COMMANDS.filter((x) => x.route === 'che_trading_desk')) {
    const kind = deskIntent(dispatchPrompt(cmd, 'NQ'))?.kind;
    assert.ok(!['mode', 'confirm_live', 'alpaca_setup', 'alpaca_remove'].includes(kind), `${cmd.id} → ${kind}`);
    if (kind === 'take') assert.equal(cmd.id, 'trade-execute');
  }
});

test('REA aliases are other names for one command, never a second command', async () => {
  assert.equal(commandById('rea-map').id, 'rea-features');
  assert.equal(commandById('rea-gap').id, 'rea-compare');
  assert.equal(commandById('rea-plan').id, 'rea-rebuild');
  assert.equal(commandById('rea-architecture').id, 'rea-explain');
  assert.equal(commandById('rea-capabilities').id, 'rea-status');
  const che = await owner({ env: READY_ENV });
  for (const slash of ['/rea-capabilities', '/rea-map', '/rea-gap', '/rea-verify']) {
    const out = await che.say(slash);
    assert.equal(out.route, 'che_rea', slash);
    assert.equal(out.modelCalls, 0, slash);
  }
  assert.match((await che.say('/rea-capabilities')).reply, /Native binaries \(Ghidra\): not available/);
  assert.match((await che.say('/rea-gap')).reply, /no REA investigation to use yet[\s\S]*Nothing was run/);
});

test('unknown commands, missing input and missing setup are answered honestly with nothing run', async () => {
  const che = await owner();
  const unknown = await che.say('/lead-scot barbers');
  assert.equal(unknown.route, 'che_command');
  assert.match(unknown.reply, /I don't have a \/lead-scot command[\s\S]*\/lead-scout[\s\S]*Nothing was run/);
  assert.equal(unknown.modelCalls, 0);
  const empty = await che.say('/che-plan');
  assert.match(empty.reply, /needs what you want to achieve[\s\S]*Nothing was run/);
  const setup = await che.say('/trade-execute');
  assert.match(setup.reply, /\/trade-execute needs setup[\s\S]*NinjaTrader[\s\S]*Nothing was run/);
  assert.equal(setup.done.command_status, 'setup_required');
  assert.equal(setup.modelCalls, 0);
});

test('a guest device cannot run commands or workflows', async () => {
  const che = await owner();
  const tenant = await che.post('/api/platform/tenants', { name: 'Guest', role: 'family' });
  const invite = await che.post('/api/platform/enrollments', { access: 'private', tenant_id: tenant.body.tenant.id });
  const guestToken = (await (await che.send('/api/enroll', { enrollment_token: invite.body.enrollment.token, device_name: 'guest' })).json()).device_token;
  const res = await che.send('/api/chat', { message: '/trade-chart NQ', history: [] }, guestToken);
  assert.match(replyFromNdjson(await res.text()), /Only the CHE owner can run commands/);
  const run = await che.send('/api/commands/workflow/run', { name: 'x', steps: [{ command: 'che-plan', input: 'y' }] }, guestToken);
  assert.equal(run.status, 403);
});

// ─── 4–5. Contextual suggestions ──────────────────────────────────────────

test('4. the owner\'s example requests get the right command combinations', () => {
  const ids = (message) => suggestCommands(message).map((card) => card.commands.map((c) => c.id));
  assert.deepEqual(ids('How can I make some money building websites?')[0], ['lead-scout', 'lead-audit', 'pricing', 'lead-proposal']);
  assert.deepEqual(ids('I want to make faceless YouTube videos.')[0], ['yt-ideas', 'yt-script', 'yt-video', 'yt-thumbnail']);
  assert.deepEqual(ids('Build me a booking app.')[0], ['che-plan', 'app-build', 'code-review']);
  assert.deepEqual(ids("What's NQ doing at the open?")[0], ['trade-open', 'trade-chart', 'trade-risk']);
});

test('5. suggestions stay relevant, few, real and dismissible', () => {
  for (const casual of ['thanks', 'hi there', 'ok', 'What time is it?', 'Tell me a joke about cats', '/trade-chart NQ', 'yes']) {
    assert.deepEqual(suggestCommands(casual), [], casual);
  }
  const known = new Set(COMMANDS.map((c) => c.id));
  for (const rule of SUGGESTION_RULES) for (const id of rule.commands) assert.ok(known.has(id), `${rule.id} → ${id}`);
  const many = suggestCommands('I want to start a business building websites and making faceless YouTube videos to make money');
  assert.ok(many.length <= 2);
  const dismissed = suggestCommands('How can I make some money building websites?', { exclude: ['website-clients'] });
  assert.ok(dismissed.every((card) => card.id !== 'website-clients'));
  // Cards that can run now come before cards that need setup.
  const bare = connectorStatus({ AI: {} });
  const cards = suggestCommands("What's NQ doing at the open?", { connectors: bare });
  assert.ok(cards[0].runnable > 0);
  const started = performance.now();
  for (let i = 0; i < 1000; i += 1) suggestCommands('How can I make some money building websites?');
  assert.ok((performance.now() - started) / 1000 < 1, 'deterministic matching costs well under 1 ms per message');
});

test('chat replies carry at most one suggestion event, after the answer, and only when relevant', async () => {
  const che = await owner();
  const asked = await che.say('How can I make some money building websites?');
  const events = asked.events.map((e) => e.type);
  assert.ok(events.indexOf('command_suggestions') > events.indexOf('done'), 'suggestions come after the answer');
  const card = asked.events.find((e) => e.type === 'command_suggestions').suggestions[0];
  assert.equal(card.id, 'website-clients');
  assert.ok(card.commands.every((c) => ['available', 'setup_required', 'unsupported', 'temporarily_unavailable'].includes(c.status)));
  assert.equal((await che.say('Thanks, that helps.')).events.filter((e) => e.type === 'command_suggestions').length, 0);
  const dismissed = await che.say('How can I make some money building websites?', { dismissed_suggestions: ['website-clients'] });
  assert.equal(dismissed.events.filter((e) => e.type === 'command_suggestions').length, 0);
  // A suggestion runs nothing: no job, no objective.
  const data = che.saved.get('che');
  assert.equal((data.objectives || []).length, 0);
});

// ─── 6. Search, categories, favorites data and saved workflows ────────────

test('6. search finds commands by name and by goal', () => {
  assert.equal(searchCommands('trade-chart')[0].id, 'trade-chart');
  assert.equal(searchCommands('/yt-seo')[0].id, 'yt-seo');
  assert.ok(searchCommands('find clients for my web design').slice(0, 3).some((r) => r.id === 'lead-scout'));
  assert.ok(searchCommands('how much should I charge').slice(0, 3).some((r) => r.id === 'pricing'));
  assert.ok(searchCommands('youtube thumbnail').slice(0, 2).some((r) => r.id === 'yt-thumbnail'));
  assert.deepEqual(searchCommands(''), []);
});

test('saved workflows persist on CHE across restarts and can be started by voice', async () => {
  const che = await owner();
  const saved = await che.post('/api/commands/workflows/save', { name: 'Website clients', steps: [{ command: 'lead-scout', input: 'barbershops in Phoenix' }, { command: 'pricing', input: '5 page site' }, { command: 'nope' }] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.workflow.steps.map((s) => s.command), ['lead-scout', 'pricing'], 'unknown commands are dropped');
  che.restart();
  const after = await che.get('/api/commands');
  assert.equal(after.workflows[0].name, 'Website clients');
  assert.equal(findSavedWorkflow(after.workflows, 'Run my website clients workflow').id, saved.body.workflow.id);
  const voice = await che.say('Run my website clients workflow');
  assert.equal(voice.route, 'che_command_workflow');
  assert.match(voice.reply, /Started "Website clients", sir: 2 steps/);
  const removed = await che.post('/api/commands/workflows/delete', { id: saved.body.workflow.id });
  assert.equal(removed.status, 200);
  assert.equal((await che.get('/api/commands')).workflows.length, 0);
});

// ─── 7. Composition and input/output passing ──────────────────────────────

test('7. a workflow is an ordered graph with purposes, dependencies, connectors and approvals', () => {
  const bare = connectorStatus({ AI: {} });
  const d = describeWorkflow({ name: 'Clients', steps: [
    { command: 'lead-scout', input: 'barbers' }, { command: 'lead-audit' }, { command: 'pricing', parallel: true }, { command: 'lead-proposal' }, { command: 'yt-publish' },
  ] }, bare);
  assert.deepEqual(d.steps.map((s) => s.depends_on), [[], ['s1'], ['s1'], ['s3'], ['s4']]);
  assert.equal(d.steps[0].purpose, commandById('lead-scout').summary);
  assert.equal(d.steps[0].produces, 'leads');
  assert.deepEqual(d.approvals, ['s5']);
  assert.ok(d.steps[1].connectors.some((c) => c.id === 'research'));
  const bad = describeWorkflow({ name: 'Bad', steps: [{ command: 'lead-scout' }, { command: 'trade-execute' }, { command: 'made-up' }] }, bare);
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => /needs: Who to look for/.test(i)));
  assert.ok(bad.issues.some((i) => /trade-execute\) needs setup: NinjaTrader/.test(i)));
  assert.ok(bad.issues.some((i) => /"made-up" is not a CHE command/.test(i)));
  const nodes = workflowNodes(d);
  assert.ok(nodes.every((n) => n.kind === 'command'));
  assert.equal(nodes[4].needs_approval, true);
});

test('workflow steps run through /api/chat on the job queue, and each step sees the earlier results', async () => {
  const che = await owner({ model: (input) => {
    const last = input.messages?.at(-1)?.content || '';
    return /scope, deliverables/i.test(last) ? 'Proposal: 5 page site, 800 dollars.' : 'Plan: 1. Pick a niche. 2. Build the site.';
  } });
  const run = await che.post('/api/commands/workflow/run', { name: 'Plan then propose', steps: [{ command: 'che-plan', input: 'a barbershop site' }, { command: 'lead-proposal', input: 'Joe\'s Barbershop site' }] });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.started, 1, 'only the first step can start');
  await che.state().processJobs();
  await che.state().processJobs();
  const mission = (await che.get('/api/commands')).missions[0];
  assert.deepEqual(mission.steps.map((s) => s.status), ['complete', 'complete']);
  assert.equal(mission.status, 'complete');
  assert.match(mission.steps[1].output, /Proposal: 5 page site/);
  assert.equal(mission.steps[0].verified_by, 'model');
  // Step 2's model call carried step 1's result as data.
  const second = che.inputs.find((i) => /scope, deliverables/i.test(JSON.stringify(i.messages)));
  assert.match(JSON.stringify(second.messages), /Results of the earlier steps[\s\S]*Plan: 1\. Pick a niche/);
});

// ─── 8. Permission checkpoints ────────────────────────────────────────────

// A signed-in NinjaTrader account (test values only), so /trade-execute is
// available. Offline, nothing can reach a broker.
const BROKER_ENV = { CHE_TRADOVATE_OAUTH_CLIENT_ID: 'tv_test_only', CHE_TRADOVATE_OAUTH_CLIENT_SECRET: 'tv_secret_test_only' };
const brokerSaved = () => new Map([['tradovate_auth', { access_token: 'tv_token_test_only', expires_at: Date.now() + 60 * 60_000 }]]);

test('8. an approval command is held for a plain yes; anything else drops the hold', async () => {
  const che = await owner({ env: BROKER_ENV, saved: brokerSaved() });
  const held = await che.say('/trade-execute');
  assert.equal(held.route, 'held');
  assert.match(held.reply, /\/trade-execute: Places a real order on your broker account\. Should I go ahead, sir\?/);
  const released = await che.say('yes');
  assert.equal(released.route, 'che_trading_desk', 'the yes releases exactly the held command to its handler');
  await che.say('/trade-execute');
  await che.say('Actually, what is the weather like?');
  const stale = await che.say('yes');
  assert.notEqual(stale.route, 'che_trading_desk', 'a yes after another turn releases nothing');
});

test('only money and owner-account actions ask first; explicit build and publish requests just run (owner rule, Sept 28)', async () => {
  assert.deepEqual(COMMANDS.filter((c) => c.confirm).map((c) => c.id).sort(), ['studio-post', 'trade-execute', 'yt-publish']);
  const che = await owner({ model: siteModel });
  await che.say('/site-build a barbershop in Phoenix');
  const published = await che.say('/site-publish');
  assert.equal(published.route, 'che_site_builder');
  assert.equal(published.done.published, true);
});

test('a workflow approval step waits for the owner; approving it lets it run', async () => {
  const che = await owner({ env: BROKER_ENV, saved: brokerSaved() });
  const run = await che.post('/api/commands/workflow/run', { name: 'Desk', steps: [{ command: 'trade-alert' }, { command: 'trade-execute' }] });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.match(run.body.spoken, /asks for your approval once the steps before it are done/);
  await che.state().processJobs();
  let mission = (await che.get('/api/commands')).missions[0];
  assert.deepEqual(mission.steps.map((s) => s.status), ['complete', 'awaiting_approval']);
  assert.equal(mission.status, 'awaiting_approval');
  assert.match(mission.spoken, /1 needs your approval/);
  await che.state().processJobs();
  assert.equal((await che.get('/api/commands')).missions[0].steps[1].status, 'awaiting_approval', 'never runs on its own');
  const approved = await che.post('/api/commands/workflow/control', { id: mission.id, action: 'approve', node_id: 's2' });
  assert.equal(approved.status, 200);
  await che.state().processJobs();
  mission = (await che.get('/api/commands')).missions[0];
  assert.notEqual(mission.steps[1].status, 'awaiting_approval');
  // It ran through the trading desk, which answered from real state: with no
  // alert open, nothing is placed, and the step is not marked done.
  assert.notEqual(mission.steps[1].status, 'complete');
  assert.match(mission.steps[1].evidence.join(' '), /no open trade alert to take right now, sir\. Nothing was placed/);
});

test('an approval step cannot be approved before it is reached', async () => {
  const che = await owner({ env: BROKER_ENV, saved: brokerSaved() });
  const run = await che.post('/api/commands/workflow/run', { name: 'Plan then trade', steps: [{ command: 'che-plan', input: 'the NQ open' }, { command: 'trade-execute' }] });
  assert.equal(run.status, 200);
  let mission = (await che.get('/api/commands')).missions[0];
  assert.equal(mission.steps[1].status, 'pending', 'not shown as needing approval while step 1 is unfinished');
  assert.equal(mission.steps[1].needs_approval, true);
  assert.doesNotMatch(mission.spoken, /needs your approval/);
  const early = await che.post('/api/commands/workflow/control', { id: mission.id, action: 'approve', node_id: 's2' });
  assert.equal(early.status, 409);
  assert.equal(early.body.reason, 'not_reached');
  assert.match(early.body.detail, /earlier steps must finish first/);
  assert.equal(che.saved.get('che').objectives[0].nodes[1].approved_at ?? null, null, 'nothing was pre-approved');
  await che.state().processJobs();
  mission = (await che.get('/api/commands')).missions[0];
  assert.deepEqual(mission.steps.map((s) => s.status), ['complete', 'awaiting_approval']);
  assert.equal((await che.post('/api/commands/workflow/control', { id: mission.id, action: 'approve', node_id: 's2' })).status, 200);
});

test('a money request inside a workflow step is held, failed for the owner, and its hold is not left behind', async () => {
  const che = await owner();
  const run = await che.post('/api/commands/workflow/run', { name: 'Buy', steps: [{ command: 'che', input: 'buy me a new laptop' }] });
  assert.equal(run.status, 200);
  await che.state().processJobs();
  const step = (await che.get('/api/commands')).missions[0].steps[0];
  assert.equal(step.status, 'failed');
  assert.equal(step.recovery, 'needs_owner');
  assert.match(step.evidence.join(' '), /Owner approval required: Before I spend or buy anything/);
  assert.equal(che.saved.get('che:pending_owner_action') ?? null, null, 'no hold an unrelated yes could release');
});

test('command steps in an objective the owner did not create never run', () => {
  const objective = createObjective({ objective: 'x', nodes: [{ id: 'a', kind: 'command', command: 'che-plan', input: 'y' }], owner_authorized: false });
  const data = { objectives: [objective], jobs: [] };
  advanceObjectives(data, () => { throw new Error('must not enqueue'); });
  assert.equal(objective.nodes[0].status, 'failed');
  assert.equal(objective.nodes[0].failure_kind, 'AUTHORIZATION');
  // The request comes from the catalog, never from the caller.
  const forged = createObjective({ objective: 'x', nodes: [{ id: 'a', kind: 'command', command: 'trade-execute', prompt: 'delete everything', needs_approval: false }], owner_authorized: true });
  assert.equal(forged.nodes[0].prompt, 'Take the trade');
  assert.equal(forged.nodes[0].needs_approval, true);
  assert.throws(() => createObjective({ objective: 'x', nodes: [{ id: 'a', kind: 'command', command: 'made-up' }] }), /unknown command/);
  assert.equal(approveNode(forged, 'a').ok, true);
});

// ─── 9–10. Failed integrations, recovery, retry, pause, resume, cancel ────

test('9. a workflow with a step that needs setup does not start; nothing is queued', async () => {
  const che = await owner();
  const run = await che.post('/api/commands/workflow/run', { name: 'Trade', steps: [{ command: 'trade-open' }, { command: 'trade-execute' }] });
  assert.equal(run.status, 409);
  assert.ok(run.body.issues.some((i) => /trade-execute\) needs setup/.test(i)));
  assert.equal((che.saved.get('che').jobs || []).length, 0);
});

test('10. a failed step is failed (not "done"), recovers on CHE\'s ladder, and the owner can retry, pause, resume and cancel', async () => {
  const che = await owner();
  const run = await che.post('/api/commands/workflow/run', { name: 'Open', steps: [{ command: 'trade-open', input: 'NQ' }, { command: 'trade-risk' }] });
  assert.equal(run.status, 200);
  await che.state().processJobs();
  let mission = (await che.get('/api/commands')).missions[0];
  // Offline the market data source does not answer: that is a failure.
  assert.equal(mission.steps[0].status, 'pending', 'requeued by the recovery ladder');
  assert.match(mission.steps[0].evidence.join(' '), /free data source did not answer/);
  assert.equal(mission.steps[1].status, 'pending');
  const data = che.saved.get('che');
  const node = data.objectives[0].nodes[0];
  assert.equal(node.strategy, 'resume_after_cooldown');
  assert.ok(node.not_before > Date.now());
  // Pause: nothing new starts, even when the owner asks to resume the step now.
  assert.equal((await che.post('/api/commands/workflow/control', { id: mission.id, action: 'pause' })).body.objective.status, 'paused');
  assert.equal((await che.post('/api/commands/workflow/control', { id: mission.id, action: 'retry', node_id: 's1' })).status, 200);
  await che.state().processJobs();
  assert.equal((await che.get('/api/commands')).missions[0].steps[0].status, 'pending');
  await che.post('/api/commands/workflow/control', { id: mission.id, action: 'resume' });
  await che.state().processJobs();
  mission = (await che.get('/api/commands')).missions[0];
  assert.match(mission.steps[0].evidence.join(' '), /did not answer/, 'it ran again after resume');
  const cancelled = await che.post('/api/commands/workflow/control', { id: mission.id, action: 'cancel' });
  assert.equal(cancelled.body.objective.status, 'cancelled');
  assert.ok((await che.get('/api/commands')).missions[0].steps.every((s) => ['cancelled', 'complete'].includes(s.status)));
  assert.equal((await che.post('/api/commands/workflow/control', { id: mission.id, action: 'dance' })).status, 409);
});

test('a recovery attempt applies the ladder\'s strategy, while the routed request stays the catalog\'s', async () => {
  const che = await owner({ model: (input) => (/For this attempt: Return the complete result as plain text/.test(JSON.stringify(input.messages))
    ? 'Plan: 1. Pick the niche. 2. Build it.'
    : 'I could not write the plan: the draft came back as an empty answer.') });
  const run = await che.post('/api/commands/workflow/run', { name: 'Plan', steps: [{ command: 'che-plan', input: 'a barbershop site' }] });
  assert.equal(run.status, 200);
  await che.state().processJobs();
  let node = che.saved.get('che').objectives[0].nodes[0];
  assert.match(node.evidence.join(' '), /empty answer/);
  assert.equal(node.strategy, 'explicit_format', 'the ladder picked a new approach for an empty answer');
  assert.ok(['pending', 'running'].includes(node.status));
  await che.state().processJobs();
  node = che.saved.get('che').objectives[0].nodes[0];
  assert.equal(node.status, 'complete', JSON.stringify(node.evidence));
  const retried = che.inputs.find((i) => /For this attempt/.test(JSON.stringify(i.messages)));
  assert.ok(retried, 'the second attempt carried the recovery strategy');
  assert.equal(retried.messages.at(-1).content.includes('For this attempt'), false, 'the routed request itself is unchanged');
  assert.match(retried.messages.at(-1).content, /Write a numbered plan for: a barbershop site/);
});

test('owner retry of a failed step is bounded', () => {
  const objective = createObjective({ objective: 'x', nodes: [{ id: 'a', kind: 'command', command: 'che-plan', input: 'y' }], owner_authorized: true });
  const node = objective.nodes[0];
  for (let i = 0; i < 2; i += 1) { node.status = 'failed'; assert.equal(retryNode(objective, 'a').ok, true); }
  node.status = 'failed';
  assert.deepEqual(retryNode(objective, 'a'), { ok: false, reason: 'strategies_exhausted' });
});

// ─── 11. Persistence ──────────────────────────────────────────────────────

test('11. command runs and workflow runs survive a restart', async () => {
  const che = await owner();
  await che.say('/trade-journal');
  await che.say('/lead-scot');
  await che.post('/api/commands/workflow/run', { name: 'Plan', steps: [{ command: 'che-plan', input: 'a booking app' }] });
  che.restart();
  const after = await che.get('/api/commands');
  assert.deepEqual(after.runs.slice(0, 2).map((r) => [r.command, r.status]), [['lead-scot', 'failed'], ['trade-journal', 'completed']]);
  assert.equal(after.runs[1].source, 'che_trading');
  assert.equal(after.missions[0].name, 'Plan');
});

// ─── 14–15. No fabricated completion; tools unavailable ───────────────────

test('14. a step whose reply reports failure is recorded as failed, never as completed', async () => {
  const che = await owner();
  await che.say('/trade-chart NQ');
  const run = (await che.get('/api/commands')).runs[0];
  assert.equal(run.command, 'trade-chart');
  // Offline the market data source does not answer.
  assert.equal(run.status, 'failed');
});

test('15. the voice test and YouTube status say what is missing instead of guessing', async () => {
  const che = await owner({ env: { ELEVENLABS_API_KEY: 'el_test_only' } });
  const voice = await che.say('/voice-test');
  assert.equal(voice.route, 'che_voice_test');
  assert.equal(voice.done.ok, false);
  assert.match(voice.reply, /ElevenLabs did not answer the voice test[\s\S]*Nothing else was tried/);
  assert.equal(voice.modelCalls, 0);
  const yt = await che.say('/yt-analytics');
  assert.match(yt.reply, /\/yt-analytics needs setup[\s\S]*YouTube/);
});

// ─── Token use ────────────────────────────────────────────────────────────

test('the catalog never enters a model prompt; a command adds only its own request', async () => {
  const che = await owner();
  await che.say('How can I make some money building websites?');
  const plain = JSON.stringify(che.inputs.at(-1));
  assert.doesNotMatch(plain, /lead-scout|\/yt-ideas|Command Center/);
  const before = che.inputs.length;
  await che.say('/marketing-plan my web design studio');
  const sent = che.inputs.slice(before).map((i) => JSON.stringify(i)).join('');
  assert.match(sent, /Write a marketing plan for my web design studio/);
  assert.doesNotMatch(sent, /lead-scout|yt-ideas/, 'other commands are not loaded');
  const catalogBytes = JSON.stringify(COMMANDS).length;
  const prompts = COMMANDS.map((c) => dispatchPrompt(c, 'my web design business').length);
  assert.ok(catalogBytes > 20000, `catalog ${catalogBytes} B stays out of prompts`);
  assert.ok(Math.max(...prompts) < 400, `largest command request ${Math.max(...prompts)} B`);
});

test('the Flutter catalog fixture matches what the Worker serves (regenerate: node tool/dump_command_catalog.mjs)', async () => {
  const { fixtureCatalog } = await import('../../tool/dump_command_catalog.mjs');
  const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/command_catalog.json', import.meta.url), 'utf8'));
  assert.deepEqual(fixture, JSON.parse(JSON.stringify(fixtureCatalog())));
  assert.equal(fixture.commands.length, 89);
  assert.ok(fixture.templates.length >= 4);
});

test('the deploy probe checks the live Command Center on an isolated CHE and reports owner readiness without secrets', async () => {
  const states = new Map();
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_VOICE_PROBE_TOKEN: 'p'.repeat(40), ELEVENLABS_API_KEY: 'el_secret_value',
    AI: { run: async () => ({ response: 'Here is the answer, sir.' }) },
  };
  env.CHE_STATE = { getByName: (name) => {
    if (!states.has(name)) states.set(name, new CheState({ storage: storageFor(new Map()), waitUntil: (p) => pending.push(p) }, env));
    // Match production Durable Object stubs: only fetch() is exposed.
    return { fetch: (request) => states.get(name).fetch(request) };
  } };
  const denied = await worker.fetch(new Request('https://che.example/api/commands/probe', { method: 'POST' }), env);
  assert.equal(denied.status, 404);
  const res = await worker.fetch(new Request('https://che.example/api/commands/probe', { method: 'POST', headers: { Authorization: `Bearer ${'p'.repeat(40)}` } }), env);
  const report = await res.json();
  for (const p of pending) await p;
  assert.equal(report.ok, true, JSON.stringify(report.steps, null, 1));
  assert.equal(report.passed, report.total);
  assert.equal(typeof report.readiness.error, 'undefined', 'readiness is genuinely available in production-stub shape');
  assert.ok(report.readiness.available >= 50, `${report.readiness.available} ready`);
  assert.ok(report.readiness.setup_required.some((c) => c.id === 'trade-execute' && c.missing.includes('NinjaTrader / Tradovate account')));
  assert.equal(report.readiness.connectors.voice, 'ready');
  assert.doesNotMatch(JSON.stringify(report), /el_secret_value/);
  assert.ok(!states.has('owner') || !(await states.get('owner').loadData()).memories?.length, 'the owner\'s memory is untouched');
});

// ─── 9. REA through the real chat (read-only, pinned, never a coding job) ──

const REA_SEMVER = JSON.parse(readFileSync(new URL('./fixtures/rea/semver-7.7.2.summary.json', import.meta.url), 'utf8'));

// Answers only the npm registry and the GitHub calls REA makes, and records every call.
async function withGitHub({ resultFor = () => undefined } = {}, run) {
  const offline = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url || input);
    const method = String(init.method || 'GET').toUpperCase();
    seen.push(`${method} ${url}`);
    if (url === 'https://registry.npmjs.org/semver/7.7.2') {
      return new Response(JSON.stringify({ name: 'semver', version: '7.7.2', license: 'MIT', dist: { integrity: REA_SEMVER.target.integrity } }), { status: 200 });
    }
    if (method === 'POST' && url.endsWith('/actions/workflows/che-rea-analysis.yml/dispatches')) return new Response(null, { status: 204 });
    const record = url.match(/mailbox\/rea\/(rea-[0-9a-f]{8})\.json/);
    if (record && method === 'GET') {
      const body = resultFor(record[1]);
      return body ? new Response(JSON.stringify({ content: Buffer.from(JSON.stringify(body)).toString('base64') }), { status: 200 }) : new Response('{"message":"Not Found"}', { status: 404 });
    }
    return new Response('{"message":"unexpected"}', { status: 500 });
  };
  try { return await run(seen); } finally { globalThis.fetch = offline; }
}

test('an REA request reaches its own read-only route: one analysis run, no model call, no coding job', async () => {
  await withGitHub({}, async (seen) => {
    const che = await owner({ env: READY_ENV });
    const out = await che.say('REA inspect: npm:semver@7.7.2');
    assert.equal(out.route, 'che_rea');
    assert.equal(out.modelCalls, 0);
    assert.match(out.reply, /started for npm semver 7\.7\.2 \(MIT\)/);
    const posts = seen.filter((s) => s.startsWith('POST'));
    assert.equal(posts.length, 1, 'exactly one dispatch');
    assert.match(posts[0], /\/actions\/workflows\/che-rea-analysis\.yml\/dispatches$/);
    assert.equal((che.saved.get('che')?.jobs || []).length, 0, 'no coding job was created');
    assert.equal(che.saved.get('rea_jobs').length, 1);
  });
});

test('a read-only REA request that asks for a fix still starts no coding job, commit or pull request', async () => {
  await withGitHub({}, async (seen) => {
    const che = await owner({ env: READY_ENV });
    const out = await che.say('REA debug: npm:semver@7.7.2 fix the range parser and open a pull request');
    assert.equal(out.route, 'che_rea');
    assert.equal(seen.filter((s) => s.startsWith('POST')).length, 1, 'only the analysis run');
    assert.equal((che.saved.get('che')?.jobs || []).length, 0);
  });
});

test('a finished REA run is answered in chat from its recorded evidence, and reading it dispatches nothing', async () => {
  let finished = false;
  await withGitHub({ resultFor: (id) => (finished ? { ...REA_SEMVER, job_id: id } : undefined) }, async (seen) => {
    const che = await owner({ env: READY_ENV });
    await che.say('REA inspect: npm:semver@7.7.2');
    finished = true;
    const out = await che.say('REA status');
    assert.equal(out.route, 'che_rea');
    assert.equal(out.modelCalls, 0);
    assert.match(out.reply, /Evidence ev_01ccdb10/);
    assert.match(out.reply, /Limitations REA reported/);
    assert.equal(seen.filter((s) => s.startsWith('POST')).length, 1, 'reading a result dispatches nothing');
  });
});

test('without a GitHub connection an REA request says so plainly and runs nothing', async () => {
  await withGitHub({}, async (seen) => {
    const che = await owner();
    const out = await che.say('REA inspect: npm:semver@7.7.2');
    assert.equal(out.route, 'che_rea');
    assert.match(out.reply, /has no GitHub connection/);
    assert.equal(seen.filter((s) => s.startsWith('POST')).length, 0);
  });
});

// ─── The owner's spoken Command Center phrases (iPhone, 2026-10-16) ───────

test('the owner\'s six spoken phrases are answered from the catalog with no model, in every spelling', async () => {
  const che = await owner();
  const variants = (phrase) => {
    const bare = phrase.replace(/^CHE,\s*/, '');
    const plain = bare.replace(/[.,?!]/g, '');
    return [phrase, plain.toLowerCase(), `Chay ${plain}`, `Chey, ${bare}`, `Hey CHE ${plain}`, `hey che, ${plain.toLowerCase()}.`];
  };
  for (const words of variants('CHE, open your Commands page.')) {
    const out = await che.say(words);
    assert.equal(out.route, 'che_command_center', words);
    assert.match(out.reply, /89 commands in 9 groups[\s\S]*2\. YouTube, 11[\s\S]*9\. Creator Studio, 6[\s\S]*Nothing was run/, words);
  }
  for (const words of variants('CHE, search for YouTube.')) {
    const out = await che.say(words);
    assert.equal(out.route, 'che_command_center', words);
    assert.match(out.reply, /^YouTube: 11 commands\. 1\. \/yt-ideas: /, words);
  }
  let list;
  for (const words of variants('Show me five YouTube commands and tell me which are ready.')) {
    list = await che.say(words);
    assert.equal(list.route, 'che_command_center', words);
    assert.match(list.reply, /4\. \/yt-video: Generate and assemble videos\. Needs setup: Video renderer\./, words);
    assert.match(list.reply, /Of these 5: 3 ready, 2 need setup\./, words);
    assert.doesNotMatch(list.reply, /6\. /, words);
  }
  const history = [{ role: 'user', content: 'Show me five YouTube commands and tell me which are ready.' }, { role: 'assistant', content: list.reply }];
  for (const words of variants('Show me number four.')) {
    const out = await che.say(words, { history });
    assert.equal(out.route, 'che_command_center', words);
    assert.match(out.reply, /^Number 4: \/yt-video\. [\s\S]*It needs setup\. Video renderer: /, words);
  }
  // The list was read on the phone's Commands page, not in this chat: no guess.
  const elsewhere = await che.say('Show me number four.', { history: [history[0], { role: 'assistant', content: 'Opening Commands for "youtube", sir.' }] });
  assert.match(elsewhere.reply, /I don't have that numbered list[\s\S]*won't guess/);
  for (const words of variants('Run the video command.')) {
    const out = await che.say(words);
    assert.equal(out.route, 'che_command', words);
    assert.equal(out.done.command, 'yt-video', words);
    assert.match(out.reply, /^\/yt-video needs setup, sir\. Video renderer: [\s\S]*Nothing was run\.$/, words);
  }
  for (const words of variants('What is on my screen?')) {
    const out = await che.say(words);
    assert.equal(out.route, 'che_screen', words);
    assert.match(out.reply, /can't see your screen from here[\s\S]*won't guess/, words);
  }
  assert.equal(che.inputs.length, 0, 'no model was asked for any of them');
  // A name part two commands share runs neither; other requests are untouched.
  assert.match((await che.say('run the publish command')).reply, /could be \/yt-publish or \/site-publish[\s\S]*Nothing was run/);
  assert.equal(readCommandSpeech('Search YouTube for jazz'), null);
  assert.equal(readCommandSpeech('search for money'), null);
  assert.equal(readCommandSpeech('run a backtest on NQ'), null);
  assert.equal(readCommandSpeech('four', []).command, null, 'a bare number with no list in the chat names nothing');
});

test('"Run the video command" reaches the real video handler once it is ready, and asks for its topic first', async () => {
  const che = await owner({ env: READY_ENV });
  const view = await che.get('/api/commands');
  assert.equal(view.commands.find((c) => c.id === 'yt-video').status, 'available', 'the free GitHub renderer is configured here');
  const bare = await che.say('Run the video command.');
  assert.equal(bare.route, 'che_command');
  assert.match(bare.reply, /^\/yt-video needs video topic, sir\.[\s\S]*Nothing was run/);
  const run = await che.say('run the video command about octopus intelligence');
  assert.equal(run.route, commandById('yt-video').route, run.reply.slice(0, 160));
  assert.equal(commandFromWords('video').command.id, 'yt-video');
});

test('a fast command or screen reply drops a held payment or app request, so a later yes releases nothing', async () => {
  for (const phrase of ['Show me five YouTube commands and tell me which are ready.', 'What is on my screen?', 'Run the video command.']) {
    const che = await owner();
    che.saved.set('che:pending_owner_action', { kinds: ['money'], text: 'buy me a new laptop', at: Date.now() });
    che.saved.set('che:pending_app_action', { app: 'spotify', text: 'open spotify', at: Date.now() });
    const out = await che.say(phrase);
    assert.equal(out.modelCalls, 0, phrase);
    assert.equal(che.saved.get('che:pending_owner_action') ?? null, null, `${phrase}: the money hold is gone`);
    assert.equal(che.saved.get('che:pending_app_action') ?? null, null, `${phrase}: the app hold is gone`);
    const yes = await che.say('yes');
    assert.doesNotMatch(yes.reply, /laptop|spotify/i, `${phrase}: a later yes releases nothing`);
  }
});
