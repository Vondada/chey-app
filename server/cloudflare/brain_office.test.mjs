import test from 'node:test';
import assert from 'node:assert/strict';
import { BRAIN_REGIONS, CheBrainStore } from './brain_store.js';
import {
  CHE_CORE_ID, answerCorrespondenceQuestion, reportedQuote, archiveTasks, correspondenceStatus, handoffRecord, importOutsideCorrespondence, internalWorkers, outsideCorrespondenceIntent,
  projectInvestigations, projectOfficeExperience, recoverHistory, redactCorrespondence, redactedRecord, speakCorrespondenceCount, speakCorrespondenceImport, taskRecord, workerBrains,
} from './brain_office.js';
import { backfillConversations, isSafeText } from './brain_store.js';
import { isSafeMemoryText } from './research_memory.js';
import { redactSecrets } from './privacy_policy.js';
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

// ─── Outside correspondence: the Flagstaff mailbox ───────────────────────────

// Built at run time so no literal token shape sits in the repository.
const FAKE_TOKEN = ['gh', 'p_', 'Z9'.repeat(18)].join('');
const HEAD1 = 'a1'.repeat(20);
const HEAD2 = 'b2'.repeat(20);
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
const OLD_REPLY = { id: 'old-2', at: '2026-09-30T19:52:40.027Z', from: 'che', to: 'claude', text: 'My coding crew failed on the avatar change. Please look.', reply_to: 'old-1' };
function flagstaffFiles() {
  return {
    'mailbox/README.md': '# Flagstaff\n',
    'mailbox/archive/claude.jsonl': jsonl([
      { id: 'old-1', at: '2026-09-30T17:18:33.992Z', from: 'claude', to: 'che', text: 'Hi CHE, this is Claude. This mailbox is our channel.', reply_to: '' },
      OLD_REPLY,
    ]),
    // The same line in the archive and the live file (a trim that lost a race): one record.
    'mailbox/claude.jsonl': jsonl([
      OLD_REPLY,
      { id: 'c-sync', at: '2026-10-18T18:45:00.000Z', from: 'claude', to: 'che', text: 'Done: the Brain sync feed is merged and live. The phone replica pulls in pages of 500.', reply_to: '' },
      { id: 'c-deploy', at: '2026-10-18T19:00:00.000Z', from: 'claude', to: 'che', text: `Deploy is green. The token is ${FAKE_TOKEN} for the test. Your api key stays in the Worker secrets. Nothing else changed.`, reply_to: '' },
    ]),
    'mailbox/chatgpt.jsonl': jsonl([
      { id: 'chatgpt-issue350', at: '2026-10-18T21:00:00.000Z', from: 'chatgpt', to: 'claude', text: 'I created ONE consolidated GitHub issue #350 with all five exact iPhone utterances. Fix the shopping hold first.', reply_to: '' },
      { id: 'chatgpt-3500', at: '2026-10-18T22:00:00.000Z', from: 'chatgpt', to: 'che', text: 'The renderer budget is 3500 frames; issue 1350 is unrelated.', reply_to: '' },
      // Its id names a key: the words are kept, the ids withheld from the text (the record's id keeps it).
      { id: 'chatgpt-api-key-note', at: '2026-10-18T23:00:00.000Z', from: 'chatgpt', to: 'che', text: 'Rotate it soon.', reply_to: '' },
      // Clean line by line, refused as a whole ("api" + "key"): only an outline can be kept.
      { id: 'chatgpt-split', at: '2026-10-18T23:10:00.000Z', from: 'chatgpt', to: 'che', text: 'Check the api\nkey rotation next week', reply_to: '' },
      { id: 'chatgpt-pw', at: '2026-10-18T23:30:00.000Z', from: 'chatgpt', to: 'che', text: 'password: hunter2', reply_to: '' },
    ]),
    // The autopilot's activity log lives beside the threads: lines, not messages.
    'mailbox/che-autopilot.jsonl': jsonl([{ at: '2026-10-03T21:19:29.743Z', action: 'reviewing', session_id: 'ocr-1', sha: '7aba461', detail: 'CI passed.' }]),
  };
}

