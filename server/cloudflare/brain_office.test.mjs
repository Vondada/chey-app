import test from 'node:test';
import assert from 'node:assert/strict';
import { BRAIN_REGIONS, CheBrainStore } from './brain_store.js';
import {
  CHE_CORE_ID, archiveTasks, handoffRecord, internalWorkers, projectInvestigations, projectOfficeExperience, recoverHistory, redactedRecord, taskRecord, workerBrains,
} from './brain_office.js';
import { REA_DETAIL_PREFIX, REA_JOBS_KEY } from './rea_runner.js';
import { EVIDENCE_RUNS } from './trading_evidence_runner.js';

async function sqlStorage() {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { return null; }
  const db = new DatabaseSync(':memory:');
  return { sql: { exec: (q, ...p) => {
    const stmt = db.prepare(q);
    return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []);
  } } };
}

function kvStorage(map = new Map()) {
  return {
    get: async (key) => (map.has(key) ? structuredClone(map.get(key)) : undefined),
    put: async (key, value) => map.set(key, structuredClone(value)),
    list: async ({ prefix = '', limit, startAfter } = {}) => {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort().slice(0, limit || undefined);
      return new Map(keys.map((k) => [k, structuredClone(map.get(k))]));
    },
    map,
  };
}

const T = '2026-10-10T10:00:00.000Z';
function officeData() {
  return {
    team: [
      { id: 'a-nova', name: 'Nova', role: 'Product and listings', responsibilities: ['Listings', 'Pricing'], skill_ids: ['s1'], runtime_status: 'idle', handoff_history: [] },
      { id: 'a-knox', name: 'Knox', role: 'Engineering', responsibilities: ['Code repairs'], skill_ids: [], runtime_status: 'working', handoff_history: [{ task_id: 't2', from_agent_name: 'Atlas', to_agent_name: 'Knox', at: '2026-10-09T09:00:00.000Z' }] },
      { id: 'a-atlas', name: 'Atlas', role: 'Research', responsibilities: [], skill_ids: [], runtime_status: 'idle' },
      { id: 'a-temp', name: 'Claude (temp)', role: 'Provider worker', temporary: true, skill_ids: [] },
      { id: 'a-grok', name: 'Grok', role: 'Outside model', skill_ids: [] },
    ],
    team_tasks: [
      { id: 't1', partner_id: 'a-nova', partner_name: 'Nova', role: 'Product', task: 'Write the Etsy listing for the brass lamp.', status: 'complete', result: 'Listing written: Brass Lamp, 40 dollars, ships in 3 days.', verified_by_che: true, memory_note_id: 'n1', created_at: T, updated_at: T },
      { id: 't2', partner_id: 'a-atlas', partner_name: 'Atlas', role: 'Research', task: 'Research silver momentum and hand the implementation to Knox.', status: 'failed', error: 'The data source timed out twice.', handoffs: [{ from_agent_name: 'Atlas', to_agent_name: 'Knox', at: '2026-10-09T09:00:00.000Z', reason: 'Implementation needed' }], created_at: '2026-10-09T08:00:00.000Z', updated_at: '2026-10-09T09:30:00.000Z' },
      { id: 't3', partner_id: 'a-knox', partner_name: 'Knox', role: 'Engineering', task: 'Paper-trade the silver signal.', status: 'running', job_id: 'j1', created_at: '2026-10-10T11:00:00.000Z', updated_at: '2026-10-10T11:00:00.000Z' },
      { id: 't4', partner_id: 'a-temp', partner_name: 'Claude (temp)', task: 'Translate the listing.', status: 'complete', result: 'Done.', created_at: T, updated_at: T },
    ],
    agent_work_log: [
      { agent: 'Nova', agent_id: 'a-nova', task_id: 't1', status: 'complete', verified_by_che: true, at: T },
      { agent: 'Nova', agent_id: 'a-nova', task_id: 't-old', status: 'failed', verified_by_che: false, error: 'Failure recorded', at: '2026-09-20T10:00:00.000Z' },
    ],
    office_skills: [{ id: 's1', name: 'Write an Etsy listing', trigger: 'A new product needs a listing', steps: ['Gather the product facts', 'Write title, price and shipping'], assigned_agents: ['Nova'], created_at: T }],
    jobs: [{ id: 'j1', kind: 'trading_lab', title: 'Paper trade silver', prompt: 'Run the silver signal on paper.', status: 'running', attempts: 1, created_at: '2026-10-10T11:00:00.000Z' }],
    projects: [{ id: 'p1', title: 'Barbershop booking app', status: 'planned', summary: 'A booking page for the shop.', created_at: T }],
    office_goals: [{ id: 'g1', goal: 'Ten listings this month', job_ids: ['j1'], created_at: T }],
    objectives: [{ id: 'o1', title: 'Launch the lamp line', status: 'active', created_at: T }],
    meetings: [{ id: 'm1', title: 'War Room: pricing', summary: 'Agreed on 40 dollars.', created_at: T }],
    memory_records: [], memory_notes: [{ id: 'n1', title: 'Etsy listing facts', bullets: ['Brass lamp sells at 40'], sources: [], kind: 'research', agent: 'Nova', created_at: T }], learned_knowledge: [], nightly_reviews: [],
  };
}

