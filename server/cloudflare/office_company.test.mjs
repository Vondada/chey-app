import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureLaAgenciaRoster, officeToolBlocker } from './office_company.js';

test('canonical Office roster reports only to CHE',()=>{
 const data={team:[]}; ensureLaAgenciaRoster(data);
 assert.deepEqual(data.team.map(a=>a.name),['Nova','Atlas','Mira','Knox','Sage','Lyra','Iris']);
 for(const a of data.team){ assert.equal(a.reports_to,'CHE'); assert.equal(a.owner_messaging,false); assert.equal(a.can_merge_code,false); assert.equal(a.can_spend_money,false); }
});

test('Iris Atlas Mira Lyra prefer auto so they are not blocked on Grok',()=>{
 const data={team:[]}; ensureLaAgenciaRoster(data);
 for (const name of ['Atlas','Mira','Lyra','Iris']) {
  const a = data.team.find((x)=>x.name===name);
  assert.equal(a.provider_preference,'auto');
  assert.equal(officeToolBlocker({},a),'');
 }
});

test('missing provider credentials are honest blockers',()=>{
 const data={team:[]}; ensureLaAgenciaRoster(data);
 assert.match(officeToolBlocker({},data.team.find(a=>a.name==='Knox')),/Blocked/);
 assert.equal(officeToolBlocker({},data.team.find(a=>a.name==='Atlas')),'');
 assert.match(officeToolBlocker({},data.team.find(a=>a.name==='Sage')),/Stripe not connected/);
});
