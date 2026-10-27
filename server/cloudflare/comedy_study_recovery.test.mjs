import test from 'node:test';
import assert from 'node:assert/strict';
import { studyTurn, studyPass, STUDY_KEY, STUDY_WAKE_KEY } from './comedy_study.js';

const memory = () => {
  const values = new Map();
  return { get: async k => structuredClone(values.get(k)), put: async (k,v) => values.set(k,structuredClone(v)), delete: async k => values.delete(k) };
};
const ask = { action: 'start', subjects: ['Martin', 'The Fresh Prince of Bel-Air'], goal: 'humor' };
const wiki = async url => {
  const p = new URL(url).searchParams;
  if (p.get('list') === 'search') return Response.json({query:{search:[{title:p.get('srsearch').startsWith('Martin') ? 'Martin (TV series)' : 'The Fresh Prince of Bel-Air'}]}});
  if (p.get('prop') === 'extracts') return Response.json({query:{pages:[{extract:'A comedy ensemble using contrast and escalation.'}]}});
  return Response.json({parse:{title:p.get('page'),wikitext:Array.from({length:60},(_,i)=>`{{Episode list\n |EpisodeNumber=${i+1}\n |Title=Episode ${i+1}\n |ShortSummary=An original comedy situation unfolds.\n}}`).join('\n')}});
};

test('discover both shows before a large first guide consumes every pass', async () => {
  const storage = memory();
  await studyTurn(storage, ask, {now:100});
  await studyPass(storage,{fetcher:wiki,now:200});
  await studyPass(storage,{fetcher:wiki,now:300});
  const [a] = await storage.get(STUDY_KEY);
  assert.ok(a.subjects.every(s=>s.article), 'both real searches must have run');
  assert.equal(a.subjects[0].cursor,0);
});

test('owner pause/new assignment during an HTTP wait survives stale pass completion', async () => {
  for (const action of ['stop','start']) {
    const storage = memory();
    await studyTurn(storage,ask,{now:100});
    let enter;
    const entered = new Promise(r=>{enter=r;});
    let release;
    const gate = new Promise(r=>{release=r;});
    let first = true;
    const running = studyPass(storage,{now:200,fetcher:async url=>{if(first){first=false;enter();await gate;}return wiki(url);}});
    await entered;
    await studyTurn(storage,action==='stop'?{action:'stop'}:{...ask,subjects:['Another Show']},{now:300});
    const ownerState = await storage.get(STUDY_KEY);
    const wake = await storage.get(STUDY_WAKE_KEY);
    release();
    await running;
    assert.deepEqual(await storage.get(STUDY_KEY),ownerState,action);
    assert.equal(await storage.get(STUDY_WAKE_KEY),wake,action);
  }
});

test('unavailable sources remain retryable with real failure evidence, never studied', async () => {
  const storage = memory();
  await studyTurn(storage,ask,{now:100});
  await studyPass(storage,{now:200,fetcher:async url=>new URL(url).searchParams.get('list')==='search'?wiki(url):new Response('unavailable',{status:503})});
  const [a] = await storage.get(STUDY_KEY);
  assert.equal(a.subjects[0].status,'pending');
  assert.match(a.log.at(-1).text,/503/);
  const reply = await studyTurn(storage,{action:'status'});
  assert.doesNotMatch(reply.text,/studied the article only/);
});

test('pause and resume during lesson generation invalidate the stale cursor and keep summaries for retry', async () => {
  const storage = memory();
  let transactions = 0;
  storage.transaction = async run => { transactions++; return run(storage); };
  await studyTurn(storage,{...ask,subjects:['Martin']},{now:100});
  await studyPass(storage,{fetcher:wiki,now:200});
  const [before] = await storage.get(STUDY_KEY);
  let enter, release;
  const entered = new Promise(r=>{enter=r;});
  const gate = new Promise(r=>{release=r;});
  const running = studyPass(storage,{fetcher:wiki,now:300,complete:async()=>{enter();await gate;return '{"lessons":[]}';}});
  await entered;
  await studyTurn(storage,{action:'stop'});
  await studyTurn(storage,{action:'resume'});
  const ownerState = await storage.get(STUDY_KEY);
  release();await running;
  assert.deepEqual(await storage.get(STUDY_KEY),ownerState);
  assert.equal((await storage.get(`${before.id}:summaries:0`)).length,60);
  assert.ok(transactions>=2,'production atomic checkpoint path exercised');
});

test('missing article content cannot become completed article-only study', async () => {
  const storage = memory();
  await studyTurn(storage,{...ask,subjects:['Martin']});
  await studyPass(storage,{fetcher:async url=>{
    const p=new URL(url).searchParams;
    return p.get('list')==='search'?wiki(url):p.get('action')==='parse'?Response.json({error:{code:'missingtitle'}}):Response.json({query:{pages:[{}]}});
  }});
  const [a]=await storage.get(STUDY_KEY);
  assert.equal(a.subjects[0].status,'pending');
  assert.match(a.last_error.message,/no readable show article/);
  assert.deepEqual(a.subjects[0].list_pages,[],'missing page never becomes a cited episode guide');
});

test('article-only lesson failures retry instead of completing the assignment', async () => {
  const storage=memory();
  await studyTurn(storage,{...ask,subjects:['Martin']});
  let calls=0;
  const fetcher=async url=>new URL(url).searchParams.get('action')==='parse'?Response.json({error:{code:'missingtitle'}}):wiki(url);
  const complete=async()=>{calls++;throw new Error('Workers AI unavailable');};
  await studyPass(storage,{fetcher,complete});
  await studyPass(storage,{fetcher,complete});
  const [a]=await storage.get(STUDY_KEY);
  assert.equal(calls,2);
  assert.equal(a.subjects[0].status,'pending');
  assert.notEqual(a.status,'done');
  assert.match(a.last_error.message,/Workers AI unavailable/);
});

test('a Wikipedia rate limit schedules the next pass after Retry-After, keeping the place', async () => {
  const storage = memory();
  await studyTurn(storage,ask,{now:100});
  await studyPass(storage,{now:200,fetcher:async url=>new URL(url).searchParams.get('list')==='search'?wiki(url):new Response('slow down',{status:429,headers:{'Retry-After':'600'}})});
  const [a] = await storage.get(STUDY_KEY);
  assert.equal(a.subjects[0].status,'pending');
  assert.equal(a.last_error.retry_after_s,600);
  assert.match(a.log.at(-1).text,/429/);
  assert.equal(await storage.get(STUDY_WAKE_KEY),200+600_000);
});