test('only internal, permanent workers are Office brains: temporary provider workers and outside AIs are excluded', () => {
  const workers = internalWorkers(officeData());
  assert.deepEqual(workers.map((w) => w.name), ['Nova', 'Knox', 'Atlas']);
});

test('the Office projects into the Brain with real attribution: core, workers, tasks, handoffs, outcomes, skills, jobs, projects; idempotent', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const data = officeData();
  const first = projectOfficeExperience(store, data, { now: T });
  assert.equal(first.workers, 3);
  const core = store.get(CHE_CORE_ID);
  assert.equal(core.region, BRAIN_REGIONS.self);
  assert.deepEqual(core.links.map((l) => l.to).sort(), ['agent:a-atlas', 'agent:a-knox', 'agent:a-nova']);
  assert.ok(store.get('agent:a-nova'));
  assert.equal(store.get('agent:a-temp'), null, 'a temporary provider worker has no brain');
  assert.equal(store.get('agent:a-grok'), null, 'an outside AI has no brain');

  const t1 = store.get('task:t1');
  assert.equal(t1.verification, 'verified_source', 'checked by CHE');
  assert.ok(t1.links.some((l) => l.type === 'produced_by_agent' && l.to === 'agent:a-nova'));
  assert.ok(t1.links.some((l) => l.type === 'learned_from' && l.to === 'note:n1'));
  assert.match(t1.body, /Result: Listing written/);
  const t2 = store.get('task:t2');
  assert.equal(t2.verification, 'unverified_reference');
  assert.match(t2.body, /Error: The data source timed out twice\./);
  assert.ok(t2.links.some((l) => l.type === 'escalated_to' && l.to === 'agent:a-knox'), 'the handoff links Atlas’s task to Knox');
  assert.deepEqual(t2.source.collaborators, ['Knox']);
  assert.equal(store.list({ region: BRAIN_REGIONS.agents, path: 'Knox' }).records.some((r) => r.id === 'task:t2'), true, 'the task shows in Knox’s brain too');
  const t3 = store.get('task:t3');
  assert.equal(t3.path, 'Active');
  assert.ok(t3.links.some((l) => l.type === 'related_to' && l.to === 'job:j1'));
  assert.ok(store.get('task:t4'), 'the Office’s work by a temporary provider worker is still a task record');
  assert.equal(store.list({ region: BRAIN_REGIONS.agents, path: 'Claude (temp)' }).records.length, 0, 'but no worker brain holds it');
  assert.equal(store.get('task:t4').links.some((l) => l.type === 'produced_by_agent'), false);

  const handoff = store.list({ region: BRAIN_REGIONS.agents, path: 'Atlas' }).records.find((r) => r.kind === 'collaboration');
  assert.ok(handoff, 'the handoff is a collaboration record');
  assert.match(handoff.title, /Atlas handed work to Knox/);
  assert.equal(store.list({ region: BRAIN_REGIONS.agents, path: 'Knox' }).records.filter((r) => r.kind === 'collaboration').length, 1, 'one record, seen from both brains, not two');

  const old = store.get('work:a-nova:t-old');
  assert.ok(old, 'a work-log outcome whose task scrolled off survives');
  assert.match(old.body, /status failed/);
  assert.equal(store.get('work:a-nova:t1'), null, 'a task still present is not duplicated as a work record');
  assert.equal(store.get('skill:s1').path, 'Nova');
  assert.equal(store.get('job:j1').region, BRAIN_REGIONS.tasks);
  assert.equal(store.get('project:p1').region, BRAIN_REGIONS.projects);
  assert.equal(store.get('goal:g1').kind, 'goal');
  assert.equal(store.get('objective:o1').kind, 'objective');
  assert.equal(store.get('meeting:m1').path, 'War Room');

  const seq = store.status().seq;
  const second = projectOfficeExperience(store, data, { now: T });
  assert.equal(Object.values(second.counts).reduce((n, c) => n + c.imported, 0), 0, 'a second run writes nothing');
  assert.equal(store.status().seq, seq);
  data.team_tasks[2].status = 'complete';
  data.team_tasks[2].result = 'Paper trade closed flat.';
  const third = projectOfficeExperience(store, data, { now: T });
  assert.equal(third.counts.team_tasks.imported, 1);
  assert.equal(store.get('task:t3').path, 'Historical');
});

