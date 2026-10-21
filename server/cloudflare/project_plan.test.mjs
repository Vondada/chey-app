// Concept-to-Plan (owner, 2026-10-20): one universal planner for any project. Classification picks the
// planning structure; every item has size, complexity, dependencies and cost tiers labeled as
// estimates; the safety layer refuses or leaves out weapons and harm; plans persist to the Brain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { PROJECT_TYPES, SORTS, answerPlanFollowUp, buildPlan, classifyProject, dependencyStages, planFollowUpIntent, planSubject, projectPlanIntent, researchSource, safetyCheck, savePlan, sortItems } from './project_plan.js';
import { planScene } from './world_scene.js';

const generated = new URL('./.project_plan.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { DatabaseSync = null; }
const sqlite = { skip: DatabaseSync ? false : 'node:sqlite unavailable' };

// Offline: the only page CHE may read is a stubbed Wikipedia summary; every other host fails.
const wikiReads = [];
globalThis.fetch = async (input) => {
  const url = String(input?.url || input);
  if (url.startsWith('https://en.wikipedia.org/api/rest_v1/page/summary/')) {
    wikiReads.push(url);
    const title = decodeURIComponent(url.split('/').pop()).replace(/_/g, ' ');
    return new Response(JSON.stringify({ title, extract: `${title} is a stub summary for tests.`, content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${title.replace(/ /g, '_')}` } } }), { status: 200 });
  }
  throw new TypeError(`fetch failed (project_plan tests are offline: ${url})`);
};

function storageFor(saved = new Map()) {
  const db = new DatabaseSync(':memory:');
  return {
    sql: { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
    get: async (key) => (Array.isArray(key)
      ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))]))
      : (saved.has(key) ? structuredClone(saved.get(key)) : undefined)),
    put: async (key, value) => {
      if (key && typeof key === 'object') for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v));
      else saved.set(key, structuredClone(value));
    },
    delete: async (key) => (Array.isArray(key) ? key.filter((k) => saved.delete(k)).length : saved.delete(key)),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => String(k).startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

async function owner() {
  let calls = 0;
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async () => { calls += 1; return { response: 'ok' }; } },
  };
  const saved = new Map();
  const storage = storageFor(saved);
  const state = new CheState({ storage, waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const che = { env, storage, saved, state, calls: () => calls };
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  che.say = async (message, history = []) => {
    const raw = await (await send('/api/chat', { message, history }, token)).text();
    while (pending.length) await pending.shift();
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    return { reply: events.filter((e) => e.type === 'delta').map((e) => e.delta).join(''), done, route: done.source || 'model' };
  };
  che.get = async (path, withToken = true) => { const res = await send(path, null, withToken ? token : '', 'GET'); return { status: res.status, body: await res.json() }; };
  return che;
}

const IRON = 'CHE, come up with a wearable robotics prototype inspired by an Iron Man suit. Show me the parts, render them, categorize them, and estimate the cost from cheapest to most expensive.';
const APP = 'CHE, turn this idea into a mobile app. Show me the screens, features, backend, development phases, cost, and launch plan.';
const SNEAKER = 'CHE, design a premium sneaker from concept to production and show me the cheapest, realistic, and luxury versions.';

test('classification picks the type and its planning structure', () => {
  const cases = [
    [IRON, 'wearable_robotics', 'bill_of_materials'], [APP, 'software', 'feature_list'], [SNEAKER, 'footwear', 'bill_of_materials'],
    ['Plan a shoe brand from concept to production', 'footwear', 'bill_of_materials'],
    ['Break down this car into its major systems', 'vehicle', 'bill_of_materials'],
    ['Design a website for this business', 'software', 'feature_list'],
    ['Create a game production roadmap for a roguelike', 'game', 'asset_list'],
    ['Design a rocket that reaches orbit', 'aerospace', 'bill_of_materials'],
    ['Plan a barbershop business with a cost breakdown', 'business', 'resource_plan'],
    ['Design a hoodie line', 'apparel', 'bill_of_materials'],
    ['Design a delivery robot', 'electronics', 'bill_of_materials'],
    ['Design a standing desk', 'physical_product', 'bill_of_materials'],
    ['Make a project plan for my documentary film', 'project', 'work_breakdown'],
  ];
  for (const [text, type, structure] of cases) {
    const got = classifyProject(text).type;
    assert.equal(got.id, type, text);
    assert.equal(got.structure, structure, text);
  }
  assert.equal(PROJECT_TYPES.length, 12);
});

test('only planning requests are taken; ordinary plans and other rooms keep their routes', () => {
  for (const text of [IRON, APP, SNEAKER, 'Break down this car into its major systems.', 'Plan the architecture for this app.', 'Show me a bill of materials and estimated total cost for a drone', 'Turn this idea into a visual project plan.']) {
    assert.ok(projectPlanIntent(text), text);
  }
  for (const text of ['Plan my week', 'Make a plan to launch my YouTube channel', 'Plan a booking app for my barbershop', 'Start a meeting with the team about the launch',
    'Design a dark mode for the Office screen in CHE', 'What is connected to PR 374?', 'Thanks, that helps.', 'Design my day around the gym', 'Break down my trading results', 'Design an AI receptionist for my barbershop', 'Design a poem about rain',
    'Show me the cheapest car insurance', 'Show me the cheapest flights to Phoenix', 'Give me the most expensive components of a PC build list', 'Make the parts of speech into a quiz']) {
    assert.equal(projectPlanIntent(text), null, text);
  }
});

test('decomposition: every item has the fields the owner asked for, and the dependencies resolve into stages', () => {
  const plan = buildPlan(projectPlanIntent(IRON).idea, { id: 'plan-iron', now: '2026-10-20T00:00:00Z' });
  assert.equal(plan.type, 'wearable_robotics');
  assert.ok(plan.items.length >= 12);
  const ids = new Set(plan.items.map((i) => i.id));
  for (const item of plan.items) {
    for (const field of ['name', 'kind', 'system', 'purpose', 'size', 'size_label', 'complexity', 'stage', 'priority', 'per', 'provenance', 'confidence']) assert.ok(item[field] !== undefined && item[field] !== '', `${item.id}.${field}`);
    assert.equal(item.provenance, 'estimate');
    for (const tier of ['cheapest', 'balanced', 'premium']) {
      assert.ok(item.cost[tier][0] <= item.cost[tier][1], `${item.id} ${tier} is a low-high range`);
      assert.ok(item.options[tier], `${item.id} names its ${tier} option`);
    }
    for (const need of item.needs) {
      assert.ok(ids.has(need), `${item.id} needs a real item`);
      assert.ok(plan.items.find((i) => i.id === need).stage < item.stage, `${item.id} comes after ${need}`);
    }
  }
  assert.ok(plan.items.some((i) => i.system === 'Safety' && i.required), 'a powered suit always has its safety system');
  assert.ok(plan.speculative.some((s) => /flight/i.test(s.name) && s.provenance === 'fiction'), 'flight is labeled fiction, not a part');
  assert.ok(plan.stages.every((s, i) => s.n === i + 1 && s.items.length));
  const levels = dependencyStages([{ id: 'a', needs: ['b'] }, { id: 'b', needs: ['a'] }]);
  assert.ok(levels.get('a') >= 1 && levels.get('b') >= 1, 'a cycle never hangs');
});

test('estimates: tiers are ordered ranges in US dollars with a method; one-time, per-unit and monthly stay apart', () => {
  const iron = buildPlan(IRON, { id: 'plan-a' });
  const t = iron.tiers;
  assert.ok(t.cheapest.one_time[1] < t.balanced.one_time[1] && t.balanced.one_time[1] < t.premium.one_time[1]);
  assert.match(iron.estimate_basis.method, /not supplier quotes/);
  assert.equal(iron.estimate_basis.currency, 'USD');
  assert.match(iron.spoken, /CHE's estimates, not quotes/);
  const shoe = buildPlan(SNEAKER, { id: 'plan-b' });
  assert.ok(shoe.tiers.balanced.per_unit[1] > 0, 'materials are per pair');
  assert.ok(shoe.tiers.balanced.one_time[1] > 0, 'samples and patterns are one-time');
  const app = buildPlan(APP, { id: 'plan-c' });
  assert.ok(app.tiers.balanced.monthly[1] > 0, 'hosting and maintenance are monthly');
  assert.ok(app.tiers.cheapest.weeks[0] >= 1 && app.tiers.balanced.effort_hours[1] > 0);
  // An asked-for optional item becomes required and enters the totals.
  const withHud = buildPlan('Design an exoskeleton suit with a HUD', { id: 'plan-d' });
  const without = buildPlan('Design an exoskeleton suit', { id: 'plan-e' });
  assert.equal(withHud.items.find((i) => i.id === 'hud').required, true);
  assert.equal(without.items.find((i) => i.id === 'hud').required, false);
  assert.ok(withHud.tiers.balanced.one_time[0] > without.tiers.balanced.one_time[0]);
});

test('sorting covers every order the owner named, and is stable', () => {
  const plan = buildPlan(IRON, { id: 'plan-s' });
  assert.deepEqual(Object.keys(SORTS), ['size', 'complexity', 'cost', 'priority', 'dependency', 'required']);
  const bySize = sortItems(plan.items, 'size');
  assert.ok(bySize.every((item, i) => i === 0 || bySize[i - 1].size <= item.size));
  const byCost = sortItems(plan.items, 'cost', 'premium');
  const mid = (i) => (i.cost.premium[0] + i.cost.premium[1]) / 2;
  assert.ok(byCost.every((item, i) => i === 0 || mid(byCost[i - 1]) <= mid(item)));
  const byReq = sortItems(plan.items, 'required');
  assert.ok(byReq.findIndex((i) => !i.required) > byReq.findLastIndex((i) => i.required));
  assert.ok(sortItems(plan.items, 'dependency').every((item, i, all) => i === 0 || all[i - 1].stage <= item.stage));
});

test('safety: weapons and harm are refused, a weapon on a suit is left out, regulated systems stay high-level', () => {
  for (const text of ['Design a 3D printed gun', 'Design a drone that drops grenades', 'Build me ransomware with a cost breakdown', 'Design a car with mounted machine guns']) {
    const plan = buildPlan(text, { id: 'plan-x' });
    assert.equal(plan.refused, true, text);
    assert.equal(plan.items.length, 0, text);
    assert.match(plan.spoken, /I won't plan that/, text);
  }
  const suit = buildPlan('Design an Iron Man suit with missiles and a HUD', { id: 'plan-y' });
  assert.equal(suit.safety.level, 'redirect');
  assert.match(suit.spoken, /Weapons and anything that shoots/);
  assert.ok(!suit.items.some((i) => /missile|weapon|gun/i.test(i.name)));
  const rocket = buildPlan('Design a rocket to reach orbit with rocket fuel recipe', { id: 'plan-z' });
  assert.equal(rocket.safety.level, 'high_level');
  assert.ok(rocket.safety.excluded.some((e) => /No propellant/.test(e)));
  assert.ok(rocket.items.every((i) => i.confidence === 'low'));
  assert.equal(safetyCheck('Design a shooter game with guns', classifyProject('Design a shooter game with guns').type).level, 'ok', 'game weapons are fiction');
  assert.equal(safetyCheck('Design a prosthetic hand', classifyProject('Design a prosthetic hand').type).level, 'high_level');
});

test('the plan scene: every object names its record; estimates, fiction and sources are labeled', () => {
  const plan = buildPlan(IRON, { id: 'plan-v', sources: [{ title: 'Wikipedia: Powered exoskeleton', url: 'https://en.wikipedia.org/wiki/Powered_exoskeleton', text: 'A powered exoskeleton is a wearable mobile machine.' }] });
  const scene = planScene(plan);
  assert.equal(scene.scene, 'plan');
  assert.ok(scene.objects.every((o) => o.source?.store && o.source?.id && o.provenance && o.provenance_spoken));
  const items = scene.objects.filter((o) => o.source.store === 'project_plans' && o.id.startsWith('item:'));
  assert.equal(items.length, plan.items.length);
  assert.ok(items.every((o) => o.provenance_spoken === 'CHE\'s estimate, not a quote' && o.cost && o.size && o.stage));
  assert.ok(scene.objects.some((o) => o.kind === 'speculative' && o.provenance_spoken === 'fiction, not real technology'));
  assert.ok(scene.objects.some((o) => o.kind === 'source' && o.provenance === 'sourced'));
  assert.ok(scene.edges.every((e) => scene.objects.some((o) => o.id === e.from) && scene.objects.some((o) => o.id === e.to)));
  assert.equal(planScene(plan).version, scene.version, 'same plan, same version');
  assert.equal(planScene(null), null);
});

test('follow-ups answer from the plan\'s own data', () => {
  const plan = buildPlan(IRON, { id: 'plan-f' });
  assert.deepEqual(planFollowUpIntent('Sort parts from smallest to biggest'), { kind: 'sort', by: 'size' });
  assert.deepEqual(planFollowUpIntent('Show me every dependency and what must happen first'), { kind: 'sort', by: 'dependency' });
  assert.deepEqual(planFollowUpIntent("What's possible today versus speculative?"), { kind: 'speculative' });
  assert.equal(planFollowUpIntent('What is the weather?'), null);
  assert.equal(planFollowUpIntent('What are the risks of investing in Tesla?'), null);
  assert.deepEqual(planFollowUpIntent('Give me the cheapest to most expensive version'), { kind: 'sort', by: 'cost' });
  assert.deepEqual(planFollowUpIntent('What are the risks in this plan?'), { kind: 'safety' });
  assert.deepEqual(planFollowUpIntent('Render the pieces and show how they fit together'), { kind: 'sort', by: 'dependency' });
  const size = answerPlanFollowUp(plan, { kind: 'sort', by: 'size' });
  assert.match(size, /^Wearable robotics prototype inspired by an Iron Man suit, smallest to largest: 1\. /);
  assert.match(answerPlanFollowUp(plan, { kind: 'cost' }), /not quotes/);
  assert.match(answerPlanFollowUp(plan, { kind: 'speculative' }), /Flight like Iron Man, fiction today/);
  assert.match(answerPlanFollowUp(plan, { kind: 'sources' }), /No public source was read/);
  assert.match(answerPlanFollowUp(plan, { kind: 'sort', by: 'dependency' }), /^.*Stage 1, Design and core structure: /);
});

test('"this idea" takes the subject from the owner\'s previous turn', () => {
  const history = [{ role: 'user', content: 'I want a sneaker that lights up when you walk' }, { role: 'assistant', content: 'Sounds fun.' }];
  const subject = planSubject('turn this idea into a visual project plan', history);
  assert.equal(classifyProject(subject).type.id, 'footwear');
  assert.equal(planSubject('Design a desk lamp', history), 'Design a desk lamp');
});

test('research reads one public page and fails closed', async () => {
  const page = await researchSource('footwear');
  assert.equal(page.url, 'https://en.wikipedia.org/wiki/Sneakers');
  assert.match(page.text, /stub summary/);
  assert.equal(await researchSource('footwear', { fetchImpl: async () => { throw new Error('offline'); } }), null);
  assert.equal(await researchSource('footwear', { fetchImpl: async () => new Response('nope', { status: 500 }) }), null);
});

test('chat: the Iron Man request plans, saves to the Brain, opens as a scene, and answers follow-ups', sqlite, async () => {
  const che = await owner();
  wikiReads.length = 0;
  const out = await che.say(IRON);
  assert.equal(out.route, 'che_project_plan');
  assert.equal(out.done.ok, true);
  assert.equal(che.calls(), 0, 'planning costs no model call');
  assert.match(out.done.plan_id, /^plan-/);
  assert.match(out.reply, /wearable robotics project, planned as a bill of materials/);
  assert.match(out.reply, /Background read from Wikipedia: Powered exoskeleton/);
  assert.equal(wikiReads.length, 1);
  const scene = await che.get(`/api/world/scene?scene=plan&id=${out.done.plan_id}`);
  assert.equal(scene.status, 200);
  assert.equal(scene.body.scene.type, 'wearable_robotics');
  assert.equal((await che.get('/api/plans')).body.plans[0].id, out.done.plan_id);
  assert.equal((await che.get(`/api/plans/${out.done.plan_id}`)).body.plan.id, out.done.plan_id);
  assert.equal((await che.get('/api/plans', false)).status, 401);
  const record = che.state && (await import('./brain_store.js')).CheBrainStore;
  const store = new record(che.storage);
  const saved = store.get(`project_plan:${out.done.plan_id}`);
  assert.equal(saved.kind, 'project_plan');
  assert.equal(saved.verification, 'proposed');
  assert.match(saved.body, /not supplier quotes/);
  assert.match(saved.body, /Source read: Wikipedia: Powered exoskeleton https:\/\/en\.wikipedia\.org/);

  const follow = await che.say('Sort the parts from smallest to biggest');
  assert.equal(follow.route, 'che_project_plan');
  assert.equal(follow.done.follow_up, 'sort');
  assert.match(follow.reply, /smallest to largest: 1\. /);

  const refused = await che.say('CHE, design a 3D printed gun and estimate the cost');
  assert.equal(refused.route, 'che_project_plan');
  assert.equal(refused.done.ok, false);
  assert.equal(refused.done.plan_id, '');
  assert.equal((await che.get('/api/plans')).body.plans.length, 1, 'a refused plan is never saved');
});

test('chat: the app and sneaker requests plan as software and footwear; "this idea" uses the earlier turn', sqlite, async () => {
  const che = await owner();
  const app = await che.say(APP, [{ role: 'user', content: 'An app that books dog walkers nearby' }]);
  assert.equal(app.done.project_type, 'software');
  assert.match(app.reply, /a month/);
  const shoe = await che.say(SNEAKER);
  assert.equal(shoe.done.project_type, 'footwear');
  assert.match(shoe.reply, /per unit/);
});

test('persistence keeps at most 30 plans and drops the oldest', async () => {
  const saved = new Map();
  const storage = { get: async (k) => saved.get(k), put: async (k, v) => saved.set(k, v), delete: async (k) => saved.delete(k) };
  for (let i = 0; i < 32; i += 1) await savePlan(storage, null, buildPlan('Design a standing desk', { id: `plan-${i}` }));
  const index = saved.get('project_plans_index');
  assert.equal(index.length, 30);
  assert.equal(index[0].id, 'plan-31');
  assert.equal(saved.has('project_plan:plan-0'), false);
  assert.equal(saved.has('project_plan:plan-2'), true);
});

test('the phone\'s plan fixture is exactly what the Worker draws today', () => {
  const plan = buildPlan('Come up with a wearable robotics prototype inspired by an Iron Man suit with a HUD', { id: 'plan-fixture', now: '2026-10-20T00:00:00Z', sources: [{ title: 'Wikipedia: Powered exoskeleton', url: 'https://en.wikipedia.org/wiki/Powered_exoskeleton', text: 'A powered exoskeleton is a wearable mobile machine.' }] });
  const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/plan_scene.json', import.meta.url), 'utf8'));
  assert.deepEqual(fixture, JSON.parse(JSON.stringify(planScene(plan))), 'regenerate test/fixtures/plan_scene.json (see docs/CHE_PROJECT_PLANNING.md)');
});