/** A read-only GitHub that serves [state.files] at [state.head]; every request is recorded. */
function fakeGitHub(state) {
  state.calls = state.calls || [];
  return async (input, init = {}) => {
    const url = new URL(String(input?.url || input));
    const method = init.method || 'GET';
    state.calls.push(`${method} ${url.pathname}${url.search}`);
    if (url.host !== 'api.github.com') throw new TypeError(`offline: ${url.host}`);
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (method !== 'GET') return json({ message: 'read-only test' }, 405);
    if (state.fail && state.fail(url)) return json({ message: 'Server Error' }, 500);
    const path = decodeURIComponent(url.pathname.replace(/^\/repos\/owner\/che/, ''));
    if (path === '/git/ref/heads/che-mailbox') return json({ object: { sha: state.head } });
    const dir = /^\/contents\/(mailbox(?:\/archive)?)$/.exec(path);
    if (dir) {
      const prefix = `${dir[1]}/`;
      const names = Object.keys(state.files).filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => k.slice(prefix.length));
      if (!names.length) return json({ message: 'Not Found' }, 404);
      return json([...names.map((name) => ({ name, type: 'file' })), ...(dir[1] === 'mailbox' ? [{ name: 'archive', type: 'dir' }] : [])]);
    }
    const file = /^\/contents\/(.+)$/.exec(path);
    if (file && state.files[file[1]] != null) return json({ sha: `sha-${file[1]}`, content: Buffer.from(state.files[file[1]]).toString('base64') });
    return json({ message: 'Not Found' }, 404);
  };
}
const GH_ENV = { CHE_GITHUB_TOKEN: 'test-only', CHE_GITHUB_REPO: 'owner/che' };

test('the Flagstaff mailbox comes in as outside correspondence with its provenance, and a second import gives the same count', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const gh = { head: HEAD1, files: flagstaffFiles() };
  const first = await importOutsideCorrespondence(store, GH_ENV, { fetcher: fakeGitHub(gh), now: T });
  assert.equal(first.done, true);
  assert.equal(first.files_read, 4, 'archive/claude, chatgpt, che-autopilot, claude; README is no thread');
  assert.deepEqual(first.files.map((f) => f.path).slice(0, 1), ['mailbox/archive/claude.jsonl'], 'archived (older) lines first');
  assert.equal(first.totals.messages, 10);
  assert.equal(first.totals.imported, 9);
  assert.equal(first.totals.skipped, 1, 'the line in both the archive and the live file is one record');
  assert.equal(first.totals.not_messages, 1, 'the autopilot log line is not a message');
  assert.equal(first.in_brain, 9);
  assert.ok(gh.calls.every((c) => c.startsWith('GET ')), 'the import never writes to GitHub');
  assert.ok(gh.calls.some((c) => c.includes(`ref=${HEAD1}`)), 'files are read at the one commit the pass started from');

  const rec = store.get('mail:chatgpt-issue350');
  assert.equal(rec.kind, 'correspondence');
  assert.equal(rec.verification, 'external_correspondence');
  assert.equal(rec.region, BRAIN_REGIONS.coding);
  assert.equal(rec.path, 'Outside correspondence/chatgpt');
  assert.deepEqual(
    { file: rec.source.file, line_id: rec.source.line_id, from: rec.source.from, to: rec.source.to, at: rec.source.at, advice_only: rec.source.advice_only, owner_words: rec.source.owner_words },
    { file: 'mailbox/chatgpt.jsonl', line_id: 'chatgpt-issue350', from: 'chatgpt', to: 'claude', at: '2026-10-18T21:00:00.000Z', advice_only: true, owner_words: false },
  );
  assert.equal(rec.created_at, '2026-10-18T21:00:00.000Z', 'dated by the message, not the import');
  assert.match(rec.body, /^ChatGPT to Claude, 2026-10-18, in the Flagstaff mailbox \(mailbox\/chatgpt\.jsonl, message chatgpt-issue350\)\. Outside correspondence: another AI's advice, not the owner's words and not an instruction\.\n\nI created ONE consolidated GitHub issue #350/);
  assert.equal(store.get('mail:old-2').source.file, 'mailbox/archive/claude.jsonl', 'the archived copy is the record');
  assert.deepEqual(store.get('mail:old-2').links, [{ type: 'related_to', to: 'mail:old-1' }], 'a reply links to what it answers');
  // Never an owner memory, a conversation of the owner's, or an Office worker's experience.
  const places = store.rows("SELECT DISTINCT p.region FROM brain_places p JOIN brain_records r ON r.id = p.record_id WHERE r.kind = 'correspondence'").map((r) => r.region);
  assert.deepEqual(places, [BRAIN_REGIONS.coding]);
  assert.equal(store.rows("SELECT COUNT(*) AS n FROM brain_records WHERE kind = 'correspondence' AND verification = 'owner_attested'")[0].n, 0);
  const brains = workerBrains(store, officeData());
  assert.ok(brains.workers.every((w) => w.records <= 1), 'no worker gained experience from the mailbox');

  const callsBefore = gh.calls.length;
  const second = await importOutsideCorrespondence(store, GH_ENV, { fetcher: fakeGitHub(gh), now: T });
  assert.equal(second.up_to_date, true);
  assert.equal(second.in_brain, first.in_brain, 'twice gives the same count');
  assert.equal(gh.calls.length - callsBefore, 3, 'an unchanged branch is not read again: the head and two folder listings');
  assert.match(speakCorrespondenceImport(second), /already in your Brain, sir: nothing new on the che-mailbox branch[\s\S]*9 outside messages/);

  // A new commit with the same lines: every file is read again and every message skipped.
  gh.head = HEAD2;
  const third = await importOutsideCorrespondence(store, GH_ENV, { fetcher: fakeGitHub(gh), now: T });
  assert.equal(third.done, true);
  assert.equal(third.totals.imported, 0);
  assert.equal(third.totals.skipped, 10);
  assert.equal(third.in_brain, 9);
  assert.equal(store.rows("SELECT MAX(rev) AS n FROM brain_records WHERE kind = 'correspondence'")[0].n, 1, 'a repeat rewrites nothing');
});