test('worker brains carry real counts and never claim learning for an idle worker with no work', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const data = officeData();
  data.team.push({ id: 'a-iris', name: 'Iris', role: 'Ad Studio', skill_ids: [], runtime_status: 'idle' });
  projectOfficeExperience(store, data, { now: T });
  const view = workerBrains(store, data);
  assert.equal(view.core.name, 'CHE');
  assert.ok(view.core.records > 10);
  const nova = view.workers.find((w) => w.name === 'Nova');
  assert.deepEqual(nova.tasks, { done: 1, failed: 0, live: 0 });
  assert.equal(nova.skills, 1);
  assert.equal(nova.work_outcomes, 1);
  const knox = view.workers.find((w) => w.name === 'Knox');
  assert.deepEqual(knox.tasks, { done: 0, failed: 1, live: 1 }, 'Atlas’s failed task counts in Knox’s brain through the handoff');
  assert.deepEqual(knox.collaborators, ['Atlas']);
  assert.equal(knox.state, 'working');
  const iris = view.workers.find((w) => w.name === 'Iris');
  assert.equal(iris.records, 1, 'only her own hub record');
  assert.equal(iris.state, 'no experience yet');
  assert.deepEqual(view.excluded.map((e) => e.name).sort(), ['Claude (temp)', 'Grok']);
});

