import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { resetRouterForTests, routeText } from './ai_router.js';
import {
  BUILTIN_PROVIDER_MANIFESTS, accountsView, approveProviderPlugin, ensureAiState, normalizeModelRecord,
  proposeProviderPlugin, providerConnection, registryView, validateProviderManifest,
} from './provider_registry.js';
import {
  applyEvaluation, discoverModels, evaluateCandidate, registerDiscovered, runModelWatcher,
} from './model_discovery.js';
import { inferNeeds, orderByCapability, recordHealth, shouldCrossCheck } from './capability_router.js';
import {
  assembleKnowledgeBundle, classifyItem, extractCandidateMemories, fineTuneDisclosure,
  personalizationPlan, providerMayReceive, setProviderPermission,
} from './privacy_policy.js';
import {
  createAgent, handoffAgentTask, normalizeAgent, queueAgentTask, routingForAgent, teachOfficeSkill,
} from './agent_runtime.js';
import { createProviderEmployee, startPairedJob, taskEnvelope } from './office_workforce.js';
import { handleAiVoiceIntent } from './ai_layer.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function memoryStorage() {
  const saved = new Map();
  return {
    saved,
    get: async (key) => saved.get(key),
    put: async (key, value) => { saved.set(key, value); },
  };
}

function emptyData() {
  return { team: [], team_tasks: [], meetings: [], office_skills: [], memories: [] };
}

const chatReply = (text) => jsonResponse({ choices: [{ message: { content: text } }], usage: { total_tokens: 10 } });

test('provider registry normalizes providers and models', () => {
  const data = emptyData();
  const view = registryView({ XAI_API_KEY: 'xai-secret-value', AI: {} }, data);
  const xai = view.find((item) => item.id === 'xai');
  assert.equal(xai.state, 'connected');
  assert.ok(xai.capabilities.includes('deep_reasoning'));
  assert.equal(view.find((item) => item.id === 'openai').state, 'available_to_connect');
  assert.equal(view.find((item) => item.id === 'cloudflare').state, 'connected');
  const record = normalizeModelRecord(BUILTIN_PROVIDER_MANIFESTS.find((m) => m.id === 'xai'), { id: 'grok-code-fast-9', context_window: 256000 });
  assert.equal(record.key, 'xai:grok-code-fast-9');
  assert.ok(record.capabilities.includes('coding'));
  assert.ok(record.capabilities.includes('long_context'));
  for (const field of ['cost_class', 'latency_class', 'context_tokens', 'locality', 'privacy']) assert.ok(field in record);
});

test('xAI model discovery registers new models as candidates', async () => {
  const data = emptyData();
  const env = { XAI_API_KEY: 'xai-test' };
  const manifest = BUILTIN_PROVIDER_MANIFESTS.find((m) => m.id === 'xai');
  let catalog = [{ id: 'grok-4.3' }, { id: 'grok-4.7' }];
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    return jsonResponse({ data: catalog });
  };
  const first = await discoverModels(env, data, manifest, fetcher);
  assert.equal(first.status, 'ok');
  assert.equal(calls[0].url, 'https://api.x.ai/v1/models');
  assert.equal(calls[0].auth, 'Bearer xai-test');
  assert.deepEqual(registerDiscovered(data, first), []);
  catalog = [...catalog, { id: 'grok-5' }];
  const fresh = registerDiscovered(data, await discoverModels(env, data, manifest, fetcher));
  assert.equal(fresh.length, 1);
  const ai = ensureAiState(data);
  assert.equal(ai.candidates[0].key, 'xai:grok-5');
  assert.equal(ai.candidates[0].status, 'candidate');
});

test('model watcher skips unconnected providers and respects its interval', async () => {
  const data = emptyData();
  const urls = [];
  const fetcher = async (url) => { urls.push(url); return jsonResponse({ data: [{ id: 'm1' }] }); };
  const result = await runModelWatcher({ XAI_API_KEY: 'k' }, data, { fetcher, now: 1_000_000_000_000 });
  assert.equal(result.status, 'ran');
  assert.ok(urls.every((url) => url.startsWith('https://api.x.ai')));
  assert.ok(result.available_to_connect.some((item) => item.id === 'openai'));
  const again = await runModelWatcher({ XAI_API_KEY: 'k' }, data, { fetcher, now: 1_000_000_000_000 + 60_000 });
  assert.equal(again.status, 'skipped');
});

