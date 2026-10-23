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
  // 'learn' is the Knowledge Atlas (issue #346), one entry over knowledge_atlas.js.
  // 'che-cancel-job' cancels a queued coding job by voice or typing (owner, 2026-10-19).
  intelligence: ['che', 'che-explore', 'che-plan', 'che-build', 'che-research', 'che-verify', 'che-memory', 'che-brain-review', 'che-flagstaff-import', 'che-outside-mail', 'che-recover', 'che-cancel-job', 'che-status', 'learn', 'security-access', 'security-chief', 'security-findings'],
  youtube: ['yt-ideas', 'yt-research', 'yt-script', 'yt-video', 'yt-voice', 'yt-thumbnail', 'yt-seo', 'yt-publish', 'yt-batch', 'yt-analytics', 'yt-grow'],
  // trade-connections reads the owner-only connections of #348 (issue #350).
  // trade-setups opens the Signal Mode Setup Progress Board (owner, 2026-10-23).
  trading: ['trade-open', 'trade-chart', 'trade-setup', 'trade-setups', 'trade-liquidity', 'trade-risk', 'trade-backtest', 'trade-learning', 'trade-research', 'trade-history', 'trade-matrix', 'trade-journal', 'trade-alert', 'trade-sim', 'trade-controls', 'trade-emergency', 'trade-execute', 'trade-connections', 'trade-pnl', 'trade-leader', 'trade-audit', 'trade-replay'],
  build: ['site-build', 'site-redesign', 'site-audit', 'site-publish', 'app-build', 'app-fix', 'ai-build', 'code-review', 'che-release', 'iphone-update', 'rea-inspect', 'rea-discover', 'rea-features', 'rea-explain', 'rea-debug', 'rea-compare', 'rea-rebuild', 'rea-build', 'rea-verify', 'rea-status'],
  money: ['money-dashboard', 'cashflow', 'budget', 'expenses', 'invoices', 'money-forecast', 'pricing', 'profit-report'],
  clients: ['lead-scout', 'lead-audit', 'lead-score', 'lead-match', 'lead-proposal', 'lead-outreach', 'lead-crm', 'lead-followup', 'client-deliver'],
  marketing: ['brand-build', 'marketing-plan', 'social-content', 'ads-plan', 'seo-growth', 'sales-funnel', 'business-launch'],
  office: ['office-status', 'office-delegate', 'warroom', 'automate', 'skill-learn', 'connect', 'voice-test', 'create-3d'],
  // Creator Studio (owner issue #347).
  studio: ['studio-bible', 'studio-pilot', 'studio-render', 'studio-export', 'studio-post', 'studio-growth', 'film-make', 'film-status'],
};

const SITE_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Joe\'s Barbershop</title></head><body><header><h1>Joe\'s Barbershop</h1></header><main><p>Classic cuts in Phoenix.</p><a href="#book">Book a cut</a></main><footer>Open daily</footer></body></html>';

// HTML only when CHE's site builder asks for a page; plain text otherwise.
const siteModel = (input) => (/website|web app|change the website|<html|html document/i.test(JSON.stringify(input.messages?.slice(-1) || '')) && /build|change|edit/i.test(JSON.stringify(input.messages?.slice(-1) || ''))
  ? SITE_HTML : 'Here is the answer, sir.');

function storageFor(saved) {
  return {
    get: async (key) => Array.isArray(key) ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))])) : saved.has(key) ? structuredClone(saved.get(key)) : undefined,
    // Like Durable Object storage, put also takes an object of several keys.
    put: async (key, value) => {
      if (key && typeof key === 'object') { for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v)); return; }
      saved.set(key, structuredClone(value));
    },
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

