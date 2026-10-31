import test from 'node:test';import assert from 'node:assert/strict';import{workshopAvatar,workshopAvatarIntent,workshopSnapshot}from'./workshop.js';
test('Workshop projects supplied work without inventing progress',()=>{const d={team:[{id:'nova',name:'Nova'}],team_tasks:[{id:'1',partner_id:'nova',partner_name:'Nova',task:'Build store website',status:'running',progress:42}],jobs:[],projects:[]};const w=workshopSnapshot(d,[]);assert.equal(w.pieces.length,1);assert.equal(w.pieces[0].progress,42);assert.match(w.summary,/42 percent/)});
test('unknown progress stays null',()=>{const w=workshopSnapshot({team:[],team_tasks:[{id:'1',task:'code',status:'running'}],jobs:[],projects:[]},[]);assert.equal(w.pieces[0].progress,null)});
test('avatar choices are allowlisted and voice changes persist',()=>{const d={team:[{id:'knox',name:'Knox'}],workshop_avatars:{}};assert.equal(workshopAvatar(d,'Knox',{hair:'locs',outfit:'jacket-red'}).appearance.hair,'locs');assert.match(workshopAvatarIntent('CHE, give Knox a new look',d).reply,/Knox/)});

test('a look word in passing changes nothing; a look command still does', () => {
  const d = { team: [{ id: 'knox', name: 'Knox' }], workshop_avatars: {} };
  for (const not of ['A shirt and a hat cost 55 in total; the shirt costs 50 more than the hat. What does the hat cost?',
    'I lost my glasses at the beach.', 'The waves were huge today.', 'Give me the answer with a chain of reasoning.']) {
    assert.equal(workshopAvatarIntent(not, d), null, not);
  }
  assert.deepEqual(d.workshop_avatars, {});
  assert.match(workshopAvatarIntent('CHE, give Knox a new look', d).reply, /Knox/);
  assert.match(workshopAvatarIntent('Put on a hat', d).reply, /Workshop look/);
  assert.match(workshopAvatarIntent('Change your workshop outfit to the red jacket', d).reply, /Workshop look/);
});
