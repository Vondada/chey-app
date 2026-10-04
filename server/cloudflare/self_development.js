// CHE self-development team.
//
// CHE manages the work; internal engineering sub-agents inspect, implement,
// proofread and repair code. The result is only a proposal. The existing
// che-update approval card must still be approved by the owner before a PR is
// opened, and CI still has to pass before merge/deploy.
//
// Recovery contract (see recovery_policy.js): ordinary engineering failures
// are handled here (class A) and never become owner homework; provider/GitHub
// outages are class B and come back as a retryable result; credentials and
// permission problems are class C; owner approval is class D.

import { isSelfUpdateEditablePath, isSelfUpdateReadablePath, validateUpdateFiles } from './self_update.js';
import { ENGINEERING_PLAYBOOK } from './engineering_playbook.js';
import {
  AgentBudget,
  FAILURE_CLASS,
  classifyFailure,
  isEvidenceRequest,
  ownerEngineeringMessage,
  stripOwnerHomework,
  strategyFingerprint,
} from './recovery_policy.js';

function repoOf(env) {
  const repo = String(env.CHE_GITHUB_REPO || '').trim();
  if (!env.CHE_GITHUB_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return repo;
}

async function gh(env, method, path, body, fetcher = fetch) {
  const repo = repoOf(env);
  if (!repo) return { ok: false, status: 503, data: null };
  let response;
  try {
    response = await fetcher(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.CHE_GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'CHE-Agent',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    return { ok: false, status: 0, data: { message: String(error?.message || error).slice(0, 200) } };
  }
  let data = null;
  try { data = await response.json(); } catch (_) {}
  return { ok: response.ok, status: response.status, data };
}

const transientStatus = (status) => !status || [408, 425, 429, 500, 502, 503, 504].includes(Number(status));

// One bounded retry for transient GitHub reads (class B), never for 4xx.
async function ghRead(env, path, fetcher, attempts = 2) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await gh(env, 'GET', path, null, fetcher);
    if (last.ok || !transientStatus(last.status)) return last;
  }
  return last;
}