test('a long import is bounded and resumable: it stops at its limit, keeps a cursor, and carries on without duplicates', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const gh = { head: HEAD1, files: flagstaffFiles() };
  const runs = [];
  for (let i = 0; i < 8; i += 1) {
    const run = await importOutsideCorrespondence(store, GH_ENV, { fetcher: fakeGitHub(gh), now: T, limit: 3 });
    runs.push(run);
    if (run.done) break;
  }
  assert.ok(runs.length >= 3, `bounded runs: ${runs.length}`);
  assert.ok(runs.every((r) => r.totals.imported + r.totals.updated <= 3), 'never more than the limit written per run');
  assert.equal(runs[0].done, false);
  assert.ok(runs[0].stopped_at, 'the first run says where it stopped');
  assert.match(speakCorrespondenceImport(runs[0]), /stopped after 3 records[\s\S]*again to carry on/);
  assert.equal(runs.at(-1).done, true);
  assert.equal(runs.at(-1).in_brain, 9, 'the same nine messages as one unbounded run');
  assert.equal(store.rows("SELECT COUNT(*) AS n FROM brain_records WHERE kind = 'correspondence'")[0].n, 9, 'no duplicate');
  // A file that cannot be read leaves the pass unfinished and is read again next time.
  const fresh = new CheBrainStore(await sqlStorage());
  const broken = { head: HEAD1, files: flagstaffFiles(), fail: (url) => url.pathname.endsWith('/chatgpt.jsonl') };
  const partial = await importOutsideCorrespondence(fresh, GH_ENV, { fetcher: fakeGitHub(broken), now: T });
  assert.equal(partial.done, false);
  assert.equal(partial.errors.length, 1);
  assert.match(speakCorrespondenceImport(partial), /could not read 1 part of the mailbox[\s\S]*not finished/);
  broken.fail = null;
  const healed = await importOutsideCorrespondence(fresh, GH_ENV, { fetcher: fakeGitHub(broken), now: T });
  assert.equal(healed.done, true);
  assert.equal(healed.in_brain, 9);
  assert.deepEqual(healed.files.map((f) => f.path), ['mailbox/chatgpt.jsonl'], 'only the file that failed is read again');
});

