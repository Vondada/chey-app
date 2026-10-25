// CHE service onboarding (owner, 2026-10-25): "CHE, connect Hugging Face."
//
// One persisted state machine per provider + capability (the idempotency key):
//
//   check_existing → account (owner) → token_requested → token_created
//     → secret_configured (destinations) → verified (capability results)
//   any step → paused (owner_auth | captcha | missing_info | spending) → resumes where it stopped
//   any step → failed (reason)
//
// Rules this module enforces in code:
// - A working connection is preserved: start() verifies the token CHE already
//   uses first and creates nothing when it works.
// - No duplicate tokens: once a token is announced (token_created, by its
//   fingerprint) a retry asks the device to post THAT token. A new one is
//   requested only after the device reports the first one lost (and revoked
//   where the provider supports revocation).
// - Replace only if valid: a new token is tested before it overwrites
//   anything; on failure the old connection is untouched.
// - "Connected" only after verification against the token the consumers
//   actually read (the merged runtime env), never on a save alone.
// - Secrets: the token arrives once over TLS in the /secret body, is tested,
//   stored in the Worker's runtime key store and dropped. State, status,
//   letters and replies carry only a fingerprint (sha256 prefix + last 4).
//   Everything outward goes through redactSecrets as a second guard.

import { KEY_PROVIDERS, STORED_KEY_WINS, fileLetter, storedKeyWins, storedKeys, testKey } from './resilience.js';
import { redactSecrets } from './privacy_policy.js';
import { putRepositorySecret } from './github_secrets.js';
import { durationSeconds, kaggleAuth, kaggleCall } from './film_farm.js';
import { ADAPTERS as GPU_ADAPTERS } from './gpu_providers.js';
import { MODAL_FORMAT_HELP, isModalDeployToken, modalHealth, parseModalCredential } from './modal_gpu.js';

export const STATES = Object.freeze(['check_existing', 'account', 'token_requested', 'token_created', 'secret_configured', 'verified', 'paused', 'failed']);
export const PAUSE_REASONS = Object.freeze(['owner_auth', 'captcha', 'missing_info', 'spending']);
const PREFIX = 'onboarding:';
const HF = 'https://huggingface.co';

// ─── Fingerprints: the only form of a token that is ever kept ─────────────
export async function fingerprint(token) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token))));
  const hex = [...bytes.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { fingerprint: `sha256:${hex}`, last4: String(token).slice(-4) };
}

const clip = (v, n = 200) => redactSecrets(String(v ?? '')).slice(0, n);
const today = (now) => new Date(now).toISOString().slice(0, 10);

// ─── Hugging Face ─────────────────────────────────────────────────────────
// Token page: https://huggingface.co/settings/tokens/new (fine-grained tab).
// Permission labels are the ones the fine-grained form shows; ids are the
// strings whoami-v2 reports under auth.accessToken.fineGrained. Verified on
// the real form only from the owner's iPhone (huggingface.co is not reachable
// from CHE's build containers); the device driver selects by label text.
const HF_PERMS = {
  inference: { id: 'inference.serverless.write', label: 'Make calls to Inference Providers' },
  gated_read: { id: 'repo.content.read', label: 'Read access to contents of all public gated repos you can access' },
  repo_write: { id: 'repo.write', label: 'Write access to contents/settings of all repos under your personal namespace' },
};

const HF_CAPABILITIES = {
  inference: {
    title: 'inference',
    uses: 'CHE\'s Hugging Face chat engine (router.huggingface.co) and the Kokoro voice fallback',
    permissions: ['inference'],
    works: 'download public models and use Hugging Face Inference Providers for my chat engine and backup voice',
    destinations: ['worker'],
  },
  download: {
    title: 'downloads',
    uses: 'model and dataset downloads, including public gated repos you were granted',
    permissions: ['gated_read'],
    works: 'download public models and the gated models your account was granted',
    destinations: ['worker'],
  },
  film_space: {
    title: 'film space',
    uses: 'Film Studio\'s free ZeroGPU Space, which CHE creates in your account on the first film',
    permissions: ['repo_write', 'inference'],
    works: 'create and run Film Studio\'s ZeroGPU Space in your account and use Inference Providers',
    destinations: ['worker'],
  },
  actions: {
    title: 'actions',
    uses: 'GitHub Actions jobs that read HF_TOKEN (the deploy key sync and the OpenCode runtime)',
    permissions: ['inference'],
    works: 'use Hugging Face from CHE\'s Worker and from GitHub Actions',
    destinations: ['worker', 'github'],
  },
};