test('tasks leaving the recent list are archived first; REA and trading runs become records; the recovery report says what is where', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const data = officeData();
  const dropped = [{ id: 't-drop', partner_id: 'a-knox', partner_name: 'Knox', task: 'Fix the flaky test.', status: 'complete', result: 'Fixed by awaiting the stream.', verified_by_che: true, created_at: '2026-09-01T00:00:00.000Z' }];
  assert.equal(archiveTasks(store, dropped, data, { now: T }), 1);
  assert.equal(store.get('task:t-drop').verification, 'verified_source');

  const kv = kvStorage();
  await kv.put(REA_JOBS_KEY, [{ id: 'r1', title: 'REA: shop.example', status: 'done', target: { name: 'shop.example' }, created_at: T }]);
  await kv.put(`${REA_DETAIL_PREFIX}r1`, { id: 'r1', status: 'done', target: { name: 'shop.example' }, summary: 'Checkout uses Stripe; three features found.', features: [{ name: 'Checkout', evidence: ['https://shop.example/checkout'] }, { name: 'Search', evidence: [] }], architecture: ['Next.js'], created_at: T });
  await kv.put(EVIDENCE_RUNS, [{ id: 'e1', status: 'complete', symbol: 'SI', summary: 'Momentum signal flat over 30 days.', at: T }]);
  await kv.put('brainmem:000001760000000:conv_1', { id: 'conv_1', at: T, title: 'Hello', body: 'You said: hello\nCHE answered: hi.', links: [] });
  const inv = await projectInvestigations(store, kv, { now: T });
  assert.equal(inv.rea.imported, 1);
  assert.equal(inv.trading.imported, 1);
  const rea = store.get('rea:r1');
  assert.equal(rea.region, BRAIN_REGIONS.rea);
  assert.equal(rea.path, 'shop.example');
  assert.equal(rea.verification, 'verified_source', 'evidence items make it source-backed');
  assert.match(rea.body, /Evidence items: 1\./);
  const trade = store.get('trade:e1');
  assert.equal(trade.region, BRAIN_REGIONS.trading);
  assert.match(trade.body, /not live money, not financial advice/);

  const report = await recoverHistory(store, kv, data, { now: T, library: [{ id: 'l1', title: 'Script', source: 'owner', chars: 100, chunks: 1, added: T }] });
  assert.equal(report.available, true);
  assert.equal(report.workers, 3);
  assert.ok(report.sources.some((s) => s.source === 'team_tasks' && s.inspected === 4));
  assert.ok(report.sources.some((s) => /REA/.test(s.source) && s.skipped === 1), 'already imported, so skipped this pass');
  assert.ok(report.sources.some((s) => /brainmem/.test(s.source) && s.done === true));
  assert.ok(report.unavailable.some((u) => /Flagstaff/.test(u)));
  assert.ok(report.unavailable.some((u) => /GitHub/.test(u)));
  const audit = store.get(`audit:recovery:${T.slice(0, 10)}`);
  assert.equal(audit.region, BRAIN_REGIONS.audits);
  assert.match(audit.body, /Not recoverable from here:/);
  assert.equal(store.get('conv:conv_1').source.full_text, false);
  assert.equal(store.get('lib:l1').kind, 'library_doc');
  assert.deepEqual(store.meta('recovery_report').sources.length, report.sources.length);
});

test('a task record names every participant and reads failures as failures', () => {
  const data = officeData();
  const index = { find: (key) => internalWorkers(data).find((w) => w.id === key || w.name.toLowerCase() === String(key || '').toLowerCase()) || null };
  const record = taskRecord(data.team_tasks[1], index);
  assert.equal(record.source.outcome, 'failed');
  assert.match(record.body, /Handoffs: Atlas → Knox/);
  assert.deepEqual(record.places, [{ region: BRAIN_REGIONS.agents, path: 'Atlas' }, { region: BRAIN_REGIONS.agents, path: 'Knox' }]);
});