test('secret-looking parts of a message are withheld and counted; a message the gate still refuses keeps a safe outline; an owner delete stays', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const redacted = redactCorrespondence(`Deploy is green. The token is ${FAKE_TOKEN} for the test. Your api key stays in the Worker secrets. Nothing else changed.`);
  assert.equal(redacted.withheld, 2);
  assert.equal(redacted.text, 'Deploy is green. Nothing else changed. [withheld: sensitive content]');
  assert.deepEqual(redactCorrespondence('A plain update about the Brain sync.'), { text: 'A plain update about the Brain sync.', withheld: 0 });

  const store = new CheBrainStore(storage);
  const report = await importOutsideCorrespondence(store, GH_ENV, { fetcher: fakeGitHub({ head: HEAD1, files: flagstaffFiles() }), now: T });
  assert.equal(report.totals.withheld, 3, 'two messages with parts withheld and one kept as an outline');
  assert.equal(report.totals.dropped, 0);
  const all = store.rows("SELECT title, body, source FROM brain_records WHERE kind = 'correspondence'").map((r) => `${r.title}\n${r.body}\n${r.source}`).join('\n');
  assert.doesNotMatch(all, new RegExp(FAKE_TOKEN));
  assert.doesNotMatch(all, /hunter2/);
  const secret = store.get('mail:c-deploy');
  assert.match(secret.body, /Deploy is green\. Nothing else changed\. \[withheld: sensitive content\]\n\n2 parts withheld: sensitive content\. The original stays in mailbox\/claude\.jsonl on the che-mailbox branch\./);
  assert.equal(secret.source.withheld_parts, 2);
  assert.match(store.get('mail:chatgpt-pw').body, /\n\n\[withheld: sensitive content\]\n\nOne part withheld: sensitive content\./);
  // Its id names a key, so the gate refuses the full record: the words stay, the ids leave the text.
  const idless = store.get('mail:chatgpt-api-key-note');
  assert.equal(idless.source.ids_withheld, true);
  assert.equal(idless.source.line_id, undefined);
  assert.match(idless.body, /\(mailbox\/chatgpt\.jsonl\)\. Outside correspondence[\s\S]*Rotate it soon\./);
  // Refused even so: an outline keeps the sender, the time and the file, never the words.
  const outline = store.get('mail:chatgpt-split');
  assert.equal(outline.verification, 'external_correspondence');
  assert.equal(outline.source.from, 'chatgpt');
  assert.equal(outline.source.message_withheld, true);
  assert.match(outline.body, /Message withheld: sensitive content\. The original stays in mailbox\/chatgpt\.jsonl on the che-mailbox branch\./);
  assert.doesNotMatch(outline.body, /rotation/);
  // The owner deletes one message from his Brain: a later import never brings it back.
  store.delete('mail:c-sync', { origin: 'owner' });
  const again = await importOutsideCorrespondence(store, GH_ENV, { fetcher: fakeGitHub({ head: HEAD2, files: flagstaffFiles() }), now: T });
  assert.equal(again.totals.deleted_by_owner, 1);
  assert.equal(store.get('mail:c-sync').deleted, true);
  assert.equal(again.in_brain, 8);
  assert.match(speakCorrespondenceImport(again), /1 you deleted stayed deleted/);
});

test('Flagstaff replies CHE remembered are outside correspondence, never the owner\'s conversations, and old ones are relabeled', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const kv = kvStorage();
  await kv.put('brainmem:000001760000000:flagstaff:m1', { id: 'flagstaff:m1', kind: 'flagstaff', at: T, title: 'Flagstaff: chatgpt: check the sync', body: 'chatgpt said in Flagstaff: check the sync\nCHE replied: the sync is green.', links: [] });
  await kv.put('brainmem:000001760000001:conv_9', { id: 'conv_9', at: T, title: 'Hello', body: 'You said: hello\nCHE answered: hi.', links: [] });
  await backfillConversations(store, kv, { batch: 10, now: T });
  const exchange = store.get('conv:flagstaff:m1');
  assert.equal(exchange.verification, 'external_correspondence');
  assert.equal(exchange.region, BRAIN_REGIONS.coding);
  assert.equal(exchange.path, 'Outside correspondence/Flagstaff replies');
  assert.equal(store.get('conv:conv_9').verification, 'owner_attested', 'the owner\'s own talk keeps its label');
  // One backfilled before this fix, filed as the owner's conversation, is put right by the next pass.
  store.put({ id: 'conv:flagstaff:m0', kind: 'flagstaff', region: BRAIN_REGIONS.conversations, path: 'flagstaff', title: 'Flagstaff: claude: hi', body: 'claude said in Flagstaff: hi\nCHE replied: hello.', verification: 'owner_attested', source: { kind: 'brainmem', brainmem_id: 'flagstaff:m0' }, created_at: T }, { now: T });
  const report = await recoverHistory(store, kv, {}, { now: T });
  const fixed = store.get('conv:flagstaff:m0');
  assert.equal(fixed.verification, 'external_correspondence');
  assert.equal(fixed.region, BRAIN_REGIONS.coding);
  assert.equal(store.rows("SELECT COUNT(*) AS n FROM brain_places WHERE record_id = 'conv:flagstaff:m0' AND region = ?", BRAIN_REGIONS.conversations)[0].n, 0);
  assert.equal(report.outside_correspondence.relabeled, 1);
  assert.ok(report.sources.some((s) => /Flagstaff replies/.test(s.source) && s.inspected === 2));
});

