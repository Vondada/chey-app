// Zero-cost evidence and model plan for CHE's OpenCode coding runner (owner rule, 2026-10-27:
// authorized AI spend is $0). The policy itself lives in server/cloudflare/model_router.mjs;
// this file only gathers evidence at request time and writes the files the runner uses. The
// runner calls a trusted copy taken from the base commit, so an attempt cannot change it.
//
//   attested                 print the owner-attested providers the runner should list with OpenCode
//   plan --out-dir D         gather evidence, rank eligible models, write routing.json, models.json,
//                            coverage.tsv, summary.txt and GITHUB_OUTPUT lines
//   config --base F --model M --models D/models.json --out F2
//                            the per-attempt OpenCode config: main and small model pinned to M, so
//                            OpenCode never picks another (possibly paid) model for titles
//   usage --phase before|after --dir D
//                            OpenRouter key usage before and after the attempts; an increase is a
//                            verified charge (billing_risk, exit 3)
//   ledger-merge --ledger F --record R --out F2
//
// Keys come from the environment (K_OPENROUTER, K_GOOGLE, K_GROQ, K_CEREBRAS, K_MISTRAL) and are
// only ever sent to their own provider. Nothing here prints a key or a key label.
// CHE_ZERO_COST_FIXTURES (tests only) maps URLs to { status, body } instead of the network.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_CANDIDATES, attestedProviders, listedModelUsable, mergeLedger, openRouterKeySummary, planCandidates, providerVerdict,
  spendAuthorization, taskKind,
} from '../server/cloudflare/model_router.mjs';

const KEY_ENV = Object.freeze({ openrouter: 'K_OPENROUTER', google: 'K_GOOGLE', groq: 'K_GROQ', cerebras: 'K_CEREBRAS', mistral: 'K_MISTRAL' });
// A cheap authenticated read per provider: it proves the key works and costs nothing.
const AUTH_URL = Object.freeze({
  openrouter: 'https://openrouter.ai/api/v1/key',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
  groq: 'https://api.groq.com/openai/v1/models',
  cerebras: 'https://api.cerebras.ai/v1/models',
  mistral: 'https://api.mistral.ai/v1/models',
});
const OPENROUTER_MODELS = 'https://openrouter.ai/api/v1/models';

function fixtures() {
  const path = process.env.CHE_ZERO_COST_FIXTURES;
  if (!path) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (_) { return {}; }
}

