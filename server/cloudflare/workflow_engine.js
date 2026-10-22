// Universal Workflow Engine: one library over what CHE already runs.
//
// Nothing here is a second router, planner or agent. CHE's deterministic chat handlers (each answers with a
// done.source), the Command Center catalog, REA, the owner's saved command workflows and the objective graph
// are the executors; this module names each of them as a reusable workflow, records every real owner run
// against the workflow that served it (outcome, model calls, time, verification), ranks workflows for a
// sentence, and learns: a request the language model answered three times that one real command covers becomes
// a candidate, is tested, and runs as a workflow (no model planning) only after the owner promotes it.
//
// Privacy: a run keeps the route, outcome, counts and up to six content words of the request with numbers,
// addresses and key-like strings removed. Never the message, reply, passwords or keys.
import { BROAD_SECRET_RE } from './security_intelligence.js';
import { COMMANDS, commandById, describeWorkflow, normalizeSavedWorkflow, searchCommands } from './command_catalog.js';

export const ENGINE_VERSION = 1;
export const WORKFLOW_ENGINE_KEY = 'che:workflow_engine';
const MAX_RUNS = 150;
const MAX_MISSES = 40;
const MAX_AUDIT = 50;
const MAX_VERSIONS = 5;
const CANDIDATE_AFTER = 3;
const LEARNED_MATCH = 0.75;

/** Building blocks the workflows are made of. Each names the existing code that does it. */
export const BLOCKS = Object.freeze({
  understand: { label: 'Read the request', code: 'chat routing in worker.js (deterministic intents first)' },
  owner_only: { label: 'Owner device check', code: 'ownerDevice / OWNER_CHAT_REQUESTS' },
  app_permission: { label: 'App permission', code: 'app permission gate (explicit per-app yes)' },
  money_delete_hold: { label: 'Money or delete hold', code: 'owner_action_gate.js' },
  approval: { label: 'Owner approval checkpoint', code: 'objective_graph approveNode' },
  connector: { label: 'Read a connected account', code: 'commandConnectors / OAuth tokens' },
  records: { label: 'Read CHE\'s own records', code: 'Durable Object storage' },
  memory: { label: 'Retrieve memory with provenance', code: 'memory_provenance.js / brain store' },
  sources: { label: 'Check sources', code: 'truth_layer.js / research cache' },
  legal: { label: 'Legal check', code: 'legal_intelligence.js' },
  command: { label: 'Run a Command Center command', code: 'runSlashCommand' },
  job: { label: 'Background job', code: 'jobs + objective graph' },
  render: { label: 'Render media', code: 'GitHub renderer / che-edit-render.yml' },
  verify: { label: 'Verify the result', code: 'evidence receipts / output checks' },
  receipt: { label: 'Action receipt', code: 'executeWithReceipt / reliability ledger' },
  recover: { label: 'Recover or retry', code: 'objective_graph recoverNode / retryNode' },
  speak: { label: 'Say the result', code: 'ndjsonReply (shown as large text, spoken when asked)' },
  model: { label: 'Language model answer', code: 'ai_router (model path)' },
});

// CHE's built-in workflows over its existing chat handlers. `sources` are the done.source values each one's
// handlers answer with; `context` is the only data that workflow may read (least necessary).
const S = (id, name, category, sources, extra) => Object.freeze({
  id, name, category, kind: 'system', version: 1, sources: Object.freeze(sources),
  summary: extra.summary, blocks: Object.freeze(extra.blocks), triggers: Object.freeze(extra.triggers || []),
  approval: extra.approval || 'none', verify: extra.verify || 'handler', context: Object.freeze(extra.context || ['request']),
  deterministic: extra.deterministic !== false,
});