test('a task whose result trips the secret gate keeps a redacted record under its id: counted as refused, never lost, archived too', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const data = officeData();
  data.team_tasks.push({ id: 'sec1', partner_id: 'a-nova', partner_name: 'Nova', task: 'Log in to the supplier portal and download the invoice.', status: 'complete', result: 'Logged in with password: hunter2 and downloaded invoice 4471.', created_at: T, updated_at: T });
  const first = projectOfficeExperience(store, data, { now: T });
  assert.equal(first.counts.team_tasks.refused, 1);
  assert.equal(first.counts.team_tasks.inspected, 5);
  const kept = store.get('task:sec1');
  assert.ok(kept, 'the task still has a record');
  assert.equal(kept.source.redacted, true);
  assert.doesNotMatch(kept.body, /hunter2/);
  assert.doesNotMatch(kept.body, /invoice 4471/);
  assert.match(kept.body, /^Task: Log in to the supplier portal and download the invoice\./m, 'the task text itself is safe and stays');
  assert.match(kept.body, /Status: complete/);
  assert.match(kept.body, /Result withheld: sensitive content; see the task history\./);
  assert.equal(kept.source.agent, 'Nova');
  const brains = workerBrains(store, data);
  assert.equal(brains.workers.find((w) => w.name === 'Nova').tasks.done, 2, 'the ledger and the brain agree');
  const second = projectOfficeExperience(store, data, { now: T });
  assert.equal(second.counts.team_tasks.refused, 0, 'not re-refused every run');
  assert.equal(second.counts.team_tasks.imported, 0);
  // Leaving the recent list: the redacted record is archived, not dropped.
  const store2 = new CheBrainStore(await sqlStorage());
  assert.equal(archiveTasks(store2, [data.team_tasks[4]], data, { now: T }), 1);
  assert.equal(store2.get('task:sec1').source.redacted, true);
  // When the task text itself is sensitive, only the outline is kept.
  const outline = redactedRecord(taskRecord({ id: 'sec2', partner_id: 'a-knox', task: 'Rotate the api key for the mail service.', status: 'failed', error: 'api key rejected' }, { find: () => null }));
  assert.equal(outline.title, 'task sec2');
  assert.doesNotMatch(outline.body, /api key/);
  assert.match(outline.body, /Status: failed/);
  // Hashes are kept only for ids still in the state blob.
  assert.equal(Object.keys(store.meta('office_hashes')).includes('task:sec1'), true);
  data.team_tasks = data.team_tasks.filter((x) => x.id !== 't1');
  projectOfficeExperience(store, data, { now: T });
  assert.equal(Object.keys(store.meta('office_hashes')).includes('task:t1'), false, 'a scrolled-out task no longer holds a hash');
  assert.ok(store.get('task:t1'), 'its record stays');
});

test('a self-handoff is no collaboration; REA targets and features given as objects, and a null trading run, do not break the projection', async (t) => {
  const index = { find: (key) => (key === 'Atlas' || key === 'a-atlas' ? { id: 'a-atlas', name: 'Atlas' } : null) };
  assert.equal(handoffRecord({ from_agent_name: 'Atlas', to_agent_name: 'Atlas', at: T }, 't9', index), null);
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const kv = kvStorage();
  await kv.put(REA_JOBS_KEY, [{ id: 'r2', status: 'done', target: { host: 'app.example' }, created_at: T }]);
  await kv.put(`${REA_DETAIL_PREFIX}r2`, { id: 'r2', status: 'done', target: { host: 'app.example' }, features: [{ title: 'Login' }, { evidence: [] }], architecture: [{ label: 'React' }], created_at: T });
  await kv.put(EVIDENCE_RUNS, [null, { status: 'complete', at: '2026-10-11T00:00:00.000Z', summary: 'Flat.' }, { id: 'e2', status: 'failed', at: T }]);
  const inv = await projectInvestigations(store, kv, { now: T });
  assert.equal(inv.rea.imported, 1);
  assert.equal(inv.trading.imported, 2, 'the null entry is skipped, the id-less run is named by its time');
  const rea = store.get('rea:r2');
  assert.equal(rea.path, 'app.example');
  assert.doesNotMatch(rea.body, /object Object/);
  assert.match(rea.body, /Features found: Login/);
  assert.match(rea.body, /Architecture: React/);
  assert.ok(store.get('trade:2026-10-11T00:00:00.000Z'));
  assert.equal(store.get('trade:1'), null);
});