export async function getJson(url, key = '', { fetcher = fetch } = {}) {
  const fake = fixtures();
  if (fake) {
    const row = fake[url];
    if (!row) return { ok: false, status: 0, body: null };
    return { ok: row.status >= 200 && row.status < 300, status: row.status, body: row.body ?? null };
  }
  try {
    const response = await fetcher(url, {
      headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    let body = null;
    try { body = await response.json(); } catch (_) { body = null; }
    return { ok: response.ok, status: response.status, body };
  } catch (_) {
    return { ok: false, status: 0, body: null };
  }
}

function argValue(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : '';
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value).replace(/\n/g, ' ')}\n`);
}

function readJson(path) {
  try { return path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch (_) { return null; }
}

function openRouterModels(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows.filter((m) => m && typeof m.id === 'string').map((m) => ({
    id: `openrouter/${m.id}`,
    provider: 'openrouter',
    name: String(m.name || m.id).slice(0, 80),
    pricing: m.pricing && typeof m.pricing === 'object' ? m.pricing : null,
    context_length: Number(m.context_length) || Number(m.top_provider?.context_length) || 0,
    max_output: Number(m.top_provider?.max_completion_tokens) || 0,
    supports_tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : undefined,
  }));
}

// Gather evidence for every provider the runner can use, then plan. Never throws for a provider
// that cannot be reached: that provider is simply not verified (and so not used).
export async function plan({ env = process.env, outDir, ledgerPath = '', requestFile = '', listingDir = '', fetcher = fetch, now = Date.now() } = {}) {
  mkdirSync(outDir, { recursive: true });
  const attested = attestedProviders(env.CHE_CODING_FREE_PROVIDERS || '');
  const verdicts = {};
  const models = [];
  for (const id of Object.keys(KEY_ENV)) {
    const key = String(env[KEY_ENV[id]] || '').trim();
    const evidence = { key_present: Boolean(key) };
    // Providers that can never be eligible are not called at all.
    const callable = key && (id === 'openrouter' || attested.includes(id));
    if (callable) {
      const auth = await getJson(AUTH_URL[id], key, { fetcher });
      evidence.auth = { ok: auth.ok, status: auth.status };
      if (id === 'openrouter' && auth.ok) evidence.openrouter_key = auth.body?.data || null;
    }
    verdicts[id] = providerVerdict(id, { evidence, attested, now });
    if (verdicts[id].coverage === 'blocked') continue;
    if (id === 'openrouter') {
      const listed = await getJson(OPENROUTER_MODELS, '', { fetcher });
      if (listed.ok) models.push(...openRouterModels(listed.body));
      else verdicts[id] = { ...verdicts[id], coverage: 'blocked', policy: 'blocked_billing_unverifiable', reason: 'live_prices_unreadable' };
    } else {
      // Attested providers: the model ids OpenCode itself lists for that key.
      const listing = listingDir ? join(listingDir, `listing-${id}.txt`) : '';
      const ids = listing && existsSync(listing) ? readFileSync(listing, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s.startsWith(`${id}/`)) : [];
      for (const model of ids) {
        if (!listedModelUsable(id, model)) continue;
        models.push({ id: model, provider: id });
      }
    }
  }
  const ledger = readJson(ledgerPath) || {};
  const request = requestFile && existsSync(requestFile) ? readFileSync(requestFile, 'utf8') : '';
  const kind = taskKind(request.split('OWNER REQUEST:').pop());
  const planned = planCandidates({ models, verdicts, kind, ledger, now, limit: MAX_CANDIDATES });
  // An explicitly requested model goes first only when it is itself eligible.
  const requested = String(env.REQUESTED || 'auto').trim();
  const notes = [];
  if (requested && requested !== 'auto') {
    const hit = planned.candidates.find((c) => c.model === requested);
    if (hit) planned.candidates = [hit, ...planned.candidates.filter((c) => c !== hit)];
    else notes.push(`The requested model ${requested.slice(0, 80)} is not verified at zero cost, so it is not used.`);
  }
  const auth = spendAuthorization(env);
  const routing = {
    authorized_spend_usd: auth.authorized_usd,
    paid_fallback: 'disabled',
    ignored_settings: auth.ignored,
    task_kind: kind,
    attested,
    verdicts,
    candidates: planned.candidates,
    capacity_resume_at: planned.capacity_resume_at,
    excluded: planned.excluded.slice(0, 20),
    notes,
    at: new Date(now).toISOString(),
  };
  writeFileSync(join(outDir, 'routing.json'), JSON.stringify(routing));
  const meta = {};
  for (const m of models) if (planned.candidates.some((c) => c.model === m.id)) meta[m.id] = { name: m.name || m.id, context: m.context_length || 0, output: m.max_output || 0 };
  writeFileSync(join(outDir, 'models.json'), JSON.stringify(meta));
  writeFileSync(join(outDir, 'coverage.tsv'), planned.candidates.map((c) => `${c.model}\t${c.coverage}`).join('\n') + '\n');
  const blockedWhy = Object.values(verdicts).filter((v) => v.coverage === 'blocked' && v.reason !== 'no_key').map((v) => `${v.id}: ${v.reason}`);
  const summary = planned.candidates.length
    ? `${planned.candidates.length} zero-cost model(s) for ${kind}: ${planned.candidates.map((c) => c.model).join(', ')}.`
    : planned.capacity_resume_at ? `Verified zero-cost models are temporarily paused until ${planned.capacity_resume_at}. No model ran and nothing was spent.`
      : `No model is verified at zero cost right now (${blockedWhy.join('; ') || 'no provider key with verified free access'}). Nothing was spent.`;
  writeFileSync(join(outDir, 'summary.txt'), summary.slice(0, 600));
  const list = planned.candidates.map((c) => c.model).join(' ');
  output('free_candidates', list);
  output('paid_candidates', '');
  output('model', planned.candidates[0]?.model || '');
  output('task_kind', kind);
  return routing;
}

// The per-attempt OpenCode config. `small_model` is pinned to the same model: left unset,
// OpenCode picks a "cheaper" model of the same provider for titles, which on OpenRouter could be
// a paid one. An OpenRouter model the bundled catalog does not list is declared here, so a model
// read live from OpenRouter can run.
export function attemptConfig({ base = {}, model = '', meta = {} } = {}) {
  const config = { ...(base && typeof base === 'object' ? base : {}), model, small_model: model };
  const [provider, ...rest] = String(model).split('/');
  const id = rest.join('/');
  const info = meta[model];
  if (provider === 'openrouter' && id && info) {
    const limit = {};
    if (info.context > 0) limit.context = info.context;
    if (info.output > 0) limit.output = info.output;
    config.provider = {
      ...(config.provider || {}),
      openrouter: { ...(config.provider?.openrouter || {}), models: { ...(config.provider?.openrouter?.models || {}), [id]: { name: info.name || id, ...(Object.keys(limit).length ? { limit } : {}) } } },
    };
  }
  return config;
}

// Usage of the OpenRouter key before and after the attempts. Free requests leave usage
// unchanged; any increase is a verified charge and stops that provider (billing_risk).
export async function usage({ env = process.env, dir, phase = 'before', fetcher = fetch } = {}) {
  const key = String(env.K_OPENROUTER || '').trim();
  const path = join(dir, 'billing.json');
  const book = readJson(path) || {};
  if (!key) return { skipped: true };
  const read = await getJson(AUTH_URL.openrouter, key, { fetcher });
  const status = read.ok ? openRouterKeySummary(read.body?.data) : null;
  const value = typeof status?.usage === 'number' ? status.usage : null;
  const row = book.openrouter || {};
  if (phase === 'before') {
    book.openrouter = { usage_before: value, verified: false };
  } else {
    row.usage_after = value;
    row.verified = typeof row.usage_before === 'number' && typeof value === 'number';
    row.delta_usd = row.verified ? Math.round((value - row.usage_before) * 1e6) / 1e6 : null;
    book.openrouter = row;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(book));
  return book.openrouter;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'attested') {
    process.stdout.write(attestedProviders(process.env.CHE_CODING_FREE_PROVIDERS || '').filter((id) => KEY_ENV[id] && id !== 'openrouter').join(' ') + '\n');
    return 0;
  }
  if (command === 'plan') {
    const outDir = argValue(rest, '--out-dir');
    const routing = await plan({ outDir, ledgerPath: argValue(rest, '--ledger'), requestFile: argValue(rest, '--request-file'), listingDir: outDir });
    process.stdout.write(`Authorized AI spend: $${routing.authorized_spend_usd}; paid fallback disabled.\n`);
    for (const note of routing.ignored_settings) process.stdout.write(`Ignored: ${note}\n`);
    for (const [id, v] of Object.entries(routing.verdicts)) {
      process.stdout.write(`Provider ${id}: ${v.policy}, ${v.coverage}, connection ${v.connected}${v.reason ? ` (${v.reason})` : ''}${v.verification && v.verification !== 'none' ? `, ${v.verification}` : ''}.\n`);
    }
    process.stdout.write(`Task kind: ${routing.task_kind}. ${readFileSync(join(outDir, 'summary.txt'), 'utf8')}\n`);
    return 0;
  }
  if (command === 'config') {
    const base = readJson(argValue(rest, '--base')) || {};
    const meta = readJson(argValue(rest, '--models')) || {};
    writeFileSync(argValue(rest, '--out'), JSON.stringify(attemptConfig({ base, model: argValue(rest, '--model'), meta })), { mode: 0o600 });
    return 0;
  }
  if (command === 'usage') {
    const row = await usage({ dir: argValue(rest, '--dir'), phase: argValue(rest, '--phase') || 'before' });
    if (row?.skipped) return 0;
    if (row.verified && row.delta_usd > 0) {
      process.stdout.write(`::error::OpenRouter usage rose by $${row.delta_usd} during free-only attempts. This is a billing_risk: the provider is stopped and the owner is told.\n`);
      return 3;
    }
    process.stdout.write(row.verified ? `OpenRouter billed cost for this run: $${row.delta_usd} (verified from the key's usage).\n` : 'OpenRouter usage could not be read; billed cost is not verified.\n');
    return 0;
  }
  if (command === 'ledger-merge') {
    const merged = mergeLedger(readJson(argValue(rest, '--ledger')), readJson(argValue(rest, '--record')) || {});
    writeFileSync(argValue(rest, '--out'), JSON.stringify(merged));
    return 0;
  }
  throw new Error(`Unknown zero-cost command: ${command || '(none)'}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${String(error?.message || error).slice(0, 200)}\n`);
    process.exitCode = 1;
  });
}