test('1. the owner\'s 71 commands exist exactly as listed, plus ten REA, six Creator Studio, two Strategy Control Center, two strategy learning commands, the historical study, the timeframe matrix and three Security Room commands, in 9 categories, each fully described', () => {
  assert.equal(COMMANDS.length, 110);
  assert.equal(new Set(COMMANDS.map((c) => c.id)).size, 110, 'ids are unique');
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
  assert.equal(view.commands.length, 110);
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
  // The Flagstaff mailbox as outside correspondence: the commands and the owner's own words reach one
  // handler each, with no model; "what did I tell you" stays his memory question. (Offline here, so the
  // import reports that GitHub could not be read.)
  const mailCe = await owner({ env: READY_ENV });
  for (const [said, route] of [
    ['/che-flagstaff-import', 'che_flagstaff_import'], ['Import the Flagstaff history', 'che_flagstaff_import'], ['import the flagstaff history', 'che_flagstaff_import'],
    ['/che-outside-mail', 'che_outside_correspondence'], ['How many outside messages are in my Brain?', 'che_outside_correspondence'],
    ['how many outside messages are in my brain', 'che_outside_correspondence'], ['What did ChatGPT tell you about #350?', 'che_outside_correspondence'],
    ['What did you tell ChatGPT about #351?', 'che_outside_correspondence'], ['What did I tell you about #350?', 'che_memory_provenance'],
  ]) {
    const out = await mailCe.say(said);
    assert.equal(out.route, route, said);
    assert.equal(out.modelCalls, 0, said);
  }
  assert.match((await che.say('/che-flagstaff-import')).reply, /needs setup[\s\S]*GitHub/, 'without GitHub the command says what it needs');
  assert.deepEqual(parseSlashCommand('/Trade-Chart  NQ please'), { name: 'trade-chart', command: commandById('trade-chart'), input: 'NQ please' });
  assert.equal(parseSlashCommand('Analyze the NQ chart'), null);
});