function decodeBase64Utf8(value) {
  const binary = atob(String(value || '').replace(/\s+/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}

function modelText(answer) {
  return String(answer?.response || answer?.choices?.[0]?.message?.content || '').trim();
}

export function jsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const candidates = [raw];
  const fenced = /^\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`$/i.exec(raw);
  if (fenced) candidates.push(fenced[1].trim());
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  return null;
}

// ─── Evidence packing ────────────────────────────────────────────────────────
// Agent payloads used to be JSON.stringify(...).slice(0, 48000), and the router
// then clipped the user message to ~35% of a small provider budget. Both cut
// the repository source out of the request, which is why agents answered
// "source was not provided". Payloads are now packed to an explicit budget:
// evidence windows shrink to fit, the JSON always stays valid, and the router
// is told the minimum context it must preserve.

const DEFAULT_AGENT_INPUT_CHARS = 17000;

function agentInputChars(env) {
  const configured = Number(env?.CHE_AGENT_INPUT_CHARS);
  return Number.isFinite(configured) && configured >= 6000 ? Math.min(configured, 120000) : DEFAULT_AGENT_INPUT_CHARS;
}

// Big files are shown as numbered windows around the lines that matter, so the
// model sees the real code without the file being truncated or rewritten.
// `anchors` are 0-based line numbers that must be visible (e.g. changed lines).
export function focusView(source, terms, maxChars = 14000, anchors = []) {
  const text = String(source || '');
  if (text.length <= maxChars) return { whole: true, text };
  const lines = text.split('\n');
  const radius = maxChars < 5000 ? 10 : maxChars < 9000 ? 16 : 25;
  const lowered = (terms || []).map((t) => String(t).toLowerCase()).filter((t) => t.length > 2);
  const centers = [];
  for (const anchor of anchors || []) if (Number.isInteger(anchor) && anchor >= 0 && anchor < lines.length) centers.push(anchor);
  lines.forEach((line, i) => {
    const l = line.toLowerCase();
    if (lowered.some((t) => l.includes(t))) centers.push(i);
  });
  const wanted = new Set();
  // Anchors first, then term hits in order, until the budget is used.
  let used = 0;
  for (const center of centers) {
    for (let j = Math.max(0, center - radius); j <= Math.min(lines.length - 1, center + radius); j += 1) {
      if (wanted.has(j)) continue;
      used += lines[j].length + 8;
      wanted.add(j);
    }
    if (used > maxChars) break;
  }
  if (!wanted.size) {
    for (let j = 0; j < lines.length && used < maxChars; j += 1) { wanted.add(j); used += lines[j].length + 8; }
  }
  const out = [];
  let prev = -2;
  let size = 0;
  for (const i of [...wanted].sort((a, b) => a - b)) {
    const row = `${i + 1}| ${lines[i]}`;
    if (size + row.length > maxChars) break;
    if (i !== prev + 1) out.push('… (lines omitted) …');
    out.push(row);
    size += row.length + 1;
    prev = i;
  }
  return { whole: false, text: out.join('\n') };
}

// Packs several files into one evidence budget. Files with search hits or
// anchors get more room; every listed file gets at least a small window.
export function packEvidence(sources, { terms = [], hits = new Map(), anchors = new Map(), budget = 12000, paths = null } = {}) {
  const list = (paths || [...sources.keys()]).filter((path) => sources.has(path));
  if (!list.length) return [];
  const weight = (path) => 1 + Math.min(4, (hits.get(path) || 0)) + ((anchors.get(path) || []).length ? 3 : 0);
  const total = list.reduce((sum, path) => sum + weight(path), 0);
  return list.map((path) => {
    const share = Math.max(1200, Math.floor((budget * weight(path)) / total));
    const view = focusView(sources.get(path), terms, share, anchors.get(path) || []);
    return { path, search_hits: hits.get(path) || 0, whole_file: view.whole, source: view.text };
  });
}

// Builds a valid JSON payload no larger than maxChars by shrinking the
// evidence budget passed to `build`.
function fitPayload(build, maxChars) {
  let evidenceBudget = Math.max(2000, maxChars - 2500);
  let text = '';
  for (let i = 0; i < 6; i += 1) {
    text = JSON.stringify(build(evidenceBudget));
    if (text.length <= maxChars) return text;
    evidenceBudget = Math.max(1200, Math.floor(evidenceBudget * (maxChars / text.length) * 0.9));
  }
  // Last resort: drop conversational context, never the evidence's validity.
  const payload = build(evidenceBudget);
  if (Array.isArray(payload.team_chat)) payload.team_chat = payload.team_chat.slice(-4);
  if (typeof payload.team_lessons === 'string') payload.team_lessons = payload.team_lessons.slice(-1500);
  return JSON.stringify(payload);
}

// ─── Agent calls ─────────────────────────────────────────────────────────────

function createContext(env, task, options = {}) {
  return {
    env,
    task,
    inputChars: agentInputChars(env),
    budget: options.budget instanceof AgentBudget ? options.budget : new AgentBudget(options.budgetLimits || {}),
    ownerInitiated: options.ownerInitiated !== false,
    diagnostics: [],
    outcomes: [],
  };
}

function note(ctx, entry) {
  ctx.diagnostics.push({ at: Date.now(), ...entry });
  if (ctx.diagnostics.length > 80) ctx.diagnostics.shift();
}

async function runAgent(ctx, { stage, role, assignment, payload, maxTokens = 2200, provider = '' }) {
  const { env } = ctx;
  const system = [
    `You are ${role}, an internal CHE software-engineering sub-agent.`,
    'CHE is the manager. You do the engineering work and report back to CHE; do not address the owner.',
    assignment,
    'All repository evidence available to you is in this request. If something you need is missing, say exactly which path or identifier CHE should fetch in your notes; never ask the owner for source, filenames, line numbers, diffs or exact text.',
    'Never expose or place credentials, tokens, private keys, passwords, or signing material in code.',
    'Never claim you inspected a file unless its actual source is included in your task.',
    ENGINEERING_PLAYBOOK,
  ].join('\n');
  const user = typeof payload === 'function' ? fitPayload(payload, ctx.inputChars) : JSON.stringify(payload);
  ctx.budget.spend(stage, Math.ceil((system.length + user.length) / 4));
  let answer;
  try {
    answer = await env.AI.run(
      env.CHE_STRONG_MODEL || env.CHE_FAST_MODEL || '@cf/meta/llama-3.1-8b-instruct-fp8',
      {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        che_strongest: true,
        che_capability: 'coding',
        che_owner_chat: ctx.ownerInitiated,
        // The router must not clip the evidence: skip engines whose context
        // budget is smaller than this request instead.
        che_min_input_chars: system.length + user.length,
        che_audit: { task: String(ctx.task || '').slice(0, 160), agent: role.split(',')[0], route: `self_development_${stage}` },
        // Ask engines for strict JSON so patches parse ("not valid JSON" failures).
        response_format: { type: 'json_object' },
        ...(provider ? { che_provider: provider } : {}),
      },
    );
  } catch (error) {
    const { failure_class: failureClass, kind } = classifyFailure(error);
    if (!error?.budget_exhausted) ctx.budget.recordError(`${stage}:${provider || 'auto'}:${failureClass}:${kind}`);
    note(ctx, { stage, role: role.split(',')[0], provider, failure_class: failureClass, kind, error: String(error?.diagnostic || error?.message || error).slice(0, 300) });
    const wrapped = new Error(String(error?.message || error));
    wrapped.failure_class = error?.budget_exhausted ? FAILURE_CLASS.INTERNAL : failureClass;
    wrapped.budget_exhausted = Boolean(error?.budget_exhausted);
    throw wrapped;
  }
  const text = modelText(answer);
  ctx.budget.addOutput(Math.ceil(text.length / 4));
  if (!text) {
    const empty = new Error(`${role} returned no work.`);
    empty.failure_class = FAILURE_CLASS.INTERNAL;
    throw empty;
  }
  return text;
}

// Runs an agent and parses its JSON. Returns { ok, value } or
// { ok:false, failure:'invalid_json'|'unavailable'|'budget', failure_class }.
async function agentJson(ctx, opts) {
  try {
    const text = await runAgent(ctx, opts);
    const value = jsonObject(text);
    if (!value) {
      note(ctx, { stage: opts.stage, provider: opts.provider, failure_class: FAILURE_CLASS.INTERNAL, kind: 'invalid_json', sample: text.slice(0, 160) });
      return { ok: false, failure: 'invalid_json', failure_class: FAILURE_CLASS.INTERNAL, raw: text };
    }
    return { ok: true, value, raw: text };
  } catch (error) {
    if (error?.budget_exhausted) return { ok: false, failure: 'budget', failure_class: FAILURE_CLASS.INTERNAL };
    const failureClass = error?.failure_class || FAILURE_CLASS.TEMPORARY_EXTERNAL;
    return { ok: false, failure: failureClass === FAILURE_CLASS.INTERNAL ? 'empty' : 'unavailable', failure_class: failureClass };
  }
}

// ─── Repository access ───────────────────────────────────────────────────────

async function readHead(env, base, fetcher) {
  const ref = await ghRead(env, `/git/ref/heads/${encodeURIComponent(base)}`, fetcher);
  if (!ref.ok || !ref.data?.object?.sha) return { error: ref };
  return { sha: String(ref.data.object.sha) };
}

async function sourceIndex(env, fetcher) {
  const repo = await ghRead(env, '', fetcher);
  if (!repo.ok) return { error: `Could not read repository metadata (${repo.status}).`, status: repo.status };
  const base = String(repo.data?.default_branch || 'main');
  const head = await readHead(env, base, fetcher);
  if (head.error) return { error: `Could not read ${base}.`, status: head.error.status };
  const tree = await ghRead(env, `/git/trees/${encodeURIComponent(head.sha)}?recursive=1`, fetcher);
  if (!tree.ok) return { error: `Could not inspect source tree (${tree.status}).`, status: tree.status };
  const paths = (Array.isArray(tree.data?.tree) ? tree.data.tree : [])
    .filter((item) => item?.type === 'blob' && isSelfUpdateReadablePath(String(item.path || '')))
    .map((item) => String(item.path))
    .slice(0, 4000);
  return { base, head_sha: head.sha, paths, editable_paths: paths.filter(isSelfUpdateEditablePath) };
}

// Reads one file at the exact inspected commit. Returns { text, sha } or null.
async function readFile(env, ref, path, fetcher) {
  if (!isSelfUpdateReadablePath(path)) return null;
  const found = await ghRead(env, `/contents/${path}?ref=${encodeURIComponent(ref)}`, fetcher);
  if (!found.ok || typeof found.data?.content !== 'string' || !found.data.content) return null;
  try { return { text: decodeBase64Utf8(found.data.content), sha: String(found.data.sha || '') || null }; } catch (_) { return null; }
}

export function isUiTask(request) {
  const text = String(request || '');
  // Classify the owner's request, not appended RAG/README/reference material.
  // A broad architecture prompt often contains words like "UI", "design" or
  // "text" inside reference docs; those must not turn the whole job into UI work.
  if (/\b(?:ui|ux|screen|page|layout|navigation|menu|panel|interface|widget)\b/i.test(text)) return true;
  const visibleElement = /\b(?:button|card|banner|label|title|font|color|theme|spacing|visible text)\b/i.test(text);
  const changeVerb = /\b(?:change|rename|redesign|restyle|move|rearrange|add|remove|hide|show|fix|improve|update|make)\b/i.test(text);
  return visibleElement && changeVerb;
}

const SOURCE_TERM_STOP = new Set([
  'about','after','again','against','already','also','and','anything','apply','before','being','better','codebase',
  'compare','current','does','everything','from','give','into','just','latest','make','more','only','owner','project',
  'request','should','source','study','than','that','their','them','then','there','these','they','this','through','use',
  'using','what','when','where','which','with','would','your','che',
]);

export function rankSourcePaths(paths, request, limit = 6) {
  const words = [...new Set(
    (String(request || '').toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [])
      .filter((word) => word.length >= 4 && !SOURCE_TERM_STOP.has(word)),
  )];
  const alias = new Map([
    ['agent', ['agent','office','team','delegate','handoff','orchestrat']],
    ['agents', ['agent','office','team','delegate','handoff','orchestrat']],
    ['delegation', ['agent','delegate','handoff','office']],
    ['handoffs', ['handoff','agent','office']],
    ['memory', ['memory','vector','rag','context','brain']],
    ['context', ['context','memory','rag','vector']],
    ['research', ['research','scout','inspiration']],
    ['inspirations', ['scout','inspiration','research']],
    ['starred', ['scout','inspiration']],
    ['coding', ['self_development','self_update','code','develop']],
    ['review', ['review','test','self_development']],
    ['workflow', ['workflow','pipeline','runtime','state','orchestrat']],
    ['retries', ['retry','resilience']],
    ['recovery', ['retry','resilience','recover']],
    ['reliability', ['resilience','retry','health']],
    ['parallel', ['agent','runtime','orchestrat','team']],
    ['planning', ['plan','agent','office']],
  ]);
  const needles = new Set(words);
  for (const word of words) for (const extra of alias.get(word) || []) needles.add(extra);
  const ranked = (Array.isArray(paths) ? paths : []).map((path) => {
    const lower = String(path).toLowerCase();
    let score = 0;
    for (const needle of needles) {
      if (lower.includes(needle)) score += needle.length >= 7 ? 3 : 1;
    }
    if (/server\/cloudflare\/(?:self_development|self_update|code_scout|agent_runtime|worker)\./.test(lower)) score += 1;
    return { path: String(path), score };
  }).filter((item) => item.score > 0);
  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return ranked.slice(0, Math.max(1, limit)).map((item) => item.path);
}

// ─── Team memory: every mistake becomes a rule, every find becomes a shortcut ───
// Stored in the Durable Object (key below). Seeded with lessons learned by hand.
const LESSONS_KEY = 'che_team_lessons';
const SEED_LESSONS = [
  { kind: 'mistake', text: 'When the owner names on-screen text (e.g. "the Ready banner"), edit the widget that shows THAT exact text. Never edit a different banner/label that merely has a similar name. PR #73 wrongly changed the Shorebird "CHE updated. Restart to apply." banner instead of the status banner.' },
  { kind: 'location', text: 'The home status banner text ("Ready. Type or speak a request." / "Voice standby...") lives in lib/main.dart (_statusBanner and the status getter).' },
  { kind: 'location', text: 'lib/self_update/che_patch_banner.dart is ONLY the Shorebird over-the-air update notice. Do not touch it unless the request is about update/restart notices.' },
];

export async function loadLessons(memory) {
  let saved = [];
  try { saved = (await memory?.get?.(LESSONS_KEY)) || []; } catch (_) {}
  // Lessons that are really agent failures ("source was not provided") are
  // poison: they teach the next team to ask for evidence. Drop them on load.
  const clean = (Array.isArray(saved) ? saved : []).filter((item) => !isEvidenceRequest(item?.text));
  return [...SEED_LESSONS, ...clean].slice(-60);
}

export async function recordLesson(memory, kind, text) {
  if (!memory?.get || !memory?.put) return;
  const clean = stripOwnerHomework(String(text || '').replace(/\s+/g, ' ').trim()).slice(0, 400);
  if (!clean || clean.length < 4) return;
  try {
    const saved = (await memory.get(LESSONS_KEY)) || [];
    const list = Array.isArray(saved) ? saved : [];
    if (list.some((item) => item.text === clean)) return;
    list.push({ kind, text: clean, at: new Date().toISOString() });
    await memory.put(LESSONS_KEY, list.slice(-50));
  } catch (_) {}
}


// ─── The crew: existing Office staff, paired, each pair on different engines ───
// Different engines = different blind spots. Pairs run at the same time.
// Engine choice is a preference; the router falls back if one is resting.
export const CREW = {
  planners: [
    { name: 'Atlas', title: 'Architect (research)', provider: 'gemini' },
    { name: 'Iris', title: 'Architect (visual/UI)', provider: 'mistral' },
  ],
  engineers: [
    { name: 'Knox', title: 'Engineer', provider: 'groq' },
    { name: 'Nova', title: 'Engineer', provider: 'cerebras' },
  ],
  reviewers: [
    { name: 'Sage', title: 'Reviewer (correctness)', provider: 'gemini' },
    { name: 'Mira', title: 'Reviewer (target + accessibility)', provider: 'github' },
  ],
};
const who = (member, role) => `${member.name}, CHE Office ${member.title}, acting as ${role}`;
// Second-chance engines for a reviewer whose first engine failed to deliver.
const REVIEW_FALLBACK = { gemini: 'mistral', github: 'openrouter', mistral: 'gemini', openrouter: 'gemini' };

function lessonText(lessons) {
  return lessons.map((item, i) => `${i + 1}. [${item.kind}] ${item.text}`).join('\n');
}

// Literal phrases the owner quoted or clearly named, used to find the real code.
export function literalTerms(request) {
  const terms = new Set();
  for (const m of String(request).matchAll(/["“']([^"”']{3,80})["”']/g)) terms.add(m[1].trim());
  for (const m of String(request).matchAll(/\b(?:say|says|read|reads|show|shows|text|label(?:ed)?|titled?)\s+([A-Z][^.,;:!?\n]{2,60})/g)) terms.add(m[1].trim());
  return [...terms].slice(0, 6);
}

async function searchCode(ctx, terms, fetcher) {
  const { env } = ctx;
  const repo = repoOf(env);
  const hits = new Map();
  if (!repo) return hits;
  const batches = await Promise.all(terms.slice(0, 5).map(async (term) => {
    const q = `"${String(term).replace(/"/g, '').slice(0, 80)}" repo:${repo}`;
    try {
      const response = await fetcher(`https://api.github.com/search/code?per_page=10&q=${encodeURIComponent(q)}`, {
        headers: {
          Authorization: `Bearer ${env.CHE_GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'CHE-Agent',
        },
      });
      if (!response.ok) {
        // Search failure is not fatal: discovery continues from the tree.
        note(ctx, { stage: 'search', kind: 'search_failed', status: response.status });
        return [];
      }
      const data = await response.json();
      return (data?.items || [])
        .map((item) => String(item?.path || ''))
        .filter((path) => isSelfUpdateReadablePath(path));
    } catch (error) {
      note(ctx, { stage: 'search', kind: 'search_failed', error: String(error?.message || error).slice(0, 120) });
      return [];
    }
  }));
  for (const paths of batches) {
    for (const path of paths) hits.set(path, (hits.get(path) || 0) + 1);
  }
  return hits;
}

// Identifier variants for a phrase: "voice button" -> voiceButton,
// VoiceButton, voice_button. Lets the content scan find widgets, classes and
// functions named after what the owner said, not only visible text.
export function identifierVariants(term) {
  const words = String(term || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  if (words.length < 2) return [];
  const pascal = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return [pascal[0].toLowerCase() + pascal.slice(1), pascal, words.join('_')];
}

// Scores files by what their CONTENT contains: exact text (5), case-insensitive
// text (3), identifier variants (2). Pure function, zero model tokens.
export function scoreSourceContent(text, terms) {
  const body = String(text || '');
  const lower = body.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const t = String(term || '').trim();
    if (t.length < 3) continue;
    if (body.includes(t)) score += 5;
    else if (lower.includes(t.toLowerCase())) score += 3;
    for (const id of identifierVariants(t)) if (body.includes(id)) { score += 2; break; }
  }
  return score;
}

// Deterministic discovery stage that runs BEFORE any model is asked to guess:
// read the highest-signal tree candidates at the inspected commit and grep
// their contents. Fixes "could not locate the source" when GitHub code search
// returns nothing (it is rate-limited and does not index every file).
export async function contentScan(ctx, index, task, terms, fetcher, { limit = 16 } = {}) {
  const hits = new Map();
  const candidates = fallbackTreeCandidates(task, index, terms, limit)
    .filter((path) => CODE_FILE.test(path));
  const files = await Promise.all(candidates.map(async (path) => [path, await readFile(ctx.env, index.head_sha, path, fetcher)]));
  for (const [path, file] of files) {
    if (!file?.text) continue;
    const score = scoreSourceContent(file.text, terms);
    if (score > 0) hits.set(path, score);
  }
  note(ctx, { stage: 'search', kind: 'content_scan', scanned: candidates.length, matched: hits.size });
  return hits;
}

export function fallbackTreeCandidates(request, index, terms = [], limit = 6) {
  const task = String(request || '').toLowerCase();
  const words = [...new Set([
    ...(String(request || '').toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || []),
    ...terms.flatMap((term) => String(term).toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || []),
  ])].filter((word) => !['the', 'and', 'for', 'with', 'this', 'that', 'make', 'change', 'code', 'app'].includes(word));

  const scored = (index?.editable_paths || []).map((path) => {
    const lower = path.toLowerCase();
    let score = 0;
    for (const word of words) if (lower.includes(word)) score += 8;
    if (/\b(ui|screen|page|button|layout|visual|interface|home|chat|voice)\b/.test(task) && lower.startsWith('lib/')) score += 10;
    if (/\b(worker|server|api|route|cloudflare|backend)\b/.test(task) && lower.startsWith('server/cloudflare/')) score += 10;
    if (lower === 'lib/main.dart') score += 4;
    if (lower === 'server/cloudflare/worker.js') score += 3;
    if (/\/(main|home|chat|app|worker|router|service)[._/-]/.test(lower)) score += 2;
    // Generated/test/vendor files are rarely the right first target.
    if (/(?:\.g\.dart|\.freezed\.dart|\.test\.m?js|_test\.dart)$/.test(lower)) score -= 6;
    return { path, score };
  });

  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, Math.max(1, limit))
    .map((item) => item.path);
}

export function applyEdits(sources, edits) {
  const next = new Map(sources);
  for (const edit of Array.isArray(edits) ? edits : []) {
    const path = String(edit?.path || '').trim();
    const requestedFind = typeof edit?.find === 'string' ? edit.find : '';
    const replace = typeof edit?.replace === 'string' ? edit.replace : null;
    if (!next.has(path)) return { error: `Edit targets ${path || 'a missing path'}, which was not inspected.`, missing_path: path };
    if (!requestedFind || replace === null) return { error: `An edit for ${path} is missing find/replace text.` };
    const current = next.get(path);
    const unnumbered = requestedFind.split('\n')
      .map((line) => line.replace(/^\s*\d+\|\s?/, ''))
      .join('\n');
    const find = current.includes(requestedFind)
      ? requestedFind
      : (unnumbered !== requestedFind && current.includes(unnumbered) ? unnumbered : requestedFind);
    const first = current.indexOf(find);
    if (first < 0) return { error: `In ${path}, the "find" text does not exist exactly in current source. Re-read this file and regenerate the edit from the inspected source; do not ask the owner to copy source text.`, anchor_path: path };
    if (current.indexOf(find, first + find.length) >= 0) return { error: `In ${path}, the proposed edit is ambiguous because it matches more than once. Re-read the surrounding function or widget and regenerate a uniquely anchored edit.`, anchor_path: path };
    next.set(path, current.slice(0, first) + replace + current.slice(first + find.length));
  }
  return { sources: next };
}

// A change "implements" something only if it touches real code: lines that
// are not blank and not comments, in a source file. Comment-only or
// docs-only edits are not an implementation (unless docs were requested).
const CODE_FILE = /\.(?:dart|m?js|cjs|ts|tsx|jsx|swift|kt|java|m|mm|h|html|css)$/i;

function codeWithoutComments(source, { lineComments = true } = {}) {
  const text = String(source || '');
  let out = '';
  let i = 0;
  let state = 'code';
  let quote = '';
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'line') {
      if (ch === '\n') { out += '\n'; state = 'code'; }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; i += 2; continue; }
      if (ch === '\n') out += '\n';
      i += 1;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = '';
      i += 1;
      continue;
    }
    if (lineComments && ch === '/' && next === '/') { state = 'line'; i += 2; continue; }
    if (ch === '/' && next === '*') { state = 'block'; i += 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

function stripHtmlCommentsOutsideQuotedText(source) {
  const text = String(source || '');
  let out = '';
  let i = 0;
  let quote = '';
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = '';
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4);
      const finish = close < 0 ? text.length : close + 3;
      // Preserve line structure so removing a comment cannot join tokens.
      for (const c of text.slice(i, finish)) if (c === '\n') out += '\n';
      i = finish;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function htmlWithoutComments(source) {
  const text = String(source || '');
  const block = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  let out = '';
  let last = 0;
  let match;
  while ((match = block.exec(text))) {
    out += stripHtmlCommentsOutsideQuotedText(text.slice(last, match.index));
    const whole = match[0];
    const tag = String(match[1] || '').toLowerCase();
    const openEnd = whole.indexOf('>') + 1;
    const closeMatch = /<\/(?:script|style)\s*>/i.exec(whole.slice(openEnd));
    const closeStart = closeMatch ? openEnd + closeMatch.index : whole.length;
    const open = whole.slice(0, openEnd);
    const body = whole.slice(openEnd, closeStart);
    const close = whole.slice(closeStart);
    out += open
      + codeWithoutComments(body, { lineComments: tag === 'script' })
      + close;
    last = match.index + whole.length;
  }
  out += stripHtmlCommentsOutsideQuotedText(text.slice(last));
  return out;
}

function normalizedExecutableSource(source, path = '') {
  const isCss = /\.css$/i.test(String(path || ''));
  const isHtml = /\.html$/i.test(String(path || ''));
  const stripped = isHtml
    ? htmlWithoutComments(source)
    : codeWithoutComments(source, { lineComments: !isCss });
  // Drop only lines made empty by comment removal. Preserve every character
  // on executable lines so whitespace changes inside strings remain visible.
  return stripped
    .split('\n')
    .filter((line) => line.trim() !== '')
    .join('\n');
}

export function substantiveChange(beforeMap, files) {
  for (const file of files) {
    if (!CODE_FILE.test(file.path)) continue;
    const before = normalizedExecutableSource(beforeMap.get(file.path) ?? '', file.path);
    const after = normalizedExecutableSource(file.content || '', file.path);
    if (before !== after) return true;
  }
  return false;
}

// Names a change newly declares (functions, methods, getters, classes) that
// nothing calls. "Add a cache and a getAgent() nobody uses" compiles and can
// fool a reviewer, but it delivers nothing, so it is not an implementation.
const DECL_SKIP = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'function', 'new', 'else', 'do', 'try', 'with',
  'build', 'initState', 'dispose', 'didChangeDependencies', 'didUpdateWidget', 'createState', 'main',
  'toString', 'noSuchMethod', 'constructor', 'fetch', 'alarm', 'scheduled', 'queue', 'webSocketMessage', 'webSocketClose',
]);

function declaredNames(source, path) {
  const names = [];
  const lines = String(source || '').split('\n');
  const dart = /\.dart$/i.test(path);
  lines.forEach((line, index) => {
    const previous = index > 0 ? lines[index - 1] : '';
    if (/@override/.test(line) || /@override\s*$/.test(previous)) return;
    const found = [];
    const type = /^\s*(?:export\s+)?(?:(?:abstract|final|sealed|base|interface)\s+)*(?:class|mixin|enum)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (type) found.push(type[1]);
    const getter = dart ? /\bget\s+([A-Za-z_]\w*)\s*(?:=>|\{)/.exec(line) : null;
    if (getter) found.push(getter[1]);
    const jsFunction = !dart ? /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(line) : null;
    if (jsFunction) found.push(jsFunction[1]);
    const jsArrow = !dart ? /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(line) : null;
    if (jsArrow) found.push(jsArrow[1]);
    const method = /^\s*(?:(?:static|external|async|export|public|private|protected|late|final)\s+)*(?:[A-Za-z_$][\w$<>?,\[\]. ]*?\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\((?:[^()]|\([^()]*\))*\)\s*(?:async\*?|sync\*)?\s*(?:\{|=>)/.exec(line);
    if (method && !/^\s*(?:return|await|new|throw|else|case)\b/.test(line)) found.push(method[1]);
    for (const name of found) if (!DECL_SKIP.has(name) && !names.includes(name)) names.push(name);
  });
  return names;
}

export function unusedNewCode(beforeMap, afterMap, files, request = '') {
  const unused = [];
  const corpus = [...afterMap.values()].map((text) => String(text || ''));
  for (const file of files) {
    if (!/\.(?:dart|m?js)$/i.test(file.path) || /(?:^|\/)test\/|\.test\.|_test\./i.test(file.path)) continue;
    const before = new Set(declaredNames(beforeMap.get(file.path) ?? '', file.path));
    const declaredNow = declaredNames(file.content, file.path);
    for (const name of declaredNow.filter((n) => !before.has(n))) {
      if (String(request).includes(name)) continue;
      const pattern = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
      const uses = corpus.reduce((sum, text) => sum + (text.match(pattern) || []).length, 0);
      const declarations = corpus.reduce((sum, text) => sum + declaredNames(text, file.path).filter((n) => n === name).length, 0);
      if (uses - declarations <= 0) unused.push({ name, path: file.path });
    }
  }
  return unused;
}

export function wantsDocsOnly(request) {
  const text = String(request || '').trim();
  const docs = /\b(?:doc(?:s|ument(?:s|ation)?)?|readme|comments?|changelog|notes?|guide|docstrings?)\b/i;
  if (!docs.test(text)) return false;

  const allMutationActions = /\b(?:build|rebuild|redesign|implement|make|upgrade|refactor|develop|ship|fix|update|add|create|edit|improve|change|write|correct|refresh|document|enable|support|configure|wire|route|connect|allow|expose|remove|delete|replace|rename|move|convert|migrate|integrate|install|set|turn|switch)\b/gi;
  const docsActions = new Set([
    'fix', 'update', 'add', 'create', 'edit', 'improve', 'change', 'write',
    'correct', 'refresh', 'document', 'remove', 'delete', 'replace', 'rename', 'move',
  ]);
  const referenceUse = /\b(?:according\s+to|based\s+on|using|per)\b/i;

  // Protect dots inside filenames/paths (README.md, docs/setup.md) before
  // treating punctuation as a sentence boundary.
  const protectedText = text.replace(/(?<=[\w/-])\.(?=[\w/-])/g, '\u0000');
  const clauses = protectedText
    .split(/\b(?:and|plus|also|along\s+with|as\s+well\s+as|then|while|whereas)\b|[,;&]|[;.!?]+/i)
    .map((clause) => clause.replace(/\u0000/g, '.').trim())
    .filter(Boolean);

  let sawDocsTarget = false;
  for (const clause of clauses) {
    const docMatch = docs.exec(clause);
    const actions = [...clause.matchAll(allMutationActions)];
    if (referenceUse.test(clause)) return false;

    // An actionless continuation such as "update README and login flow" means
    // mixed work, not a documentation-only request.
    if (!actions.length) {
      if (!docMatch) return false;
      sawDocsTarget = true;
      continue;
    }

    // Inspect every action, not just the first. Unknown feature mutations such
    // as enable/support/configure must never be excused merely because docs are
    // mentioned somewhere in the same clause.
    // Only words in verb position count ("update docs for the API route":
    // "route" is a noun). A verb leads the clause or follows to/please/also/
    // can/should/must/will/then, so "update docs to enable X" still counts.
    actions.forEach((action, index) => {
      const before = clause.slice(0, action.index).trim().split(/\s+/).pop()?.toLowerCase() || '';
      action.isVerb = index === 0 || ['to', 'please', 'also', 'can', 'should', 'must', 'will', 'then', 'and'].includes(before);
    });
    for (const action of actions.filter((item) => item.isVerb)) {
      const verb = String(action[0] || '').toLowerCase();
      if (!docsActions.has(verb)) return false;
    }
    if (!docMatch) return false;
    sawDocsTarget = true;
  }
  return sawDocsTarget;
}
// 0-based line numbers that differ between two versions (in the new version).
function changedLines(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  let top = 0;
  while (top < a.length && top < b.length && a[top] === b[top]) top += 1;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= top && eb >= top && a[ea] === b[eb]) { ea -= 1; eb -= 1; }
  const out = [];
  for (let i = top; i <= Math.max(top, eb); i += 1) out.push(i);
  return out.slice(0, 200);
}

function diffView(before, after) {
  const out = [];
  for (const [path, text] of after) {
    const old = before.get(path) ?? '';
    if (old === text) continue;
    const a = old.split('\n');
    const b = text.split('\n');
    let top = 0;
    while (top < a.length && top < b.length && a[top] === b[top]) top++;
    let ea = a.length - 1;
    let eb = b.length - 1;
    while (ea >= top && eb >= top && a[ea] === b[eb]) { ea--; eb--; }
    const from = Math.max(0, top - 6);
    out.push(`--- ${path} (around line ${top + 1})`);
    for (let i = from; i < top; i++) out.push(`  ${a[i]}`);
    for (let i = top; i <= ea; i++) out.push(`- ${a[i]}`);
    for (let i = top; i <= eb; i++) out.push(`+ ${b[i]}`);
    for (let i = eb + 1; i < Math.min(b.length, eb + 7); i++) out.push(`  ${b[i]}`);
  }
  return out.join('\n').slice(0, 40000);
}

// Exact-strategy fingerprint (kept for compatibility); the pipeline itself
// uses the normalized strategyFingerprint so equivalent strategies match.
export function attemptFingerprint(answer) {
  const edits = (Array.isArray(answer?.edits) ? answer.edits : []).map((edit) => ({
    path: String(edit?.path || '').trim(),
    find: String(edit?.find || ''),
    replace: String(edit?.replace ?? ''),
  }));
  const newFiles = (Array.isArray(answer?.new_files) ? answer.new_files : []).map((file) => ({
    path: String(file?.path || '').trim(),
    content: String(file?.content || ''),
  }));
  return JSON.stringify({
    no_change: answer?.no_change === true,
    edits,
    new_files: newFiles,
  });
}

export function diagnoseNoOp(sources, answer) {
  const edits = Array.isArray(answer?.edits) ? answer.edits : [];
  const newFiles = Array.isArray(answer?.new_files) ? answer.new_files : [];

  if (!edits.length && !newFiles.length)
    return 'The implementation proposed no file changes.';

  const same = edits.filter(
    (edit) => String(edit?.find || '') === String(edit?.replace ?? ''),
  );
  if (same.length)
    return `The proposed replacement is identical to the existing text in ${
      same.map((edit) => edit.path).join(', ')
    }.`;

  return 'The proposed edits produced an empty diff. Re-read the target and choose a different edit strategy.';
}

// ─── Review ──────────────────────────────────────────────────────────────────
// A reviewer that cannot deliver a verdict (engine down, invalid JSON, or an
// answer asking for source it was given) has failed as an agent; that is not a
// code rejection. It is retried once on another engine with the evidence
// re-packed; if it still cannot review, the attempt is "unreviewed" and the
// change is never approved by default.

function reviewNotes(review) {
  return [...(Array.isArray(review?.notes) ? review.notes : []), review?.repair_instructions].filter(Boolean).map(String).join(' ');
}

async function reviewWithRecovery(ctx, member, buildCall) {
  const providers = [member.provider, REVIEW_FALLBACK[member.provider] || ''].filter((p, i, list) => p !== undefined && list.indexOf(p) === i);
  let lastFailure = 'unavailable';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const provider = providers[attempt] ?? '';
    const res = await agentJson(ctx, buildCall(provider, attempt));
    if (!res.ok) {
      lastFailure = res.failure;
      if (res.failure === 'budget') break;
      continue;
    }
    const review = res.value;
    if (isEvidenceRequest(reviewNotes(review))) {
      lastFailure = 'evidence_request';
      note(ctx, { stage: 'reviewer', reviewer: member.name, provider, kind: 'agent_evidence_request' });
      continue;
    }
    return { ...review, reviewer: member.name };
  }
  return { approved: false, agent_failure: lastFailure, reviewer: member.name, notes: [] };
}

function reviewProposal(ctx, { request, architecture, diff, uiTask, lessons, member, chat, evidence }) {
  return reviewWithRecovery(ctx, member, (provider, attempt) => ({
    stage: 'reviewer',
    role: who(member, uiTask ? 'CHE UI/UX + Code Review Agent' : 'CHE Code Review + QA Agent'),
    assignment: [
      'Independently review this change against the owner request.',
      'FIRST check TARGET CORRECTNESS: does the diff change exactly the thing the owner referred to (same visible text, same screen, same widget)? If it edits a different element with a similar name, reject.',
      'Then check Dart or JavaScript syntax, missing imports, regressions and whether the request is fully met.',
      uiTask ? 'For UI, also check VoiceOver labels and voice-first use are preserved.' : 'Check existing behavior is preserved.',
      'Apply every team lesson; a change that repeats a listed mistake must be rejected.',
      'Read team_chat (planners, engineers and the other reviewer). If a teammate raised a point, address it explicitly in notes.',
      'changed_source holds the post-change code around every edited line; inspected_source holds the verified pre-change source CHE fetched from GitHub for this job. Review against them directly.',
      attempt ? 'A previous reviewer failed to return a usable verdict. The evidence is in this request; give a concrete verdict.' : '',
      'If you reject, repair_instructions must name the exact file and what to change so an engineer can fix it.',
      'Return ONLY JSON: {"approved":true|false,"target_correct":true|false,"notes":["..."],"repair_instructions":"...","lesson":"one-sentence rule to prevent this mistake next time, or empty"}.',
    ].filter(Boolean).join('\n'),
    payload: (budget) => ({
      request,
      architecture,
      diff: diff.slice(0, Math.max(1500, Math.floor(budget * 0.3))),
      changed_source: evidence.changed(Math.floor(budget * 0.35)),
      inspected_source: evidence.inspected(Math.floor(budget * 0.35)),
      team_lessons: lessonText(lessons),
      team_chat: chat.slice(-20),
    }),
    maxTokens: 1500,
    provider,
  }));
}

// When the two reviewers disagree, they talk it out once: each sees the
// other's verdict and reasoning, then gives a final answer. Both must pass.
async function settleReviews(ctx, args, reviews) {
  const pass = (r) => r?.approved === true && r?.target_correct !== false;
  if (reviews.every(pass) || !reviews.some(pass)) return reviews;
  if (reviews.some((r) => r.agent_failure)) return reviews;
  const talk = [...args.chat, ...reviews.map((r, i) => ({
    from: CREW.reviewers[i].name,
    msg: `${pass(r) ? 'APPROVE' : 'REJECT'}: ${reviewNotes(r)}`.slice(0, 700),
  }))];
  return Promise.all(CREW.reviewers.map((reviewer) => reviewProposal(ctx, {
    ...args,
    request: `${args.request}\n\nYou and the other reviewer disagreed. Read team_chat, weigh their argument honestly, and give your final verdict.`,
    member: reviewer,
    chat: talk,
  })));
}

function reviewNoChange(ctx, { request, architecture, claims, lessons, member, chat, evidence }) {
  return reviewWithRecovery(ctx, member, (provider) => ({
    stage: 'reviewer',
    role: who(member, 'CHE No-Change Verification Agent'),
    assignment: [
      'Independently verify the engineers\' claim that no code delta is justified.',
      'Approve ONLY if the inspected source already satisfies the owner request or the referenced capability would be duplicate, worse, unsafe, incompatible, or unnecessary.',
      'Reject if there is still a concrete missing capability or if the evidence is vague, and name the file and change that is still needed.',
      'A no-change approval is a reviewed engineering conclusion, not permission to skip requested work.',
      'The inspected_source payload contains repository source CHE already fetched from GitHub. Use it directly.',
      'Return ONLY JSON: {"approved":true|false,"notes":["..."],"repair_instructions":"..."}.',
    ].join('\n'),
    payload: (budget) => ({
      request,
      architecture,
      no_change_claims: claims,
      inspected_source: evidence.inspected(budget),
      team_lessons: lessonText(lessons),
      team_chat: chat.slice(-20),
    }),
    maxTokens: 1200,
    provider,
  }));
}

// ─── Implementation ──────────────────────────────────────────────────────────

const ENGINEER_PROVIDER_ROUNDS = [
  ['groq', 'cerebras'],
  ['gemini', 'mistral'],
  ['github', 'huggingface'],
];

function engineerForRound(member, index, round) {
  const provider = ENGINEER_PROVIDER_ROUNDS[round]?.[index] || member.provider;
  return { ...member, provider };
}

async function recoveryPlan(ctx, { task, architecture, feedback, index, lessons, member, chat }) {
  const res = await agentJson(ctx, {
    stage: 'recovery',
    role: who(member, 'CHE Source Recovery Architect'),
    assignment: [
      'The previous implementation pass failed or produced no real diff. Do not repeat the same edit.',
      'Re-locate the actual source for the owner request using the failure feedback and repository file list.',
      'Prefer exact visible text for UI requests; for architecture/repository work, use module names, exported functions and likely server or Flutter files. Name new files to inspect when the previous set was wrong or incomplete.',
      'Return ONLY JSON: {"plan":"...","search_terms":["exact text or identifier"],"paths":["an actual repository path"]}.',
    ].join('\n'),
    payload: (budget) => ({
      request: task,
      previous_architecture: architecture,
      previous_failure: String(feedback || '').slice(0, 2000),
      editable_source_files: listForBudget(index.editable_paths, Math.floor(budget * 0.6)),
      readable_source_files: listForBudget(index.paths.filter((p) => !isSelfUpdateEditablePath(p)), Math.floor(budget * 0.15)),
      team_lessons: lessonText(lessons),
      team_chat: chat.slice(-24),
    }),
    maxTokens: 1600,
    provider: member.provider,
  });
  return res.ok ? res.value : null;
}

function listForBudget(paths, budget) {
  const out = [];
  let used = 2;
  for (const path of paths || []) {
    used += path.length + 3;
    if (used > budget) break;
    out.push(path);
  }
  return out;
}


export async function prepareSelfUpdate(env, request, fetcher = fetch, memory = null, options = {}) {
  if (!repoOf(env)) {
    return {
      status: 503,
      failure_class: FAILURE_CLASS.PERMANENT_EXTERNAL,
      detail: 'Self-development needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO on the server.',
      owner_message: 'GitHub self-development is not connected on the CHE Worker, sir (the CHE GitHub token or repository setting is missing). Nothing was changed.',
    };
  }
  const task = String(request || '').trim().slice(0, 16000);
  const ownerIntent = String(options?.intentRequest || request || '').trim().slice(0, 16000);
  if (!task || !ownerIntent) return { status: 400, detail: 'Describe the requested app change.' };
  const ctx = createContext(env, task, options);
  const finish = (result) => ({ ...result, diagnostics: { budget: ctx.budget.snapshot(), events: ctx.diagnostics.slice(-40), outcomes: ctx.outcomes.slice(-30) } });

  try {
    const lessons = await loadLessons(memory);
    const index = await sourceIndex(env, fetcher);
    if (index.error || !index.paths?.length) {
      const { failure_class: failureClass, kind } = classifyFailure({ status: index.status, detail: index.error || '' });
      const cls = failureClass === FAILURE_CLASS.INTERNAL ? FAILURE_CLASS.TEMPORARY_EXTERNAL : failureClass;
      return finish({
        status: cls === FAILURE_CLASS.TEMPORARY_EXTERNAL ? 503 : 502,
        failure_class: cls,
        retryable: cls === FAILURE_CLASS.TEMPORARY_EXTERNAL,
        detail: index.error || 'CHE could not inspect its source.',
        owner_message: ownerEngineeringMessage(cls, kind),
      });
    }
    const uiTask = isUiTask(ownerIntent);

    // 1. Two architects in parallel on different engines; plans are merged.
    const plans = await Promise.all(CREW.planners.map(async (member) => {
      const res = await agentJson(ctx, {
        stage: 'planner',
        role: who(member, uiTask ? 'CHE UI/UX Architect' : 'CHE Software Architect'),
        assignment: [
          'Plan the smallest change that does exactly what the owner asked.',
          'Ponytail ladder (after reading the real flow): skip it if not needed; reuse what CHE already has; prefer the standard library, native platform features and installed dependencies; one line if one line works; otherwise the minimum that works. Never cut validation, security, data-loss handling or accessibility.',
          'If the request is vague (e.g. "one small real improvement"), choose one concrete, low-risk, user-visible or reliability improvement yourself; do not ask the owner to choose.',
          'For UI requests, name exact visible text or widget identifiers. For architecture/repository work, name concrete modules, functions, routes or server files that implement the capability.',
          'Use the team lessons (they include known file locations). You may inspect read-only control files for context, but edits must stay inside editable_source_files. Pick at most 6 existing files.',
          'Return ONLY JSON: {"plan":"...","search_terms":["exact text or identifier"],"paths":["an actual repository path"]}.',
        ].join('\n'),
        payload: (budget) => ({
          owner_request: ownerIntent,
          engineering_context: task,
          editable_source_files: listForBudget(index.editable_paths, Math.floor(budget * 0.6)),
          readable_source_files: listForBudget(index.paths.filter((p) => !isSelfUpdateEditablePath(p)), Math.floor(budget * 0.15)),
          team_lessons: lessonText(lessons),
        }),
        maxTokens: 1200,
        provider: member.provider,
      });
      return res.ok ? res.value : null;
    }));
    const chat = [];
    plans.forEach((p, i) => { if (p) chat.push({ from: CREW.planners[i].name, msg: `Plan: ${String(p.plan || '').slice(0, 600)} Look for: ${(Array.isArray(p.search_terms) ? p.search_terms : []).slice(0, 5).join(' / ')}` }); });
    const good = plans.filter(Boolean);
    const architecture = {
      plan: good.map((p, i) => `${CREW.planners[i]?.name || 'Architect'}: ${p.plan || ''}`).join('\n'),
      search_terms: good.flatMap((p) => (Array.isArray(p.search_terms) ? p.search_terms : [])).map(String),
      paths: good.flatMap((p) => (Array.isArray(p.paths) ? p.paths : [])).map(String),
    };
    const terms = [...new Set([
      ...literalTerms(ownerIntent),
      ...(Array.isArray(architecture.search_terms) ? architecture.search_terms.map(String) : []),
    ])].filter((t) => t.trim().length > 2).slice(0, 8);

    // 2. Locate: real code search beats guessing from file names. Planner
    //    paths that do not exist in the tree (hallucinations) are dropped.
    const hits = await searchCode(ctx, terms, fetcher);
    const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);
    const planned = architecture.paths.filter((p) => index.paths.includes(p));
    const inferred = rankSourcePaths(index.editable_paths, ownerIntent, 6);
    let chosen = [...new Set([...ranked, ...planned, ...inferred])].filter((path) => index.paths.includes(path)).slice(0, 6);
    if (!chosen.length && terms.length) {
      const scanned = await contentScan(ctx, index, task, terms, fetcher);
      for (const [path, score] of scanned.entries()) hits.set(path, (hits.get(path) || 0) + score);
      chosen = [...scanned.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path).slice(0, 5);
      if (chosen.length) chat.push({ from: 'CHE', msg: `Content scan found the source: ${chosen.join(', ')}` });
    }
    if (!chosen.length) {
      const recoveryMember = CREW.planners[1];
      const recovery = await recoveryPlan(ctx, {
        task,
        architecture,
        feedback: 'Initial discovery returned no verified source paths. Broaden discovery from the repository tree; use visible text, identifiers, widgets/classes/functions, routes, imports, callers/callees and likely feature directories.',
        index,
        lessons,
        member: recoveryMember,
        chat,
      });
      if (recovery) {
        const recoveryTerms = (Array.isArray(recovery.search_terms) ? recovery.search_terms : [])
          .map(String).filter((item) => item.trim().length > 2);
        for (const term of recoveryTerms) if (!terms.includes(term)) terms.push(term);
        const recoveryPaths = (Array.isArray(recovery.paths) ? recovery.paths : [])
          .map(String).filter((path) => index.paths.includes(path));
        const moreHits = await searchCode(ctx, recoveryTerms, fetcher);
        for (const [path, count] of moreHits.entries()) hits.set(path, (hits.get(path) || 0) + count);
        const reranked = [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);
        chosen = [...new Set([...recoveryPaths, ...reranked])].filter((path) => index.paths.includes(path)).slice(0, 5);
        architecture.plan = [architecture.plan, `Initial recovery: ${String(recovery.plan || '')}`].filter(Boolean).join('\n');
        architecture.search_terms = [...new Set([...architecture.search_terms, ...recoveryTerms])];
        architecture.paths = [...new Set([...architecture.paths, ...recoveryPaths])];
        chat.push({ from: recoveryMember.name, msg: `Initial recovery locate: ${String(recovery.plan || '').slice(0, 500)} Paths: ${recoveryPaths.join(', ') || 'search again'}` });
      }
    }
    if (!chosen.length) {
      chosen = fallbackTreeCandidates(task, index, terms, 6);
      if (chosen.length) {
        architecture.plan = [
          architecture.plan,
          'Deterministic tree fallback: inspect the highest-signal editable source candidates directly because model/search discovery returned no verified path.',
        ].filter(Boolean).join('\n');
        architecture.paths = [...new Set([...architecture.paths, ...chosen])];
        chat.push({ from: 'CHE', msg: `Deterministic repository fallback selected: ${chosen.join(', ')}` });
      }
    }
    if (!chosen.length) {
      return finish({
        status: 422,
        failure_class: FAILURE_CLASS.PERMANENT_EXTERNAL,
        detail: 'CHE inspected the repository tree but it contains no editable source paths. This is a repository or permissions limitation, not an owner source-text request.',
        owner_message: 'The CHE repository has no source files CHE is allowed to edit, sir. That is a repository configuration limit, not something I need from you to code. Nothing was changed.',
      });
    }

    // Sources are always read at the exact inspected commit (head_sha), and
    // each file's blob SHA is kept so a later write can prove freshness.
    const sources = new Map();
    const blobShas = new Map();
    let baseSha = index.head_sha;
    const readInto = async (paths) => {
      const reads = await Promise.all([...new Set(paths)].map(async (path) => ({ path, file: await readFile(env, baseSha, path, fetcher) })));
      for (const { path, file } of reads) {
        if (!file) { note(ctx, { stage: 'read', kind: 'read_failed', path }); continue; }
        sources.set(path, file.text);
        blobShas.set(path, file.sha);
      }
      return reads.filter((item) => item.file).map((item) => item.path);
    };
    await readInto(chosen);
    if (!sources.size) {
      // First reads failed (wrong/unreadable files): try the tree fallback once.
      await readInto(fallbackTreeCandidates(task, index, terms, 4).filter((path) => !chosen.includes(path)));
    }
    if (!sources.size) {
      return finish({
        status: 503,
        failure_class: FAILURE_CLASS.TEMPORARY_EXTERNAL,
        retryable: true,
        detail: 'GitHub did not return the located source files.',
        owner_message: ownerEngineeringMessage(FAILURE_CLASS.TEMPORARY_EXTERNAL),
      });
    }

    // Main moved while CHE was working: re-read at the new head so nothing is
    // planned or written against stale source.
    const refreshBase = async () => {
      const head = await readHead(env, index.base, fetcher);
      if (head.error || head.sha === baseSha) return false;
      note(ctx, { stage: 'base', kind: 'base_moved', from: baseSha, to: head.sha });
      baseSha = head.sha;
      const paths = [...sources.keys()];
      sources.clear();
      blobShas.clear();
      await readInto(paths);
      chat.push({ from: 'CHE', msg: `${index.base} moved while we worked; every inspected file was re-read at the new head.` });
      return true;
    };

    // 3. Engineers build in parallel. If a pass fails, CHE re-inspects the
    //    repository and changes provider pair before trying again.
    const role = uiTask ? 'CHE Flutter UI Engineer' : 'CHE Flutter Implementation Agent';
    const feedbacks = CREW.engineers.map(() => '');
    let result = null;
    const maxRounds = ENGINEER_PROVIDER_ROUNDS.length;
    const seenStrategies = new Set();
    const rejectedNoChange = new Set();
    const failedStrategies = [];
    let widenEvidence = false;

    const inspectedEvidence = (budget, extraAnchors = new Map()) => packEvidence(sources, {
      terms,
      hits,
      anchors: extraAnchors,
      budget: widenEvidence ? Math.floor(budget * 1.0) : budget,
    });

    const record = (round, member, outcome, detail = '') => {
      ctx.outcomes.push({ round: round + 1, engineer: member.name, provider: member.provider, outcome, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) });
    };

    const attemptOnce = async (round, member, i) => {
      const res = await agentJson(ctx, {
        stage: 'engineer',
        role: who(member, role),
        assignment: [
          'Implement the change as exact search-and-replace edits on the inspected source.',
          'Return ONLY strict JSON. Normal change: {"summary":"1-2 sentences","edits":[{"path":"existing/source.file","find":"exact existing text","replace":"new text"}],"new_files":[{"path":"allowed/new.file","content":"COMPLETE FILE"}]}.',
          'If and only if the inspected code already satisfies the owner request and a real change would be duplicate, worse, unsafe, or unnecessary, return {"no_change":true,"summary":"why no delta is justified","evidence":["concrete file/function/capability evidence"]}. Never manufacture a no-op edit just to create a diff.',
          '"find" must be copied character-for-character from the source, WITHOUT the "123| " line-number prefixes, and must be unique in its file. Keep each find small (1-15 lines).',
          'Only edit files CHE is allowed to write. Read-only workflow/signing/dependency/config files may be inspected for context but must never appear in edits/new_files.',
          'You may edit any path listed in other_repository_files; CHE fetches it for you before applying the edit.',
          'Change only what the request needs. Preserve VoiceOver labels and voice-first behavior.',
          'Obey every team lesson. Read team_chat and failed_strategies: build on teammates\' good ideas and never repeat a failed strategy.',
        ].join('\n'),
        payload: (budget) => ({
          request: task,
          architecture,
          inspected: inspectedEvidence(Math.floor(budget * 0.7)),
          other_repository_files: listForBudget(index.editable_paths.filter((p) => !sources.has(p)), Math.floor(budget * 0.06)),
          previous_attempt_problem: feedbacks[i] || '',
          failed_strategies: failedStrategies.slice(-6),
          team_lessons: lessonText(lessons),
          team_chat: chat.slice(-20),
        }),
        maxTokens: 6000,
        provider: member.provider,
      });
      if (!res.ok) {
        if (res.failure_class === FAILURE_CLASS.TEMPORARY_EXTERNAL) {
          record(round, member, 'provider_unavailable');
          return null;
        }
        if (res.failure === 'budget') { record(round, member, 'budget_exhausted'); return null; }
        feedbacks[i] = 'Your last answer was not valid JSON. Return only the JSON object, with small edits.';
        record(round, member, 'invalid_json');
        return null;
      }
      const answer = res.value;
      const claimText = [answer.summary, ...(Array.isArray(answer.evidence) ? answer.evidence : [])].map(String).join(' ');
      if (isEvidenceRequest(claimText) && !(Array.isArray(answer.edits) && answer.edits.length)) {
        // The engineer says it lacks source it was given: agent failure, not
        // a strategy. CHE widens the evidence and retries.
        widenEvidence = true;
        feedbacks[i] = 'The verified repository source is in the "inspected" field of this request (fetched from GitHub by CHE). Work from it; other_repository_files lists more paths CHE will fetch if you edit them.';
        record(round, member, 'agent_evidence_request');
        return null;
      }
      if (answer.no_change === true) {
        const evidence = (Array.isArray(answer.evidence) ? answer.evidence : [])
          .map(String).map((item) => item.trim()).filter(Boolean).slice(0, 8);
        if (!evidence.length) {
          feedbacks[i] = 'A no-change conclusion needs concrete file/function/capability evidence from the inspected source.';
          record(round, member, 'no_change_without_evidence');
          return null;
        }
        // Two engineers agreeing on no-change is agreement, not repetition;
        // only a conclusion the reviewers already rejected is a dead strategy.
        const fingerprint = strategyFingerprint({ no_change: true, evidence });
        if (rejectedNoChange.has(fingerprint)) {
          feedbacks[i] = 'That no-change conclusion was already rejected by independent review. Implement a concrete change instead.';
          record(round, member, 'duplicate_strategy');
          return null;
        }
        const noChangeSummary = String(answer.summary || 'No code delta is justified.').trim().slice(0, 1200);
        chat.push({
          from: member.name,
          msg: `Round ${round + 1} via ${member.provider}. NO CHANGE: ${noChangeSummary} Evidence: ${evidence.join(' | ').slice(0, 1200)}`,
        });
        return { no_change: true, summary: noChangeSummary, evidence, engineer: member.name, provider: member.provider, fingerprint };
      }
      const fingerprint = strategyFingerprint(answer);
      if (seenStrategies.has(fingerprint)) {
        feedbacks[i] =
          'This exact implementation strategy was already attempted. ' +
          'Re-read current source and choose a materially different path, anchor, or implementation.';
        record(round, member, 'duplicate_strategy');
        return null;
      }
      seenStrategies.add(fingerprint);
      const failStrategy = (outcome, why) => {
        failedStrategies.push({ engineer: member.name, outcome, why: String(why).slice(0, 300), edits: (answer.edits || []).map((e) => `${e?.path}: ${String(e?.find || '').slice(0, 80)}`).slice(0, 3) });
        record(round, member, outcome, why);
      };
      const requestedEdits = Array.isArray(answer.edits) ? answer.edits : [];
      const requestedFiles = Array.isArray(answer.new_files) ? answer.new_files.slice(0, 4) : [];
      const protectedPath = [...requestedEdits, ...requestedFiles]
        .map((item) => String(item?.path || '').trim())
        .find((path) => !isSelfUpdateEditablePath(path));
      if (protectedPath !== undefined) {
        feedbacks[i] = `That edit targets a protected/read-only path: ${protectedPath || 'missing path'}. Keep the control plane read-only and implement through normal source instead.`;
        failStrategy('protected_path', protectedPath);
        return null;
      }
      // Edits to real repository files that were not inspected yet: CHE
      // fetches them herself instead of failing the strategy.
      const unseen = [...new Set(requestedEdits.map((edit) => String(edit?.path || '').trim()).filter((path) => path && !sources.has(path)))];
      const missing = unseen.filter((path) => !index.paths.includes(path));
      if (missing.length) {
        feedbacks[i] = `${missing.join(', ')} does not exist in the repository. Edit an existing file from inspected/other_repository_files, or use new_files for a genuinely new file.`;
        failStrategy('nonexistent_path', missing.join(', '));
        return null;
      }
      if (unseen.length) {
        const fetched = await readInto(unseen);
        if (fetched.length < unseen.length) {
          feedbacks[i] = `CHE could not read ${unseen.filter((p) => !fetched.includes(p)).join(', ')} from GitHub right now; work from the inspected files.`;
          record(round, member, 'read_failed');
          return null;
        }
        chat.push({ from: 'CHE', msg: `Fetched ${unseen.join(', ')} for ${member.name}'s edit.` });
      }
      const applied = applyEdits(sources, requestedEdits);
      if (applied.error) {
        feedbacks[i] = applied.error;
        failStrategy(/ambiguous/.test(applied.error) ? 'ambiguous_anchor' : 'missing_anchor', applied.error);
        return null;
      }
      for (const file of requestedFiles) {
        const path = String(file?.path || '').trim();
        if (index.paths.includes(path) || sources.has(path)) {
          feedbacks[i] = `${path} already exists; change it with edits, not new_files.`;
          failStrategy('overwrite_existing', path);
          return null;
        }
        if (typeof file?.content === 'string') applied.sources.set(path, file.content);
      }
      const diff = diffView(sources, applied.sources);
      if (!diff) {
        const diagnosis = diagnoseNoOp(sources, answer);
        feedbacks[i] =
          `${diagnosis} Re-inspect the source and make a real change that satisfies the owner request. ` +
          'Do not repeat this strategy.';
        failStrategy('no_diff', diagnosis);
        return null;
      }
      // Deterministic validation runs BEFORE any reviewer is paid for, and an
      // AI approval can never override it.
      const changedFiles = [...applied.sources.entries()]
        .filter(([path, content]) => sources.get(path) !== content)
        .map(([path, content]) => ({ path, content }));
      const checked = validateUpdateFiles(changedFiles, { baseline: sources });
      if (checked.error) {
        feedbacks[i] = `Deterministic validation rejected the change: ${checked.error} Fix it in a new edit.`;
        failStrategy('validation_failed', checked.error);
        return null;
      }
      if (!wantsDocsOnly(task) && !substantiveChange(sources, changedFiles)) {
        feedbacks[i] = 'That change only edits comments or documentation; it does not implement anything. Change the real code (widgets, logic, data) that delivers the request.';
        failStrategy('no_substance', 'comment/docs-only change');
        return null;
      }
      const unused = unusedNewCode(sources, applied.sources, changedFiles, task);
      if (unused.length) {
        feedbacks[i] = `The new code is never called: ${unused.map((u) => `${u.name} in ${u.path}`).join(', ')}. Code nothing calls delivers nothing. Call it from the real flow that delivers the request (ask for that file if you need it), or do not add it.`;
        failStrategy('dead_code', unused.map((u) => u.name).join(','));
        return null;
      }
      chat.push({ from: member.name, msg: `Round ${round + 1} via ${member.provider}. My change: ${String(answer.summary || '').slice(0, 300)}\n${diff.slice(0, 1500)}` });

      const anchors = new Map(changedFiles.map((file) => [file.path, changedLines(sources.get(file.path), file.content)]));
      const after = new Map([...sources, ...changedFiles.map((file) => [file.path, file.content])]);
      const evidence = {
        changed: (budget) => packEvidence(after, { terms: [], anchors, budget, paths: changedFiles.map((f) => f.path) }),
        inspected: (budget) => packEvidence(sources, { terms, hits, anchors, budget, paths: changedFiles.map((f) => f.path).filter((p) => sources.has(p)) }),
      };
      const reviewArgs = { request: task, architecture, diff, uiTask, lessons, chat, evidence };
      const first = await Promise.all(CREW.reviewers.map((reviewer) => reviewProposal(ctx, { ...reviewArgs, member: reviewer })));
      const reviews = await settleReviews(ctx, reviewArgs, first);
      reviews.forEach((r, k) => chat.push({
        from: CREW.reviewers[k].name,
        msg: r.agent_failure
          ? `Could not deliver a review verdict (${r.agent_failure}).`
          : `On ${member.name}'s change: ${r.approved === true ? 'APPROVE' : 'REJECT'} ${reviewNotes(r).slice(0, 500)}`,
      }));
      const unreviewed = reviews.filter((r) => r.agent_failure);
      if (unreviewed.some((r) => r.agent_failure === 'budget')) {
        record(round, member, 'budget_exhausted');
        return null;
      }
      if (unreviewed.length) {
        // Not a code rejection, no lesson, not the engineer's fault.
        record(round, member, 'review_unavailable', unreviewed.map((r) => `${r.reviewer}:${r.agent_failure}`).join(','));
        seenStrategies.delete(fingerprint);
        return null;
      }
      const passed = reviews.every((r) => r.approved === true && r.target_correct !== false);
      if (!passed) {
        const why = stripOwnerHomework(reviews.filter((r) => r.approved !== true || r.target_correct === false)
          .map((r) => reviewNotes(r)).join(' | ')) || 'Reviewers rejected it without specific notes; re-check target correctness and regressions.';
        feedbacks[i] = `Independent review rejected it: ${why}`.slice(0, 1500);
        failStrategy('review_rejected', why);
        for (const r of reviews) if (r.lesson) await recordLesson(memory, 'mistake', r.lesson);
        if (!reviews.some((r) => r.lesson)) await recordLesson(memory, 'mistake', `For "${task.slice(0, 80)}": ${why}`);
        return null;
      }
      return { next: applied.sources, files: checked.files, review: reviews, diff, discussion: chat.slice(-30), summary: String(answer.summary || 'CHE update').slice(0, 1800), engineer: member.name };
    };

    for (let round = 0; round < maxRounds && !result; round++) {
      const roundEngineers = CREW.engineers.map((member, i) => engineerForRound(member, i, round));
      const attempts = await Promise.all(roundEngineers.map((member, i) => attemptOnce(round, member, i)));

      const winner = attempts.find((attempt) => attempt && !attempt.no_change);
      if (winner) {
        result = winner;
        break;
      }

      const noChangeClaims = attempts.filter((attempt) => attempt?.no_change);
      if (noChangeClaims.length === roundEngineers.length) {
        const evidence = { inspected: (budget) => packEvidence(sources, { terms, hits, budget }) };
        const noChangeReviews = await Promise.all(CREW.reviewers.map((reviewer) =>
          reviewNoChange(ctx, { request: task, architecture, claims: noChangeClaims, lessons, member: reviewer, chat, evidence })));
        noChangeReviews.forEach((review, k) => chat.push({
          from: CREW.reviewers[k].name,
          msg: review.agent_failure
            ? `Could not deliver a no-change verdict (${review.agent_failure}).`
            : `On no-change conclusion: ${review.approved === true ? 'APPROVE' : 'REJECT'} ${reviewNotes(review).slice(0, 500)}`,
        }));
        if (noChangeReviews.every((review) => review.approved === true && !review.agent_failure)) {
          const evidenceLines = [...new Set(noChangeClaims.flatMap((claim) => claim.evidence))].slice(0, 12);
          return finish({
            status: 200,
            already_satisfied: true,
            summary: noChangeClaims.map((claim) => claim.summary).join(' | ').slice(0, 1800),
            evidence: evidenceLines,
            review: noChangeReviews,
            discussion: chat.slice(-30),
            team: [...CREW.planners, ...CREW.engineers, ...CREW.reviewers].map((m) => m.name),
            approval_required: false,
            next: 'No PR is needed because both engineers and both independent reviewers verified that no useful code delta is justified.',
          });
        }
        if (noChangeReviews.some((review) => review.agent_failure)) {
          noChangeClaims.forEach((claim) => record(round, { name: claim.engineer, provider: claim.provider }, 'review_unavailable'));
        } else {
          const rejection = stripOwnerHomework(noChangeReviews
            .flatMap((review) => [...(review.notes || []), review.repair_instructions])
            .filter(Boolean).join(' | ')).slice(0, 1200);
          feedbacks[0] = `No-change review rejected: ${rejection || 'insufficient evidence; implement a concrete improvement.'}`;
          feedbacks[1] = feedbacks[0];
          noChangeClaims.forEach((claim) => {
            rejectedNoChange.add(claim.fingerprint);
            failedStrategies.push({ engineer: claim.engineer, outcome: 'no_change_rejected', why: rejection.slice(0, 300) });
          });
        }
      }

      if (round >= maxRounds - 1) break;
      if (!ctx.budget.canSpend('engineer', 4000)) break;
      // A valid change could not be reviewed even after reviewer fallback:
      // engines are down (class B). Stop now instead of burning more rounds.
      if (ctx.outcomes.some((o) => o.round === round + 1 && o.outcome === 'review_unavailable')) break;

      // Failed pass: refresh the base, ask a different architect to
      // re-locate the real source, then fetch newly suggested files before
      // the next provider pair runs.
      await refreshBase();
      const feedback = [...new Set(feedbacks.filter(Boolean))].join(' || ');
      const recoveryMember = CREW.planners[(round + 1) % CREW.planners.length];
      const recovery = feedback
        ? await recoveryPlan(ctx, { task, architecture, feedback, index, lessons, member: recoveryMember, chat })
        : null;

      if (recovery) {
        const recoveryTerms = [
          ...(Array.isArray(recovery.search_terms) ? recovery.search_terms.map(String) : []),
          ...literalTerms(task),
        ].filter((item) => item.trim().length > 2);
        for (const term of recoveryTerms) if (!terms.includes(term)) terms.push(term);

        const recoveryPaths = Array.isArray(recovery.paths)
          ? recovery.paths.map(String).filter((path) => index.paths.includes(path))
          : [];
        architecture.plan = [architecture.plan, `Recovery ${round + 1}: ${String(recovery.plan || '')}`].filter(Boolean).join('\n');
        architecture.search_terms = [...new Set([...architecture.search_terms, ...recoveryTerms])];
        architecture.paths = [...new Set([...architecture.paths, ...recoveryPaths])];
        chat.push({
          from: recoveryMember.name,
          msg: `Recovery locate: ${String(recovery.plan || '').slice(0, 500)} Paths: ${recoveryPaths.join(', ') || 'search again'}`,
        });

        const moreHits = await searchCode(ctx, recoveryTerms, fetcher);
        for (const [path, count] of moreHits.entries()) hits.set(path, (hits.get(path) || 0) + count);
        const reranked = [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);
        const candidates = [...new Set([...recoveryPaths, ...reranked, ...architecture.paths])]
          .filter((path) => index.paths.includes(path))
          .slice(0, 8);
        await readInto(candidates);
      }
    }

    if (!result) {
      const feedback = feedbacks.filter(Boolean).join(' | ');
      if (/does not exist exactly|more than once/.test(feedback)) await recordLesson(memory, 'mistake', 'Edit "find" text must be copied exactly from the source without line-number prefixes and include enough lines to be unique.');
      const outcomes = ctx.outcomes.map((item) => item.outcome);
      // Temporary (B) when a valid candidate existed but could not be
      // reviewed, or when every real attempt failed for provider reasons.
      const real = outcomes.filter((outcome) => outcome !== 'duplicate_strategy');
      const temporary = outcomes.includes('review_unavailable')
        || (real.length > 0 && real.every((outcome) => outcome === 'provider_unavailable'));
      const engineering = [...new Set(feedbacks.filter(Boolean))].join(' | ');
      if (temporary) {
        return finish({
          status: 503,
          failure_class: FAILURE_CLASS.TEMPORARY_EXTERNAL,
          retryable: true,
          detail: 'AI engines were unavailable for implementation or independent review; no unreviewed change was proposed.',
          owner_message: ownerEngineeringMessage(FAILURE_CLASS.TEMPORARY_EXTERNAL),
        });
      }
      return finish({
        status: 422,
        failure_class: FAILURE_CLASS.INTERNAL,
        detail: `The coding team exhausted ${maxRounds} implementation passes and re-inspected the source but could not produce a safe reviewed change. ${engineering || 'No safe diff passed review.'}`.slice(0, 800),
        owner_message: ownerEngineeringMessage(FAILURE_CLASS.INTERNAL),
      });
    }

    await recordLesson(memory, 'location', `"${task.slice(0, 90)}" was done by editing ${result.files.map((f) => f.path).join(', ')}.`);
    const baseFiles = Object.fromEntries(result.files.map((file) => [file.path, blobShas.get(file.path) ?? null]));
    const summary = `${result.summary} (built by ${result.engineer}, approved by ${CREW.reviewers.map((r) => r.name).join(' and ')})`;
    return finish({
      status: 200,
      proposal: { summary, files: result.files, expected_base_sha: baseSha || '', base_files: baseFiles },
      review: result.review,
      diff: result.diff,
      discussion: result.discussion,
      validation: { deterministic: 'passed', checks: ['protected paths', 'secret scan', 'baseline-relative static check'] },
      team: [...CREW.planners, ...CREW.engineers, ...CREW.reviewers].map((m) => m.name),
      approval_required: true,
      next: 'Present the che-update proposal to the owner. Do not write or merge anything until owner approval.',
    });
  } catch (error) {
    const { failure_class: failureClass, kind } = classifyFailure(error);
    note(ctx, { stage: 'pipeline', kind: 'exception', error: String(error?.message || error).slice(0, 300) });
    return finish({
      status: failureClass === FAILURE_CLASS.TEMPORARY_EXTERNAL ? 503 : 502,
      failure_class: failureClass,
      retryable: failureClass === FAILURE_CLASS.TEMPORARY_EXTERNAL,
      detail: String(error?.message || error).slice(0, 1000),
      owner_message: ownerEngineeringMessage(failureClass, kind),
    });
  }
}