test('investigations keep their own hashes, a refused REA record keeps a safe outline and is counted, an owner edit survives, and the report says what was withheld', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const kv = kvStorage();
  await kv.put(REA_JOBS_KEY, [
    { id: 'r1', title: 'REA: shop.example', status: 'done', target: { name: 'shop.example' }, created_at: T },
    { id: 'r2', title: 'REA: bank.example login', status: 'done', target: { host: 'bank.example' }, created_at: T },
  ]);
  await kv.put(`${REA_DETAIL_PREFIX}r1`, { id: 'r1', status: 'done', target: { name: 'shop.example' }, summary: 'Checkout uses Stripe.', features: [{ name: 'Checkout', evidence: ['https://shop.example/checkout'] }], created_at: T });
  await kv.put(`${REA_DETAIL_PREFIX}r2`, { id: 'r2', status: 'done', target: { host: 'bank.example' }, summary: 'Login uses a password field and a session cookie.', features: [{ name: 'Login', evidence: ['https://bank.example/login'] }], created_at: T });
  const first = await projectInvestigations(store, kv, { now: T });
  assert.deepEqual(first.rea, { inspected: 2, imported: 2, skipped: 0, refused: 1, dropped: 0 });
  const kept = store.get('rea:r2');
  assert.ok(kept, 'the refused investigation still has a record');
  assert.equal(kept.source.redacted, true);
  assert.doesNotMatch(kept.body, /password|cookie/);
  assert.match(kept.body, /^Target: bank\.example\. Status: done\.$/m);
  assert.match(kept.body, /Evidence items: 1\./);
  assert.match(kept.body, /withheld: sensitive content/);
  assert.deepEqual(Object.keys(store.meta('investigation_hashes')).sort(), ['rea:r1', 'rea:r2']);
  // The Office projection prunes its own map and leaves the investigations' alone.
  projectOfficeExperience(store, officeData(), { now: T });
  assert.deepEqual(Object.keys(store.meta('investigation_hashes')).sort(), ['rea:r1', 'rea:r2']);
  // The owner annotates an investigation on the phone: the next pass skips it and keeps his words.
  const edit = store.apply({ type: 'put', record: { ...store.get('rea:r1'), body: `${store.get('rea:r1').body}\nOwner note: worth copying their checkout flow.` }, base_rev: store.get('rea:r1').rev }, { origin: 'iphone' });
  assert.equal(edit.outcome, 'updated');
  const second = await projectInvestigations(store, kv, { now: '2026-10-11T10:00:00.000Z' });
  assert.deepEqual(second.rea, { inspected: 2, imported: 0, skipped: 2, refused: 0, dropped: 0 });
  assert.match(store.get('rea:r1').body, /Owner note: worth copying/);
  const report = await recoverHistory(store, kv, officeData(), { now: '2026-10-11T10:00:00.000Z' });
  const rea = report.sources.find((s) => /REA/.test(s.source));
  assert.equal(rea.refused, 0, 'already present now');
  // A fresh store shows the refusal in the report and the audit record.
  const store2 = new CheBrainStore(await sqlStorage());
  const fresh = await recoverHistory(store2, kv, officeData(), { now: T });
  assert.equal(fresh.sources.find((s) => /REA/.test(s.source)).refused, 1);
  assert.match(store2.get(`audit:recovery:${T.slice(0, 10)}`).body, /1 with details withheld \(sensitive content\)/);
  assert.match(store2.get(`audit:recovery:${T.slice(0, 10)}`).body, /1 record kept only as a safe outline/);
});