test('candidate evaluation stores results and promotes only within policy', async () => {
  const data = emptyData();
  const ai = ensureAiState(data);
  ai.catalog.xai = { models: [{ model: 'grok-5', status: 'candidate', cost_class: 'medium' }], synced_at: 'x' };
  ai.candidates.push({ key: 'xai:grok-5', provider: 'xai', model: 'grok-5', status: 'candidate' });
  const good = async (_c, prompt) => {
    if (/train/.test(prompt)) return '6:15 PM';
    if (/add/.test(prompt)) return 'function add(a, b) { return a + b; }';
    if (/HORIZON/.test(prompt)) return 'HORIZON';
    return 'amber-47';
  };
  const evaluation = await evaluateCandidate(ai.candidates[0], good);
  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.score, 1);
  ai.policy.max_cost_class = 'low';
  let applied = applyEvaluation({ XAI_API_KEY: 'k' }, data, evaluation);
  assert.equal(applied.decision.promote, false);
  ai.policy.max_cost_class = 'high';
  applied = applyEvaluation({ XAI_API_KEY: 'k' }, data, evaluation);
  assert.equal(applied.decision.promote, true);
  assert.equal(ai.catalog.xai.models[0].status, 'active');
  assert.ok(ai.catalog.xai.models[0].trial_until > Date.now());
  assert.equal(ai.evaluations[0].key, 'xai:grok-5');
  const bad = await evaluateCandidate({ key: 'x:y', provider: 'x', model: 'y' }, async () => 'nope');
  assert.equal(bad.passed, false);
});

test('capability routing picks by need, not fixed order', async () => {
  resetRouterForTests();
  const env = { CHE_OPENAI_API_KEY: 'o', XAI_API_KEY: 'x', GROQ_API_KEY: 'g', CHE_DISABLE_KEYLESS_AI: '1' };
  const hits = [];
  const fetcher = async (url, init) => { hits.push({ url, model: JSON.parse(init.body).model }); return chatReply('ok'); };
  const coding = await routeText(env, '@cf/x', {
    che_capability: 'coding', che_strongest: true, messages: [{ role: 'user', content: 'Implement a parser' }],
  }, fetcher);
  assert.ok(['openai', 'xai'].includes(coding.engine));
  const casual = await routeText({ ...env }, '@cf/x', { messages: [{ role: 'user', content: 'hey' }] }, fetcher);
  assert.equal(casual.engine, 'groq');
  const needs = inferNeeds({ messages: [{ role: 'user', content: 'debug this stack trace in my Dart code' }] });
  assert.equal(needs.capability, 'coding');
  const ordered = orderByCapability([{ id: 'cloudflare' }, { id: 'xai' }, { id: 'groq' }], { capability: 'image_generation' });
  assert.deepEqual(ordered.map((p) => p.id).sort(), ['cloudflare', 'xai']);
});

test('provider pinning routes to Grok and local-only never leaves local', async () => {
  resetRouterForTests();
  const env = { CHE_OPENAI_API_KEY: 'o', XAI_API_KEY: 'x', CHE_DISABLE_KEYLESS_AI: '1' };
  const urls = [];
  const fetcher = async (url) => { urls.push(url); return chatReply('done'); };
  const pinned = await routeText(env, '@cf/x', { che_provider: 'xai', che_model: 'grok-5', messages: [{ role: 'user', content: 'Plan the launch' }] }, fetcher);
  assert.equal(pinned.engine, 'xai');
  assert.equal(pinned.model, 'grok-5');
  await assert.rejects(
    routeText(env, '@cf/x', { che_local_only: true, messages: [{ role: 'user', content: 'private question' }] }, fetcher),
    /Local-only mode/,
  );
  const local = await routeText({ ...env, CHE_OLLAMA_URL: 'https://llm.home.example' }, '@cf/x',
    { che_local_only: true, messages: [{ role: 'user', content: 'private question' }] }, fetcher);
  assert.equal(local.engine, 'ollama');
  assert.equal(urls.at(-1), 'https://llm.home.example/v1/chat/completions');
});