test('/che-cancel-job and its spoken forms reach the coding-job cancel route with no model, no approval and no delete hold', async () => {
  const c = commandById('che-cancel-job');
  assert.equal(c.route, 'che_coding_cancel');
  assert.equal(c.local, 'coding_cancel');
  assert.equal(c.confirm, '', 'cancelling a queued job deletes nothing and costs nothing, so it does not ask first');
  assert.equal(commandStatus(c, connectorStatus({ AI: {} })).status, 'available');
  assert.equal(commandFromWords('cancel job')?.command?.id, 'che-cancel-job', '"run the cancel job command"');
  const che = await owner();
  const queued = (id, request) => ({ id, kind: 'self_development', title: `Code: ${request}`, prompt: request, request, status: 'queued', attempts: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  const accepted = [{ role: 'assistant', content: 'I accepted coding job c2987a73, sir. It is queued, not running yet. Ask "coding status" anytime.' }];
  for (const [said, history] of [['/che-cancel-job c2987a73', []], ['Cancel coding job c2987a73', []], ['cancel job c2987a73', []],
    ['Cancel that coding job', accepted], ['Cancel the last coding job', accepted], ['Cancel that fake commit by Che', accepted]]) {
    che.saved.get('che').jobs = [queued('c2987a73-0000-4000-8000-000000000001', 'Which of those features could improve your app?'), queued('5b1e09aa-0000-4000-8000-000000000002', 'Add a dark mode switch')];
    const out = await che.say(said, { history });
    assert.equal(out.route, 'che_coding_cancel', said);
    assert.equal(out.modelCalls, 0, said);
    assert.match(out.reply, /^I cancelled coding job c2987a73, sir\./, said);
    assert.deepEqual(che.saved.get('che').jobs.map((j) => j.status), ['cancelled', 'queued'], said);
  }
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
  for (const words of ['Import the Flagstaff history', 'What did ChatGPT tell you about #350?', 'How many outside messages are in my Brain?']) {
    const out = await che.send('/api/chat', { message: words, history: [] }, guestToken);
    assert.match(replyFromNdjson(await out.text()), /^Only the CHE owner can/, words);
  }
  const run = await che.send('/api/commands/workflow/run', { name: 'x', steps: [{ command: 'che-plan', input: 'y' }] }, guestToken);
  assert.equal(run.status, 403);
});

// The strategy simulation's pause, resume and status, typed through the catalog's /trade-sim command (owner only).
test('/trade-sim pauses, resumes and reports the strategy simulation through its own chat route, with no model call', async () => {
  const che = await owner({ model: siteModel, env: READY_ENV });
  const paused = await che.say('/trade-sim pause');
  assert.equal(paused.route, 'che_strategy_sim');
  assert.equal(paused.modelCalls, 0);
  assert.equal((await che.get('/api/trading/sim')).status, 'paused');
  const status = await che.say('/trade-sim status');
  assert.equal(status.route, 'che_strategy_sim');
  assert.match(status.reply, /is paused/);
  const resumed = await che.say('/trade-sim resume');
  assert.equal(resumed.route, 'che_strategy_sim');
  assert.equal((await che.get('/api/trading/sim')).status, 'running');
});

test('the strategy simulation answers plain speech, owner only, with no model call, and leaves trading and desk phrases alone', async () => {
  const che = await owner({ model: siteModel, env: READY_ENV });
  const said = async (words, status) => {
    const out = await che.say(words);
    assert.equal(out.route, 'che_strategy_sim', `${words} → ${out.route}`);
    assert.equal(out.modelCalls, 0, words);
    assert.equal((await che.get('/api/trading/sim')).status, status, words);
    return out;
  };
  await said('Pause the strategy simulation', 'paused');
  await said('Resume the simulation', 'running');
  await said('Stop the simulation', 'paused');
  assert.match((await said('How is the simulation doing?', 'paused')).reply, /is paused/);
  await said('Simulation status', 'paused');
  await said('Start the strategy simulation', 'running');
  for (const words of ['Pause trading', 'Switch to simulation mode', 'Run a Monte Carlo simulation on my last 50 trades', 'Buy 10 shares of AAPL on Alpaca paper']) {
    assert.notEqual((await che.say(words)).route, 'che_strategy_sim', words);
  }
  assert.equal((await che.get('/api/trading/sim')).status, 'running', 'none of those changed it');
});

// Historical trading intelligence: typed, spoken or /trade-history, owner only, answered from stored tests with no model call.
test('/trade-history and plain questions reach the historical study; nothing is invented while it has no data', async () => {
  const che = await owner({ model: siteModel, env: READY_ENV });
  const before = await che.say('How did your strategies do historically on NQ since 1999?');
  assert.equal(before.route, 'che_trading_intelligence');
  assert.equal(before.modelCalls, 0);
  assert.match(before.reply, /No historical study has run yet/);
  // Offline here: the provider cannot be reached, so the study records that and reports no numbers.
  const run = await che.say('/trade-history run');
  assert.equal(run.route, 'che_trading_intelligence');
  assert.equal(run.modelCalls, 0);
  const view = await che.get('/api/trading/intelligence');
  assert.equal(view.state.status, 'complete');
  assert.ok(view.datasets.every((d) => d.ok === false && d.error), 'each dataset says why it was not verified');
  assert.equal(view.results.length, 0, 'no result without verified data');
  assert.doesNotMatch(run.reply, /out-of-sample trades/);
  assert.equal((await che.say('Backtest NQ')).route === 'che_trading_intelligence', false, 'the existing backtest command keeps its route');
  const dirty = await che.say('Test Dirty Trez on MNQ');
  assert.match(dirty.reply, /no written rules for Dirty Trez/);
});

// Timeframe backtest matrix: typed, spoken or /trade-matrix, owner only, no model call, nothing invented offline.
test('/trade-matrix and timeframe questions reach the matrix; offline it reports no numbers', async () => {
  const che = await owner({ model: siteModel, env: READY_ENV });
  const before = await che.say('Which strategy works best on which timeframe for NQ?');
  assert.equal(before.route, 'che_trading_matrix');
  assert.equal(before.modelCalls, 0);
  assert.match(before.reply, /has not run yet/);
  const run = await che.say('/trade-matrix run');
  assert.equal(run.route, 'che_trading_matrix');
  assert.equal(run.modelCalls, 0);
  assert.match(run.reply, /no order was placed/);
  const view = await che.get('/api/trading/matrix');
  assert.equal(view.ranking.length, 0, 'no ranking without data');
  assert.equal(view.timeframes.find((t) => t.id === '15s').available, false);
  assert.equal((await che.say('How did your strategies do historically on NQ since 1999?')).route, 'che_trading_intelligence', 'decades questions keep their route');
});

test('a guest device cannot read or run the historical study', async () => {
  const che = await owner();
  const tenant = await che.post('/api/platform/tenants', { name: 'Guest', role: 'family' });
  const invite = await che.post('/api/platform/enrollments', { access: 'private', tenant_id: tenant.body.tenant.id });
  const guestToken = (await (await che.send('/api/enroll', { enrollment_token: invite.body.enrollment.token, device_name: 'guest' })).json()).device_token;
  const spoken = await che.send('/api/chat', { message: 'Run the historical strategy study', history: [] }, guestToken);
  assert.doesNotMatch(replyFromNdjson(await spoken.text()), /historical study is finished|the historical study, sir/);
  assert.equal((await che.send('/api/trading/intelligence', null, guestToken, 'GET')).status, 403);
  assert.equal((await che.get('/api/trading/intelligence')).state.status, 'never run', 'the guest started nothing');
});

test('a guest device cannot pause the strategy simulation through /trade-sim', async () => {
  const che = await owner();
  const tenant = await che.post('/api/platform/tenants', { name: 'Guest', role: 'family' });
  const invite = await che.post('/api/platform/enrollments', { access: 'private', tenant_id: tenant.body.tenant.id });
  const guestToken = (await (await che.send('/api/enroll', { enrollment_token: invite.body.enrollment.token, device_name: 'guest' })).json()).device_token;
  const res = await che.send('/api/chat', { message: '/trade-sim pause', history: [] }, guestToken);
  assert.match(replyFromNdjson(await res.text()), /Only the CHE owner can run commands/);
  assert.equal((await che.get('/api/trading/sim')).status, 'running', 'the refused guest did not pause it');
  const spoken = await che.send('/api/chat', { message: 'Stop the simulation', history: [] }, guestToken);
  await spoken.text();
  assert.equal((await che.get('/api/trading/sim')).status, 'running', 'plain speech from a guest does not pause it either');
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
  assert.equal(forged.nodes[0].prompt, 'Yes, take the trade', 'the catalog prompt carries the explicit yes');
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
  assert.equal(fixture.commands.length, 110);
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
    assert.match(out.reply, /110 commands in 9 groups[\s\S]*2\. YouTube, 11[\s\S]*9\. Creator Studio, 8[\s\S]*Nothing was run/, words);
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

test('context continuity: the real chat model receives details older than 80 turns once, with their roles', async () => {
  const che = await owner();
  const first = 'Willo receives order 42 on Friday at 16:45 via https://example.com/a?b=2.';
  const history = [{ role: 'user', content: first }, ...Array.from({ length: 90 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: `ordinary detail ${i}` }))];
  await che.say('/che-plan summarize the delivery details', { history });
  const input = che.inputs.at(-1);
  assert.equal(input.messages.filter((m) => m.role === 'user' && m.content === first).length, 1);
  assert.ok(input.messages.some((m) => m.content === 'ordinary detail 0'));
});

test('workflow dependencies pass the complete earlier result, including its late constraint', async () => {
  const result = 'Project detail. '.repeat(150) + ' FINAL: ask Willo before publishing.';
  const che = await owner({ model: () => result });
  const run = await che.post('/api/commands/workflow/run', { name: 'Context test', steps: [
    { command: 'che-plan', input: 'Outline the project' }, { command: 'che-plan', input: 'Refine the earlier outline' },
  ] });
  assert.equal(run.status, 200);
  await che.state().processJobs();
  await che.state().processJobs();
  assert.ok(che.inputs.some((input) => input.messages.some((m) => String(m.content).includes(result))), 'the dependent model receives the whole verified result');
});

test('a code-review workflow cannot accept a model reply as proof of repository inspection', async () => {
  const che = await owner({ env: READY_ENV });
  const started = await che.post('/api/commands/workflow/run', { name: 'Code review', steps: [{ command: 'code-review', input: 'routing' }] });
  assert.equal(started.status, 200);
  const data = che.saved.get('che');
  const job = data.jobs.find((j) => j.kind === 'command');
  const state = che.state();
  state.handleRequest = async () => new Response(JSON.stringify({ type: 'delta', delta: 'Done, job-12345 completed the review.' }) + '\n' + JSON.stringify({ type: 'done', source: 'model', ok: true }) + '\n');
  const out = await state.runCommandJob(job);
  assert.equal(out.status, 'failed');
  assert.match(out.error, /route|handler/i);
  assert.equal(out.result, '');
});

test('a voice/typed sentence compiles named commands into the existing saved workflow without model calls', async () => {
  const che = await owner();
  const out = await che.say('Create a workflow to che plan Willo Project then che plan Refine Willo Project');
  assert.equal(out.route, 'che_command_workflow');
  assert.equal(out.done.ok, true);
  assert.equal(out.modelCalls, 0);
  const saved = che.saved.get('che');
  assert.equal(saved.command_workflows.length, 1);
  assert.equal(saved.command_workflows[0].steps[0].input, 'Willo Project');
  assert.equal(saved.jobs.length, 0);
  const started = await che.say(`run my ${saved.command_workflows[0].name} workflow`);
  assert.equal(started.done.ok, true);
  assert.equal(che.saved.get('che').objectives[0].source, 'command_workflow');
});

test('an unknown step in a natural workflow queues nothing; oversized command input keeps the late prohibition', async () => {
  const che = await owner();
  const unknown = await che.say('run a workflow to che plan Willo Project then imaginary command');
  assert.equal(unknown.done.ok, false);
  assert.equal(unknown.modelCalls, 0);
  assert.equal((che.saved.get('che').jobs || []).length, 0);
  const long = await che.say('/che-plan ' + 'x'.repeat(4100) + ' do not buy anything');
  assert.equal(long.done.ok, false);
  assert.equal(long.modelCalls, 0);
  assert.match(long.reply, /Nothing was cut or run/);
});

test('REA workflows wait for real runner evidence, then unblock the dependent command without redispatching', async () => {
  let finished = false;
  await withGitHub({ resultFor: (id) => finished ? { ...REA_SEMVER, job_id: id } : undefined }, async (seen) => {
    const che = await owner({ env: READY_ENV });
    const start = await che.say('run a workflow to rea inspect npm:semver@7.7.2 then rea explain npm:semver@7.7.2');
    assert.equal(start.done.ok, true);
    await che.state().processJobs();
    let data = che.saved.get('che');
    const first = data.objectives[0].nodes[0];
    assert.equal(first.status, 'running');
    assert.equal(data.objectives[0].nodes[1].status, 'pending');
    const job = data.jobs.find((j) => j.kind === 'command');
    assert.equal(job.status, 'queued');
    assert.ok(job.retry_at > Date.now());
    finished = true;
    job.retry_at = 0;
    che.saved.set('che', data);
    await che.state().processJobs();
    await che.state().processJobs();
    data = che.saved.get('che');
    assert.ok(data.objectives[0].nodes.every((n) => n.status === 'complete'));
    assert.equal(seen.filter((s) => s.startsWith('POST')).length, 1);
    assert.equal(che.inputs.length, 0);
  });
});

test('comprehension audit: "what commands do you have?" is answered from the catalog', () => {
  for (const text of ['What commands do you have?', 'which commands are there', 'chey list all your commands']) {
    assert.deepEqual(readCommandSpeech(text), { kind: 'groups' }, text);
  }
  assert.deepEqual(readCommandSpeech('open commands'), { kind: 'open' });
  assert.equal(readCommandSpeech('what commands should I use for youtube'), null);
});

// Music rights (owner, 2026-10-22): one song record in Projects carries samples, licences, splits and readiness.
test('music rights: a sample blocks release until its licence is attached; splits never invented; no model call', async () => {
  const che = await owner();
  const created = await che.post('/api/music/rights', { action: 'create_song', title: 'Midnight' });
  assert.equal(created.status, 200);
  const id = created.body.project.id;
  assert.equal(created.body.project.type, 'music', 'the song is an ordinary project record');
  const added = await che.post('/api/music/rights', { action: 'add_sample', project_id: id, sample: { name: 'Soul vocal', provenance: 'LICENSED', source: 'a site' } });
  assert.equal(added.body.evaluation.state, 'unresolved');
  const splits = await che.post('/api/music/rights', { action: 'set_splits', project_id: id, splits: [{ group: 'songwriting', name: 'Owner', percent: 60, agreement: 'signed' }, { group: 'songwriting', name: 'Feature', percent: 30, agreement: 'signed' }] });
  assert.ok(splits.body.check.issues.includes('Songwriting shares total 90%, not 100%.'));
  const ask = await che.say('Is Midnight ready to release? Check my samples and splits.');
  assert.equal(ask.route, 'che_music_rights');
  assert.equal(ask.modelCalls, 0);
  assert.match(ask.reply, /Midnight is not ready to release/);
  assert.match(ask.reply, /Soul vocal/);
  assert.match(ask.reply, /90%, not 100%/);
  assert.doesNotMatch(ask.reply, /\bsafe\b|cannot be sued|guarantee/i);
  const lic = await che.post('/api/music/rights', { action: 'attach_license', project_id: id, sample_id: added.body.sample.id, license: { license_type: 'Royalty-free pack licence', license_ref: 'invoice 1042', commercial_use: true } });
  assert.equal(lic.body.evaluation.state, 'documented');
  const read = await che.get(`/api/music/rights?project_id=${id}`);
  assert.equal(read.readiness.items.find((i) => i.id === 'samples').ok, true, 'the licence was saved on the song');
  assert.equal(read.readiness.ready, false, 'still no master, artwork or reconciled splits');
  const defend = await che.say('Can we defend Midnight? How risky is this song?');
  assert.equal(defend.route, 'che_music_rights');
  assert.match(defend.reply, /UNCLEAR|LOWER RISK|HIGHER RISK|ATTORNEY REVIEW RECOMMENDED/);
  const projects = (await che.get('/api/state')).projects || [];
  assert.ok(projects.some((p) => p.id === id), 'the same record appears in Projects');
});

test('music rights by voice: add a song and a sample in chat, saved and read back, no model call', async () => {
  const che = await owner();
  const song = await che.say('CHE, add a song called Pressure');
  assert.equal(song.route, 'che_music_rights');
  assert.equal(song.modelCalls, 0);
  const sample = await che.say('Add a sample called Rain loop to Pressure from freesound');
  assert.match(sample.reply, /not verified yet/);
  const id = ((await che.get('/api/state')).projects || []).find((p) => p.title === 'Pressure').id;
  const read = await che.get(`/api/music/rights?project_id=${id}`);
  assert.equal(read.project.music.samples[0].name, 'Rain loop');
  assert.equal(read.readiness.items.find((i) => i.id === 'samples').ok, false);
});

test('music business by voice: a quote is a draft, a managed artist gets a private workspace, money is never invented', async () => {
  const che = await owner();
  const quote = await che.say('CHE, quote Jay R $250 for a mix and master');
  assert.equal(quote.route, 'che_music_business');
  assert.equal(quote.modelCalls, 0);
  assert.match(quote.reply, /Draft quote for Jay R: mix and master, \$250\.00.*Nothing is sent until you approve it/);
  const view = await che.get('/api/music/business');
  const jay = view.workspaces.find((w) => w.name === 'Jay R');
  assert.equal(jay.kind, 'CLIENT');
  const deal = ((await che.get('/api/pipeline')).deals || []).find((d) => d.music_workspace_id === jay.id);
  assert.equal(deal.stage, 'proposal', 'the quote waits in the existing pipeline for the owner');
  const artist = await che.say("I'm managing Erica now");
  assert.match(artist.reply, /private workspace for Erica/);
  const dash = await che.say('How is my music business?');
  assert.match(dash.reply, /No payments are recorded this month/);
  assert.equal(view.dashboard.revenue_usd, null);
});

test('music business by voice: services, songs, quote approval, client feedback and delivery status, all spoken back', async () => {
  const che = await owner();
  assert.match((await che.say('Set my mix price to $200 with 1 revision')).reply, /mix is set at \$200\.00 with 1 revision/);
  await che.say('Add a client called Jay R');
  const song = await che.say('Add a song called Night Drive for Jay R');
  assert.equal(song.route, 'che_music_business');
  assert.match(song.reply, /not tied to a quote yet/);
  await che.say('Quote Jay R $200 for a mix');
  const approved = await che.say('Approve the quote for Jay R');
  assert.match(approved.reply, /Approved the quote for Jay R: mix, \$200\.00\. It is yours to send\. Nothing was sent/);
  const feedback = await che.say('Jay R wants changes on Night Drive: vocal louder');
  assert.match(feedback.reply, /no version on record yet/);
  const delivery = await che.say('Is Night Drive ready to deliver?');
  assert.equal(delivery.route, 'che_music_business');
  assert.match(delivery.reply, /Waiting for payment|not tied to one quote/);
  assert.notEqual((await che.say('The bank approved my loan')).route, 'che_music_business', 'unknown names are not business actions');
});

test('Legal Intelligence by voice: home, "can I record somebody here?", a location change, a contract upload and one exclusive-sale answer', async () => {
  const che = await owner();
  assert.match((await che.say('Can I record somebody here?')).reply, /Where are you\? .*I do not track your location/);
  assert.match((await che.say('My home state is Louisiana')).reply, /Louisiana is your home jurisdiction/);
  const ask = await che.say('Can I record somebody here?');
  assert.equal(ask.route, 'che_legal');
  assert.equal(ask.modelCalls, 0);
  assert.match(ask.reply, /Will you be part of the conversation you record\?/);
  const mine = await che.say("Can I record a call I'm on here?");
  assert.match(mine.reply, /Probably yes\. Louisiana law \(La\. R\.S\. 15:1303\) allows recording a conversation you take part in.*not checked live today/);
  // Location stays off until the owner turns it on; then only his activities are compared.
  assert.match((await che.say("I'm in California now, is there anything relevant that changed?")).reply, /Location-aware legal differences are off/);
  assert.match((await che.say('Turn on location legal alerts')).reply, /never a precise location/);
  const moved = await che.say("I'm in California now, is there anything relevant that changed?");
  assert.match(moved.reply, /Legal difference \(IMPORTANT\): In California, Cal\. Penal Code § 632 requires the consent of everyone/);
  assert.match(moved.reply, /Lawful option: Ask everyone for consent/);
  // A contract upload: terms quoted from the text, flags, nothing invented.
  const text = 'This producer agreement is made by and between Beat Lab LLC and the Artist. Artist assigns all right, title and interest in the master recordings to Beat Lab LLC. Beat Lab LLC shall pay Artist $500. This agreement shall be governed by the laws of the State of New York.';
  const up = await che.say('Check this contract', { attachment: { name: 'producer-agreement.txt', media_type: 'text/plain', base64: Buffer.from(text).toString('base64') } });
  assert.equal(up.route, 'che_legal');
  assert.match(up.reply, /HIGH RISK: Assignment of all right, title and interest/);
  assert.match(up.reply, /Not found in the text: .*Termination/);
  const stored = await che.get('/api/legal');
  assert.equal(stored.contracts[0].name, 'producer-agreement.txt');
  assert.ok(stored.coverage.find((c) => c.id === 'us-la-new-orleans').status === 'NOT YET INDEXED');
  // Sell a beat exclusively: Music, Business and Legal answer together.
  await che.say('Add a beat called Smoke, basic lease $30, exclusive $500');
  await che.say('Sold a basic lease of Smoke to Mike, payment cs_1');
  assert.equal((await che.say('Sell Smoke exclusively')).route, 'held', 'an instruction to sell is a money action: it waits for the owner');
  const ex = await che.say('Can I sell Smoke exclusively?');
  assert.equal(ex.route, 'che_music_business');
  assert.match(ex.reply, /Smoke is not ready for an exclusive sale at \$500\.00\. Legal: 1 lease is already sold \(Mike\)/);
  assert.notEqual((await che.say('Can I trade NQ now?')).route, 'che_legal');
});

test('Expert Intelligence by voice: emergencies first, a private case, a Doctor Brief, a note kept verbatim, a measured test', async () => {
  const che = await owner();
  const urgent = await che.say('My dad has chest pain and shortness of breath right now');
  assert.equal(urgent.route, 'che_health_urgent');
  assert.equal(urgent.modelCalls, 0);
  assert.match(urgent.reply, /^Chest pain with these symptoms can be a heart attack\. Call 911 now\./);
  assert.match((await che.say("Prepare me for my doctor's appointment")).reply, /There is no medical case on file yet/);
  assert.match((await che.say('Open a medical case called Back and leg')).reply, /private and kept apart/);
  const brief = await che.say("Prepare me for my doctor's appointment");
  assert.equal(brief.route, 'che_expert');
  assert.match(brief.reply, /DOCTOR BRIEF: Back and leg[\s\S]*Missing from the file: reason for visit/);
  assert.match((await che.say('My doctor said ordered an MRI of the lumbar spine')).reply, /Saved your doctor note word for word\. I added: ordered an MRI of the lumbar spine/);
  const exam = await che.say('Test your legal knowledge');
  assert.match(exam.reply, /Law test: 8 of 8 passed \(100%\)\. A test score is evidence of what I do, not a licence/);
  assert.match((await che.say('How good are you at law?')).reply, /Latest test: 8 of 8 passed/);
  const view = await che.get('/api/expert');
  assert.equal(view.cases[0].title, 'Back and leg');
  assert.ok(view.expertise.some((e) => e.domain === 'health' && e.level === 'not built'), 'no health sources yet, so no claim');
});

// ─── Codex review of #458/#459 through /api/chat ────────────────────────────

test('a guest\'s emergency gets the deterministic 911 answer before any model call', async () => {
  const che = await owner();
  const tenant = await che.post('/api/platform/tenants', { name: 'Guest', role: 'family' });
  const invite = await che.post('/api/platform/enrollments', { access: 'private', tenant_id: tenant.body?.tenant?.id });
  const guest = (await (await che.send('/api/enroll', { enrollment_token: invite.body.enrollment.token, device_name: 'guest' })).json()).device_token;
  const before = che.inputs.length;
  const raw = await (await che.send('/api/chat', { message: 'My dad has chest pain and shortness of breath right now', history: [] }, guest)).text();
  assert.match(replyFromNdjson(raw), /^Chest pain with these symptoms can be a heart attack\. Call 911 now\./);
  assert.match(raw, /"source":"che_health_urgent"/);
  assert.equal(che.inputs.length, before, 'no model call');
});

test('location alerts compare only what the owner records show he does: no recording alert out of nowhere', async () => {
  const che = await owner();
  await che.say('My home state is Louisiana');
  await che.say('Turn on location legal alerts');
  assert.match((await che.say("I'm in California now, is there anything relevant that changed?")).reply, /Nothing I have indexed for what you're doing changes in California/);
  await che.say("Can I record a call I'm on here?");
  assert.match((await che.say("I'm in California now, is there anything relevant that changed?")).reply, /Cal\. Penal Code § 632/);
});

// ChatGPT live iPhone report (2026-10-22): the single follow-up word "Collectively" came back as only "Stopped.".
// The phone side is scoped per request (4001b2d, test/che_stop_state_test.dart); no Worker command reads it as a stop.
test('"Collectively" is an ordinary follow-up: no command, no stop, and the conversation continues', () => {
  const history = [{ role: 'user', content: 'What do these three studies say?' }, { role: 'assistant', content: 'Each one finds a small effect.' }];
  for (const words of ['Collectively', 'Collectively?', 'collectively, what do they show?']) {
    assert.equal(readCommandSpeech(words, history), null, words);
    assert.equal(parseSlashCommand(words), null, words);
    assert.equal(commandFromWords(words), null, words);
  }
});

test('Signal Mode: /trade-setups and plain questions open the Setup Progress Board on the chart route, with no model and no order', async () => {
  const c = commandById('trade-setups');
  assert.equal(c.route, 'che_trading_chart');
  assert.equal(c.confirm, '');
  const che = await owner();
  for (const [said, answer] of [['/trade-setups', undefined], ['Show setups', undefined], ['CHE, show the setup progress board', undefined], ['What setups are ready?', 'ready'], ['Which setups are near entry right now?', 'ready']]) {
    const out = await che.say(said);
    assert.equal(out.route, 'che_trading_chart', said);
    assert.equal(out.modelCalls, 0, said);
    assert.equal(out.done.open_view, 'trading_chart', said);
    assert.equal(out.done.chart.section, 'setups', said);
    assert.equal(out.done.chart.answer, answer, said);
    assert.equal(out.done.order_sent, undefined, said);
  }
  assert.notEqual((await che.say('Find setups on MNQ')).done?.chart?.section, 'setups', 'the learned-strategy analysis keeps its own command');
});

test('Security Room: /security-access and /security-findings open Security on the right list, with no model and no secret', async () => {
  for (const id of ['security-access', 'security-findings']) {
    const c = commandById(id);
    assert.equal(c.route, 'che_security', id);
    assert.equal(c.confirm, '', id);
  }
  const che = await owner();
  for (const [said, section] of [['/security-access', 'agents'], ['Open security access', 'agents'], ['Who has access to CHE?', 'agents'], ['/security-findings', 'threats'], ['Show security findings', 'threats']]) {
    const out = await che.say(said);
    assert.equal(out.route, 'che_security', said);
    assert.equal(out.modelCalls, 0, said);
    assert.equal(out.done.open_screen, 'security', said);
    assert.equal(out.done.security_section, section, said);
    assert.match(out.reply, /not an all-clear|every check ran|not checked|not visible/, `${said}: coverage is stated`);
  }
});

test('Security Chief: "have Knox check security" runs the real checks through CHE; sentences that only mention Knox are not caught', async () => {
  const c = commandById('security-chief');
  assert.equal(c.route, 'che_security');
  const che = await owner();
  for (const said of ['/security-chief', 'CHE, have Knox check security', 'Ask Knox to run a security check', 'Knox, check security']) {
    const out = await che.say(said);
    assert.equal(out.route, 'che_security', said);
    assert.equal(out.modelCalls, 0, said);
    assert.equal(out.done.security_action, 'chief_check', said);
    assert.equal(out.done.security_chief, 'Knox', said);
    assert.match(out.reply, /^Knox ran the security check at \d{4}-\d\d-\d\d \d\d:\d\d UTC, sir\./, said);
    assert.match(out.reply, /Checked: threat and access check/, said);
    assert.match(out.reply, /Not checked: .*dependency advisories/, `${said}: an unrun check says not checked`);
  }
  const core = await che.get('/api/security/core');
  assert.ok(core.chief.recent_verified_activity.some((a) => a.kind === 'check'), 'the check is in Knox\'s verified activity');
  for (const said of ['Knox fixed the bug', 'Have Knox check the website', 'What did Knox say about security?', "Knox's notes on security", 'check security of my website with my brother']) {
    const out = await che.say(said);
    assert.notEqual(out.done.security_action, 'chief_check', said);
  }
});
