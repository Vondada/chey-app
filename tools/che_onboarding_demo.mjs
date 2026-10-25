// Command-to-connection demo for "CHE, connect Hugging Face." — offline.
//
// The real Worker runs in-process (as server/cloudflare tests run it) with its
// real routes; huggingface.co is a local fake (tools/fake_huggingface.mjs)
// served over HTTP to a real headless Chromium. The device steps are the ones
// lib/connect/che_service_onboarding.dart performs, replayed here with the
// same injected driver (assets/browser/che_hf_token_page.js), because a
// Flutter WebView cannot run in this container. Prints a redacted transcript.
//
// Run: NODE_PATH=<dir with playwright> node tools/che_onboarding_demo.mjs   (CHE_CHROMIUM=/path/to/chrome optional)
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fakeHuggingFace, hfFetch, serveFake } from './fake_huggingface.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const DRIVER = readFileSync(new URL('../assets/browser/che_hf_token_page.js', import.meta.url), 'utf8');
const W = new URL('../server/cloudflare/', import.meta.url);

const generated = new URL('./.onboarding_demo.generated.mjs', W);
writeFileSync(generated, readFileSync(new URL('./worker.js', W), 'utf8').replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
let mod;
try { mod = await import(generated.href); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;
const { replyFromNdjson } = await import(new URL('./brain_memory.js', W).href);

const fake = fakeHuggingFace({ user: 'vondada' });
globalThis.fetch = hfFetch(fake, async (i) => { throw new TypeError(`offline demo: ${new URL(String(i?.url || i)).host}`); });
const served = await serveFake(fake);

const saved = new Map();
const storage = {
  get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : saved.has(k) ? structuredClone(saved.get(k)) : undefined),
  put: async (k, v) => { if (k && typeof k === 'object') { for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); } else saved.set(k, structuredClone(v)); },
  delete: async (k) => saved.delete(k), list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))), setAlarm: async () => {}, deleteAlarm: async () => {},
};
const pending = [];
const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'model was not needed' }) } };
const state = new CheState({ storage, waitUntil: (p) => pending.push(p) }, env);
env.CHE_STATE = { getByName: () => state };
const call = async (path, body, method = 'POST') => {
  const res = await worker.fetch(new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), env);
  const text = await res.text();
  while (pending.length) await pending.shift();
  return { status: res.status, text };
};
let token = '';
token = JSON.parse((await call('/api/pair', { code: '123456' })).text).device_token;

let secretValue = '';
const transcript = [];
const fp = (v) => `sha256:${createHash('sha256').update(v).digest('hex').slice(0, 12)}`;
const redact = (s) => (secretValue ? String(s).split(secretValue).join(`[token ${fp(secretValue)}]`) : String(s));
const log = (who, text) => { const line = `${who}: ${redact(text)}`; transcript.push(line); console.log(line); };
const chat = async (words) => {
  log('Owner', words);
  const out = await call('/api/chat', { message: words, history: [] });
  const done = out.text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'done') || {};
  log('CHE', `${replyFromNdjson(out.text).replace(/\n/g, ' | ')}  [route ${done.source}${done.open_screen ? `, opens ${done.open_screen}` : ''}]`);
  return done;
};

const browser = await chromium.launch(process.env.CHE_CHROMIUM ? { executablePath: process.env.CHE_CHROMIUM } : {});
const page = await browser.newPage();
const step = async (js) => JSON.parse(await page.evaluate(`${DRIVER}\n${js}`));
try {
  let done = await chat('CHE, connect Hugging Face.');
  let plan = done.onboarding.plan;
  const local = plan.url.replace('https://huggingface.co', served.base);
  await page.goto(local);
  let seen = await step('window.__cheHf.detect()');
  log('Device', `opened ${plan.url} in CHE's browser; page=${seen.page}, signed in as ${seen.user}`);
  let r = await call('/api/onboarding/huggingface/event', { capability: 'inference', kind: 'account_seen', username: seen.user });
  log('Worker', JSON.parse(r.text).speech);
  done = await chat('yes, use vondada on hugging face');
  plan = done.onboarding.plan;
  await page.goto(local);
  seen = await step('window.__cheHf.detect()');
  r = await call('/api/onboarding/huggingface/event', { capability: 'inference', kind: 'account_seen', username: seen.user });
  log('Device', `account ${seen.user} matches the approved account (HTTP ${r.status})`);
  const filled = await step(`window.__cheHf.fill(${JSON.stringify(plan.token_name)}, ${JSON.stringify(plan.permissions)})`);
  log('Device', `filled "${plan.token_name}", fine-grained, ticked [${filled.checked.join('; ')}], unticked [${filled.unticked.join('; ')}]`);
  await step('window.__cheHf.submit()');
  await page.waitForSelector('#modal:not([hidden])');
  const read = await step('window.__cheHf.readToken()');
  secretValue = read.token;
  log('Device', `read the new token once from the page: ${read.token}`);
  r = await call('/api/onboarding/huggingface/event', { capability: 'inference', kind: 'token_created', fingerprint: fp(secretValue), last4: secretValue.slice(-4), name: plan.token_name });
  log('Worker', `token_created recorded: state=${JSON.parse(r.text).state}`);
  r = await call('/api/onboarding/huggingface/secret', { capability: 'inference', token: secretValue });
  const stored = JSON.parse(r.text);
  log('Device', 'POST /api/onboarding/huggingface/secret (the only request that carries the token)');
  log('Worker', `HTTP ${r.status} state=${stored.state}`);
  for (const line of stored.lines) log('Worker', line);
  log('CHE (spoken)', stored.speech);
  await chat('Is Hugging Face connected?');
  const keys = JSON.parse((await call('/api/keys', null, 'GET')).text).providers.find((p) => p.id === 'huggingface');
  log('Keys screen', `Hugging Face: ${keys.status}, ending ${keys.last4}`);
  log('Fake huggingface.co', `tokens created: ${fake.state.created.length}; permissions: ${JSON.stringify(fake.state.created[0].permissions)}; Worker calls: ${fake.calls.filter((c) => c.auth === 'bearer').map((c) => `${c.method} ${c.host}${c.path}`).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`);
  const wire = transcript.join('\n');
  const leaked = wire.includes(secretValue) || JSON.stringify([...saved].filter(([k]) => k !== 'provider_keys')).includes(secretValue);
  log('Check', `token in transcript or in any storage key other than the runtime key store: ${leaked ? 'YES (FAIL)' : 'no'}`);
  if (leaked || stored.state !== 'verified') process.exitCode = 1;
} finally {
  await browser.close();
  await served.close();
}