test('the recovery report carries the Flagstaff import; without GitHub the import says so, and only the board archive comes in', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const kv = kvStorage();
  const before = await recoverHistory(store, kv, officeData(), { now: T });
  assert.ok(before.unavailable.some((u) => /Flagstaff mailbox: not imported yet[\s\S]*import the Flagstaff history/.test(u)));
  const offline = await importOutsideCorrespondence(store, {}, { now: T });
  assert.equal(offline.connected, false);
  assert.equal(offline.in_brain, 0);
  assert.match(speakCorrespondenceImport(offline), /^I can't read the Flagstaff mailbox, sir: GitHub isn't connected[\s\S]*Nothing was imported from it\. Your Brain holds 0 outside messages\.$/);
  // Without GitHub the board's own locked sessions still come in, and the reply says from where.
  const boardOnly = new CheBrainStore(await sqlStorage());
  const board = kvStorage();
  await board.put('web_mailbox_archive', [{ id: 's1', locked_at: T, messages: [{ id: 'w1', at: T, from: 'grok', to: 'che', text: 'Grok here: the board works.' }] }]);
  assert.match(speakCorrespondenceImport(await importOutsideCorrespondence(boardOnly, {}, { storage: board, now: T })), /Nothing was imported from it\. I brought in 1 message from my own Flagstaff board archive\. Your Brain holds 1 outside message\.$/);
  // No mailbox branch yet, and a GitHub that cannot be reached: each says so, nothing is claimed.
  const none = await importOutsideCorrespondence(store, GH_ENV, { fetcher: async () => new Response('{"message":"Not Found"}', { status: 404 }), now: T });
  assert.equal(none.no_branch, true);
  assert.match(speakCorrespondenceImport(none), /^There is no Flagstaff mailbox on GitHub yet, sir: the che-mailbox branch does not exist/);
  const down = await importOutsideCorrespondence(store, GH_ENV, { fetcher: async () => { throw new TypeError('fetch failed'); }, now: T });
  assert.equal(down.done, false);
  assert.match(speakCorrespondenceImport(down), /^I couldn't read the Flagstaff mailbox, sir: Mailbox read failed \(fetch failed\)\. Nothing new was imported\. Your Brain holds 0 outside messages\.$/);
  await importOutsideCorrespondence(store, GH_ENV, { fetcher: fakeGitHub({ head: HEAD1, files: flagstaffFiles() }), now: T });
  const after = await recoverHistory(store, kv, officeData(), { now: T });
  const row = after.sources.find((s) => /Flagstaff mailbox/.test(s.source));
  assert.equal(row.inspected, 10);
  assert.equal(row.imported, 9);
  assert.equal(row.refused, 3, 'messages kept with a part withheld');
  assert.match(row.note, /outside correspondence, never owner memories or Office worker experience; 9 in the Brain/);
  assert.equal(after.unavailable.some((u) => /not imported yet/.test(u)), false);
  assert.equal(after.outside_correspondence.messages, 9);
  assert.match(store.get(`audit:recovery:${T.slice(0, 10)}`).body, /Flagstaff mailbox \(che-mailbox branch and the board archive\): 10 inspected, 9 imported/);
  const audit = store.get(`audit:correspondence:${T.slice(0, 10)}`);
  assert.equal(audit.region, BRAIN_REGIONS.audits);
  assert.match(audit.body, /Flagstaff history imported, sir: I read 4 mailbox files \(commit a1a1a1a\)\. 10 messages read: 9 brought in, 1 already there; 3 kept with a sensitive part withheld\. 1 line was an activity log/);
  assert.equal(store.meta('correspondence_import').head, HEAD1);
  const status = correspondenceStatus(store);
  assert.deepEqual(status.by_sender, { claude: 3, che: 1, chatgpt: 5 });
  assert.match(speakCorrespondenceCount(status), /^Your Brain holds 9 outside messages, sir: ChatGPT 5, Claude 3, CHE 1\. Last import: 10 October 2026 at 10:00 UTC, commit a1a1a1a\. They are outside correspondence/);
  assert.match(speakCorrespondenceCount(status, { peer: 'claude' }), /^Your Brain holds 3 messages from Claude, sir, out of 9 outside messages\./);
});

test('the web board\'s locked sessions add only messages GitHub never had', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const kv = kvStorage();
  await kv.put('web_mailbox_archive', [{ id: 'sess-1', locked_at: T, count: 2, messages: [
    { id: 'chatgpt-issue350', at: '2026-10-18T21:00:00.000Z', from: 'chatgpt', to: 'claude', text: 'A board copy of the same message.' },
    { id: 'web-only-1', at: '2026-10-01T10:00:00.000Z', from: 'grok', to: 'che', text: 'Grok here through the web link: the board works.' },
  ] }]);
  const report = await importOutsideCorrespondence(store, GH_ENV, { storage: kv, fetcher: fakeGitHub({ head: HEAD1, files: flagstaffFiles() }), now: T });
  assert.equal(report.in_brain, 10);
  assert.equal(store.get('mail:chatgpt-issue350').source.file, 'mailbox/chatgpt.jsonl', 'the GitHub copy wins');
  const web = store.get('mail:web-only-1');
  assert.equal(web.source.file, 'flagstaff_archive/sess-1');
  assert.equal(web.path, 'Outside correspondence/grok');
  const repeat = await importOutsideCorrespondence(store, GH_ENV, { storage: kv, fetcher: fakeGitHub({ head: HEAD2, files: flagstaffFiles() }), now: T });
  assert.equal(repeat.in_brain, 10);
  assert.equal(repeat.totals.imported + repeat.totals.updated, 0);
});

