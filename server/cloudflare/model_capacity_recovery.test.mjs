import test from 'node:test';
import assert from 'node:assert/strict';
import { planCandidates } from './model_router.mjs';
import { breakerAfter, resumeDecision } from './coding_failover.mjs';

const now=Date.parse('2026-10-27T12:00:00Z');
const model={id:'openrouter/qwen/qwen3-coder:free',provider:'openrouter',pricing:{prompt:'0',completion:'0',request:'0'}};
const verdicts={openrouter:{id:'openrouter',coverage:'free',verification:'runtime',policy:'verified_zero_cost'}};

test('a verified free model in capacity cooldown remains resumable after the actual breaker expires',()=>{
  const breaker=breakerAfter(null,{errorClass:'credit_exhausted',now});
  const plan=planCandidates({models:[model],verdicts,ledger:{breakers:{[model.id]:breaker}},now:now+15*60_000});
  assert.equal(plan.candidates.length,0);
  assert.equal(plan.capacity_resume_at,breaker.until);
  const retry=resumeDecision({resumable:true,now:now+15*60_000,notBefore:plan.capacity_resume_at});
  assert.equal(retry.at,breaker.until,'backoff cannot retry before the known cooldown');
  const resumed=planCandidates({models:[model],verdicts,ledger:{breakers:{[model.id]:breaker}},now:Date.parse(retry.at)+1});
  assert.equal(resumed.candidates[0].model,model.id);
  assert.equal(resumed.candidates[0].trial,true);
});

test('missing zero-cost authorization and billing/auth breakers never become automatic capacity recovery',()=>{
  assert.equal(planCandidates({models:[model],verdicts:{},now}).capacity_resume_at,null);
  for(const errorClass of ['billing_risk','auth_failure']){
    const breaker=breakerAfter(null,{errorClass,now});
    assert.equal(planCandidates({models:[model],verdicts,ledger:{breakers:{openrouter:breaker}},now}).capacity_resume_at,null);
  }
  assert.equal(resumeDecision({resumable:true,resumeCount:3,notBefore:new Date(now+3600000).toISOString(),now}).resume,false,'existing retry cap preserved');
});
