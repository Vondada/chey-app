// A chat turn that really did something carries an execution receipt on its done frame, with the real id: a picture
// saved, a render dispatched, a coding job queued. A failed or refused action carries none. The wording here is not
// taken from the certification question bank.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { derivedReceipt, noCommitNote, turnReceipt } from './action_receipts.js';
import { chatPictureTurn, pictureMeta, pictureSizeNote } from './chat_image_provider.js';
import { videoRequestSeconds } from './video_route.js';

const generated = new URL('./.action_turn_receipts.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null,
  };
}

async function paired(env, saved = new Map()) {
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message) => {
    const raw = await (await send('/api/chat', { message }, token)).text();
    const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { raw, reply: lines.filter((l) => l.type === 'delta').map((l) => l.delta).join(''), done: lines.find((l) => l.type === 'done') || {} };
  };
  return { say, saved };
}

test('turnReceipt: only success or queued, and only with a real id', () => {
  const ok = turnReceipt({ tool: 'x', operation: 'y', status: 'queued', id: 'job-1' }, new Date('2026-11-01T00:00:00Z'));
  assert.deepEqual(ok, { tool: 'x', operation: 'y', status: 'queued', id: 'job-1', created_at: '2026-11-01T00:00:00.000Z' });
  assert.equal(turnReceipt({ tool: 'x', operation: 'y', status: 'success', id: '' }), null, 'no id, no receipt');
  assert.equal(turnReceipt({ tool: 'x', operation: 'y', status: 'failed', id: 'a' }), null, 'a failure is never a receipt');
  assert.equal(turnReceipt({ tool: 'x', operation: 'y', status: 'skipped', id: 'a' }), null);
});

test('derivedReceipt: real actions get a receipt from their done facts; reads, repeats and failures get none', () => {
  const pick = (m) => { const r = derivedReceipt(m); return r && [r.tool, r.status, r.id]; };
  assert.deepEqual(pick({ source: 'che_self_development', background_job_id: 'j1', background_job_status: 'queued' }), ['coding_job', 'queued', 'j1']);
  assert.deepEqual(pick({ source: 'che_self_development', runtime: 'opencode', job_id: 'j2', state: 'queued' }), ['coding_job', 'queued', 'j2']);
  assert.equal(pick({ source: 'che_self_development', job_id: 'j2', state: 'running' }), null, 'a job past queued was not queued by this turn');
  assert.equal(pick({ source: 'che_self_development', failure_class: 'internal' }), null, 'a failed save has no job id');
  assert.equal(pick({ source: 'che_coding_status', background_job_id: 'j1', background_job_status: 'queued' }), null, 'a status read is not an action');
  assert.deepEqual(pick({ source: 'video_renderer', video_status: 'queued', task_id: 'gha_1', dispatched: true }), ['video_renderer', 'queued', 'gha_1']);
  assert.equal(pick({ source: 'video_renderer', video_status: 'queued', task_id: 'gha_1' }), null, 'checking a pending render dispatches nothing');
  assert.equal(pick({ source: 'video_renderer', video_status: 'not_created', ok: false }), null);
  assert.deepEqual(pick({ source: 'video_renderer', video_status: 'complete', media_type: 'video', media_id: 'm1' }), ['video_renderer', 'success', 'm1']);
  assert.deepEqual(pick({ source: 'che_trading_desk', order_sent: true, order_id: 'o1' }), ['alpaca_paper', 'success', 'o1']);
  assert.equal(pick({ source: 'che_trading_desk', order_sent: true, order_id: 'o1', repeated: true }), null, 'a retried yes sent nothing new');
  assert.equal(pick({ source: 'che_trading_desk', order_sent: false }), null);
  const own = { tool: 'arithmetic', status: 'success' };
  assert.equal(derivedReceipt({ source: 'che_self_development', background_job_id: 'j1', background_job_status: 'queued', execution_receipts: [own] }), null, 'a route\'s own receipt is kept');
});

test('noCommitNote: only for a queued job and a request that asks for a commit or SHA', () => {
  assert.match(noCommitNote('push the change and tell me its sha'), /No commit has been made yet/);
  assert.equal(noCommitNote('make the banner friendlier'), '');
  assert.equal(noCommitNote('commit it', 'running'), '');
  assert.equal(noCommitNote('a commitment to tidy code'), '', 'a longer word is not the verb');
});