test('a null handoff or work-log entry never breaks the projection; a handoff note is recorded; last activity is the work\'s own date; the archive step keeps an owner\'s edit', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const data = officeData();
  data.team_tasks[1].handoffs = [null, { from_agent_name: 'Atlas', to_agent_name: 'Knox', at: '2026-10-09T09:00:00.000Z', note: 'Knox has the trading harness' }];
  data.team[1].handoff_history = [null, ...data.team[1].handoff_history];
  data.agent_work_log = [null, ...data.agent_work_log];
  const out = projectOfficeExperience(store, data, { now: '2026-10-18T03:00:00.000Z' });
  assert.equal(out.available, true);
  const handoff = store.get('handoff:t2:a-atlas:a-knox:2026-10-09T09:00:00.000Z');
  assert.match(handoff.body, /Reason: Knox has the trading harness/);
  const brains = workerBrains(store, data);
  assert.equal(brains.workers.find((w) => w.name === 'Nova').last_activity, T, 'the task\'s own date, not tonight');
  assert.equal(brains.workers.find((w) => w.name === 'Atlas').last_activity, '2026-10-09T09:00:00.000Z', 'his handoff to Knox is his latest work');
  // The owner edits a task record; the task then leaves the window: the archive step leaves his words.
  const t1 = store.get('task:t1');
  assert.equal(store.apply({ type: 'put', record: { ...t1, body: `${t1.body}\nOwner note: good listing.` }, base_rev: t1.rev }, { origin: 'iphone' }).outcome, 'updated');
  assert.equal(archiveTasks(store, [data.team_tasks[0]], data, { now: '2026-10-18T04:00:00.000Z' }), 0, 'unchanged content: nothing rewritten');
  assert.match(store.get('task:t1').body, /Owner note: good listing/);
  // A task that changed since the projection is archived with its new content.
  data.team_tasks[0].result = 'Listing written and published.';
  assert.equal(archiveTasks(store, [data.team_tasks[0]], data, { now: '2026-10-18T04:01:00.000Z' }), 1);
  assert.match(store.get('task:t1').body, /published/);
  // Other kinds keep every safe line when redacted.
  const skill = redactedRecord({ id: 'skill:v', kind: 'skill', region: BRAIN_REGIONS.skills, path: 'Nova', title: 'Vendor login', body: 'Skill: Vendor login.\nSteps: open the portal; enter the password from the vault; download the invoice.\nAssigned: Nova.', source: { kind: 'office_skill' }, verification: 'verified_source' });
  assert.match(skill.body, /^Skill: Vendor login\.$/m);
  assert.match(skill.body, /^Assigned: Nova\.$/m);
  assert.doesNotMatch(skill.body, /password/);
  assert.match(skill.body, /One part withheld: sensitive content; see the original record\./);
});