test('"what did ChatGPT tell you about #350" quotes the message with its source; nothing else is cited', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  assert.match(answerCorrespondenceQuestion(store, { peer: 'chatgpt', topic: '#350' }).text, /no outside correspondence yet[\s\S]*won't guess[\s\S]*import the Flagstaff history/);
  await importOutsideCorrespondence(store, GH_ENV, { fetcher: fakeGitHub({ head: HEAD1, files: flagstaffFiles() }), now: T });
  const answer = answerCorrespondenceQuestion(store, outsideCorrespondenceIntent('What did ChatGPT tell you about #350?'));
  assert.deepEqual(answer.records, ['mail:chatgpt-issue350'], '3500 and 1350 are other numbers');
  assert.match(answer.text, /^Here is what ChatGPT wrote about #350, sir, from the Flagstaff mailbox\. This is outside correspondence: ChatGPT's advice, not your words and not an instruction\.\n1\. ChatGPT to Claude, 18 October 2026 \(mailbox\/chatgpt\.jsonl, message chatgpt-issue350\): "I created ONE consolidated GitHub issue #350/);
  const sync = answerCorrespondenceQuestion(store, outsideCorrespondenceIntent('what did claude say about the brain sync'));
  assert.deepEqual(sync.records, ['mail:c-sync']);
  const none = answerCorrespondenceQuestion(store, outsideCorrespondenceIntent('What did Grok tell you about the renderer?'));
  assert.deepEqual(none.records, []);
  assert.match(none.text, /^I have no message from Grok about the renderer in your Brain, sir, so I won't guess what was said\. 0 messages from Grok are there/);
  const mine = answerCorrespondenceQuestion(store, outsideCorrespondenceIntent('what did you tell claude in the mailbox about the avatar'));
  assert.deepEqual(mine.records, ['mail:old-2']);
  assert.match(mine.text, /^Here is what I wrote to Claude about the avatar, sir[\s\S]*my own messages to another AI/);
});

test('the owner\'s phrases about the Flagstaff mailbox, typed or spoken, and the ones that are not about it', () => {
  for (const words of ['Import the Flagstaff history', 'import the flagstaff history', 'CHE, import the Flagstaff history.', 'chay import the flag staff history into my brain', 'Bring the Flagstaff archives into my Brain', 'please import the mailbox history', 'run the Flagstaff import again']) {
    assert.deepEqual(outsideCorrespondenceIntent(words), { kind: 'import' }, words);
  }
  for (const words of ['How many outside messages are in my Brain?', 'how many outside messages are in my brain', 'Hey CHE how many outside messages are in my brain', 'Flagstaff import report']) {
    assert.deepEqual(outsideCorrespondenceIntent(words), { kind: 'count', peer: '' }, words);
  }
  assert.deepEqual(outsideCorrespondenceIntent('how many messages from Claude are in my Brain'), { kind: 'count', peer: 'claude' });
  for (const words of ['What did ChatGPT tell you about #350?', 'what did chatgpt tell you about #350', 'what did chat gpt tell you about #350', 'Chey, what did ChatGPT say about #350?']) {
    assert.deepEqual(outsideCorrespondenceIntent(words), { kind: 'ask', peer: 'chatgpt', direction: 'from', topic: '#350' }, words);
  }
  assert.deepEqual(outsideCorrespondenceIntent('what has Claude said in the mailbox about the Brain sync'), { kind: 'ask', peer: 'claude', direction: 'from', topic: 'the brain sync' });
  assert.deepEqual(outsideCorrespondenceIntent('What did the other AIs say about the coding runtime?'), { kind: 'ask', peer: '', direction: 'from', topic: 'the coding runtime' });
  assert.deepEqual(outsideCorrespondenceIntent('did Codex mention the Shorebird patch'), { kind: 'ask', peer: 'codex', direction: 'from', topic: 'the shorebird patch' });
  assert.deepEqual(outsideCorrespondenceIntent('What did you tell ChatGPT about #351?'), { kind: 'ask', peer: 'chatgpt', direction: 'to', topic: '#351' });
  // The owner's own words, the live mailbox, sending, and an import he said not to do are not this.
  for (const words of ['What did I tell you about #350?', 'what did i say about the brain sync', 'Check the mailbox', 'any new messages from Claude?', 'Tell ChatGPT that #350 is fixed', "Don't import the Flagstaff history",
    'how many messages are in my brain', 'How do I import the Flagstaff history?', 'What did the doctor tell you about my knee?', 'What are you doing?', 'Read me my brain review']) {
    assert.equal(outsideCorrespondenceIntent(words), null, words);
  }
  assert.deepEqual(outsideCorrespondenceIntent("Don't import the Flagstaff history, just tell me how many outside messages are in my Brain"), { kind: 'count', peer: '' });
});

// ─── Review of #354 ──────────────────────────────────────────────────────────

// Fixtures built at run time from pieces, so no literal key, token or password sits in the repository.
const PEM_LINES = ['-----BEGIN OPENSSH ' + 'PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW', 'QyNTUxOQAAACDx4ql3', ['AAAEC4dX', 'kFGtqE9w=='].join(''), '-----END OPENSSH ' + 'PRIVATE KEY-----'];
const JWT_PARTS = [['eyJhbGciOiJI', 'UzI1NiIsInR5cCI6IkpXVCJ9'].join(''), ['eyJzdWIiOiIx', 'MjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ'].join(''), ['SflKxwRJSMeK', 'KF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('')];
const PASS = ['Summer', '2026', '!'].join('');
const SECRET_MESSAGES = [
  `credentials vondada:${PASS}`,
  `The Robinhood account is vondada and ${PASS} gets you in. The build is green.`,
  `Here is the deploy key:\n${PEM_LINES.join('\n')}\nKeep it safe. The deploy is green.`,
  `Session for the test: ${JWT_PARTS[0]}\n.${JWT_PARTS[1]}\n.${JWT_PARTS[2]}\nThe payload again: ${JWT_PARTS[1]}. Build passed.`,
];
const SECRET_PIECES = [PASS, 'vondada:', ...PEM_LINES.slice(1, 4), ...JWT_PARTS];

test('passwords, key blocks and token pieces never land in the Brain: the shared gates catch their shapes, the import withholds them whole (review of #354)', async (t) => {
  for (const text of SECRET_MESSAGES) {
    assert.equal(isSafeMemoryText(text), false, text.slice(0, 40));
    assert.equal(isSafeText(text), false, text.slice(0, 40));
    const { text: kept, withheld } = redactCorrespondence(text);
    assert.ok(withheld >= 1, text.slice(0, 40));
    for (const piece of SECRET_PIECES) assert.equal(kept.includes(piece), false, `${piece.slice(0, 12)} in: ${kept}`);
  }
  assert.equal(redactCorrespondence(SECRET_MESSAGES[2]).text, 'Here is the deploy key:\n[withheld: sensitive content]\nKeep it safe. The deploy is green.', 'the whole block, BEGIN to END, as one part');
  assert.equal(redactCorrespondence(SECRET_MESSAGES[3]).text, 'Session for the test: [withheld: sensitive content]\nThe payload again: [withheld: sensitive content]. Build passed.', 'every segment of the token, wherever it appears');
  assert.doesNotMatch(redactSecrets(`log ${JWT_PARTS.join('.')} and ${PEM_LINES.join('\n')}`), /eyJ|AAAEC4dX|BEGIN/, 'the audit scrubber knows the same shapes');
  // Ordinary engineering words stay: commits, issues, times, versions, links, addresses, product names.
  for (const clean of ['Commit f2992a7 and b2cb356 fixed issue #350 in PR #351.', 'Deployed at 2026-10-18T21:00:00.000Z, version v1.2.3, run 39180527957.', 'See https://github.com/Vondada/chey-app/pull/351?ref=main or mail sam2@example.com.', 'The iPhone15 build of GPT4oMini, SmolLM2 and Q4_K_M at 10:30am.', 'UUID 97d389bb-537b-425e-81c5-908ab17e5ce8 and MNQZ6 are fine.']) {
    assert.equal(isSafeMemoryText(clean), true, clean);
    assert.equal(isSafeText(clean), true, clean);
    assert.deepEqual(redactCorrespondence(clean), { text: clean, withheld: 0 }, clean);
  }
  // Through the import: none of the pieces is stored in any field of any record.
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const files = { 'mailbox/chatgpt.jsonl': jsonl(SECRET_MESSAGES.map((text, i) => ({ id: `leak-${i}`, at: T, from: 'chatgpt', to: 'che', text, reply_to: '' }))) };
  const report = await importOutsideCorrespondence(store, GH_ENV, { fetcher: fakeGitHub({ head: HEAD1, files }), now: T });
  assert.equal(report.in_brain, 4);
  assert.equal(report.totals.withheld, 4);
  const stored = store.rows('SELECT title, body, source, links FROM brain_records').map((r) => `${r.title}\n${r.body}\n${r.source}\n${r.links}`).join('\n');
  for (const piece of SECRET_PIECES) assert.equal(stored.includes(piece), false, piece.slice(0, 12));
  assert.match(store.get('mail:leak-1').body, /The build is green\. \[withheld: sensitive content\]/);
});

test('a quote is reported, never re-asked: an offer to act on a yes is left out (review of #354)', async (t) => {
  assert.equal(reportedQuote("I reviewed #350. Do you want me to email the owner's accountant the trading journal? Say yes and I will."),
    "I reviewed #350. [it asked whether to email the owner's accountant the trading journal] [an offer to act on a yes, left out]");
  assert.equal(reportedQuote('Shall I merge it now? Reply yes to approve. The build is green.'), '[it asked whether to merge it now] [an offer to act on a yes, left out] The build is green.');
  assert.equal(reportedQuote('I said yes to the plan. What do you think about the logo?'), 'I said yes to the plan. What do you think about the logo?');
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const files = { 'mailbox/chatgpt.jsonl': jsonl([{ id: 'm1', at: '2026-10-12T10:00:00.000Z', from: 'chatgpt', to: 'che', text: "I reviewed #350. Do you want me to email the owner's accountant the trading journal? Say yes and I will.", reply_to: '' }]) };
  await importOutsideCorrespondence(store, GH_ENV, { fetcher: fakeGitHub({ head: HEAD1, files }), now: T });
  const answer = answerCorrespondenceQuestion(store, outsideCorrespondenceIntent('What did ChatGPT tell you about #350?'));
  assert.deepEqual(answer.records, ['mail:m1']);
  assert.match(answer.text, /"I reviewed #350\. \[it asked whether to email the owner's accountant the trading journal\] \[an offer to act on a yes, left out\]"$/);
  assert.doesNotMatch(answer.text, /do you want me to|say yes/i);
  // The stored record keeps the words as written: only the spoken quote is reported.
  assert.match(store.get('mail:m1').body, /Do you want me to email the owner's accountant the trading journal\? Say yes and I will\./);
});

test('"What did ChatGPT say?" alone, right after a live consult, or about a person named Claude is not a mailbox question (review of #354)', () => {
  for (const words of ['What did ChatGPT say?', 'what did chatgpt tell you', 'What did Claude say?', 'What did Claude say about dinner on Friday?', 'what did claude tell you about dinner on friday', 'What did Gemini say about my horoscope?', 'What did you tell Claude about the party?']) {
    assert.equal(outsideCorrespondenceIntent(words), null, words);
  }
  assert.deepEqual(outsideCorrespondenceIntent('What did ChatGPT say in the mailbox?'), { kind: 'ask', peer: 'chatgpt', direction: 'from', topic: '' });
  assert.deepEqual(outsideCorrespondenceIntent('What did Claude say about the Brain sync?'), { kind: 'ask', peer: 'claude', direction: 'from', topic: 'the brain sync' });
  assert.deepEqual(outsideCorrespondenceIntent('what did claude tell you about 350'), { kind: 'ask', peer: 'claude', direction: 'from', topic: '350' });
  assert.deepEqual(outsideCorrespondenceIntent('What did Claude write in the mailbox about dinner?'), { kind: 'ask', peer: 'claude', direction: 'from', topic: 'dinner' });
  const consult = [{ role: 'user', content: 'Ask ChatGPT what it thinks of the logo' }, { role: 'assistant', content: 'ChatGPT (OpenAI gpt-oss) says: It reads well at small sizes.' }];
  for (const words of ['What did ChatGPT say about the logo?', 'what did chatgpt tell you about it', 'What did the other AIs say about the logo?']) {
    assert.equal(outsideCorrespondenceIntent(words, { history: consult }), null, words);
  }
  assert.equal(outsideCorrespondenceIntent('What did ChatGPT say about the logo?', { history: [consult[1]] }), null, 'the consult answer alone is enough');
  assert.deepEqual(outsideCorrespondenceIntent('What did ChatGPT say in the mailbox about the logo?', { history: consult }), { kind: 'ask', peer: 'chatgpt', direction: 'from', topic: 'the logo' });
  assert.deepEqual(outsideCorrespondenceIntent('What did Codex say about #350?', { history: consult }), { kind: 'ask', peer: 'codex', direction: 'from', topic: '#350' }, 'another AI than the one consulted');
});