export const SYSTEM_WORKFLOWS = Object.freeze([
  S('status_report', 'Status report', 'intelligence',
    ['che_activity_status', 'che_mission_status', 'che_verified_status', 'che_usage', 'che_engines', 'che_devices', 'device_clock', 'che_change_history', 'che_self_update', 'che_youtube_status', 'che_github_actions_deploy_status'],
    { summary: 'Says what is running, finished, deployed or used, from CHE\'s own records.', blocks: ['understand', 'records', 'speak'], triggers: ['doing', 'status', 'running', 'finished', 'deployed', 'usage', 'version', 'time', 'devices'], context: ['jobs', 'deploys'] }),
  S('memory_recall', 'Memory recall', 'intelligence',
    ['explicit_memory', 'che_memory', 'che_memory_search', 'che_memory_provenance', 'che_memory_setup', 'che_personal_recall', 'che_reply_provenance', 'location_provenance', 'che_identity'],
    { summary: 'Remembers or recalls what the owner told CHE, with where each memory came from.', blocks: ['understand', 'memory', 'verify', 'speak'], triggers: ['remember', 'recall', 'memory', 'told', 'forget', 'who', 'my name'], verify: 'provenance', context: ['memory'] }),
  S('knowledge_answer', 'Knowledge answer', 'intelligence',
    ['che_knowledge', 'che_knowledge_atlas', 'che_library', 'che_research_cache', 'che_cache', 'che_topic_study', 'che_source_check', 'che_resource_finder', 'che_browse', 'che_tech'],
    { summary: 'Answers from the Knowledge Library and checked sources before any model.', blocks: ['understand', 'sources', 'verify', 'speak'], triggers: ['what is', 'explain', 'research', 'source', 'library', 'learn', 'study', 'article'], verify: 'sources', context: ['knowledge'] }),
  S('trading_desk', 'Trading desk', 'trading',
    ['che_trading', 'che_trading_desk', 'che_trading_chart', 'che_trading_controls', 'che_trading_evidence', 'che_trading_intelligence', 'che_trading_live', 'che_trading_matrix', 'che_trading_ledgers', 'che_strategy_sim', 'che_brokerage'],
    { summary: 'Charts, paper trades, strategies and the account, with every order held for the owner\'s yes.', blocks: ['understand', 'connector', 'records', 'money_delete_hold', 'receipt', 'speak'], triggers: ['trade', 'trading', 'chart', 'portfolio', 'position', 'strategy', 'stock', 'futures', 'buy', 'sell', 'paper'], approval: 'money', verify: 'receipt', context: ['trading'] }),
  S('coding_job', 'Coding job', 'build',
    ['che_self_development', 'che_coding_history', 'che_coding_resume', 'che_coding_cancel', 'che_code_scout', 'che_repository_analysis', 'che_repository_inspection', 'che_engineering_playbook', 'che_app_build', 'che_pipeline', 'che_github_verification', 'che_handoff'],
    { summary: 'Inspects, plans or changes CHE\'s code as a reviewed draft pull request with tests.', blocks: ['understand', 'owner_only', 'job', 'verify', 'receipt', 'recover', 'speak'], triggers: ['code', 'build', 'fix', 'bug', 'pull request', 'repository', 'feature', 'implement'], approval: 'publish', verify: 'receipt', context: ['repository'] }),
  S('rea_investigation', 'Reverse-engineering analysis (REA)', 'build', ['che_rea'],
    { summary: 'Studies an app, site or repository and maps its features against CHE.', blocks: ['understand', 'connector', 'job', 'verify', 'receipt', 'speak'], triggers: ['reverse', 'engineer', 'analyze app', 'competitor', 'rea'], verify: 'receipt', context: ['repository', 'target'] }),
  S('media_create', 'Create media', 'studio',
    ['che_creator_studio', 'che_media_library', 'che_media_store', 'che_video_line', 'video_renderer', 'che_voice_studio', 'che_voice_test', 'che_image_generation', 'che_visual_studio', 'che_showroom', 'che_site_builder', 'che_invention_studio'],
    { summary: 'Makes and edits pictures, videos, voices and sites, and verifies the rendered file.', blocks: ['understand', 'job', 'render', 'verify', 'speak'], triggers: ['picture', 'image', 'video', 'edit', 'render', 'thumbnail', 'voice', 'website', 'caption', 'template'], approval: 'publish', verify: 'output', context: ['media'] }),
  S('music_business', 'Music business', 'studio', ['che_music_rights', 'che_music_business'],
    { summary: 'Songs, rights, deals and releases; nothing is signed, transferred or published without the owner.', blocks: ['understand', 'records', 'legal', 'approval', 'speak'], triggers: ['song', 'music', 'album', 'royalty', 'deal', 'release', 'label', 'split'], approval: 'publish', verify: 'receipt', context: ['music'] }),
  S('legal_check', 'Legal check', 'intelligence', ['che_legal'],
    { summary: 'Checks a question against official sources for the owner\'s place, with alternatives and risk.', blocks: ['understand', 'legal', 'sources', 'verify', 'speak'], triggers: ['legal', 'law', 'allowed', 'contract', 'license', 'sue', 'regulation', 'copyright'], verify: 'sources', context: ['legal'] }),
  S('expert_brief', 'Expert brief', 'intelligence', ['che_expert', 'che_health_urgent'],
    { summary: 'Health, finance and engineering answers from ranked sources, with red flags first.', blocks: ['understand', 'sources', 'verify', 'speak'], triggers: ['doctor', 'symptom', 'health', 'medication', 'lab', 'expert', 'engineering'], verify: 'sources', context: ['expert'] }),
  S('mail_and_accounts', 'Mail and accounts', 'office',
    ['che_google', 'che_mailbox', 'che_letters', 'che_starred_newest', 'github_stars', 'che_outside_correspondence', 'che_flagstaff_import'],
    { summary: 'Reads and sends mail and reads connected accounts, with app permission enforced.', blocks: ['understand', 'app_permission', 'connector', 'receipt', 'speak'], triggers: ['email', 'mail', 'inbox', 'gmail', 'calendar', 'drive', 'letter', 'unread'], approval: 'app', verify: 'receipt', context: ['mail'] }),
  S('office_delegation', 'Office delegation', 'office',
    ['che_office', 'office', 'che_office_skills', 'che_workshop', 'che_meeting_room', 'che_collaboration', 'ai_round_table', 'che_consult', 'che_flagstaff'],
    { summary: 'Hands work to the Office workers and AIs, and reports their real results.', blocks: ['understand', 'job', 'receipt', 'speak'], triggers: ['office', 'worker', 'team', 'meeting', 'delegate', 'assign', 'consult', 'round table'], verify: 'receipt', context: ['office'] }),
  S('command_run', 'Command run', 'intelligence',
    ['che_command', 'che_command_center', 'che_command_workflow', 'che_installed_skills', 'che_self_skills', 'che_engines_switch'],
    { summary: 'Runs a Command Center command or saved command workflow on the objective graph.', blocks: ['understand', 'command', 'approval', 'job', 'recover', 'speak'], triggers: ['command', 'workflow', 'run', 'skills'], verify: 'receipt', context: ['commands'] }),
  S('screen_describe', 'Describe the screen', 'intelligence', ['che_screen', 'che_read_only'],
    { summary: 'Describes the current screen from the phone\'s real screen report.', blocks: ['understand', 'records', 'speak'], triggers: ['screen', 'where am i', 'what is on', 'read this'], context: ['screen'] }),
  S('safety_gate', 'Safety gate', 'intelligence',
    ['che_held_action', 'owner_approved', 'credential_safety', 'che_secret_refused', 'che_keys', 'che_lockdown', 'che_guest', 'che_clarify'],
    { summary: 'Holds money and delete actions for a yes, refuses secrets in chat, and keeps guests apart.', blocks: ['understand', 'money_delete_hold', 'owner_only', 'speak'], triggers: ['yes', 'confirm', 'key', 'password', 'approve'], approval: 'money', context: ['request'] }),
  S('self_review', 'Self review', 'intelligence',
    ['che_brain_review', 'che_autonomy_exam', 'che_five_layer_exam', 'che_reliability', 'che_evidence_receipt', 'che_strategy_review'],
    { summary: 'CHE checks her own reliability, exams and evidence and reports the measured result.', blocks: ['understand', 'records', 'verify', 'speak'], triggers: ['reliability', 'exam', 'evidence', 'proof', 'review yourself'], verify: 'receipt', context: ['ledger'] }),
  S('open_conversation', 'Open conversation (language model)', 'intelligence', ['model', 'owner_chat', 'ai_layer', 'che_chat_only'],
    { summary: 'No reusable workflow fit, so the language model answered. These runs are what the engine learns from.', blocks: ['understand', 'model', 'speak'], triggers: [], context: ['request', 'recent_turns'], deterministic: false }),
]);