async function hfJson(fetcher, url, token, method = 'GET') {
  try {
    const r = await fetcher(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    let body = null;
    if (method !== 'HEAD') body = await r.json().catch(() => null);
    return { http: r.status, ok: r.ok, body };
  } catch (_) {
    return { http: 0, ok: false, body: null };
  }
}

// What the token is allowed to do, from Hugging Face's own description of it.
export function hfPermissionCheck(who, needs) {
  const at = who?.auth?.accessToken || {};
  const role = String(at.role || '');
  if (role === 'write' || role === 'admin') return { ok: true, role, missing: [] };
  if (role === 'read') {
    const missing = needs.filter((p) => p === 'repo_write');
    return { ok: missing.length === 0, role, missing };
  }
  if (role === 'fineGrained') {
    const fg = at.fineGrained || {};
    const user = String(who?.name || '');
    const granted = new Set([...(Array.isArray(fg.global) ? fg.global : [])]);
    for (const s of Array.isArray(fg.scoped) ? fg.scoped : []) {
      if (s?.entity?.type === 'user' && (!user || s.entity.name === user)) for (const p of s.permissions || []) granted.add(p);
    }
    if (fg.canReadGatedRepos === true) granted.add(HF_PERMS.gated_read.id);
    const missing = needs.filter((p) => !granted.has(HF_PERMS[p].id));
    return { ok: missing.length === 0, role, missing };
  }
  return { ok: false, role: role || 'unknown', missing: needs, unknown: true };
}

export const huggingface = {
  id: 'huggingface',
  name: 'Hugging Face',
  env: 'HF_TOKEN',
  mode: 'device', // CHE's browser creates the token with the owner's session
  capabilities: HF_CAPABILITIES,
  defaultCapability: 'inference',
  signup: `${HF}/join`,
  validToken: (t) => /^hf_[A-Za-z0-9]{30,64}$/.test(String(t || '')),
  plan(capability, { attempt = 1, now = Date.now(), account = '' } = {}) {
    const cap = HF_CAPABILITIES[capability];
    return {
      kind: 'device_browser',
      url: `${HF}/settings/tokens/new?tokenType=fineGrained`,
      signin_url: `${HF}/login?next=${encodeURIComponent('/settings/tokens/new?tokenType=fineGrained')}`,
      signup_url: `${HF}/join`,
      token_type: 'fineGrained',
      token_name: `CHE ${cap.title} ${today(now)}${attempt > 1 ? ` #${attempt}` : ''}`,
      permissions: cap.permissions.map((p) => HF_PERMS[p].label),
      expected_account: account,
      revoke_url: `${HF}/api/credentials/revoke`,
    };
  },
  // Every check is free: no inference is run and nothing is created.
  async verify(token, capability, { fetcher = fetch, account = '' } = {}) {
    const cap = HF_CAPABILITIES[capability];
    const checks = [];
    const who = await hfJson(fetcher, `${HF}/api/whoami-v2`, token);
    const name = String(who.body?.name || '');
    if (who.http === 429) return { ok: false, auth: 'rate_limited', checks: [{ id: 'auth', ok: false, detail: 'Hugging Face rate-limited the identity check (whoami-v2 is strict); try again in a few minutes.' }] };
    if (!who.ok || !name) {
      return { ok: false, auth: who.http === 401 ? 'invalid' : who.http ? 'refused' : 'network',
        checks: [{ id: 'auth', ok: false, detail: who.http === 401 ? 'Hugging Face says the token is invalid (HTTP 401).' : who.http ? `Hugging Face refused the identity check (HTTP ${who.http}).` : 'Hugging Face could not be reached.' }] };
    }
    checks.push({ id: 'auth', ok: true, detail: `Hugging Face account ${clip(name, 60)}` });
    if (account && account.toLowerCase() !== name.toLowerCase()) {
      checks.push({ id: 'account', ok: false, detail: `The token belongs to ${clip(name, 60)}, not your approved account ${clip(account, 60)}.` });
      return { ok: false, auth: 'wrong_account', account: name, checks };
    }
    const perm = hfPermissionCheck(who.body, cap.permissions);
    const roleSaid = perm.role === 'fineGrained' ? 'fine-grained' : perm.role === 'read' ? 'read-only' : perm.role;
    checks.push({ id: 'permissions', ok: perm.ok, detail: perm.ok ? `token ${roleSaid}, with ${cap.permissions.map((p) => `"${HF_PERMS[p].label}"`).join(' and ')}`
      : perm.unknown ? 'Hugging Face did not describe this token\'s permissions.' : `token ${roleSaid} is missing ${perm.missing.map((p) => `"${HF_PERMS[p].label}"`).join(', ')}` });
    // The model CHE's voice fallback uses: proves the Hub accepts the token on a content route.
    const model = await hfJson(fetcher, `${HF}/api/models/hexgrad/Kokoro-82M`, token);
    checks.push({ id: 'download', ok: model.ok, detail: model.ok ? 'the Hub accepted the token for model metadata (hexgrad/Kokoro-82M)' : `the Hub refused the model lookup (HTTP ${model.http})` });
    if (cap.permissions.includes('inference')) {
      // The router's model list needs no credits; an invalid token is refused here.
      const router = await hfJson(fetcher, 'https://router.huggingface.co/v1/models', token);
      checks.push({ id: 'inference_router', ok: router.ok, detail: router.ok ? 'the Inference Providers router accepted the token (model list; no inference was run, nothing was spent)' : `the Inference Providers router refused the token (HTTP ${router.http})` });
    }
    if (cap.permissions.includes('repo_write')) {
      const spaces = await hfJson(fetcher, `${HF}/api/spaces?author=${encodeURIComponent(name)}&limit=5`, token);
      checks.push({ id: 'spaces', ok: spaces.ok && Array.isArray(spaces.body), detail: spaces.ok ? `listed your Spaces (${Array.isArray(spaces.body) ? spaces.body.length : 0} found); the Film Studio Space is created on the first film` : `could not list your Spaces (HTTP ${spaces.http})` });
    }
    return { ok: checks.every((c) => c.ok), auth: 'ok', account: name, role: perm.role, checks, works: cap.works };
  },
};

// ─── Guided providers: the owner creates the key; the same machine stores and verifies it ───
function guided(id) {
  const p = KEY_PROVIDERS[id];
  return {
    id, name: p.name, env: p.env, mode: 'guided',
    capabilities: { default: { title: 'default', uses: `CHE's ${p.name} engine`, permissions: [], works: `use ${p.name} through my engine rotation`, destinations: ['worker'] } },
    defaultCapability: 'default',
    validToken: (t) => String(t || '').trim().length >= 12 && !/\s/.test(String(t)),
    plan: () => ({ kind: 'guided', url: p.page, steps: [`Open ${p.page} and sign in yourself.`, 'Create a key. I stop for sign-in, captchas, codes and terms; those are yours.', 'Paste it in the secure field on this screen; it goes straight to my server, never into chat.'] }),
    async verify(token, _capability, { fetcher = fetch } = {}) {
      const t = await testKey(id, token, fetcher);
      const ok = t.status === 'healthy';
      return { ok, auth: ok ? 'ok' : t.status, checks: [{ id: 'auth', ok, detail: ok ? `${p.name} accepted the key (an authenticated model list, nothing spent)` : `${p.name} answered ${t.status}${t.code ? ` (HTTP ${t.code})` : ''}` }], works: `use ${p.name} through my engine rotation` };
    },
  };
}

// ─── GPU providers for the compute pool: guided, with a free read that proves the key (balance or quota) ───
// The owner creates the account, verifies his phone, loads prepaid credit and creates the key himself; CHE opens the
// page and its secure field. A saved key never starts a paid GPU by itself: the owner's GPU budget does
// (compute_budget.js, "allow up to $20 for GPUs").
const NEVER_CHAT = 'Paste it only into my secure field on this screen; it goes straight to my server. Never paste a key into chat.';
const GPU_ONCE = {
  kaggle: ['Sign in at kaggle.com (create the account yourself if you have none).', 'Verify your phone number in Kaggle settings: GPU sessions with internet need it.', 'In Settings, API, create a new token and copy it as username:token.', NEVER_CHAT],
  runpod: ['Sign in at runpod.io (create the account yourself if you have none).', 'Add prepaid credit yourself on the Billing page, for example 10 or 20 dollars. I never pay or add a card. RunPod needs one hour of credit to start a GPU.', 'In Settings, API Keys, create a key and copy it.', NEVER_CHAT, 'Then set a GPU budget: say "allow up to 20 dollars for GPUs". Until then I spend nothing.'],
  vast: ['Sign in at vast.ai (create the account yourself if you have none).', 'Add prepaid credit yourself on the Billing page. I never pay or add a card.', 'On the Keys page, create an API key and copy it.', NEVER_CHAT, 'Then set a GPU budget: say "allow up to 20 dollars for GPUs". Until then I spend nothing.'],
  // Modal (docs/CHE_MODAL_FREE_FIRST_USAGE_PRIVACY.md): the API token deploys CHE's app from GitHub Actions; the Worker
  // itself only ever holds a Proxy Auth Token for that app's endpoint (modal_gpu.js), verified by an authenticated /health.
  modal: ['Sign in at modal.com (create the account yourself if you have none; the Starter plan includes monthly compute credit).',
    'On Modal\'s Usage and Billing page, set the workspace spend limit to $0, so Modal stops work at the included credit instead of charging. I cannot see that setting; you tell me.',
    'In Modal Settings, API Tokens, create a token. Add its two parts as GitHub repository secrets MODAL_TOKEN_ID and MODAL_TOKEN_SECRET (GitHub, Settings, Secrets and variables, Actions). They never come to me.',
    'Run the "CHE Modal deploy" workflow in GitHub Actions. It deploys my app and prints its endpoint, like https://your-workspace--che-gpu.modal.run.',
    'In Modal Settings, Proxy Auth Tokens, create a token. Then say "CHE, connect Modal" and paste wk-ID:ws-SECRET@ and the endpoint into my secure field.', NEVER_CHAT,
    'I call my app once to verify it; only then is Modal connected. To let me use the credit, say "use Modal\'s free credit", "I set Modal\'s spend limit to zero" and "my Modal credit is 30 dollars" with your real figure.'],
};

function gpuGuided(id) {
  const base = guided(id);
  const p = KEY_PROVIDERS[id];
  const plain = p.name.replace(/\s*\(.*\)$/, '');
  return {
    ...base,
    capabilities: { default: { title: 'GPU', uses: `CHE's compute pool (character builds on a ${id === 'kaggle' ? 'free' : id === 'modal' ? 'Modal' : 'prepaid'} GPU)`, permissions: [], works: id === 'kaggle' ? 'use your free weekly Kaggle GPU quota for GPU jobs, before any paid GPU' : id === 'modal' ? 'send GPU-only character jobs to my Modal app after free GPUs, once you allow Modal\'s included credit' : `use ${plain} GPUs for GPU jobs no free GPU can take, only within the GPU budget you set`, destinations: ['worker'] } },
    validToken: id === 'modal' ? (t) => Boolean(parseModalCredential(t)) : base.validToken,
    badTokenDetail: id === 'modal' ? (t) => `${isModalDeployToken(t) ? 'That is a Modal API token, the deploy key. ' : 'That does not look like a Modal Proxy Auth Token with an endpoint. '}${MODAL_FORMAT_HELP} Nothing was stored.` : null,
    plan: () => ({ kind: 'guided', url: p.page, steps: GPU_ONCE[id] }),
    async verify(token, _capability, { fetcher = fetch } = {}) {
      const works = this.capabilities.default.works;
      if (id === 'kaggle') {
        const auth = kaggleAuth(String(token).trim());
        if (!auth?.username) return { ok: false, auth: 'missing_info', checks: [{ id: 'auth', ok: false, detail: 'Paste the Kaggle token as username:token; CHE needs the username to start a GPU kernel' }] };
        let r;
        try { r = await kaggleCall(auth, 'GetAcceleratorQuotaStatistics', {}, fetcher); } catch (_) { r = { status: 0, ok: false }; }
        if (!r.ok) return { ok: false, auth: r.status === 401 || r.status === 403 ? 'invalid' : r.status === 429 ? 'rate_limited' : r.status ? 'refused' : 'network', checks: [{ id: 'auth', ok: false, detail: `Kaggle ${r.status === 401 || r.status === 403 ? 'refused the token' : r.status ? `answered HTTP ${r.status}` : 'could not be reached'}` }] };
        const g = r.data?.gpuQuota || r.data?.gpu_quota || {};
        const left = Math.max(0, durationSeconds(g.totalTimeAllowed ?? g.total_time_allowed) - durationSeconds(g.timeUsed ?? g.time_used));
        const pay = Boolean(g.isPayToScaleEnabled ?? g.is_pay_to_scale_enabled);
        return { ok: true, auth: 'ok', account: auth.username, checks: [{ id: 'auth', ok: true, detail: `Kaggle account ${clip(auth.username, 40)}` },
          { id: 'quota', ok: true, detail: `Kaggle read your free GPU quota: ${(left / 3600).toFixed(1)} GPU hours left this week (read only, nothing spent)${pay ? '; pay-to-scale is on, so CHE will not start Kaggle sessions until you turn it off' : ''}` }], works };
      }
      if (id === 'modal') {
        // Connected only when CHE's own app answers an authenticated /health with the expected version.
        const h = await modalHealth(parseModalCredential(token), fetcher);
        return { ok: h.ok, auth: h.ok ? 'ok' : h.auth, checks: [{ id: 'auth', ok: h.ok, detail: h.detail }], works: h.ok ? works : undefined };
      }
      const b = await GPU_ADAPTERS[id].balance(String(token).trim(), fetcher);
      if (!b.ok) return { ok: false, auth: b.status === 'unauthorized' ? 'invalid' : b.status, checks: [{ id: 'auth', ok: false, detail: `${plain} ${b.status === 'unauthorized' ? 'refused the key' : b.status === 'network' ? 'could not be reached' : `answered ${b.status}${b.http ? ` (HTTP ${b.http})` : ''}`}` }] };
      return { ok: true, auth: 'ok', checks: [{ id: 'auth', ok: true, detail: `${plain} accepted the key` },
        { id: 'balance', ok: true, detail: `prepaid balance $${Number(b.usd).toFixed(2)} (a read-only balance check; nothing was started or spent)` }], works };
    },
  };
}
const GPU_GUIDED = new Set(['kaggle', 'runpod', 'vast', 'modal']);

// YouTube is Google sign-in (Connect YouTube), never a pasted key.
export const PROVIDERS = Object.freeze(Object.fromEntries(Object.keys(KEY_PROVIDERS).filter((id) => id !== 'youtube')
  .map((id) => [id, id === 'huggingface' ? huggingface : GPU_GUIDED.has(id) ? gpuGuided(id) : guided(id)])));

// ─── Persisted records ───────────────────────────────────────────────────
const keyOf = (provider, capability) => `${PREFIX}${provider}:${capability}`;

function fresh(provider, capability, now) {
  return { id: `${provider}:${capability}`, provider, capability, state: 'check_existing', attempt: 1, created_at: now, updated_at: now,
    account: { approved: '', seen: '' }, token: null, lost_tokens: [], destinations: [], verification: null, pause: null, failure: null, preserved: false, history: [] };
}

async function load(storage, provider, capability) {
  try { return (await storage.get(keyOf(provider, capability))) || null; } catch (_) { return null; }
}

async function save(storage, rec, state, note = '', now = Date.now()) {
  if (state && state !== rec.state) rec.history = [...(rec.history || []), { from: rec.state, to: state, at: now, note: clip(note, 160) }].slice(-40);
  if (state) rec.state = state;
  rec.updated_at = now;
  await storage.put(keyOf(rec.provider, rec.capability), rec);
  return rec;
}

function resolve(provider, capability) {
  const adapter = PROVIDERS[provider];
  if (!adapter) return { error: provider === 'youtube' ? 'YouTube connects with Google sign-in: say "connect YouTube" in Keys.' : 'I have no onboarding for that service yet.' };
  const cap = capability && adapter.capabilities[capability] ? capability : adapter.defaultCapability;
  if (capability && !adapter.capabilities[capability] && capability !== 'default') return { error: `${adapter.name} has no "${clip(capability, 40)}" capability. I know: ${Object.keys(adapter.capabilities).join(', ')}.` };
  return { adapter, capability: cap };
}

// ─── Outcome lines and speech: the honest three outcomes ─────────────────
export function outcomeLines(rec, adapter) {
  const name = adapter?.name || rec.provider;
  const t = rec.token;
  const tokenLine = rec.preserved ? 'Token created: no, your existing token already works, so I kept it.'
    : t ? `Token created: yes${t.name ? `, "${clip(t.name, 60)}"` : ''}, ending ${clip(t.last4, 4)}.` : 'Token created: not yet.';
  const configured = (rec.destinations || []).filter((d) => d.status === 'configured');
  const other = (rec.destinations || []).filter((d) => d.status !== 'configured');
  const secretLine = rec.preserved ? 'Secret configured: unchanged.'
    : configured.length || other.length ? `Secret configured: ${configured.length ? configured.map((d) => d.label).join('; ') : 'nowhere yet'}${other.length ? `. Not configured: ${other.map((d) => `${d.label} (${d.detail})`).join('; ')}` : ''}.`
      : 'Secret configured: not yet.';
  const v = rec.verification;
  const verifiedLine = rec.state === 'verified' && v?.ok
    ? `Connection verified: ${v.checks.filter((c) => c.ok).map((c) => c.detail).join('; ')}.`
    : v && !v.ok ? `Connection verified: no. ${v.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}.`
      : v?.provisional ? `Connection verified: not yet. ${v.checks.map((c) => c.detail).join('; ')}.` : 'Connection verified: not yet.';
  // A guided key was created by the owner, not by CHE: say "saved", never "created".
  const first = adapter?.mode === 'guided' && t && !rec.preserved ? `Token saved: yes, ending ${clip(t.last4, 4)} (you created it; I keep only its fingerprint ${clip(t.fingerprint, 20)}).` : tokenLine;
  return [first, secretLine, verifiedLine].map((l) => clip(l, 600));
}

export function speakOutcome(rec, adapter) {
  const name = adapter?.name || rec.provider;
  const v = rec.verification;
  if (rec.state === 'verified' && v?.ok) {
    const auth = v.checks.find((c) => c.id === 'auth')?.detail || name;
    const perm = v.checks.find((c) => c.id === 'permissions')?.detail;
    return clip(`Connected: ${auth}${perm ? `, ${perm.split(', with')[0]}` : ''}. I can ${v.works || 'use it'}.${rec.preserved ? ' It was already working, so I created nothing new.' : ''}`, 500);
  }
  if (rec.state === 'paused') return clip(`${name} setup is paused: ${rec.pause?.detail || rec.pause?.reason}.${rec.pause?.step === 'confirm_account' ? '' : ` Say "connect ${name}" when you're ready and I'll continue from here.`}`, 400);
  if (rec.state === 'failed') return clip(`${name} is not connected: ${rec.failure?.detail || rec.failure?.reason}.`, 400);
  if (rec.state === 'secret_configured' && v?.provisional) return clip(`${name}: the key is saved in my server's key store, but it is not verified: ${v.checks[0]?.detail || 'there is no free check'}.`, 400);
  if (rec.state === 'secret_configured') return clip(`${name}: the token is stored but the connection is not verified yet.`, 300);
  if (rec.state === 'token_created') return clip(`${name}: a token was created and I am waiting for it to reach my server; it is not connected yet.`, 300);
  return clip(`${name} is not connected yet (step: ${rec.state.replace('_', ' ')}).`, 300);
}

export function publicView(rec, adapter) {
  if (!rec) return null;
  return JSON.parse(redactSecrets(JSON.stringify({
    id: rec.id, provider: rec.provider, capability: rec.capability, state: rec.state, attempt: rec.attempt, preserved: rec.preserved,
    account: rec.account, token: rec.token ? { fingerprint: rec.token.fingerprint, last4: rec.token.last4, name: rec.token.name, at: rec.token.at } : null,
    lost_tokens: rec.lost_tokens, destinations: rec.destinations, verification: rec.verification, pause: rec.pause, failure: rec.failure,
    outcomes: {
      token_created: Boolean(rec.token) && !rec.preserved,
      secret_configured: (rec.destinations || []).filter((d) => d.status === 'configured').map((d) => d.id),
      connection_verified: rec.state === 'verified' && rec.verification?.ok === true,
    },
    lines: outcomeLines(rec, adapter), speech: speakOutcome(rec, adapter), updated_at: rec.updated_at,
  })));
}

// ─── Engine ──────────────────────────────────────────────────────────────
// ctx: { storage, env (Worker secrets), keyEnv() → merged env consumers read,
//        refresh() → re-merges stored keys, fetcher, now }
const effectiveToken = (ctx, adapter) => String((ctx.keyEnv?.() || ctx.env || {})[adapter.env] || '');

async function runVerify(ctx, adapter, rec, token) {
  const result = await adapter.verify(token, rec.capability, { fetcher: ctx.fetcher || fetch, account: rec.account?.approved || '' });
  return { ...result, at: ctx.now?.() || Date.now(), checks: result.checks.map((c) => ({ id: c.id, ok: Boolean(c.ok), detail: clip(c.detail, 240) })) };
}

export async function onboardingStatus(ctx, provider, capability) {
  const r = resolve(provider, capability);
  if (r.error) return { ok: false, status: 404, detail: r.error };
  const rec = await load(ctx.storage, provider, r.capability);
  return { ok: true, ...(rec ? publicView(rec, r.adapter) : { provider, capability: r.capability, state: 'none', speech: `${r.adapter.name} onboarding has not started.`, lines: [] }) };
}

// Starts or resumes. Never creates a second token while one is outstanding.
export async function startOnboarding(ctx, provider, { capability = '', account = '', lost_fingerprint = '', revoked = false } = {}) {
  const r = resolve(provider, capability);
  if (r.error) return { ok: false, status: 404, detail: r.error };
  const { adapter } = r;
  const now = ctx.now?.() || Date.now();
  let rec = (await load(ctx.storage, provider, r.capability)) || fresh(provider, r.capability, now);
  if (account) rec.account = { ...rec.account, approved: clip(account, 80) };

  // A token was announced and never stored: post that one, or report it lost.
  if (rec.state === 'token_created' && rec.token) {
    if (!lost_fingerprint) {
      await save(ctx.storage, rec, null, '', now);
      return { ok: true, action: 'post_held_token', fingerprint: rec.token.fingerprint, ...publicView(rec, adapter), speech: `${adapter.name}: I already created a token (ending ${rec.token.last4}). I'll store that one instead of making another.` };
    }
    if (lost_fingerprint !== rec.token.fingerprint) return { ok: false, status: 409, detail: 'That is not the outstanding token; nothing changed.' };
    rec.lost_tokens = [...(rec.lost_tokens || []), { ...rec.token, revoked: revoked === true, lost_at: now }].slice(-10);
    rec.token = null;
    rec.attempt = (rec.attempt || 1) + 1;
    await save(ctx.storage, rec, 'token_requested', revoked ? 'token lost; revoked by value' : 'token lost; not revoked', now);
  }

  // 1. check_existing: a working connection is preserved.
  const current = effectiveToken(ctx, adapter);
  if (current && rec.state !== 'paused') {
    await save(ctx.storage, rec, 'check_existing', 'checking the token CHE already uses', now);
    const v = await runVerify(ctx, adapter, rec, current);
    if (v.ok && !v.provisional) {
      rec.verification = v; rec.preserved = true; rec.failure = null; rec.pause = null;
      rec.account = { ...rec.account, seen: v.account || rec.account.seen };
      await save(ctx.storage, rec, 'verified', 'existing connection works; nothing created', now);
      return { ok: true, action: 'none', ...publicView(rec, adapter) };
    }
    rec.existing = { fingerprint: (await fingerprint(current)).fingerprint, ok: false, auth: v.auth, at: now };
    if (v.auth === 'rate_limited' || v.auth === 'network') {
      rec.verification = v;
      rec.failure = { reason: v.auth, detail: v.checks[0]?.detail || v.auth };
      await save(ctx.storage, rec, 'failed', 'could not check the existing token', now);
      return { ok: false, status: 503, ...publicView(rec, adapter) };
    }
  }
  rec.preserved = false;

  // Stored but unverified: verify again rather than making a new token.
  if (rec.state === 'secret_configured' && current) return verifyOnboarding(ctx, provider, rec.capability);

  // 2. account (owner) → 3. token_requested, with the plan for the device or the guided page.
  const resumeFrom = rec.state === 'paused' ? rec.pause?.resume_state : '';
  rec.pause = null; rec.failure = null;
  if (adapter.mode === 'device' && !rec.account.approved && resumeFrom !== 'token_requested') await save(ctx.storage, rec, 'account', 'owner account check on the device', now);
  const plan = adapter.plan(rec.capability, { attempt: rec.attempt, now, account: rec.account.approved });
  rec.plan_name = plan.token_name || '';
  await save(ctx.storage, rec, 'token_requested', adapter.mode === 'device' ? 'device opens the token page' : 'owner creates the key on the provider page', now);
  return { ok: true, action: adapter.mode === 'device' ? 'create_token' : 'guided', plan, ...publicView(rec, adapter),
    speech: adapter.mode === 'device'
      ? `Setting up ${adapter.name} for ${adapter.capabilities[rec.capability].uses}. I'm opening your ${adapter.name} token page in my browser to create "${plan.token_name}" with only ${plan.permissions.map((p) => `"${p}"`).join(' and ')}. I'll stop if ${adapter.name} needs you to sign in or solve a check.`
      : `Setting up ${adapter.name}. ${adapter.name} keys are created on their own page with your sign-in, so I open it and you paste the key into my secure field; it goes straight to my server, never into chat.`
        + (GPU_GUIDED.has(provider) ? ` What you do once: ${plan.steps.map((s, i) => `${i + 1}. ${s}`).join(' ')}` : '') };
}

// Device reports: account seen, pause, token created (fingerprint only).
export async function onboardingEvent(ctx, provider, body = {}) {
  const r = resolve(provider, body.capability);
  if (r.error) return { ok: false, status: 404, detail: r.error };
  const { adapter } = r;
  const now = ctx.now?.() || Date.now();
  const rec = await load(ctx.storage, provider, r.capability);
  if (!rec) return { ok: false, status: 409, detail: 'Start onboarding first.' };
  const kind = String(body.kind || '');
  if ('token' in body || redactSecrets(JSON.stringify(body)) !== JSON.stringify(body)) return { ok: false, status: 400, detail: 'Events never carry a secret; nothing was recorded.' };
  if (kind === 'paused') {
    const reason = PAUSE_REASONS.includes(body.reason) ? body.reason : 'missing_info';
    const resume = rec.state === 'paused' ? rec.pause?.resume_state : rec.state;
    rec.pause = { reason, step: clip(body.step, 80), detail: clip(body.detail || reason.replace('_', ' '), 240), resume_state: resume, at: now };
    await save(ctx.storage, rec, 'paused', `paused: ${reason}`, now);
    return { ok: true, ...publicView(rec, adapter) };
  }
  if (kind === 'account_seen') {
    const seen = clip(body.username, 80);
    rec.account = { ...rec.account, seen };
    if (rec.account.approved && seen && rec.account.approved.toLowerCase() !== seen.toLowerCase()) {
      rec.failure = { reason: 'wrong_account', detail: `The browser is signed in to ${seen}, not your approved account ${rec.account.approved}. I created nothing.` };
      await save(ctx.storage, rec, 'failed', 'wrong account signed in', now);
      return { ok: false, status: 409, ...publicView(rec, adapter) };
    }
    if (!rec.account.approved) {
      rec.pause = { reason: 'missing_info', step: 'confirm_account', detail: seen ? `I'm signed in to ${adapter.name} as ${seen}. Say "yes, use ${seen} on ${adapter.name}" to approve it` : `I could not read which ${adapter.name} account is signed in. Say "yes, use" and your ${adapter.name} username, then "on ${adapter.name}"`, resume_state: 'token_requested', at: now };
      await save(ctx.storage, rec, 'paused', 'account needs owner approval', now);
      return { ok: true, needs_approval: true, ...publicView(rec, adapter) };
    }
    await save(ctx.storage, rec, null, '', now);
    return { ok: true, ...publicView(rec, adapter) };
  }
  if (kind === 'token_created') {
    const fp = String(body.fingerprint || '');
    if (!/^sha256:[0-9a-f]{12}$/.test(fp)) return { ok: false, status: 400, detail: 'A token fingerprint is required.' };
    if (rec.state === 'token_created' && rec.token && rec.token.fingerprint !== fp) return { ok: false, status: 409, detail: `A token (ending ${rec.token.last4}) is already outstanding; a second one is refused. Post that token or report it lost.` };
    if (rec.state === 'token_created' && rec.token?.fingerprint === fp) return { ok: true, duplicate: true, ...publicView(rec, adapter) };
    if (rec.state !== 'token_requested') return { ok: false, status: 409, detail: `A token cannot be announced at step ${rec.state}.` };
    rec.token = { fingerprint: fp, last4: clip(body.last4, 4), name: clip(body.name || rec.plan_name, 80), at: now };
    await save(ctx.storage, rec, 'token_created', 'device created the token', now);
    return { ok: true, ...publicView(rec, adapter) };
  }
  return { ok: false, status: 400, detail: 'Unknown event.' };
}

// The token itself, once. Tested before it replaces anything.
export async function storeSecret(ctx, provider, body = {}) {
  const r = resolve(provider, body.capability);
  if (r.error) return { ok: false, status: 404, detail: r.error };
  const { adapter } = r;
  const now = ctx.now?.() || Date.now();
  const token = String(body.token || '').trim();
  if (!adapter.validToken(token)) return { ok: false, status: 422, detail: adapter.badTokenDetail?.(token) || `That does not look like a ${adapter.name} token. Nothing was stored.` };
  const fp = await fingerprint(token);
  const rec = (await load(ctx.storage, provider, r.capability)) || fresh(provider, r.capability, now);

  // Retried POST of the same token: return what already happened.
  if (rec.secret_fingerprint === fp.fingerprint && ['secret_configured', 'verified'].includes(rec.state)) return { ok: true, duplicate: true, ...publicView(rec, adapter) };
  // A different token than the one announced would be a duplicate.
  if (rec.state === 'token_created' && rec.token && rec.token.fingerprint !== fp.fingerprint) {
    return { ok: false, status: 409, detail: `This is not the token CHE created (ending ${rec.token.last4}); a second token is refused. Nothing was stored.` };
  }
  if (!rec.token || rec.token.fingerprint !== fp.fingerprint) {
    // Guided paste (or a resumed device run): the owner created this token.
    rec.token = { fingerprint: fp.fingerprint, last4: fp.last4, name: clip(body.name || rec.plan_name || '', 80), at: now };
    rec.preserved = false;
    await save(ctx.storage, rec, 'token_created', 'token received', now);
  }

  // Replace only if valid: test the new token before touching anything.
  const pre = await runVerify(ctx, adapter, rec, token);
  if (pre.auth !== 'ok' || !pre.ok) {
    const current = effectiveToken(ctx, adapter);
    const keptOld = Boolean(current) && current !== token;
    rec.verification = pre;
    rec.failure = { reason: pre.auth === 'ok' ? 'capability_check_failed' : `token_${pre.auth}`, detail: `${adapter.name} did not accept the new token for ${adapter.capabilities[rec.capability].title}${keptOld ? '; your existing token is unchanged' : ''}. Nothing was stored` };
    await save(ctx.storage, rec, 'failed', 'new token failed its test; nothing stored', now);
    await fileLetter(ctx.storage, { tray: provider, subject: `${adapter.name} onboarding: new token rejected`, body: `Token ending ${fp.last4} (${fp.fingerprint}) failed: ${pre.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}. Nothing was stored.`, tag: 'system', severity: 'action' });
    return { ok: false, status: 422, ...publicView(rec, adapter) };
  }
  if (pre.account) rec.account = { ...rec.account, seen: pre.account, approved: rec.account.approved || pre.account };

  // 4. Destinations, each reported separately.
  const destinations = [];
  const wants = adapter.capabilities[rec.capability].destinations;
  // The Worker runtime key store: what refreshKeyEnv merges and every consumer reads.
  {
    const keys = await storedKeys(ctx.storage);
    keys[adapter.env] = token;
    const wins = storedKeyWins(keys);
    const workerSecret = String(ctx.env?.[adapter.env] || '');
    if (workerSecret && workerSecret !== token) wins.add(adapter.env); else wins.delete(adapter.env);
    keys[STORED_KEY_WINS] = [...wins];
    await ctx.storage.put('provider_keys', keys);
    const health = (await ctx.storage.get('key_health')) || {};
    health[provider] = { status: 'healthy', at: now, latency_ms: null, last4: fp.last4 };
    await ctx.storage.put('key_health', health);
    await ctx.refresh?.();
    const live = effectiveToken(ctx, adapter);
    const reads = live && (await fingerprint(live)).fingerprint === fp.fingerprint;
    destinations.push({ id: 'worker', label: 'CHE Worker runtime key store (read by the chat engine, voice and Film Studio)', status: reads ? 'configured' : 'failed',
      detail: reads ? (workerSecret && workerSecret !== token ? `it now takes precedence over the old ${adapter.env} Worker secret, which failed its check` : 'live without a redeploy') : 'the runtime still reads a different token' });
  }
  if (wants.includes('github')) {
    const env = ctx.keyEnv?.() || ctx.env || {};
    const out = await putRepositorySecret({ token: env.CHE_GITHUB_TOKEN, repo: env.CHE_GITHUB_REPO, name: adapter.env, value: token }, ctx.fetcher || fetch);
    destinations.push({ id: 'github', label: `GitHub Actions secret ${adapter.env}`, status: out.ok ? 'configured' : out.status, detail: clip(out.ok ? (out.created ? 'created' : 'updated') : out.detail, 240) });
  }
  rec.destinations = destinations;
  rec.secret_fingerprint = fp.fingerprint;
  rec.failure = null;
  const workerOk = destinations.find((d) => d.id === 'worker')?.status === 'configured';
  if (!workerOk) {
    rec.failure = { reason: 'secret_not_configured', detail: 'the Worker runtime does not read the new token' };
    await save(ctx.storage, rec, 'failed', 'runtime store not effective', now);
    return { ok: false, status: 500, ...publicView(rec, adapter) };
  }
  await save(ctx.storage, rec, 'secret_configured', `stored: ${destinations.filter((d) => d.status === 'configured').map((d) => d.id).join(', ')}`, now);
  await fileLetter(ctx.storage, { tray: provider, subject: `${adapter.name} token stored`, body: `Token ending ${fp.last4} (${fp.fingerprint}) stored in: ${destinations.map((d) => `${d.label}: ${d.status}`).join('; ')}.`, tag: 'system', severity: 'info' });
  // 5. Verify against what consumers actually read.
  return verifyOnboarding(ctx, provider, rec.capability);
}

export async function verifyOnboarding(ctx, provider, capability) {
  const r = resolve(provider, capability);
  if (r.error) return { ok: false, status: 404, detail: r.error };
  const { adapter } = r;
  const now = ctx.now?.() || Date.now();
  const rec = (await load(ctx.storage, provider, r.capability)) || fresh(provider, r.capability, now);
  const token = effectiveToken(ctx, adapter);
  if (!token) {
    rec.failure = { reason: 'missing_info', detail: `CHE has no ${adapter.name} token to verify` };
    await save(ctx.storage, rec, 'failed', 'nothing to verify', now);
    return { ok: false, status: 409, ...publicView(rec, adapter) };
  }
  const v = await runVerify(ctx, adapter, rec, token);
  rec.verification = v;
  if (v.ok && v.provisional) {
    // Stored, but no free check exists: never "Connected".
    rec.failure = null; rec.pause = null;
    await save(ctx.storage, rec, 'secret_configured', 'stored; no free verification exists', now);
    return { ok: true, ...publicView(rec, adapter) };
  }
  if (v.ok) {
    rec.failure = null; rec.pause = null;
    await save(ctx.storage, rec, 'verified', 'auth and capability checks passed', now);
    await fileLetter(ctx.storage, { tray: provider, subject: `${adapter.name} connected (${rec.capability})`, body: outcomeLines(rec, adapter).join('\n'), tag: 'system', severity: 'info' });
    return { ok: true, ...publicView(rec, adapter) };
  }
  rec.failure = { reason: v.auth === 'ok' ? 'capability_check_failed' : `token_${v.auth}`, detail: v.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ') };
  await save(ctx.storage, rec, 'failed', 'verification failed', now);
  return { ok: false, status: 422, ...publicView(rec, adapter) };
}

// ─── HTTP routes (owner-only, lockdown-aware; called from CheState.fetch) ──
export async function onboardingRoute(ctx, path, method, body, { owner = false, lockedDown = false, query = '' } = {}) {
  const m = /^\/api\/onboarding\/([a-z0-9_-]{2,30})(?:\/(start|secret|verify|event))?$/.exec(path);
  if (!m) return null;
  if (!owner) return { status: 403, body: { detail: 'Only the CHE owner can connect services.' } };
  const [, provider, action = ''] = m;
  if (method === 'GET' && !action) { const out = await onboardingStatus(ctx, provider, new URLSearchParams(query).get('capability') || ''); return { status: out.status || 200, body: out }; }
  if (method !== 'POST' || !action) return { status: 405, body: { detail: 'Use POST.' } };
  if (lockedDown && action !== 'verify') return { status: 423, body: { detail: 'Lockdown is on; key changes are frozen.' } };
  const run = { start: () => startOnboarding(ctx, provider, body || {}), event: () => onboardingEvent(ctx, provider, body || {}), secret: () => storeSecret(ctx, provider, body || {}), verify: () => verifyOnboarding(ctx, provider, body?.capability || '') }[action];
  const out = await run();
  return { status: out.status || 200, body: JSON.parse(redactSecrets(JSON.stringify(out))) };
}

// ─── Words ───────────────────────────────────────────────────────────────
const NAMES = [
  ['huggingface', /\bhugging ?face\b|\bhf\b/], ['groq', /\bgroq\b/], ['gemini', /\bgemini\b|\bgoogle ai studio\b/],
  ['cerebras', /\bcerebras\b/], ['mistral', /\bmistral\b/], ['openrouter', /\bopen ?router\b/], ['github', /\bgithub models\b/],
  ['sambanova', /\bsamba ?nova\b/], ['kaggle', /\bkaggle\b/], ['runpod', /\brun ?pod\b/], ['vast', /\bvast(?:\.ai| ai)?\b/], ['modal', /\bmodal\b/], ['openai', /\bopen ?ai\b|\bcodex\b/], ['xai', /\bx\.?ai\b|\bgrok\b/],
];

export function onboardingProvider(text) {
  const t = String(text || '').toLowerCase();
  return NAMES.find(([, re]) => re.test(t))?.[0] || null;
}

function capabilityFrom(t) {
  if (/\b(?:film|movie|space|zerogpu|zero gpu)\b/.test(t)) return 'film_space';
  if (/\b(?:github actions|actions|workflows?)\b/.test(t)) return 'actions';
  if (/\b(?:downloads?|gated)\b/.test(t)) return 'download';
  return '';
}

// "CHE, connect Hugging Face." / "connect hugging face for film studio" / "is hugging face connected?"
export function onboardingIntent(message) {
  const t = String(message || '').toLowerCase().replace(/^(?:hey |ok |okay )?(?:che|chay)[,:]?\s+/, '').replace(/[.!?]+$/, '').trim();
  if (!t || t.length > 120) return null;
  const status = /^(?:is|are)\s+(?:my\s+)?(.+?)\s+(?:still\s+)?connected(?:\s+(?:for|to)\s+(.+))?$/.exec(t) || /^(?:check|test|verify)\s+(?:my\s+|the\s+)?(.+?)\s+connection$/.exec(t);
  if (status) { const provider = onboardingProvider(status[1]); return provider ? { kind: 'status', provider, capability: capabilityFrom(t) } : null; }
  const yes = /^yes,?\s+use\s+([a-z0-9][\w.-]{0,60})\s+(?:on|for)\s+(.+)$/.exec(t);
  if (yes) { const provider = onboardingProvider(yes[2]); return provider ? { kind: 'connect', provider, capability: capabilityFrom(yes[2]), account: yes[1] } : null; }
  const connect = /^(?:please\s+)?(?:connect|hook up|link|onboard)\s+(?:to\s+)?(?:my\s+)?(.+?)(?:\s+(?:account|token|api|key))?(?:\s+(?:for|so)\s+(.+))?(?:\s+please)?$/.exec(t);
  if (!connect) return null;
  const provider = onboardingProvider(connect[1]);
  if (!provider) return null;
  return { kind: 'connect', provider, capability: capabilityFrom(`${connect[1]} ${connect[2] || ''}`) };
}

// ─── Chat replies (worker.js turns these into the ndjson reply) ──────────
export const CONNECT_HELP = 'I can connect Hugging Face automatically (I create the token in my browser with your sign-in), and guide you through Groq, Gemini, Cerebras, Mistral, OpenRouter, GitHub Models, SambaNova, OpenAI and xAI, plus the GPU providers for my compute pool: Kaggle (free weekly GPU), RunPod and Vast.ai (prepaid; used only within the GPU budget you set) and Modal (its included GPU credit, after free GPUs and only once you allow it). Say "connect" and one of those names. Never paste a key into chat: I open my secure field for it.';

// /connect-service <input>: the input may be a name or a whole sentence.
export function connectServiceIntent(input) {
  const words = String(input || '').trim();
  return onboardingIntent(words) || onboardingIntent(`connect ${words}`);
}

export async function onboardingChatReply(ctx, onboard, { owner = false } = {}) {
  const base = { source: 'che_onboarding' };
  if (!onboard) return { text: CONNECT_HELP, meta: { ...base, ok: false } };
  if (!owner) return { text: 'Only the CHE owner can connect services.', meta: { ...base, ok: false } };
  if (onboard.kind === 'status') {
    const out = await onboardingStatus(ctx, onboard.provider, onboard.capability);
    const text = out.state === 'none' ? `${out.speech} Say "connect" and the name to start.` : [out.speech, ...(out.lines || [])].join('\n');
    return { text, meta: { ...base, provider: onboard.provider, onboarding: out } };
  }
  const out = await startOnboarding(ctx, onboard.provider, { capability: onboard.capability, account: onboard.account || '' });
  if (!out.ok && !out.state) return { text: out.detail || 'I could not start that setup.', meta: { ...base, provider: onboard.provider, ok: false } };
  const action = out.action || 'none';
  const text = action === 'none' ? [out.speech, ...(out.lines || [])].join('\n') : out.speech;
  const deviceWork = ['create_token', 'guided', 'post_held_token'].includes(action);
  return { text, meta: { ...base, provider: onboard.provider, ok: out.ok !== false,
    onboarding: { provider: onboard.provider, capability: out.capability, state: out.state, action, plan: out.plan || null, fingerprint: out.fingerprint || '', lines: out.lines || [] },
    ...(deviceWork ? { open_screen: 'service_onboarding' } : {}) } };
}
