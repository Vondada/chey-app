import assert from 'node:assert/strict';
import test from 'node:test';
import { agentMayMessageOwner, officeToday } from './office_board.js';

test('office board derives today from persisted jobs', () => {
 const data={team_tasks:[
  {id:'1',partner_id:'knox',partner_name:'Knox',task:'Build checkout',status:'complete',created_at:'2026-09-29T10:00:00Z'},
  {id:'2',partner_id:'nova',partner_name:'Nova',task:'Writing listing',status:'running',created_at:'2026-09-29T11:00:00Z'}]};
 const b=officeToday(data,{status:200,sales:[]},new Date('2026-09-29T12:00:00Z'));
 assert.equal(b.shipped.length,1); assert.equal(b.agents_working,1);
});

test('today earnings subtract refunds',()=>{
 const b=officeToday({}, {status:200,sales:[{amount:2500,amount_refunded:500,created_at:'2026-09-29T10:00:00Z'}]}, new Date('2026-09-29T12:00:00Z'));
 assert.equal(b.stripe.charges_cents,2500); assert.equal(b.stripe.refunds_cents,500); assert.equal(b.stripe.net_cents,2000);
});

test('disconnected Stripe is explicit zero, never fake money',()=>{
 const b=officeToday({}, {status:503}, new Date('2026-09-29T12:00:00Z'));
 assert.equal(b.stripe.connected,false); assert.equal(b.stripe.net_cents,0); assert.equal(b.stripe.status,'not_connected');
});

test('agents cannot message owner directly',()=>{
 for(const id of ['nova','atlas','mira','knox','sage','lyra']) assert.equal(agentMayMessageOwner(id),false);
 assert.equal(agentMayMessageOwner('che'),true);
});