test('a saved picture carries a success receipt with its media id; a failed one carries none', async () => {
  const env = {};
  const storage = storageFor(new Map());
  const made = await chatPictureTurn(env, storage, {
    message: 'Draw me two pictures of a lighthouse at dusk, 512x512 please', origin: 'https://che.example',
    makeImages: async () => [
      { number: 1, ok: true, id: 'media-aaa', mime_type: 'image/jpeg', title: 'lighthouse', status: 200, engine: 'workers-ai' },
      { number: 2, ok: false, reason: 'the engine timed out', status: 502 },
    ],
  });
  assert.equal(made.meta.execution_receipts.length, 1, 'one receipt for the one saved picture');
  const [r] = made.meta.execution_receipts;
  assert.equal(r.status, 'success');
  assert.equal(r.id, 'media-aaa');
  assert.equal(r.tool, 'image_generation');
  assert.match(made.text, /You asked for 512 by 512 pixels; I cannot set a picture's size/);

  const failed = await chatPictureTurn(env, storage, {
    message: 'paint a fox in the snow', origin: 'https://che.example',
    makeImages: async () => [{ number: 1, ok: false, reason: 'no image', status: 502 }],
  });
  assert.equal(failed.meta.execution_receipts, undefined, 'nothing made, no receipt');
  assert.doesNotMatch(failed.text, /pixels/);
});

test('a started Modal picture is queued with its call id; a refused one has no receipt', () => {
  const started = pictureMeta({ status: 202, call_id: 'fc-123' });
  assert.equal(started.execution_receipts[0].status, 'queued');
  assert.equal(started.execution_receipts[0].id, 'fc-123');
  assert.equal(pictureMeta({ status: 402, http_status: 402 }).execution_receipts, undefined);
});

test('the size note appears only when a pixel size is named', () => {
  assert.equal(pictureSizeNote('a sunset over the sea'), '');
  assert.match(pictureSizeNote('an icon, 1024 × 768'), /1024 by 768/);
});

test('a video length written as a word is the length asked for', () => {
  assert.equal(videoRequestSeconds('Make a ten-second clip of rain on a window.'), 10);
  assert.equal(videoRequestSeconds('a thirty second video about owls'), 30);
  assert.equal(videoRequestSeconds('a video about owls'), 15);
  assert.equal(videoRequestSeconds('a 20 second video'), 20);
});

/** GitHub with the video workflow: dispatches answer `status`. */
function githubVideo(status = 204) {
  const gh = { dispatches: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url || input);
    if (/\/dispatches$/.test(url)) { gh.dispatches += 1; return new Response(null, { status }); }
    if (url.includes('/actions/workflows/che-video-render.yml/runs')) return Response.json({ workflow_runs: [] });
    throw new TypeError(`fetch failed (offline: ${url})`);
  };
  gh.restore = () => { globalThis.fetch = original; };
  return gh;
}

const VIDEO_ENV = () => ({
  CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_GITHUB_TOKEN: 'gh-test', CHE_GITHUB_REPO: 'Vondada/chey-app',
  AI: { run: async () => ({ response: 'unused' }) },
});

test('a dispatched video render carries a queued receipt with the task id and the length asked for', async () => {
  const gh = githubVideo(204);
  try {
    const che = await paired(VIDEO_ENV());
    const out = await che.say('Please make a ten-second video of a thunderstorm over the prairie.');
    assert.equal(gh.dispatches, 1);
    assert.match(out.reply, /a 10-second vertical video/);
    const [r] = out.done.execution_receipts;
    assert.equal(r.status, 'queued', 'queued, never success: no MP4 exists yet');
    assert.equal(r.id, out.done.task_id);
    assert.match(r.id, /^gha_/);
  } finally { gh.restore(); }
});

test('a refused video dispatch carries no receipt', async () => {
  const gh = githubVideo(403);
  try {
    const che = await paired(VIDEO_ENV());
    const out = await che.say('Please make a ten-second video of a thunderstorm over the prairie.');
    assert.notEqual(out.done.video_status, 'queued');
    assert.equal(out.done.execution_receipts, undefined);
  } finally { gh.restore(); }
});

const CODING_ENV = () => ({
  CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r',
  AI: { run: async () => ({ response: 'unused' }) },
});

test('a queued coding job carries a queued receipt with the job id, also when autonomy is paused', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  try {
    const saved = new Map();
    const che = await paired(CODING_ENV(), saved);
    const data = saved.get('che');
    data.autonomy = false;
    saved.set('che', data);
    const out = await che.say('Update your code: fix the spelling of "recieve" in the welcome banner and send me the commit hash.');
    assert.equal(out.done.source, 'che_self_development', JSON.stringify(out));
    const job = saved.get('che').jobs.find((j) => j.kind === 'self_development');
    assert.ok(job, 'the job was really saved');
    const [r] = out.done.execution_receipts;
    assert.equal(r.status, 'queued');
    assert.equal(r.id, job.id);
    assert.equal(saved.get('che').autonomy, false, 'autonomy stayed paused: the job waits, it was not run');
    assert.match(out.reply, /autonomy is paused/);
    assert.match(out.reply, /No commit has been made yet, so there is no commit SHA/);
    assert.doesNotMatch(out.reply, /I committed|committed the fix/i);
  } finally { globalThis.fetch = original; }
});

test('a coding request that does not ask for a commit gets the receipt and no commit sentence', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  try {
    const saved = new Map();
    const che = await paired(CODING_ENV(), saved);
    const out = await che.say('Update your code: make the ready banner friendlier');
    assert.equal(out.done.execution_receipts[0].status, 'queued');
    assert.doesNotMatch(out.reply, /No commit has been made/);
  } finally { globalThis.fetch = original; }
});