test('provider health failover reroutes around an unhealthy provider', async () => {
  resetRouterForTests();
  const storage = memoryStorage();
  const env = { CHE_OPENAI_API_KEY: 'o', XAI_API_KEY: 'x', CHE_DISABLE_KEYLESS_AI: '1' };
  const fetcher = async (url) => (url.includes('openai.com')
    ? jsonResponse({ error: { message: 'down' } }, 500)
    : chatReply('grok ok'));
  const out = await routeText(env, '@cf/x', { che_route: 'quality', messages: [{ role: 'user', content: 'Analyze this plan carefully' }] }, fetcher, storage);
  assert.equal(out.engine, 'xai');
  const health = storage.saved.get('ai_health');
  assert.ok(health.openai.failure >= 1);
  assert.ok(health.xai.success >= 1);
  const h = {};
  for (let i = 0; i < 4; i += 1) recordHealth(h, 'openai', { ok: false, status: 429 });
  const order = orderByCapability([{ id: 'openai' }, { id: 'xai' }], { capability: 'deep_reasoning', difficulty: 'hard' }, h);
  assert.equal(order[0].id, 'xai');
});

test('privacy data classes filter context per provider and audit omits secrets', async () => {
  resetRouterForTests();
  const data = emptyData();
  assert.equal(classifyItem({ content: 'My bank account balance is 4000' }), 'financial');
  assert.equal(classifyItem({ content: 'the API key is sk-abc' }), 'secret');
  assert.equal(providerMayReceive(data, 'ollama', 'financial'), true);
  assert.equal(providerMayReceive(data, 'gemini', 'personal'), false);
  assert.equal(providerMayReceive(data, 'ollama', 'secret'), false);
  const denied = setProviderPermission(data, 'openai', { deny: ['personal'] }, false);
  assert.ok(denied.error);
  setProviderPermission(data, 'openai', { deny: ['personal'] }, true);
  assert.equal(providerMayReceive(data, 'openai', 'personal'), false);

  const storage = memoryStorage();
  const sent = [];
  const fetcher = async (_url, init) => { sent.push(init.body); return chatReply('ok'); };
  await routeText({ GEMINI_API_KEY: 'AIzaSECRETSECRETSECRET123', CHE_DISABLE_KEYLESS_AI: '1' }, '@cf/x', {
    che_route: 'quality',
    che_context: { items: [
      { id: 'm1', section: 'projects', data_class: 'personal', text: 'Owner project Aurora launch plan' },
      { id: 'm2', section: 'knowledge', data_class: 'public', text: 'Public fact about Chicago' },
    ] },
    che_audit: { task: 'question with token sk-abcdefghijklmnop', agent: 'CHE', route: 'owner_chat' },
    messages: [{ role: 'user', content: 'Tell me about the plan' }],
  }, fetcher, storage);
  assert.ok(!sent[0].includes('Aurora'), 'Gemini must not receive personal context by default');
  assert.ok(sent[0].includes('Chicago'));
  const audit = storage.saved.get('ai_audit')[0];
  assert.equal(audit.provider, 'gemini');
  assert.deepEqual(audit.memory_ids, ['m2']);
  assert.deepEqual(audit.withheld_classes, ['personal']);
  assert.ok(!JSON.stringify(audit).includes('sk-abcdefghijklmnop'));
  assert.ok(!JSON.stringify(audit).includes('AIzaSECRET'));
});

test('knowledge bundle is provider-neutral and minimal', () => {
  const data = emptyData();
  const matches = [
    { id: 'p1', kind: 'projects', content: 'CHE app launch is the owner priority project', similarity: 0.9 },
    { id: 's1', kind: 'vault', content: 'password for bank is hunter2', similarity: 0.9 },
  ];
  const openai = assembleKnowledgeBundle({ data, providerId: 'openai', task: 'launch project status', vectorMatches: matches });
  const gemini = assembleKnowledgeBundle({ data, providerId: 'gemini', task: 'launch project status', vectorMatches: matches });
  assert.deepEqual(Object.keys(openai.sections), Object.keys(gemini.sections));
  assert.equal(openai.provided.length, 1);
  assert.equal(gemini.provided.length, 0);
  assert.ok(openai.withheld.some((item) => item.data_class === 'secret'));
});