const BY_SOURCE = new Map(SYSTEM_WORKFLOWS.flatMap((w) => w.sources.map((s) => [s, w])));
const STOP = new Set('a an and are as at be but by can che chey chay could did do does doing for from get give have how i i\'m in is it its just let me my no not now of on or our please show so tell that the then there this to up us was we what when where which who why will with would you your yeah ok okay hey sir'.split(' '));

// Up to six content words of a request: numbers, addresses, links and key-like strings never kept.
export function signature(message = '') {
  const words = String(message || '').toLowerCase()
    .replace(/https?:\/\/\S+|\S+@\S+/g, ' ')
    .replace(/[^a-z' ]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, '').replace(/'s$/, ''))
    .filter((w) => w.length > 2 && w.length < 20 && !STOP.has(w));
  return [...new Set(words)].slice(0, 6).sort().join(' ');
}

function jaccard(a, b) {
  const x = new Set(String(a).split(' ').filter(Boolean)), y = new Set(String(b).split(' ').filter(Boolean));
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

// Key-, token- and password-shaped text. Workflows never carry these; an import that does is refused.
// One pattern set for CHE: Security Intelligence owns it (security_intelligence.js BROAD_SECRET_RE).
export const SECRET_RE = BROAD_SECRET_RE;

export function emptyState() {
  return { v: ENGINE_VERSION, stats: {}, runs: [], misses: {}, candidates: [], learned: [], prefs: { disabled: [], preferred: {} }, feedback: {}, versions: {}, audit: [] };
}

export async function loadEngine(storage) {
  let saved = null;
  try { saved = await storage.get(WORKFLOW_ENGINE_KEY); } catch (_) { saved = null; }
  const base = emptyState();
  return saved && typeof saved === 'object' ? { ...base, ...saved, prefs: { ...base.prefs, ...(saved.prefs || {}) } } : base;
}

export async function saveEngine(storage, state) {
  await storage.put(WORKFLOW_ENGINE_KEY, state);
}

function audit(state, action, detail, now) {
  state.audit = [{ at: now, action, detail: String(detail || '').slice(0, 160) }, ...(state.audit || [])].slice(0, MAX_AUDIT);
}

/** A command as a workflow: the catalog command is the definition, its handler the executor. */
function commandWorkflow(c) {
  return {
    id: `cmd:${c.id}`, name: `/${c.id}`, category: c.category, kind: 'command', version: 1, sources: c.route === 'model' ? [] : [c.route],
    summary: c.summary, blocks: ['understand', 'command', ...(c.confirm ? ['approval'] : []), ...(c.route === 'model' ? ['model'] : ['records']), 'speak'],
    triggers: [...c.keywords], approval: c.confirm ? 'owner' : 'none', verify: c.route === 'model' ? 'none' : 'handler',
    context: ['request'], deterministic: c.route !== 'model', command: c.id,
  };
}

/** The owner's saved command workflows (data.command_workflows) as library entries. Migrated in place, not copied. */
function ownerWorkflow(w, state) {
  const steps = (w.steps || []).map((s) => commandById(s.command)).filter(Boolean);
  const versions = state.versions?.[`owner:${w.id}`] || [];
  return {
    id: `owner:${w.id}`, name: w.name, category: steps[0]?.category || 'intelligence', kind: 'owner', version: versions.length + 1,
    sources: ['che_command_workflow'], summary: steps.map((c) => `/${c.id}`).join(' then '),
    blocks: ['understand', 'command', ...(steps.some((c) => c.confirm) ? ['approval'] : []), 'job', 'recover', 'speak'],
    triggers: [...new Set(w.name.toLowerCase().split(/\s+/).filter((t) => t.length > 2))], approval: steps.some((c) => c.confirm) ? 'owner' : 'none',
    verify: 'receipt', context: ['commands'], deterministic: steps.every((c) => c.route !== 'model'), saved_id: w.id, steps: w.steps,
  };
}

/** The whole library: built-in, every command, the owner's saved workflows and promoted learned ones. */
export function library(data = {}, state = emptyState()) {
  const disabled = new Set(state.prefs?.disabled || []);
  const all = [
    ...SYSTEM_WORKFLOWS.map((w) => ({ ...w })),
    ...COMMANDS.map(commandWorkflow),
    ...(Array.isArray(data.command_workflows) ? data.command_workflows : []).map((w) => ownerWorkflow(w, state)),
    ...(state.learned || []).map((w) => ({ ...w, kind: 'learned' })),
  ];
  return all.map((w) => ({ ...w, disabled: disabled.has(w.id), stats: statsView(state.stats?.[w.id]), feedback: state.feedback?.[w.id] || { up: 0, down: 0 } }));
}

function statsView(s) {
  if (!s?.runs) return { runs: 0, ok: 0, failed: 0, held: 0, verified: 0, success_rate: null, avg_model_calls: null, avg_ms: null, last_at: null };
  return {
    runs: s.runs, ok: s.ok, failed: s.failed, held: s.held || 0, verified: s.verified || 0,
    success_rate: Math.round((s.ok / s.runs) * 100), avg_model_calls: Math.round((s.model_calls / s.runs) * 100) / 100,
    avg_ms: Math.round(s.ms / s.runs), last_at: s.last_at,
  };
}

/** Which library workflow served a finished reply. */
export function workflowForRun({ source = '', slash = '', workflow_id = '', engine_workflow = '' } = {}, data = {}, state = emptyState()) {
  if (engine_workflow && (state.learned || []).some((w) => w.id === engine_workflow)) return engine_workflow;
  if (slash && commandById(slash)) return `cmd:${commandById(slash).id}`;
  if (source === 'che_command_workflow' && workflow_id && (data.command_workflows || []).some((w) => w.id === workflow_id)) return `owner:${workflow_id}`;
  const src = source || 'model';
  const sys = BY_SOURCE.get(src);
  if (sys) return sys.id;
  return `route:${src}`.slice(0, 60);
}

/**
 * Records one finished owner request against the workflow that served it. `done` is the reply's done event (or
 * the held-for-owner JSON). Model-answered requests are counted as misses by signature; three of the same kind
 * that one real command covers become a tested candidate.
 */
export function recordRun(state, { message = '', done = {}, held = false, slash = '', ms = 0, data = {} } = {}, now = new Date().toISOString()) {
  const source = held ? 'che_held_action' : String(done.source || 'model');
  const wf = workflowForRun({ source, slash, workflow_id: done.workflow_id, engine_workflow: done.engine_workflow }, data, state);
  // A route that does not report its count but shows a model served it (served_by, engine, an applied Soul) counts
  // as at least one call; only a route with no sign of a model counts as zero.
  const reported = done.model_calls !== undefined && done.model_calls !== null && Number.isFinite(Number(done.model_calls));
  const modelUsed = source === 'model' || Boolean(done.served_by || done.engine || done.provider || done.soul?.applied === true);
  const modelCalls = reported ? Number(done.model_calls) : modelUsed ? 1 : 0;
  const ok = !held && done.ok !== false;
  const sys = SYSTEM_WORKFLOWS.find((w) => w.id === wf);
  const verified = ok && Boolean(done.receipt || done.evidence || done.verified === true || done.verification || (sys && sys.deterministic && sys.verify === 'handler') || (wf.startsWith('cmd:') && modelCalls === 0));
  const sig = signature(message);
  const s = (state.stats[wf] ||= { runs: 0, ok: 0, failed: 0, held: 0, verified: 0, model_calls: 0, ms: 0, last_at: null });
  s.runs++; s.model_calls += modelCalls; s.ms += Math.max(0, Math.round(ms)); s.last_at = now;
  if (held) s.held++; else if (ok) s.ok++; else s.failed++;
  if (verified) s.verified++;
  state.runs = [{ at: now, wf, source, ok, held, model_calls: modelCalls, ...(reported ? {} : { model_calls_lower_bound: modelUsed }), ms: Math.round(ms), verified, sig }, ...(state.runs || [])].slice(0, MAX_RUNS);
  if (wf === 'open_conversation' && ok && sig && !slash) noteMiss(state, sig, message, now);
  return { workflow: wf, verified, model_calls: modelCalls };
}

function noteMiss(state, sig, message, now) {
  const misses = state.misses || (state.misses = {});
  // A near-identical earlier miss counts as the same kind of request.
  const key = Object.keys(misses).find((k) => jaccard(k, sig) >= LEARNED_MATCH) || sig;
  const m = (misses[key] ||= { count: 0, first_at: now, last_at: now });
  m.count++; m.last_at = now;
  const keys = Object.keys(misses);
  if (keys.length > MAX_MISSES) {
    for (const k of keys.sort((a, b) => String(misses[a].last_at).localeCompare(String(misses[b].last_at))).slice(0, keys.length - MAX_MISSES)) delete misses[k];
  }
  if (m.count >= CANDIDATE_AFTER) proposeCandidate(state, key, message, now);
}

/**
 * A candidate only when one real command clearly covers the request (a clear best match in the catalog), and
 * only when nothing in the library already does the same (dedupe). The request itself is its parameter.
 */
export function proposeCandidate(state, sig, message, now = new Date().toISOString()) {
  if ((state.candidates || []).some((c) => jaccard(c.sig, sig) >= LEARNED_MATCH) || (state.learned || []).some((w) => jaccard(w.sig, sig) >= LEARNED_MATCH)) return null;
  const ranked = searchCommands(message, { limit: 2 });
  const top = ranked[0];
  if (!top || top.score < 10 || (ranked[1] && ranked[1].score >= top.score)) return null;
  const command = commandById(top.id);
  if (!command || command.confirm || command.id === 'che') return null;
  const candidate = {
    id: `cand-${crypto.randomUUID().slice(0, 8)}`, sig, status: 'candidate', created_at: now,
    name: `${sig.split(' ').slice(0, 3).join(' ')} → /${command.id}`.slice(0, 80),
    steps: [{ command: command.id, input: '{request}' }],
    benefit: command.route === 'model' ? 'focused' : 'deterministic',
    reason: `The language model answered this kind of request ${state.misses?.[sig]?.count || CANDIDATE_AFTER} times; /${command.id} covers it${command.route === 'model' ? ' with a focused prompt' : ' with its own handler and no model planning'}.`,
  };
  state.candidates = [candidate, ...(state.candidates || [])].slice(0, 10);
  audit(state, 'candidate', candidate.name, now);
  return candidate;
}

/** Test step of candidate → test → promote: the steps must be real, valid and runnable with today's connectors. */
export function testCandidate(state, id, connectors = {}, now = new Date().toISOString()) {
  const c = (state.candidates || []).find((x) => x.id === id);
  if (!c) return { ok: false, reason: 'not_found' };
  const described = describeWorkflow({ name: c.name, steps: c.steps.map((s) => ({ ...s, input: 'sample request' })) }, connectors);
  c.test = { at: now, ok: described.ok, runnable: described.runnable, issues: described.issues.slice(0, 4) };
  c.status = described.ok ? 'tested' : 'failed_test';
  audit(state, 'test', `${c.name}: ${described.ok ? 'passed' : described.issues[0] || 'failed'}`, now);
  return { ok: described.ok, candidate: c };
}

/** Promote only on the owner's word, and only a candidate that passed its test. */
export function promoteCandidate(state, id, connectors = {}, now = new Date().toISOString()) {
  const c = (state.candidates || []).find((x) => x.id === id);
  if (!c) return { ok: false, reason: 'not_found' };
  if (c.status !== 'tested') {
    const tested = testCandidate(state, id, connectors, now);
    if (!tested.ok) return { ok: false, reason: 'failed_test', candidate: c };
  }
  const command = commandById(c.steps[0].command);
  const wf = {
    id: `learned:${c.id.replace(/^cand-/, '')}`, name: c.name, category: command?.category || 'intelligence', kind: 'learned', version: 1,
    sources: command && command.route !== 'model' ? [command.route] : [], summary: c.reason, sig: c.sig, steps: c.steps,
    blocks: ['understand', 'command', command?.route === 'model' ? 'model' : 'records', 'speak'], triggers: c.sig.split(' '),
    approval: 'none', verify: command?.route === 'model' ? 'none' : 'handler', context: ['request'],
    deterministic: command?.route !== 'model', benefit: c.benefit, promoted_at: now,
  };
  state.learned = [wf, ...(state.learned || []).filter((w) => w.id !== wf.id)].slice(0, 30);
  state.candidates = state.candidates.filter((x) => x.id !== id);
  audit(state, 'promote', wf.name, now);
  return { ok: true, workflow: wf };
}

export function dismissCandidate(state, id, now = new Date().toISOString()) {
  const c = (state.candidates || []).find((x) => x.id === id);
  if (!c) return { ok: false, reason: 'not_found' };
  state.candidates = state.candidates.filter((x) => x.id !== id);
  // The same kind of request does not come back as a candidate right away.
  if (state.misses?.[c.sig]) state.misses[c.sig].count = 0;
  audit(state, 'dismiss', c.name, now);
  return { ok: true };
}

/**
 * The promoted learned workflow this request matches, or null. Only promoted workflows run this way, and a
 * disabled one never does. The owner's request is the workflow's {request} parameter.
 */
export function matchLearned(state, message) {
  const sig = signature(message);
  if (!sig) return null;
  const disabled = new Set(state.prefs?.disabled || []);
  let best = null;
  for (const w of state.learned || []) {
    if (disabled.has(w.id)) continue;
    const score = jaccard(w.sig, sig);
    if (score >= LEARNED_MATCH && (!best || score > best.score)) best = { workflow: w, score };
  }
  if (!best) return null;
  return { ...best, steps: best.workflow.steps.map((s) => ({ command: s.command, input: s.input === '{request}' ? String(message).trim().slice(0, 1000) : s.input })) };
}

/**
 * Ranks library workflows for a sentence and explains each match: trigger words, the owner's preference, its
 * measured success and model calls. Disabled workflows are never offered.
 */
export function rankWorkflows(message, lib, state = emptyState(), { limit = 3 } = {}) {
  const text = ` ${String(message || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ')} `;
  const sig = signature(message);
  const preferred = Object.entries(state.prefs?.preferred || {}).filter(([k]) => k && jaccard(k, sig) >= 0.5).map(([, v]) => v);
  const scored = [];
  for (const w of lib) {
    if (w.disabled || w.id === 'open_conversation') continue;
    const hits = (w.triggers || []).filter((t) => t && (text.includes(` ${t} `) || (t.length > 4 && text.includes(` ${t}`))));
    // A workflow's name counts only through its distinctive words ("check", "run", "report" name many).
    const nameHits = String(w.name).toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 3 && !GENERIC_NAME_WORDS.has(t) && text.includes(` ${t}`));
    let score = hits.length * 3 + nameHits.length * 2;
    if (w.sig) score += jaccard(w.sig, sig) * 8;
    if (!score) continue;
    const st = w.stats || {};
    const why = [];
    if (hits.length) why.push(`matches "${hits.slice(0, 3).join('", "')}"`);
    if (preferred.includes(w.id)) { score += 6; why.push('you prefer it for this'); }
    if (st.runs >= 3) {
      score += ((st.success_rate ?? 0) - 50) / 25;
      why.push(`${st.success_rate}% of ${st.runs} runs succeeded`);
      if (st.avg_model_calls === 0) { score += 1; why.push('no model calls'); }
    }
    const fb = w.feedback || {};
    score += Math.min(2, fb.up || 0) * 0.5 - (fb.down || 0);
    if (fb.down) why.push(`${fb.down} "that was wrong" from you`);
    if (w.kind === 'system') score += 0.5;
    scored.push({ id: w.id, name: w.name, kind: w.kind, score: Math.round(score * 10) / 10, why: why.join('; '), deterministic: w.deterministic !== false });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** How much the workflows actually saved, from recorded runs only. */
export function efficiency(state) {
  const runs = state.runs || [];
  const wfRuns = runs.filter((r) => r.wf !== 'open_conversation' && !r.held);
  const modelRuns = runs.filter((r) => r.wf === 'open_conversation');
  const avg = (rs, f) => (rs.length ? Math.round((rs.reduce((n, r) => n + Number(f(r) || 0), 0) / rs.length) * 100) / 100 : null);
  const viaWorkflow = runs.length ? Math.round((wfRuns.length / runs.length) * 100) : 0;
  const workflowCalls = avg(wfRuns, (r) => r.model_calls);
  const modelCalls = avg(modelRuns, (r) => r.model_calls);
  const zero = wfRuns.filter((r) => r.model_calls === 0).length;
  return {
    requests: runs.length,
    via_workflow: wfRuns.length,
    via_model_only: modelRuns.length,
    held: runs.filter((r) => r.held).length,
    percent_via_workflow: viaWorkflow,
    workflow_runs_without_model: zero,
    avg_model_calls_workflow: workflowCalls,
    avg_model_calls_model_path: modelCalls,
    avg_ms_workflow: avg(wfRuns, (r) => r.ms),
    avg_ms_model_path: avg(modelRuns, (r) => r.ms),
    verified: runs.filter((r) => r.verified).length,
    // Model calls the workflow runs did not make, against the model path's own measured average. Null until both exist.
    model_calls_avoided: modelCalls == null || workflowCalls == null ? null : Math.max(0, Math.round((modelCalls - workflowCalls) * wfRuns.length)),
    learned_runs: runs.filter((r) => String(r.wf).startsWith('learned:')).length,
  };
}

export function speakEfficiency(e) {
  if (!e.requests) return 'No requests are recorded yet, sir. Each request you make from now on is recorded against the workflow that served it.';
  const parts = [`Of your last ${e.requests} requests, ${e.via_workflow} ran through reusable workflows (${e.percent_via_workflow} percent), and ${e.via_model_only} needed the language model with no workflow.`];
  if (e.workflow_runs_without_model) parts.push(`${plural(e.workflow_runs_without_model, 'workflow run')} used no model call at all.`);
  if (e.avg_model_calls_workflow != null && e.avg_model_calls_model_path != null) parts.push(`Workflow runs averaged ${e.avg_model_calls_workflow} model calls against at least ${e.avg_model_calls_model_path} on the model path; that is at least ${plural(e.model_calls_avoided, 'model call')} avoided, measured.`);
  if (e.avg_ms_workflow != null && e.avg_ms_model_path != null) parts.push(`They took ${e.avg_ms_workflow} milliseconds on average against ${e.avg_ms_model_path}.`);
  if (e.held) parts.push(`${e.held} waited for your yes.`);
  if (e.learned_runs) parts.push(`${e.learned_runs} ran through workflows learned from your repeated requests.`);
  return parts.join(' ');
}

function findWorkflow(lib, words) {
  const want = String(words || '').toLowerCase().replace(/^(?:the|my)\s+/, '').trim();
  if (!want) return null;
  return lib.find((w) => w.id.toLowerCase() === want || w.name.toLowerCase() === want || w.name.toLowerCase() === `/${want}`)
    || lib.find((w) => w.name.toLowerCase().includes(want) || w.id.toLowerCase().includes(want.replace(/\s+/g, '_')) || w.id.toLowerCase().includes(want.replace(/\s+/g, '-'))) || null;
}

export function setDisabled(state, lib, words, disabled, now = new Date().toISOString()) {
  const w = findWorkflow(lib, words);
  if (!w) return { ok: false, reason: 'not_found' };
  if (w.id === 'safety_gate' && disabled) return { ok: false, reason: 'protected', workflow: w };
  // Only workflows whose execution checks this switch can be turned off: commands, saved and learned workflows.
  // A built-in workflow is CHE's own handler for that kind of request; turning it off would not stop it.
  if (w.kind === 'system' && disabled) return { ok: false, reason: 'built_in', workflow: w };
  const set = new Set(state.prefs.disabled || []);
  if (disabled) set.add(w.id); else set.delete(w.id);
  state.prefs.disabled = [...set];
  audit(state, disabled ? 'disable' : 'enable', w.name, now);
  return { ok: true, workflow: w };
}

export function setPreferred(state, lib, words, forWhat, now = new Date().toISOString()) {
  const w = findWorkflow(lib, words);
  if (!w) return { ok: false, reason: 'not_found' };
  const key = signature(forWhat || w.name) || w.id;
  state.prefs.preferred = Object.fromEntries(Object.entries({ ...(state.prefs.preferred || {}), [key]: w.id }).slice(-30));
  audit(state, 'prefer', `${w.name} for ${key}`, now);
  return { ok: true, workflow: w, key };
}

/** "That was wrong" / "that worked": feedback on the workflow that served the last request. */
/** Is this workflow turned off by the owner? Checked by the executors (commands, saved and learned workflows). */
export function isDisabled(state, id) { return (state?.prefs?.disabled || []).includes(id); }

export function feedbackOnLast(state, good, now = new Date().toISOString()) {
  const last = (state.runs || []).find((r) => !r.feedback_for);
  if (!last) return { ok: false, reason: 'no_run' };
  const f = (state.feedback[last.wf] ||= { up: 0, down: 0 });
  if (good) f.up++; else f.down++;
  audit(state, good ? 'feedback_up' : 'feedback_down', last.wf, now);
  return { ok: true, workflow: last.wf, needs_review: f.down >= 3 };
}

/** Version history of the owner's saved workflows; the latest five earlier versions are kept for restore. */
export function noteVersion(state, earlier, now = new Date().toISOString()) {
  if (!earlier?.id) return;
  const key = `owner:${earlier.id}`;
  state.versions[key] = [{ at: now, name: earlier.name, steps: earlier.steps }, ...(state.versions[key] || [])].slice(0, MAX_VERSIONS);
  audit(state, 'version', earlier.name, now);
}

export function restoreVersion(state, data, savedId, index = 0, now = new Date().toISOString()) {
  const key = `owner:${savedId}`;
  const version = (state.versions[key] || [])[index];
  const current = (data.command_workflows || []).find((w) => w.id === savedId);
  if (!version || !current) return { ok: false, reason: 'not_found' };
  noteVersion(state, current, now);
  const restored = normalizeSavedWorkflow({ ...current, name: version.name, steps: version.steps }, now);
  restored.created_at = current.created_at;
  data.command_workflows = data.command_workflows.map((w) => (w.id === savedId ? restored : w));
  state.versions[key] = state.versions[key].filter((_, i) => i !== index + 1);
  audit(state, 'restore', restored.name, now);
  return { ok: true, workflow: restored };
}

/** Owner and learned workflows, portable, with no keys, tokens or passwords and no run history. */
export function exportWorkflows(data = {}, state = emptyState()) {
  const clean = (s) => (SECRET_RE.test(String(s || '')) ? '' : String(s || ''));
  return {
    format: 'che-workflows', version: ENGINE_VERSION,
    workflows: [
      ...(data.command_workflows || []).map((w) => ({ kind: 'owner', name: clean(w.name), steps: w.steps.map((s) => ({ command: s.command, input: clean(s.input), parallel: s.parallel === true })) })),
      ...(state.learned || []).map((w) => ({ kind: 'learned', name: clean(w.name), sig: w.sig, steps: w.steps.map((s) => ({ command: s.command, input: clean(s.input) })) })),
    ],
  };
}

/** Import: every step must be a real command, nothing secret-shaped, and an identical workflow is not duplicated. */
export function importWorkflows(data, state, payload = {}, now = new Date().toISOString()) {
  const items = Array.isArray(payload?.workflows) ? payload.workflows.slice(0, 30) : [];
  const out = { added: [], skipped: [] };
  const existing = data.command_workflows || (data.command_workflows = []);
  for (const item of items) {
    if (SECRET_RE.test(JSON.stringify(item))) { out.skipped.push({ name: String(item?.name || '').slice(0, 40), why: 'contains a key, token or password' }); continue; }
    const norm = normalizeSavedWorkflow({ name: item?.name, steps: item?.steps }, now);
    if (!norm) { out.skipped.push({ name: String(item?.name || '').slice(0, 40), why: 'no real commands' }); continue; }
    if (norm.steps.length !== (item.steps || []).length) { out.skipped.push({ name: norm.name, why: 'a step is not a CHE command' }); continue; }
    if (existing.some((w) => JSON.stringify(w.steps) === JSON.stringify(norm.steps))) { out.skipped.push({ name: norm.name, why: 'already in your library' }); continue; }
    if (existing.length >= 30) { out.skipped.push({ name: norm.name, why: 'the library holds 30 saved workflows' }); continue; }
    existing.push(norm);
    out.added.push(norm.name);
  }
  audit(state, 'import', `${out.added.length} added, ${out.skipped.length} skipped`, now);
  return out;
}

/** The Workflows page and "list my workflows": the library with stats, the gaps, candidates and audit. */
export function engineView(data = {}, state = emptyState()) {
  const lib = library(data, state);
  const gaps = Object.entries(state.misses || {}).sort((a, b) => b[1].count - a[1].count).slice(0, 8).map(([sig, m]) => ({ sig, count: m.count, last_at: m.last_at }));
  return {
    version: ENGINE_VERSION,
    blocks: Object.entries(BLOCKS).map(([id, b]) => ({ id, ...b })),
    workflows: lib.map((w) => ({ id: w.id, name: w.name, kind: w.kind, category: w.category, version: w.version, summary: w.summary, blocks: w.blocks, approval: w.approval, verify: w.verify, context: w.context, deterministic: w.deterministic !== false, disabled: w.disabled, stats: w.stats, feedback: w.feedback, steps: w.steps || null })),
    efficiency: efficiency(state),
    candidates: state.candidates || [],
    gaps,
    recent: (state.runs || []).slice(0, 20),
    audit: (state.audit || []).slice(0, 20),
    preferred: state.prefs?.preferred || {},
  };
}

/** What the owner asked about workflows, or null. Deterministic. */
export function workflowIntent(message = '') {
  const t = String(message || '').trim().toLowerCase().replace(/[’]/g, "'")
    .replace(/^(?:(?:hey|hi|ok|okay)[\s,.!]+)?(?:che|chay|chey|shay)\b[\s,.:;!?-]*/, '').replace(/^(?:please|can you|could you)\s+/, '').replace(/[.!?]+$/, '').trim();
  let m;
  if (/^(?:open\s+)?(?:the\s+|my\s+)?(?:workflows? page|workflow library page)$/.test(t) || /^open (?:my |the )?workflows$/.test(t)) return { action: 'list', open: true };
  if (/^(?:list|show|read|what are)\s+(?:me\s+)?(?:my\s+|the\s+|your\s+|all\s+)?(?:workflows|workflow library)$/.test(t)) return { action: 'list' };
  if ((m = /^(?:which|what) workflow (?:would|do|will|should) you use (?:for|to)\s+(.{3,200})$/.exec(t))) return { action: 'explain', about: m[1] };
  if (/^(?:workflow|workflows) (?:stats|savings|efficiency|report|measurements?)$/.test(t) || /^how much (?:did|do|have) (?:the |my |your )?workflows (?:save|saved)/.test(t)) return { action: 'efficiency' };
  if ((m = /^(?:disable|turn off|stop using) (?:the |my )?(.{2,60}?) workflow$/.exec(t))) return { action: 'disable', name: m[1] };
  if ((m = /^(?:enable|turn on|start using) (?:the |my )?(.{2,60}?) workflow(?: again)?$/.exec(t))) return { action: 'enable', name: m[1] };
  if ((m = /^(?:prefer|always use) (?:the |my )?(.{2,60}?) workflow(?: for (.{3,120}))?$/.exec(t))) return { action: 'prefer', name: m[1], for: m[2] || '' };
  if (/^(?:read |show |list )?(?:the |my )?workflow candidates$|^(?:any )?(?:new|learned) workflows? to (?:review|approve)$/.test(t)) return { action: 'candidates' };
  if ((m = /^(?:promote|approve|accept) (?:workflow )?candidate (?:number )?(\d{1,2}|one|two|three|four|five)$/.exec(t))) return { action: 'promote', index: numberWord(m[1]) };
  if ((m = /^(?:dismiss|reject|decline) (?:workflow )?candidate (?:number )?(\d{1,2}|one|two|three|four|five)$/.exec(t))) return { action: 'dismiss', index: numberWord(m[1]) };
  if (/^that workflow (?:was wrong|is wrong|didn't work|did not work|failed)$/.test(t)) return { action: 'feedback', good: false };
  if (/^that workflow (?:worked|was right|was good)$/.test(t)) return { action: 'feedback', good: true };
  if (/^(?:workflow|workflows) (?:history|audit|changes)$/.test(t)) return { action: 'audit' };
  if (/^export (?:my |the )?workflows$/.test(t)) return { action: 'export' };
  if (/^(?:workflow|workflows) status$|^(?:what|which) workflows? (?:is|are) running$/.test(t)) return { action: 'status' };
  if ((m = /^(?:resume|continue|unpause) (?:my |the )?(.{2,60}?) workflow$/.exec(t))) return { action: 'resume', name: m[1] };
  return null;
}

const GENERIC_NAME_WORDS = new Set(['check', 'report', 'run', 'answer', 'create', 'open', 'conversation', 'language', 'model', 'review', 'brief', 'status', 'recall', 'desk', 'make', 'build']);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const numberWord = (w) => (/^\d+$/.test(w) ? Number(w) : { one: 1, two: 2, three: 3, four: 4, five: 5 }[w] || 0);

/** One spoken list of the library, numbered, at most `count`. */
export function speakLibrary(view, count = 6) {
  const used = view.workflows.filter((w) => w.stats.runs).sort((a, b) => b.stats.runs - a.stats.runs).slice(0, count);
  const kinds = view.workflows.reduce((m, w) => ((m[w.kind] = (m[w.kind] || 0) + 1), m), {});
  const head = `Your workflow library has ${view.workflows.length} workflows: ${kinds.system || 0} built in, ${kinds.command || 0} commands, ${kinds.owner || 0} you saved and ${kinds.learned || 0} learned.`;
  if (!used.length) return `${head} None has run since recording started.`;
  return `${head} Most used: ${used.map((w, i) => `${i + 1}. ${w.name}, ${w.stats.runs} runs, ${w.stats.success_rate} percent succeeded`).join('; ')}.`;
}
