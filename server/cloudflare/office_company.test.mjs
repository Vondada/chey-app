import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureLaAgenciaRoster, officeToolBlocker } from './office_company.js';

test('canonical Office roster reports only to CHE',()=>{
 const data={team:[]}; ensureLaAgenciaRoster(data);
 assert.deepEqual(data.team.map(a=>a.name),['Nova','Atlas','Mira','Knox','Sage','Lyra','Orion','Iris','Vale']);
 for(const a of data.team){ assert.equal(a.reports_to,'CHE'); assert.equal(a.owner_messaging,false); assert.equal(a.can_merge_code,false); assert.equal(a.can_spend_money,false); }
});

test('every head but Atlas (Codex engineering) prefers auto so they are not blocked on Grok',()=>{
 const data={team:[]}; ensureLaAgenciaRoster(data);
 for (const name of ['Nova','Mira','Knox','Lyra','Orion','Iris','Vale']) {
  const a = data.team.find((x)=>x.name===name);
  assert.equal(a.provider_preference,'auto');
  assert.equal(officeToolBlocker({},a),'');
 }
});

test('missing provider credentials are honest blockers',()=>{
 const data={team:[]}; ensureLaAgenciaRoster(data);
 assert.match(officeToolBlocker({},data.team.find(a=>a.name==='Atlas')),/Blocked: tool not configured \(Codex\)/);
 assert.equal(officeToolBlocker({},data.team.find(a=>a.name==='Knox')),'');
 assert.match(officeToolBlocker({},data.team.find(a=>a.name==='Sage'),'Report on Stripe sales today'),/Stripe not connected/);
 assert.equal(officeToolBlocker({},data.team.find(a=>a.name==='Sage'),'Weigh the evidence for these two plans'),'', 'Sage analysis does not need Stripe');
});

test('agents cannot merge code, spend money or open payouts', async () => {
  const { agentActionGuard } = await import('./office_company.js');
  const knox = { name: 'Knox', can_merge_code: false, can_spend_money: false, can_open_payouts: false };
  assert.match(agentActionGuard(knox, 'Merge the checkout PR into main'), /cannot merge code/);
  assert.match(agentActionGuard(knox, 'Buy a domain for the store'), /cannot spend money/);
  assert.match(agentActionGuard(knox, 'Open a Stripe payout to the bank'), /payouts/);
  assert.equal(agentActionGuard(knox, 'Build a checkout page where customers buy the course'), '');
  assert.equal(agentActionGuard(knox, 'Write tests for the store'), '');
});


test('Mira (research) only requires a trend feed for trend-scout work', () => {
  const data = { team: [] }; ensureLaAgenciaRoster(data);
  const atlas = data.team.find((a) => a.name === 'Mira');
  assert.equal(officeToolBlocker({}, atlas, 'Summarize this owner-provided report'), '');
  assert.match(officeToolBlocker({}, atlas, 'Scout trending video topics'), /no trend feed/);
});

test('the reorganisation keeps each agent and records the job it held before', () => {
  const data = { team: [{ id: 'k1', name: 'Knox', role: 'Engineering / Codex jobs', specialty: 'Implementation', handoff_history: [{ task_id: 't1' }] }] };
  ensureLaAgenciaRoster(data);
  const knox = data.team.find((a) => a.name === 'Knox');
  assert.equal(knox.id, 'k1', 'same agent, same ID');
  assert.equal(knox.role, 'Security / protection');
  assert.deepEqual(knox.role_history.map((r) => r.role), ['Engineering / Codex jobs']);
  assert.equal(knox.handoff_history.length, 1, 'history is kept');
  ensureLaAgenciaRoster(data);
  assert.equal(knox.role_history.length, 1, 'recorded once, not on every load');
  assert.equal(data.team.filter((a) => a.name === 'Knox').length, 1, 'no duplicate agent');
});

test('each department has exactly one head; engineering is not reviewed by its own head', async () => {
  const { LA_AGENCIA_ROLES, departmentHead } = await import('./office_company.js');
  const ids = Object.values(LA_AGENCIA_ROLES).map((r) => r.department?.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(departmentHead('security').name, 'Knox');
  assert.equal(departmentHead('engineering').name, 'Atlas');
  assert.equal(departmentHead('qa').name, 'Vale');
  assert.equal(departmentHead('markets').name, 'Orion');
  assert.notEqual(departmentHead('security').name, departmentHead('engineering').name, 'separation of duties');
});