test('provider secrets are never returned to the app', async () => {
  const generated = new URL('./.ai.test.generated.mjs', import.meta.url);
  writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
    "import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  ));
  let mod;
  try { mod = await import(`${generated.href}?t=${Date.now()}`); } finally { unlinkSync(generated); }
  const saved = new Map();
  const env = {
    CHE_PAIR_CODE: '123456',
    XAI_API_KEY: 'xai-SUPERSECRETVALUE123',
    CHE_OPENAI_API_KEY: 'sk-SUPERSECRETVALUE456',
    AI: { run: async () => ({ response: 'ok' }) },
  };
  const state = new mod.CheState({ storage: { get: (k) => saved.get(k), put: (k, v) => saved.set(k, v), setAlarm: async () => {} } }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, method = 'GET', body = {}, token = '') => mod.default.fetch(new Request(`https://che.example${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await send('/api/pair', 'POST', { code: '123456' })).json()).device_token;
  for (const path of ['/api/ai/overview', '/api/ai/accounts', '/api/ai/audit', '/api/state']) {
    const text = await (await send(path, 'GET', {}, token)).text();
    assert.ok(!text.includes('SUPERSECRETVALUE'), `${path} leaked a secret`);
  }
  const overview = await (await send('/api/ai/overview', 'GET', {}, token)).json();
  assert.equal(overview.accounts.find((a) => a.id === 'xai').connected, true);
  assert.equal(overview.accounts.find((a) => a.id === 'anthropic').state, 'available_to_connect');
  const voice = await (await send('/api/chat', 'POST', { message: 'CHE, what AI models do you have?' }, token)).text();
  assert.match(voice, /xAI Grok/);
  assert.ok(!voice.includes('SUPERSECRETVALUE'));
});

test('new provider needs validation and owner authorization before use', () => {
  const data = emptyData();
  assert.ok(validateProviderManifest({ id: 'newai', code: 'rm -rf /' }).errors.length);
  assert.ok(validateProviderManifest({ id: 'newai', auth: { type: 'api_key', secrets: ['NEWAI_API_KEY'] }, api_base: 'http://insecure', capabilities: ['text'] }).errors);
  const proposal = proposeProviderPlugin(data, {
    id: 'newai', name: 'New AI', auth: { type: 'api_key', secrets: ['NEWAI_API_KEY'] },
    api_base: 'https://api.newai.example/v1', capabilities: ['text', 'coding'], discovery: { method: 'openai_models' },
  });
  assert.equal(proposal.pending.status, 'pending_owner_review');
  assert.ok(approveProviderPlugin(data, proposal.pending.id, false).error);
  const installed = approveProviderPlugin(data, proposal.pending.id, true).installed;
  assert.deepEqual(installed.privacy.default_data_classes, ['public']);
  const env = { NEWAI_API_KEY: 'k' };
  assert.equal(providerConnection(env, data, installed).state, 'awaiting_owner_authorization');
  assert.equal(accountsView({}, data).find((a) => a.id === 'newai').state, 'available_to_connect');
});

test('Grok-backed employee, OpenAI/xAI handoff and provider-neutral envelope', () => {
  const data = emptyData();
  const env = { XAI_API_KEY: 'x', CHE_OPENAI_API_KEY: 'o' };
  assert.ok(createProviderEmployee({}, data, { provider: 'xai', specialty: 'coding' }).error);
  const grok = createProviderEmployee(env, data, { provider: 'xai', specialty: 'coding' }).agent;
  assert.equal(grok.role, 'Grok Coding Specialist');
  assert.equal(grok.provider_preference, 'xai');
  assert.deepEqual(grok.capability_requirements, ['coding']);
  for (const field of ['id', 'role', 'workspace', 'memory_refs', 'skill_ids', 'permissions', 'handoff_history']) assert.ok(field in grok);
  const gpt = createProviderEmployee(env, data, { provider: 'openai', specialty: 'research' }).agent;
  const task = queueAgentTask(data, gpt, 'Research the market', 'owner', {
    context_items: [{ id: 'm1', section: 'projects', data_class: 'personal', text: 'Aurora project' }],
  });
  task.result = 'Draft research findings';
  task.review_feedback = 'Add sources';
  task.steering.push({ text: 'Focus on Chicago', at: 'now' });
  task.citations.push('https://example.com/source');
  task.provider_trail.push({ provider: 'openai', model: 'gpt-x' });
  const moved = handoffAgentTask(data, task.id, grok.id, 'Implement it');
  assert.equal(moved.task.partner_id, grok.id);
  const handoff = moved.task.handoffs.at(-1);
  assert.equal(handoff.from_provider, 'openai');
  assert.equal(handoff.to_provider, 'xai');
  const envelope = taskEnvelope(moved.task);
  assert.equal(envelope.prior_result, 'Draft research findings');
  assert.equal(envelope.review_feedback, 'Add sources');
  assert.deepEqual(envelope.steering, ['Focus on Chicago']);
  assert.deepEqual(envelope.citations, ['https://example.com/source']);
  assert.equal(envelope.context_items[0].id, 'm1');
  // pgvector context survives the handoff and is re-filtered for the new provider.
  const routing = routingForAgent(grok, data, moved.task);
  assert.equal(routing.che_provider, 'xai');
  assert.equal(routing.che_context.items[0].id, 'm1');
  assert.equal(grok.handoff_history.length, 1);
});

test('cross-provider handoff executes on the new provider with context', async () => {
  resetRouterForTests();
  const data = emptyData();
  const env = { XAI_API_KEY: 'x', CHE_OPENAI_API_KEY: 'o', CHE_DISABLE_KEYLESS_AI: '1' };
  const grok = createProviderEmployee(env, data, { provider: 'xai', specialty: 'coding' }).agent;
  const task = queueAgentTask(data, grok, 'Build it', 'owner', {
    context_items: [{ id: 'm9', section: 'projects', data_class: 'personal', text: 'Project Aurora uses Flutter' }],
  });
  const bodies = [];
  const out = await routeText(env, '@cf/x', {
    ...routingForAgent(grok, data, task),
    messages: [{ role: 'user', content: task.task }],
  }, async (url, init) => { bodies.push({ url, body: init.body }); return chatReply('built'); });
  assert.equal(out.engine, 'xai');
  assert.ok(bodies[0].url.includes('x.ai'));
  assert.ok(bodies[0].body.includes('Project Aurora uses Flutter'));
});

test('paired intelligence staffs multiple provider families', () => {
  const data = emptyData();
  const env = { XAI_API_KEY: 'x', CHE_OPENAI_API_KEY: 'o' };
  const started = startPairedJob(env, data, { objective: 'Compare two launch strategies', families: ['openai', 'xai'] });
  assert.ok(started.meeting);
  const roles = data.team.map((a) => a.role);
  assert.ok(roles.includes('OpenAI Researcher'));
  assert.ok(roles.includes('Grok Researcher'));
  assert.ok(data.team.every((a) => a.temporary));
  assert.ok(startPairedJob({ XAI_API_KEY: 'x' }, emptyData(), { objective: 'x', families: ['openai', 'xai'] }).error);
  assert.equal(shouldCrossCheck({ difficulty: 'trivial' }, {}, 3), false);
  assert.equal(shouldCrossCheck({ difficulty: 'hard' }, {}, 3), true);
});

test('skills stay provider-neutral and reuse across providers', () => {
  const data = emptyData();
  const skill = teachOfficeSkill(data, {
    name: 'Research company',
    trigger: 'research company',
    steps: ['Always use Grok model for the search', 'Summarize findings with sources'],
  }).skill;
  assert.ok(!/grok/i.test(skill.steps[0]));
  assert.equal(skill.provider_neutral, true);
  assert.ok(skill.capabilities.includes('deep_reasoning'));
  const a = normalizeAgent(createAgent(data, { role: 'OpenAI Researcher', provider_preference: 'openai' }).agent);
  const b = normalizeAgent(createAgent(data, { role: 'Grok Researcher', provider_preference: 'xai' }).agent);
  assert.equal(routingForAgent(a, data).che_provider, 'openai');
  assert.equal(routingForAgent(b, data).che_provider, 'xai');
});

test('RAG stays the personal lane; fine-tuning discloses and needs approval', () => {
  assert.equal(personalizationPlan().default_lane, 'rag');
  const plan = personalizationPlan({ wantsDeeperPersonalization: true, localTrainingAvailable: true });
  assert.equal(plan.fine_tuning.requires_owner_approval, true);
  const disclosure = fineTuneDisclosure({ examples: [{ prompt: 'my password is x', completion: 'ok' }], base_model: 'llama' }, 'vmware');
  assert.equal(disclosure.contains_secrets, true);
  assert.equal(disclosure.destination, 'vmware');
  assert.equal(disclosure.record_count, 1);
  const memories = extractCandidateMemories('Answer\n```che-remember\n[Projects] Owner is launching Aurora\n[Knowledge] api key sk-123\n```', { provider: 'xai' });
  assert.equal(memories.length, 1);
  assert.equal(memories[0].status, 'candidate');
});

test('voice intents confirm consequential permissions aloud', async () => {
  const data = emptyData();
  const storage = memoryStorage();
  const env = { GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' };
  setProviderPermission(data, 'gemini', { allow: ['personal'] }, true);
  const ask = await handleAiVoiceIntent(env, data, storage, "Don't send my personal memories to Gemini");
  assert.match(ask.reply, /To confirm/);
  assert.equal(providerMayReceive(data, 'gemini', 'personal'), true);
  const done = await handleAiVoiceIntent(env, data, storage, 'yes');
  assert.match(done.reply, /Done/);
  assert.equal(providerMayReceive(data, 'gemini', 'personal'), false);
  const hire = await handleAiVoiceIntent(env, data, storage, 'Make a Grok coding employee');
  assert.match(hire.reply, /Grok Coding Specialist/);
  const local = await handleAiVoiceIntent(env, data, storage, 'Use only local AI for this');
  assert.match(local.reply, /no local model is connected/);
  const strongest = await handleAiVoiceIntent(env, data, storage, 'Use the strongest model available');
  assert.equal(storage.saved.get('ai_routing').policy.prefer_strongest, true);
  assert.match(strongest.reply, /strongest/);
  assert.equal(await handleAiVoiceIntent(env, data, storage, 'What is the weather like'), null);
});

test('free agents join the owner in the Theater; working agents keep working', async () => {
  const { agentLocation } = await import('./agent_runtime.js');
  const now = Date.now();
  assert.equal(agentLocation({ id: 'a', runtime_status: 'idle' }, now, now + 1000).room, 'theater');
  assert.equal(agentLocation({ id: 'a', runtime_status: 'building', runtime_task: 'paint a portrait' }, now, now + 1000).room, 'gallery');
  assert.equal(agentLocation({ id: 'a', runtime_status: 'building', runtime_task: 'DJ my playlist' }, now).activity, 'djing');
  assert.notEqual(agentLocation({ id: 'a', runtime_status: 'idle' }, now, now - 1).room, 'theater');
});

test('Theater notes give CHE the relevant movie dialogue', async () => {
  const generated = new URL('./.theater.test.generated.mjs', import.meta.url);
  writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
    "import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  ));
  let mod;
  try { mod = await import(`${generated.href}?t=${Date.now()}`); } finally { unlinkSync(generated); }
  const notes = { title: 'Heist Night', lines: [{ t: 65, text: 'Meet me at the diner at midnight.' }, { t: 3700, text: 'The vault code is in the painting.' }] };
  const ctx = mod.theaterNotesContext(notes, 'What did he say about the diner in the movie?');
  assert.match(ctx, /\[01:05\] Meet me at the diner/);
  assert.match(ctx, /not the picture/);
  assert.equal(mod.theaterNotesContext(notes, 'what is the weather'), '');
});