test('a secret never survives its label: multi-line results, JSON, errors and reviews are withheld as whole fields; names and URLs that trip the gate still leave a stored outline', async (t) => {
  const index = { find: (key) => (['Nova', 'a-nova'].includes(key) ? { id: 'a-nova', name: 'Nova' } : null) };
  const cases = [
    ['result', { result: 'Logged in.\nPassword:\nhunter2\nDownloaded invoice 4471.' }, /hunter2|4471/],
    ['api key', { result: 'Configured the mailer.\nAPI key:\nsk-live-9f8e7d6c5b4a3210\nSaved to the vault.' }, /sk-live|vault/],
    ['json', { result: '{\n "password":\n "hunter2"\n}' }, /hunter2/],
    ['error', { status: 'failed', error: 'Login failed.\nPassword:\nhunter2 was rejected by the portal.' }, /hunter2|portal/],
    ['review', { review_feedback: 'Good.\nNever paste the password again:\nhunter2 appeared in the log.' }, /hunter2|appeared/],
  ];
  for (const [name, extra, secret] of cases) {
    const outline = redactedRecord(taskRecord({ id: `s-${name}`, partner_id: 'a-nova', task: 'Set up the supplier mailer.', status: 'complete', created_at: T, ...extra }, index));
    assert.ok(outline, `${name}: an outline is kept`);
    assert.doesNotMatch(outline.body, secret, `${name}: the value is gone with its label`);
    assert.match(outline.body, /^Task: Set up the supplier mailer\./m, `${name}: the safe task text stays`);
    assert.match(outline.body, /Result withheld: sensitive content; see the task history\./);
  }
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const data = officeData();
  // The kind label, the partner's name and a reset URL are what trips the gate here, not the body.
  data.team_tasks.push({ id: 's11', kind: 'api_key_rotation', partner_id: 'a-nova', partner_name: 'Nova', task: 'Rotate the mail credential.', status: 'complete', result: 'Rotated.', created_at: T });
  data.team_tasks.push({ id: 's12', partner_name: 'Password Vault Bot', task: 'File the receipts.', status: 'complete', result: 'Filed.', created_at: T });
  const first = projectOfficeExperience(store, data, { now: T });
  assert.equal(first.counts.team_tasks.refused, 2);
  assert.equal(first.counts.team_tasks.dropped, 0);
  for (const id of ['task:s11', 'task:s12']) {
    const kept = store.get(id);
    assert.ok(kept && !kept.deleted, `${id} is really in the Brain`);
    assert.equal(kept.source.redacted, true);
    assert.doesNotMatch(JSON.stringify(kept), /api_key_rotation|Password Vault/i);
  }
  assert.ok(store.rows('SELECT path FROM brain_places WHERE record_id = ?', 'task:s11').some((row) => row.path === 'Nova'), 'Nova keeps the experience');
  const second = projectOfficeExperience(store, data, { now: T });
  assert.equal(second.counts.team_tasks.refused, 0, 'not refused again on the next pass');
  const kv = kvStorage();
  await kv.put(REA_JOBS_KEY, [{ id: 'r9', status: 'done', target: { kind: 'website', url: 'https://app.example/reset?token=abc123' }, created_at: T }]);
  const inv = await projectInvestigations(store, kv, { now: T });
  const rea = store.get('rea:r9');
  assert.ok(rea && !rea.deleted, 'the investigation is stored');
  assert.equal(rea.path, 'app.example', 'named by its host, never by the URL');
  assert.doesNotMatch(JSON.stringify(rea), /abc123/);
  assert.equal(inv.rea.imported + inv.rea.refused, 1);
  assert.equal(inv.rea.dropped, 0);
  const again = await projectInvestigations(store, kv, { now: T });
  assert.equal(again.rea.refused + again.rea.imported, 0, 'nothing is re-refused or rewritten on the next pass');
});

test('the change feed carries every place a record sits in, so the phone draws a shared task in both workers\' brains', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  projectOfficeExperience(store, officeData(), { now: T });
  const feed = store.changes({ since: 0, limit: 500 });
  const shared = feed.records.find((r) => r.id === 'task:t2');
  assert.deepEqual(shared.places.map((p) => p.path).sort(), ['Atlas', 'Historical', 'Knox']);
  assert.deepEqual(shared.places.filter((p) => p.region === BRAIN_REGIONS.agents).map((p) => p.path).sort(), ['Atlas', 'Knox']);
  const own = feed.records.find((r) => r.id === 'task:t1');
  assert.deepEqual(own.places.filter((p) => p.region === BRAIN_REGIONS.agents).map((p) => p.path), ['Nova']);
  const temp = feed.records.find((r) => r.id === 'task:t4');
  assert.equal(temp.places.some((p) => p.region === BRAIN_REGIONS.agents), false, 'a temporary provider worker has no brain to sit in');
  for (const r of feed.records) assert.ok(Array.isArray(r.places) && r.places.length >= 1, `${r.id} has places`);
  // Paging keeps places on every page; a page of one still works.
  const one = store.changes({ since: 0, limit: 1 });
  assert.equal(one.records.length, 1);
  assert.ok(one.records[0].places.length >= 1);
});

test('a blocked task is live work for its worker, not an unknown outcome', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const data = officeData();
  const before = workerBrains(store, data).workers.find((w) => w.name === 'Nova').tasks;
  data.team_tasks.push({ id: 'blk1', partner_id: 'a-nova', partner_name: 'Nova', task: 'Wait for the vendor to answer.', status: 'blocked', created_at: T });
  projectOfficeExperience(store, data, { now: T });
  const after = workerBrains(store, data).workers.find((w) => w.name === 'Nova').tasks;
  assert.equal(after.live, (before.live || 0) + 1, 'blocked counts as live');
  assert.equal(store.get('task:blk1').source.outcome, 'live');
});
