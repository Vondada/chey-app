// CHE truth layer: claim <= verified_execution_state.
//
// Model output may PROPOSE an action ("I should ask Claude"); only real
// execution records (receipts) can make CHE SAY it happened. This module:
//  - stores receipts for real actions (mail sent/received, jobs, study,
//    proposals, PRs, merges, deploys, CI);
//  - builds the verified state CHE is allowed to report;
//  - strips unsupported action claims and owner "homework" from
//    model-generated owner replies before they reach chat or voice.

import { requestNamesAction, storyRequested } from './memory_provenance.js';
import { isEvidenceRequest } from './recovery_policy.js';

export const RECEIPTS_KEY = 'che_receipts';
export const PEERS = ['claude', 'chatgpt', 'codex', 'gemini', 'grok', 'copilot', 'cursor'];
const PEER_RE = '(claude|chat\\s?gpt|codex|gemini|grok|copilot|cursor)';
const RECENT_MS = 6 * 3600_000;

export function normalizePeerName(name) {
  const value = String(name || '').toLowerCase().replace(/\s+/g, '');
  return value === 'chatgpt' || value === 'chat-gpt' ? 'chatgpt' : value;
}

// Append-only receipt log (bounded). `key` makes recording idempotent.
export async function recordReceipt(storage, receipt) {
  if (!storage?.get || !storage?.put) return null;
  let list = [];
  try { list = (await storage.get(RECEIPTS_KEY)) || []; } catch (_) { list = []; }
  if (!Array.isArray(list)) list = [];
  if (receipt.key && list.some((item) => item.key === receipt.key)) return list.find((item) => item.key === receipt.key);
  const entry = { ...receipt, at: receipt.at || new Date().toISOString() };
  list.push(entry);
  try { await storage.put(RECEIPTS_KEY, list.slice(-300)); } catch (_) {}
  if (CHANGE_EVENTS.has(entry.kind) && Number(entry.number) > 0) await recordChange(storage, entry);
  return entry;
}

// ─── Change history ──────────────────────────────────────────────────────────
// One entry per CHE update (pull request), built only from real receipts, so
// "what changed?" never reports anything that did not happen. Kept apart from
// the general receipt log so mail traffic never pushes old updates out.
export const CHANGE_HISTORY_KEY = 'che_change_history';
const CHANGE_EVENTS = new Set(['pr_opened', 'update_approved', 'ci_passed', 'merged', 'deployed', 'deploy_failed']);
const MAX_CHANGES = 250;

async function recordChange(storage, receipt) {
  let list = [];
  try { list = (await storage.get(CHANGE_HISTORY_KEY)) || []; } catch (_) { list = []; }
  if (!Array.isArray(list)) list = [];
  const number = Number(receipt.number);
  let entry = list.find((item) => item.number === number);
  if (!entry) {
    entry = { number, opened_at: receipt.at };
    list.push(entry);
  }
  if (receipt.kind === 'pr_opened') {
    if (receipt.url) entry.url = String(receipt.url).slice(0, 200);
    if (receipt.summary) entry.summary = String(receipt.summary).slice(0, 220);
    if (Array.isArray(receipt.files)) entry.files = receipt.files.map(String).slice(0, 8);
    if (receipt.sha) entry.commit = String(receipt.sha).slice(0, 40);
  }
  if (receipt.kind === 'update_approved') entry.approved_at = receipt.at;
  if (receipt.kind === 'ci_passed') entry.checks = 'passed';
  if (receipt.kind === 'merged') { entry.merged_at = receipt.at; if (receipt.sha) entry.merge_commit = String(receipt.sha).slice(0, 40); }
  if (receipt.kind === 'deployed') entry.deployed_at = receipt.at;
  if (receipt.kind === 'deploy_failed') entry.deploy_failed_at = receipt.at;
  try { await storage.put(CHANGE_HISTORY_KEY, list.slice(-MAX_CHANGES)); } catch (_) {}
}

export async function loadChangeHistory(storage) {
  try {
    const list = (await storage?.get?.(CHANGE_HISTORY_KEY)) || [];
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

// "What changed?", "what did you change", "change history", "your updates".
export function changeHistoryIntent(message) {
  const text = String(message || '').trim();
  if (!text || text.length > 120) return false;
  return /^(?:(?:che|chay|chey|shay)[,:]?\s*)?(?:what(?:'s| has| have)?\s+(?:you\s+)?changed(?:\s+(?:lately|recently|in you|about you|in your (?:code|app)))?(?:\s+(?:this week|this month|today|lately|recently))?|what\s+did\s+you\s+(?:change|update)(?:\s+(?:lately|recently|in yourself))?|(?:show|read|tell)\s+(?:me\s+)?(?:your\s+|the\s+)?(?:change|update)\s+(?:history|log)|(?:your\s+)?(?:change|update)\s+(?:history|log)|what\s+updates?\s+(?:did\s+you\s+(?:get|make|do)|have\s+you\s+(?:had|made)))[?.!]*$/i.test(text);
}

export function speakChangeHistory(list, limit = 5) {
  const items = (Array.isArray(list) ? list : []).slice(-limit).reverse();
  if (!items.length) return 'I have no recorded updates to myself yet, sir. Every change I make from now on is logged here with its pull request, checks and delivery.';
  const date = (iso) => (iso ? String(iso).slice(0, 10) : '');
  const lines = items.map((item, i) => {
    const state = item.deployed_at ? `merged and verified live on ${date(item.deployed_at)}`
      : item.deploy_failed_at ? 'merged, but its deploy failed, so production kept the previous version'
        : item.merged_at ? `merged on ${date(item.merged_at)}`
          : item.approved_at ? 'approved, waiting for its checks before I merge it'
            : 'opened, not merged';
    return `${i + 1}. Pull request ${item.number}${item.summary ? `: ${item.summary}` : ''}. ${state[0].toUpperCase()}${state.slice(1)}.`;
  });
  return `My latest ${items.length === 1 ? 'update' : `${items.length} updates`}, newest first, sir:\n${lines.join('\n')}`;
}

export async function loadReceipts(storage, { sinceMs = RECENT_MS, now = Date.now() } = {}) {
  let list = [];
  try { list = (await storage?.get?.(RECEIPTS_KEY)) || []; } catch (_) { list = []; }
  return (Array.isArray(list) ? list : []).filter((item) => now - Date.parse(item.at || 0) <= sinceMs);
}

// What CHE can truthfully say right now.
export function verifiedState(receipts, jobs = [], extras = {}) {
  const byKind = (kind) => receipts.filter((r) => r.kind === kind);
  const lastFor = (kind, peer) => byKind(kind).filter((r) => r.peer === peer).at(-1) || null;
  const peers = {};
  for (const peer of PEERS) {
    const sent = lastFor('mail_sent', peer);
    const reply = lastFor('mail_received', peer);
    if (sent || reply) {
      peers[peer] = {
        sent: Boolean(sent),
        sent_id: sent?.message_id || '',
        sent_at: sent?.at || '',
        replied: Boolean(reply && (!sent || reply.at >= sent.at)),
        reply_id: reply?.message_id || '',
        reply_text: reply?.text || '',
      };
    }
  }
  const engineeringKinds = new Set(['self_development', 'repo_study']);
  const activeJobs = (jobs || []).filter((job) => engineeringKinds.has(job.kind) && ['queued', 'running'].includes(job.status));
  const finishedJobs = (jobs || []).filter((job) => engineeringKinds.has(job.kind) && ['complete', 'failed'].includes(job.status)
    && Date.now() - Date.parse(job.updated_at || 0) <= RECENT_MS);
  // Status is about NOW: old receipts are history, not current state, and a
  // PR that was merged afterwards is no longer "open". (Old merge/deploy
  // receipts were read out as "the repository was updated" for new work.)
  const recent = (receipt) => receipt && Date.now() - Date.parse(receipt.at || 0) <= RECENT_MS ? receipt : null;
  const merged = recent(byKind('merged').at(-1) || null);
  const openPr = recent(byKind('pr_opened').at(-1) || null);
  const prStillOpen = openPr && !byKind('merged').some((r) => Number(r.number) === Number(openPr.number) && r.at >= openPr.at) ? openPr : null;
  return {
    peers,
    active_jobs: activeJobs.map((job) => ({ id: job.id, kind: job.kind, status: job.status, title: job.title })),
    finished_jobs: finishedJobs.map((job) => ({ id: job.id, kind: job.kind, status: job.status, title: job.title, owner_message: job.owner_message || '' })),
    study: byKind('study_complete').at(-1) || null,
    study_started: byKind('study_started').at(-1) || null,
    proposal_ready: Boolean(extras.pendingProposal),
    proposal_summary: String(extras.pendingProposal?.summary || '').slice(0, 160),
    pr: openPr,
    pr_open: Boolean(prStillOpen),
    merged,
    deployed: recent(byKind('deployed').at(-1) || null),
    ci_passed: recent(byKind('ci_passed').at(-1) || null),
    renders: byKind('video_render').slice(-3).map((r) => ({ task_id: String(r.task_id || ''), topic: String(r.topic || '').slice(0, 120), status: String(r.status || 'queued'), at: r.at || '' })),
  };
}

const shortId = (id) => String(id || '').slice(0, 8);
const peerLabel = (peer) => ({ chatgpt: 'ChatGPT', claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grok: 'Grok', copilot: 'Copilot', cursor: 'Cursor' }[peer] || peer);

// Deterministic owner-facing status built only from receipts and jobs.
export function verifiedStatusText(state) {
  const lines = [];
  for (const render of state.renders || []) {
    lines.push(`Video render ${shortId(render.task_id)} for "${render.topic}" is ${render.status} on the free renderer. No upload is recorded.`);
  }
  for (const job of state.active_jobs) {
    lines.push(`${job.kind === 'repo_study' ? 'Repository study' : 'Coding job'} ${shortId(job.id)} is ${job.status === 'running' ? 'running' : 'queued to run'}.`);
  }
  for (const job of state.finished_jobs.slice(-2)) {
    lines.push(job.owner_message || `${job.kind === 'repo_study' ? 'Repository study' : 'Coding job'} ${shortId(job.id)} ${job.status === 'complete' ? 'finished' : 'stopped without a result'}.`);
  }
  for (const [peer, info] of Object.entries(state.peers)) {
    if (info.replied) lines.push(`${peerLabel(peer)} replied (message ${shortId(info.reply_id)}).`);
    else if (info.sent) lines.push(`I sent ${peerLabel(peer)} the request (message ${shortId(info.sent_id)}); no reply yet.`);
  }
  if (state.proposal_ready) {
    // Said as its own fact, so a stopped newer job and an older waiting
    // change never read as one contradictory story.
    const what = state.proposal_summary ? ` (${state.proposal_summary})` : '';
    lines.push(state.finished_jobs.length
      ? `Separately, an earlier reviewed change${what} is still waiting for your approval; it is not on GitHub yet.`
      : `A reviewed change${what} is waiting for your approval; it is not on GitHub yet.`);
  }
  if (state.pr && state.pr_open !== false) lines.push(`PR #${state.pr.number} is open.`);
  if (state.merged) lines.push(`PR #${state.merged.number} was merged (commit ${String(state.merged.sha || '').slice(0, 7)}).`);
  if (state.deployed) lines.push('The last merged Worker change was verified as deployed.');
  if (!lines.length) return 'Nothing is running right now, sir: no coding job, repository study or AI request is in progress.';
  return `Here is exactly where things stand, sir. ${lines.join(' ')}`;
}

// ─── Claim guard ─────────────────────────────────────────────────────────────
// Each rule: a pattern for an execution claim and the evidence it requires.

function mentionedPeers(sentence) {
  const out = new Set();
  for (const m of sentence.matchAll(new RegExp(PEER_RE, 'gi'))) out.add(normalizePeerName(m[1]));
  return [...out];
}

// Work claims are policed in engineering context only, so ordinary chat
// ("I reviewed your calendar" with a real tool result) is not touched.
const ENGINEERING = /\b(?:code|codebase|repo|repositor\w*|source|files?|pr|pull request|branch|commits?|integrat\w*|implement\w*|patch\w*|engineer\w*|architecture|modifications?|agents?|deploy\w*|tests?|upgrade|delegation|study|analysis|plan|self[-_ ]?development)\b/i;

const RULES = [
  {
    name: 'peer_collaboration',
    test: (s) => new RegExp(`\\b${PEER_RE}\\b`, 'i').test(s) && (
      /\b(?:contacted|messaged|reached out|emailed|pinged|sent|told|asked|notified|coordinat\w*|synced|opened\b[^.]{0,40}\bmailbox)\b/i.test(s)
      || /\b(?:and I|with me|we)\b[^.]{0,30}\b(?:are|am|have been|were)\b[^.]{0,20}\b(?:working|reading|reviewing|coordinating|collaborating|analy[sz]ing|comparing|building|coding)\b/i.test(s)
      || new RegExp(`\\b${PEER_RE}\\b[^.]{0,20}\\b(?:is|are|has been)\\s+(?:currently\\s+)?(?:working|helping|reviewing|reading|coding|building|analy[sz]ing|on it|finished|done)\\b`, 'i').test(s)
      || /\b(?:replied|responded|answered|acknowledged|agreed|confirmed)\b/i.test(s)
    ),
    supported: (s, st) => {
      const peers = mentionedPeers(s);
      if (!peers.length) return false;
      const needsReply = /\b(?:replied|responded|answered|acknowledged|agreed|confirmed|working|helping|reviewing|reading|coding|building|analy[sz]ing|finished|done|on it|and I|with me|we)\b/i.test(s);
      return peers.every((peer) => (needsReply ? st.peers[peer]?.replied : st.peers[peer]?.sent));
    },
  },
  {
    name: 'work_in_progress',
    test: (s) => /\b(?:I(?:'m| am)|I have been|we(?:'re| are))\s+(?:currently\s+|now\s+|already\s+)?(?:analy[sz]ing|reading|reviewing|inspecting|integrating|working on|mapping|building|coding|implementing|studying|comparing|verifying|fixing|testing|preparing|drafting|staging)\b/i.test(s)
      || /\b(?:the\s+)?(?:agents?|team|office|crew|engineers?)\s+(?:is|are)\s+(?:currently\s+|now\s+)?(?:working|analy[sz]ing|building|coding|reviewing)\b/i.test(s),
    supported: (s, st) => !ENGINEERING.test(s) || st.active_jobs.length > 0,
  },
  {
    name: 'work_done',
    test: (s) => /\b(?:I|we|the team|my team)\s+(?:have\s+|has\s+|'ve\s+)?(?:already\s+|now\s+|just\s+)?(?:inspected|analy[sz]ed|reviewed|mapped out|designed|studied|compared|integrated|implemented|verified|fixed|finished|completed|built|tested|confirmed|created|configured|enabled|finalized|set up|wired|added|updated|initiated|activated)\b/i.test(s)
      || /\bmy analysis (?:confirms|shows)\b/i.test(s),
    supported: (s, st, ctx) => (!ENGINEERING.test(s) && !/\b(?:fixed|finished|completed|implemented|integrated|tested|configured|enabled|finalized|wired|activated)\b/i.test(s)) || ctx.turnEvidence || st.finished_jobs.some((job) => job.status === 'complete') || Boolean(st.study)
      || (/\b(?:pull request|pr)\b/i.test(s) && Boolean(st.pr)),
  },
  {
    name: 'tests',
    test: (s) => /\b(?:tests?|checks?|ci)\s+(?:all\s+)?(?:passed|are passing|ran|succeeded|went green)\b/i.test(s),
    supported: (_s, st) => Boolean(st.ci_passed),
  },
  {
    name: 'pr',
    test: (s) => /\b(?:created|opened|submitted|raised)\s+(?:the\s+|a\s+)?(?:draft\s+)?(?:pull request|pr)\b/i.test(s) || /\b(?:pull request|pr)\b[^.]{0,20}\b(?:is|was)\s+(?:open|opened|created|ready)\b/i.test(s),
    supported: (_s, st) => Boolean(st.pr),
  },
  {
    name: 'ready_for_pr',
    test: (s) => /\bready to (?:create|open|stage|submit)\b[^.]{0,30}\b(?:pull request|pr)\b/i.test(s) || /\b(?:pull request|pr)\b[^.]{0,30}\bready to be (?:staged|created|opened)\b/i.test(s),
    supported: (_s, st) => st.proposal_ready,
  },
  {
    name: 'merged',
    test: (s) => /\b(?:I|we|it)\s+(?:have\s+|has been\s+|was\s+)?merged\b/i.test(s),
    supported: (_s, st) => Boolean(st.merged),
  },
  {
    name: 'deployed',
    test: (s) => /\b(?:deployed|is live|in production|production is running)\b/i.test(s) && !/\bnot\b/i.test(s),
    supported: (_s, st) => Boolean(st.deployed),
  },
];

function splitSentences(text) {
  // Sentence ends are punctuation followed by whitespace/end, so file names
  // like self_development.js stay inside their sentence.
  return String(text || '').match(/[\s\S]+?(?:[.!?]+(?=\s|$)\s*|\n+|$)/g)?.filter((part) => part.length) || [];
}

// Returns { text, removed: [{rule, sentence}], homework: boolean }.
export function guardOwnerReply(reply, state, ctx = {}) {
  const removed = [];
  let homework = false;
  const kept = [];
  for (const sentence of splitSentences(reply)) {
    const plain = sentence.trim();
    if (!plain) { kept.push(sentence); continue; }
    if (ctx.repoAvailable !== false && isEvidenceRequest(plain)) {
      homework = true;
      removed.push({ rule: 'owner_homework', sentence: plain });
      continue;
    }
    const broken = RULES.find((rule) => rule.test(plain) && !rule.supported(plain, state, ctx));
    if (broken) {
      removed.push({ rule: broken.name, sentence: plain });
      continue;
    }
    kept.push(sentence);
  }
  return { text: kept.join('').replace(/\n{3,}/g, '\n\n').trim(), removed, homework };
}

/**
 * Grounded-fact guard for replies built on a repository inspection: a
 * sentence naming a file that is not in the inspected commit, a pull request
 * link to another repository, or a job id CHE does not hold is removed, and
 * so is any "I verified it" sentence in a reply that needed such removal.
 */
// Quoted code must exist in the repository. `codeIncludes(text)` answers
// whether the exact text appears anywhere in the pinned commit; without it
// code quotes are not checked.
// Code CHE writes herself (an exam answer, a proposed fix) is not a quote, so
// it is not checked against the repository. That needs affirmative context:
// the line introducing this block says so ("here is my fix", "I wrote"), or
// the block defines a function the sender asked her to write or fix and the
// introducing line does not present it as existing code ("the current code
// is"). A name merely missing from the repository is not evidence of
// authorship (it is what a hallucinated quote looks like).
const NEW_CODE_CUE = /\b(?:here(?:'s| is) (?:my|the|a|an) (?:fix|fixed|new|corrected|solution|implementation|version|function|answer|code)|I (?:wrote|write|would write|have written|fixed|rewrote|corrected)|my (?:fix|solution|version|implementation|code|answer)|(?:fixed|corrected|new|proposed|suggested|rewritten) (?:version|code|function|implementation|loop))\b/i;
const DEFINES = /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^\s*def\s+([A-Za-z_]\w*)|^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/m;

const QUOTE_CUE = /\b(?:current(?:ly)?|existing|repository|repo|codebase|pinned|defined (?:as|in)|the (?:line|code|source) (?:is|reads|says)|looks like this|in [\w./-]+\.(?:dart|m?js|cjs|ts|tsx|py|swift|kt))\b/i;

function isOwnCode(intro, body, authoredNames) {
  if (NEW_CODE_CUE.test(intro)) return true;
  const m = DEFINES.exec(body);
  const name = m && (m[1] || m[2] || m[3]);
  return Boolean(name && authoredNames.has(name) && !QUOTE_CUE.test(intro));
}

/**
 * Function names a request asks CHE to write or fix: "write a function
 * vowelCount(s)", or a `function sumTo(` given in a request about a bug.
 */
export function requestedCodeNames(request) {
  const text = String(request || '');
  const names = new Set();
  for (const m of text.matchAll(/\b(?:write|implement|create|code|build)\b[^.\n]{0,60}?\bfunction\s+([A-Za-z_$][\w$]*)/gi)) names.add(m[1]);
  // "Write canAttempt(state, kind) and recordAttempt(state, kind)": every name
  // called in a sentence that asks for writing counts, not only the first.
  for (const sentence of text.split(/[.;\n]/)) {
    if (!/\b(?:write|implement|create|code|build)\b/i.test(sentence)) continue;
    for (const m of sentence.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
  }
  if (/\b(?:fix|bug|wrong|correct)/i.test(text)) for (const m of text.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
  return names;
}

function stripUnverifiedCode(reply, codeIncludes, removed, flagOnly = false, authoredNames = new Set()) {
  if (typeof codeIncludes !== 'function') return reply;
  const text = String(reply || '');
  let lastEnd = 0;
  return text.replace(/```[^\n]*\n([\s\S]*?)```/g, (block, body, at) => {
    // Only the line that introduces this block counts, not a cue for an earlier block.
    const intro = text.slice(lastEnd, at).trim().split('\n').pop().slice(-200);
    lastEnd = at + block.length;
    if (isOwnCode(intro, body, authoredNames)) return block;
    // Every line with a real word is checked, short statements included;
    // lone braces, blank lines and "..." are not evidence either way.
    const lines = body.split('\n').map((l) => l.trim()).filter((l) => /[A-Za-z_$][\w$]{2,}/.test(l) && !/^(?:\/\/\s*)?\.\.\.$/.test(l));
    const missing = lines.find((l) => !codeIncludes(l));
    if (!missing) return block;
    removed.push({ rule: 'unverified_code', sentence: missing.slice(0, 200) });
    return flagOnly ? `${NOT_VERIFIED} ${block}` : '';
  });
}

const CODE_SPAN = /`([^`\n]{3,200})`/g;
const looksLikeCode = (span) => /[(){};=]|=>/.test(span) || /^[a-z]+[A-Z][A-Za-z0-9]*$|^[A-Za-z]+_[A-Za-z0-9_]+$/.test(span);

// A sentence that cites a line ("self_skills.js line 130", "worker.js:971")
// must match the pinned file: the line must exist, and the identifiers or
// quoted code the sentence names must be on that line. `fileText(path)`
// returns the file's text at the pinned commit, or null when not loaded.
function wrongLineCitation(s, paths, fileText) {
  if (typeof fileText !== 'function') return '';
  const cited = [...new Set(paths.filter((p) => s.includes(p)))];
  const nums = [...s.matchAll(/\bline\s+(\d{1,6})\b|\.(?:dart|m?js|cjs|ts|tsx|py|swift|kt|json|md):(\d{1,6})\b/gi)].map((m) => Number(m[1] || m[2]));
  if (cited.length !== 1 || !nums.length) return '';
  const path = cited[0];
  const text = fileText(path);
  if (text == null) return '';
  const lines = String(text).split('\n');
  // Code-like names the sentence relies on (camelCase, snake_case or backticked),
  // with the cited paths removed so a file name is not taken for an identifier.
  const prose = paths.reduce((acc, p) => acc.split(p).join(' '), s);
  const idents = [...prose.matchAll(/`([^`\n]{4,200})`|\b([a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z]+_[A-Za-z0-9_]+)\b/g)]
    .map((m) => (m[1] || m[2] || '').trim())
    .filter((t) => t.length >= 4 && !/\s/.test(t));
  for (const n of nums) {
    if (n < 1 || n > lines.length) return `line_out_of_range:${path}:${n}`;
    const line = lines[n - 1].toLowerCase();
    const miss = idents.find((t) => !line.includes(t.toLowerCase()));
    if (miss) return `wrong_line:${path}:${n}:${miss.slice(0, 60)}`;
  }
  return '';
}

const NOT_VERIFIED = '[NOT VERIFIED]';

/**
 * Grounded-fact guard. Default: a failing sentence is removed. flagOnly: it is kept and marked [NOT VERIFIED].
 */
export function guardGroundedFacts(reply, { paths = [], repo = '', jobIds = [], codeIncludes = null, fileText = null, flagOnly = false, authoredNames = new Set() } = {}) {
  const known = new Set(paths);
  const basenames = new Set(paths.map((p) => p.split('/').pop()));
  const ids = new Set(jobIds.map(String));
  const removed = [];
  const PATH = /(?:[\w.-]+\/)+[\w.-]+\.(?:dart|m?js|cjs|ts|tsx|py|swift|kt|ya?ml|json|md|html|css)\b|\b[\w-]+\.(?:dart|m?js|cjs|ts|tsx|py|swift)\b/g;
  const badFact = (s) => {
    for (const hit of s.match(PATH) || []) {
      if (/^(?:node|next|vue|react|three|express|d3|chart|moment|socket\.io)\.js$/i.test(hit)) continue; // product names, not files
      if (hit.includes('/') ? !known.has(hit) : !basenames.has(hit)) return `unknown_file:${hit}`;
    }
    for (const m of s.matchAll(/github\.com\/([\w.\/-]+?)\/(?:pull|issues)\/\d+/gi)) if (!repo || m[1].toLowerCase() !== repo.toLowerCase()) return `foreign_pr:${m[1]}`;
    if (typeof codeIncludes === 'function') {
      for (const m of s.matchAll(CODE_SPAN)) {
        const span = m[1].trim();
        if (looksLikeCode(span) && !paths.includes(span) && !codeIncludes(span)) return `unverified_code:${span.slice(0, 80)}`;
      }
    }
    const line = wrongLineCitation(s, paths, fileText);
    if (line) return line;
    const job = /\bjob(?:\s+id)?\s*[:#]?\s*(?:under\s+id\s*[:#]?\s*)?([A-Za-z0-9][\w-]{7,})\b/i.exec(s);
    if (job && /\d/.test(job[1]) && !ids.has(job[1])) return `unknown_job:${job[1]}`;
    return '';
  };
  reply = stripUnverifiedCode(reply, codeIncludes, removed, flagOnly, authoredNames);
  // Fenced code was judged above as a whole block; the sentence checks below
  // are for prose (a template literal inside code is not a repository quote).
  const fences = [];
  if (typeof codeIncludes === 'function') reply = reply.replace(/```[\s\S]*?```/g, (m) => `\u0000${fences.push(m) - 1}\u0000`);
  const parts = splitSentences(reply);
  const kept = [];
  for (const sentence of parts) {
    const why = paths.length || repo || jobIds.length || codeIncludes || fileText ? badFact(sentence) : '';
    if (why) {
      removed.push({ rule: why, sentence: sentence.trim() });
      // flagOnly keeps the sentence and marks it, so nothing the owner asked for is cut off.
      if (flagOnly && sentence.trim()) kept.push(`${NOT_VERIFIED} ${sentence.trim()} `);
      continue;
    }
    kept.push(sentence);
  }
  const text = (removed.length && !flagOnly ? kept.filter((s) => !/\b(?:verified|confirmed|checked)\b/i.test(s)) : kept).join('')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => fences[Number(i)]).replace(/\n{3,}/g, '\n\n').trim();
  return { text, removed };
}


// Owner GPS provenance: the current CHE phone /api/chat request sends a device
// timezone, not CoreLocation coordinates. Do not confuse that clock context,
// a weather tool's geocoded city, or remembered addresses with live position.
export function asksForCurrentOwnerLocation(message) {
  const text = String(message || '').trim().toLowerCase();
  if (!text || text.length > 240) return false;
  return /\bwhere\s+(?:exactly\s+)?(?:am\s+i|i\s+am|i'm)\b(?!\s+(?:going|headed|in\s+life))/.test(text) ||
    /\b(?:do|can|so)\s+you\s+(?:know|see|tell)\s+(?:me\s+)?where\s+i\s+am\b/.test(text) ||
    /\b(?:do\s+)?you\s+(?:know|have|see)\s+my\s+(?:live\s+|current\s+|exact\s+)?(?:location|gps\s+position)\b/.test(text) ||
    /\b(?:what|where)(?:'s| is)\s+my\s+(?:live\s+|current\s+|exact\s+)?(?:location|gps\s+position)\b/.test(text) ||
    // "What city am I in?", "which town am I in right now?" (comprehension audit).
    /\b(?:what|which)\s+(?:city|town|state|country|place|neighborhood|street)\s+(?:am\s+i|i(?:'m|\s+am))\s+(?:in|at|on)(?:\s+(?:right\s+now|now|currently))?\s*\??$/.test(text);
}

export const OWNER_LOCATION_NOT_VERIFIED =
  'I cannot verify where you physically are right now, sir. This CHE chat sends your iPhone time zone, not live GPS coordinates. I can use a city or address you shared for a forecast, but that does not prove your current position. I should not have claimed otherwise.';

// A truthful forecast requires a completed weather tool call, not a plausible
// temperature produced by the AI. The guard deliberately preserves general
// weather conversation and verified city-based forecasts.
export function guardLocationWeatherReply(message, reply, { forecastVerified = false } = {}) {
  const answer = String(reply || '');
  const askedWeather = /\b(?:weather|forecast|temperatures?|highs?\s+and\s+lows?|rain|snow)\b/i.test(message || '');
  const assertedForecast = /\b(?:forecast\s+(?:shows|says|predicts)|(?:will|going to)\s+be\s+(?:mostly\s+)?(?:sunny|cloudy|rainy|clear|warm|cold)|(?:high|low)\s+(?:of|around)\s+\d+|\d+\s*(?:degrees|°[fc]))\b/i.test(answer);
  if (askedWeather && assertedForecast && !forecastVerified) {
    return 'I do not have a verified live weather forecast for that request, sir. Tell me the city you want checked, or enable CHE’s Weather tool. Your iPhone time zone is not your GPS location.';
  }
  const unprovedGpsClaim =
    /\bi(?:'ve| have)?\s+(?:used|checked|pulled|retrieved|accessed|looked up|got)\b[^.!?\n]{0,120}\b(?:your\s+(?:current\s+|live\s+|gps\s+)?location|the\s+location\s+you(?:'ve| have)\s+shared)\b/i.test(answer) ||
    /\bi\s+(?:know|can see|have)\s+(?:exactly\s+)?where\s+you\s+are\b/i.test(answer) ||
    /\b(?:checked|pulled|looked up)\s+(?:the\s+)?forecast\s+for\s+your\s+current\s+location\b/i.test(answer);
  if (unprovedGpsClaim) return OWNER_LOCATION_NOT_VERIFIED;
  return answer;
}


// Only tool execution receipts, not plausible model prose, can establish that
// CHE browsed, searched, or compared sources. Guard past-tense claims, not
// explanations of HOW one might research a fact.
// "Research a fact, check your sources and explain what you verified" names
// no subject. Researching the request's own words would return sources about
// nothing in particular, so CHE asks which fact instead.
const RESEARCH_VERB = /\b(?:research|fact ?check|look (?:something|anything|it) up|look up|find out|verify|check)\b/;
const PLACEHOLDER_SUBJECT = /\b(?:a|any|some|one|random) (?:fact|topic|thing|claim|subject|statement)\b|\bsomething\b|\banything\b/;
const NO_SUBJECT_WORDS = /\b(?:che|hey|please|can|could|would|will|you|i|want|need|to|go|and|then|also|now|a|an|any|some|one|random|the|your|my|me|for|it|what|which|how|have|has|did|do|explain|tell|show|research|researched|look|looked|up|fact|facts|check|checked|verify|verified|find|found|out|about|source|sources|something|anything|topic|thing|claim|subject|statement|information|info|search|web|online|internet|carefully|thoroughly|quickly|real|reliable|sir)\b/g;

export function vagueResearchRequest(message) {
  const q = String(message || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q || q.split(' ').length > 25 || !RESEARCH_VERB.test(q) || !PLACEHOLDER_SUBJECT.test(q)) return false;
  return !q.replace(NO_SUBJECT_WORDS, ' ').trim();
}

export function guardClaimedResearchActions(reply, { research = null, tools = [], documentRead = false, message = '' } = {}) {
  const text = String(reply || '');
  // A story or role-play the owner asked for may say "I searched the attic".
  if (storyRequested(message)) return { text, corrected: false };
  const successful = (Array.isArray(tools) ? tools : []).filter((t) => t?.ok === true);
  const actualBrowser = successful.some((t) => /\b(?:browser|web_search|web search)\b/i.test(
    String(t.plugin || '') + ' ' + String(t.tool || '')));
  const actualResearch = Boolean(research?.summary && research.cached !== true &&
    (Array.isArray(research.sources) ? research.sources : []).some((s) => /^https:\/\/\S+/i.test(String(s)))) ||
    successful.some((t) => /\b(?:search|research|browse|fetch)\b/i.test(String(t.tool || '')));
  const comparisonReceipt = successful.some((t) =>
    /\b(?:compare|cross.?check|corroborat)\b/i.test(String(t.tool || '')));
  const claimedBrowser = /\b(?:i|we)\s+(?:used|opened|ran|accessed)\s+(?:the |my |a )?(?:browser|web search)(?: tool)?\b/i.test(text);
  // Searching, googling, looking something up and "my research shows" all
  // claim a search that ran, including counts ("three websites"). Reading a
  // document the owner shared is judged by the document check below.
  const SEARCHED_WHAT = '(?:(?:the|some|multiple|several|most|many|a\\s+few|a\\s+couple\\s+of|\\d+|two|three|four|five|six|ten|all\\s+the|a\\s+bunch\\s+of)\\s+)?(?:fresh|recent|current|live|online|web|internet|sources?|articles?|websites?|sites?|news|studies|google)\\b';
  const claimedSearch = /\b(?:i|we)\s+(?:searched|looked up|pulled|researched|checked|retrieved)\s+(?:(?:the|some|multiple|several|most)\s+)?(?:fresh|recent|current|live|online|web|sources?|articles?|documents?|information)\b/i.test(text)
    || new RegExp(`\\b(?:i|we)(?:'ve|\\s+have)?\\s+(?:just\\s+|already\\s+|also\\s+|quickly\\s+)?(?:searched|looked\\s+up|pulled|checked|retrieved|browsed|scanned|consulted|visited)\\s+(?:through\\s+|across\\s+|on\\s+)?${SEARCHED_WHAT}`, 'i').test(text)
    || /\b(?:i|we)(?:'ve|\s+have)?\s+(?:just\s+|already\s+|also\s+|quickly\s+)?(?:googled|web.?searched|researched)\b|\b(?:i|we)(?:'ve|\s+have)?\s+looked\s+(?:it|this|that|them|those|these)\s+up\b|\b(?:i|we)\s+(?:looked|searched)\s+(?:it\s+)?(?:up\s+)?(?:online|on\s+(?:the\s+)?(?:web|internet|google))\b/i.test(text)
    || /\baccording\s+to\s+(?:my|our)\s+(?:research|search(?:es)?|sources|findings|fact.?check(?:ing)?)\b|\bmy\s+(?:research|search(?:es)?|fact.?check(?:ing)?)\s+(?:shows?|showed|found|finds|confirms?|confirmed|suggests?|indicates?)\b/i.test(text);
  const claimedComparison = /\b(?:i|we)\s+(?:compared|cross.?checked|corroborated)\b[^.!?\n]{0,100}\b(?:sources?|information|articles?|evidence|data|results?)\b/i.test(text);
  // "I verified / fact-checked / double-checked that" and "I reviewed the
  // documents" are execution claims too: they need a real research, tool or
  // document result from this turn.
  const claimedVerification = /\b(?:i|we)(?:'ve|\s+have)?\s+(?:independently\s+|personally\s+|already\s+)?(?:verified|fact.?checked|double.?checked|validated)\s+(?:this|that|it|the|each|every|all|these|those|your|with|against)\b/i.test(text);
  const claimedDocumentReview = /\b(?:i|we)(?:'ve|\s+have)?\s+(?:reviewed|read|examined|analy[sz]ed|went through|looked through)\s+(?:the|your|those|these|several|multiple|some|all|each|every)\s+(?:\w+\s+){0,2}(?:documents?|articles?|pages?|papers?|reports?|files?|pdfs?|links?|studies|filings?)\b/i.test(text);
  // A step-by-step report with no "I" ("1. Searched fresh sources – …",
  // "- Compared the info") claims the same actions.
  const stepReport = /(?:^|\n)[ \t]*(?:\d+[.)]|[-*•])[ \t]*\**[ \t]*(?:searched|looked up|researched|browsed|pulled|compared|cross.?checked|fact.?checked|verified|reviewed|checked)\b/i.test(text);
  const claimedSourceLook = /\b(?:i|we)(?:'ve|\s+have)?\s+(?:looked at|checked|went over|compared)\s+(?:the|each|every|all|both|several|multiple|those|these)\s+(?:\w+\s+){0,2}(?:sources?|articles?|sites?|websites?)\b/i.test(text);
  // Opening, reading or clicking a page or article (2026-10-15: "I opened the
  // MIT Technology Review article" with nothing opened), "after browsing
  // several news sites", and reading code all claim work that left a receipt.
  const claimedOpen = /\b(?:i|we)(?:'ve|\s+have)?\s+(?:just\s+|already\s+|also\s+)?(?:opened|visited|clicked(?:\s+on)?|browsed|read|followed|loaded|pulled\s+up|skimmed)\s+(?:through\s+)?(?:the|that|this|your|their|its|each|both|all|several|those|these|a\s+few|some)\s+(?:[\w'-]+\s+){0,4}(?:links?|urls?|pages?|articles?|sites?|websites?|stor(?:y|ies)|posts?|press\s+releases?|reports?|papers?|studies|sources?)\b/i.test(text)
    || /\b(?:after|from)\s+(?:searching|browsing|checking|reviewing|reading|scanning|comparing|looking\s+(?:at|through))\s+(?:through\s+)?(?:\w+\s+){0,3}(?:sources?|sites?|websites?|news|articles?|outlets?|the\s+web|online|reports?|pages?)\b/i.test(text);
  const claimedCode = /\b(?:i|we)(?:'ve|\s+have)?\s+(?:just\s+|already\s+|also\s+)?(?:inspected|reviewed|examined|read(?:\s+through)?|looked\s+(?:at|through)|went\s+through|scanned|audited)\s+(?:the|your|my|its|their|che's)\s+(?:[\w'-]+\s+){0,2}(?:code(?:base)?|source\s+code|repo(?:sitory)?|source\s+files?|worker\.js|dart\s+files?)\b/i.test(text);
  const opened = (Array.isArray(research?.articles) && research.articles.some((a) => a?.ok)) || actualResearch;
  const anyReceipt = actualResearch || comparisonReceipt || successful.length > 0;
  if ((claimedBrowser && !actualBrowser) || (claimedSearch && !actualResearch) ||
      (claimedComparison && !comparisonReceipt) ||
      (claimedVerification && !anyReceipt) ||
      (claimedDocumentReview && !anyReceipt && !documentRead) ||
      ((stepReport || claimedSourceLook) && !anyReceipt) ||
      (claimedOpen && !opened && !successful.length && !documentRead)) {
    return {
      text: 'I need to correct that, sir: I do not have execution receipts proving I performed the search or comparison I described. I have not independently fact-checked that answer.',
      corrected: true,
    };
  }
  if (claimedCode && !successful.length && !documentRead) {
    return {
      text: 'I need to correct that, sir: I did not read any code for this answer, so I cannot claim I reviewed it. Ask me to inspect the code and I will read it first.',
      corrected: true,
    };
  }
  return { text, corrected: false };
}

// A model reply on the chat path can never have sent, bought, deleted, uploaded, rendered, traded or opened
// anything: those run only through their own routes, which answer with their own records before the model
// is reached. So "Done, sir. I sent it and bought it." is invented whatever was asked (comprehension audit,
// issue #350). Each such sentence is taken out and the owner is told plainly that nothing was done.
// Strong verbs claim an outside effect on their own; weak ones only with what they act on.
const STRONG_DONE = {
  sent: 'sent', emailed: 'sent', texted: 'sent', messaged: 'sent', forwarded: 'sent',
  bought: 'bought', purchased: 'bought', ordered: 'ordered', subscribed: 'bought',
  paid: 'paid', transferred: 'paid', deleted: 'deleted', erased: 'deleted', wiped: 'deleted',
  uploaded: 'uploaded', published: 'uploaded', posted: 'uploaded',
  booked: 'scheduled', scheduled: 'scheduled', sold: 'sold',
};
// Ordinary ways of speaking that use the same verbs: "I paid close attention", "I ordered them by date".
const NOT_AN_ACTION_AFTER = { paid: /^\s+(?:close\s+|careful\s+|special\s+|extra\s+|more\s+)?attention\b/i, ordered: /^\s+(?:[\w-]+\s+){0,3}?(?:by|alphabetically|chronologically|from\s+\w+\s+to)\b/i };
const WEAK_DONE = {
  placed: 'placed', executed: 'placed', submitted: 'placed', closed: 'closed', flattened: 'closed', removed: 'deleted', cancelled: 'cancelled', canceled: 'cancelled',
  opened: 'opened', launched: 'opened', started: 'started', queued: 'started', dispatched: 'started', 'kicked off': 'started', rendered: 'rendered',
  switched: 'changed', changed: 'changed', connected: 'connected', set: 'set', added: 'added', created: 'created',
};
const ACTED_ON = String.raw`(?:order|trade|position|payment|purchase|transfer|subscription|email|e-mail|message|text|reminder|alarm|timer|event|meeting|appointment|invite|calendar|cart|draft|video|render|upload|job|task|investigation|build|exam|app|youtube|notes|spotify|account|broker|voice|mode|live|paper|note|file|post)s?`;
const FILLER_ADVERBS = String.raw`(?:(?:just|already|now|also|successfully|gone\s+ahead\s+and|went\s+ahead\s+and)\s+)*`;
const STRONG_RE = new RegExp(String.raw`\b(?:I|we)(?:['’]ve|\s+have|\s+had)?\s+${FILLER_ADVERBS}(${Object.keys(STRONG_DONE).join('|')})\b`, 'i');
const WEAK_RE = new RegExp(String.raw`\b(?:I|we)(?:['’]ve|\s+have|\s+had)?\s+${FILLER_ADVERBS}(${Object.keys(WEAK_DONE).join('|').replace(' ', '\\s+')})\b(?:\s+(?:it|that|this|them|you|everything))?(?:\s+(?:up|on|over|off|to|for|in|into))?(?:\s+(?:a|an|the|your|my|one|two|\d+|new|live|paper))?(?:\s+[\w-]+){0,2}?\s+${ACTED_ON}\b`, 'i');
const PASSIVE_RE = new RegExp(String.raw`\b(?:it|that|this|everything|all\s+of\s+(?:it|them)|your\s+[\w-]+(?:\s+[\w-]+)?|the\s+(?:[\w-]+\s+)?${ACTED_ON})\s+(?:(?:has|have|had)\s+been|is|was|were|are)\s+(?:now\s+|successfully\s+|already\s+)?(${[...Object.keys(STRONG_DONE), 'placed', 'executed', 'submitted', 'removed', 'cancelled', 'canceled', 'rendered', 'closed'].join('|')})\b`, 'i');
// "I made the video", but never "I made a note of that" (an ordinary way to say "I'll keep it in mind").
const MADE_RE = new RegExp(String.raw`\b(?:I|we)(?:['’]ve|\s+have)?\s+${FILLER_ADVERBS}(made)\s+(?:a|an|the|your|one)\s+(?:[\w-]+\s+){0,2}(?:video|render|reminder|event|appointment|order|payment|purchase|reservation|booking|trade)s?\b`, 'i');
// More of the same claim later in the sentence: "I sent it and bought it".
const MORE_DONE = new RegExp(String.raw`(?:\band|\bthen|,)\s+(?:also\s+)?(${Object.keys(STRONG_DONE).join('|')})\b`, 'gi');
// "Done, sir." / "All done." / "Consider it done." / "Sent." opening a sentence.
const DONE_RE = /^\s*(?:(?:all|it['’]?s|it\s+is)\s+)?done\b(?!\s+(?:with|by|in|for|on|at|before|after)\b)|\bconsider\s+it\s+done\b|^\s*(?:sent|ordered|bought|booked|scheduled|deleted|uploaded|published|posted|placed)\s*(?:[,.!]|$)/i;
// A condition, a plan or a question about the action does not claim it: "once I've sent it", "if I had paid".
const NOT_A_CLAIM = /\b(?:if|once|when|whenever|after|until|unless|whether|before|would|could|should|might|can|will|shall|going\s+to)\b/i;
// Text the owner asked CHE to write in his voice ("draft a text saying I sent it") may say "I sent it"; only
// CHE's own words to him around it ("Done, sir.") are checked then. Only when the request asks for no action:
// "draft a text to mom and send it" is a send, so its reply is checked like any other (comprehension audit, #350).
const WRITING_REQUEST = /\b(?:write|draft|compose|reword|rephrase|translate|proofread)\b[^.?!]{0,60}\b(?:saying|says|say|telling|tells|letting|announcing|replies|reply|response|post|caption|tweet|letter|message|text|e-?mail|note|speech|toast)\b|\brole.?play|\bpretend\b|\bact\s+as\b/i;

// Claims with no matching verb, in English and Spanish (comprehension audit, issue #350): "It's been dispatched to
// Sarah", "Your order went through", "I've taken care of the bill", "Purchase complete", "Your notes are gone now",
// "The email is on its way", "Listo, señor: pagué la factura." Each names what it claims; a null label is removed
// without adding a verb to CHE's note ("Confirmation number 4471" is a receipt CHE does not have).
const NOUN_LABELS = [
  [/^(?:e-?mails?|mails?|messages?|texts?|replies|reply|reports?|files?|notes?|sms)$/, 'sent'],
  [/^(?:payments?|bills?|invoices?|rent|fees?|charges?|dues|transfers?|transactions?)$/, 'paid'],
  [/^(?:orders?|packages?|parcels?|shipments?|deliver(?:y|ies))$/, 'ordered'],
  [/^(?:purchases?|checkouts?|subscriptions?|gifts?|flowers|tickets?)$/, 'bought'],
  [/^(?:bookings?|reservations?|appointments?|reminders?|events?|meetings?)$/, 'scheduled'],
];
function nounLabel(word, fallback) {
  const w = String(word || '').toLowerCase();
  for (const [re, label] of NOUN_LABELS) if (re.test(w)) return label;
  return fallback;
}
// Each claim names its person. "first" is CHE's own action ("I've taken care of the bill"), which the note may deny by name.
// "third" is a claim about someone or something else ("the email went out", "your order went through"). CHE cannot confirm
// it, so it is taken out with a neutral note: "nothing was sent" would be false for a real email (review of PR #356, round 2).
// A delivery noun, then its verb: "the email went out", "the report is in Sarah's inbox". Between them only words that
// are not a negation or a modal, so "the email never went out" and "the report will be with Sarah" are not claims made now.
const DELIVERY_NOUN = String.raw`(e-?mails?|mails?|messages?|texts?|replies|reply|reports?|files?|notes?|letters?|sms|documents?)`;
const DELIVERY_GAP = String.raw`(?:(?!(?:not|never|no|will|would|can|could|should|might|may|shall|if|once|when|unless|until|going)\b)[\w'’-]+\s+){0,2}?`;
// "not", "never" or "no" right before a generic claim ("it is not all done and dusted") negates it.
const NEG_BEFORE = /\b(?:not|never|no)\s+(?:\S+\s+){0,1}$/i;
// A thing that is sent, not a person: the noun before a delivery passive ("the email is dispatched", "the report was sent
// yesterday", "the report got sent"). The verb must be a delivery verb, so "the report is ready to go" is not a claim.
const DELIVERED_THING = String.raw`(e-?mails?|mails?|messages?|texts?|replies|reply|reports?|files?|notes?|letters?|sms|documents?|packages?|parcels?|orders?|payments?|invoices?|invitations?|gifts?|flowers|tickets?|reminders?|bookings?|reservations?|notices?)`;
const DELIVERY_VERB = String.raw`(?:sent|dispatched|delivered|mailed|emailed|forwarded|shipped|posted|submitted|placed)`;
const CLAIM_PHRASES = [
  { re: /\b(?:it|that|this|everything|they)(?:\s+(?:has\s+been|have\s+been|has|have|is|was|were|are)|['’]s(?:\s+been)?|['’]re)\s+(?:now\s+|already\s+|successfully\s+|just\s+)?dispatched\b/i, label: 'sent' },
  { re: /\b(email|e-?mail|message|text|reply|report|file|note|mail|sms|package|parcel|order|gift|flowers|tickets?|payment|bill)\s+(?:is|was|are|were|has\s+been|have\s+been)\s+(?:now\s+|already\s+)?on\s+(?:its|their|the)\s+way\b/i, noun: 1, fallback: 'sent' },
  { re: /\b(order|payment|purchase|transfer|transaction|checkout|subscription|booking|reservation|reminder|charge)\s+(?:(?:has\s+been|have\s+been|has|have|is|was|are|were|now|already|successfully)\s+)*(?:went\s+through|complete|completed|processed|confirmed|finalized|successful|successfully\s+completed)\b/i, noun: 1, fallback: 'done' },
  { re: /\b(purchase|order|payment|transaction|checkout|sale)\s+(?:is\s+|was\s+|has\s+been\s+)?(?:now\s+)?(?:complete|completed)\b/i, noun: 1, fallback: 'done' },
  { re: /\b(?:I|we)(?:['’]ve|\s+have)?\s+(?:already\s+|just\s+|now\s+|personally\s+)?taken\s+care\s+of\s+(?:the\s+|your\s+|my\s+)?(\w+)?/i, noun: 1, fallback: 'done', person: 'first' },
  { re: /\b(?:your|my|the|these|those|all\s+(?:of\s+)?(?:your|my|the))\s+(?:[\w'-]+\s+){0,2}?(?:notes?|files?|emails?|messages?|texts?|data|memor(?:y|ies)|history|chats?|drafts?|reminders?|events?|photos?|videos?|contacts?|records?|logs?|skills?)\s+(?:are|is|were|was|have\s+been|has\s+been)\s+(?:now\s+|all\s+|already\s+|finally\s+)?gone\b/i, label: 'deleted' },
  { re: /\beverything\s+(?:is|was|has\s+been|have\s+been)\s+(?:now\s+|already\s+)?gone\b/i, label: 'deleted' },
  // Comprehension audit, review of PR #356: "Okay, I'm on it: the email went out", "Got it, the report is in Sarah's
  // inbox", "The report is with Sarah". Each is a claim about a delivery, taken out for any request. The name after "with"
  // or before "'s inbox" is a person, capitalized ("with Sarah", not "with errors" or "with no attachments"), and
  // "went out of date" is not a delivery (review of PR #356, round 2).
  { re: new RegExp(String.raw`\b${DELIVERY_NOUN}\s+${DELIVERY_GAP}(?:went|has\s+gone|have\s+gone|had\s+gone)\s+out\b(?!\s+of\b)`, 'i'), noun: 1, fallback: 'sent' },
  { re: new RegExp(String.raw`\b${DELIVERY_NOUN}\s+${DELIVERY_GAP}(?:is|was|are|were|has\s+been|have\s+been)\s+(?:now\s+|already\s+|just\s+)?with\s+(?!(?:the|a|an|my|your|his|her|their|our|its|you|me|us|him|them|it|this|that|these|those|someone|anyone|everyone)\b)([A-Za-z][\w'’-]*)`, 'i'), noun: 1, name: 2, fallback: 'sent' },
  { re: new RegExp(String.raw`\b${DELIVERY_NOUN}\s+${DELIVERY_GAP}(?:in|into)\s+([A-Za-z][\w'’-]*)['’]s\s+inbox\b`, 'i'), noun: 1, name: 2, fallback: 'sent' },
  // A delivery passive on a thing or a message, with or without "the" ("the email is dispatched", "the report was sent yesterday",
  // "the report got sent"). A claim about someone or something else: the neutral note (review of PR #356, round 3).
  { re: new RegExp(String.raw`\b(?:(?:the|your|my|this|that|its|their|our|these|those)\s+)?${DELIVERED_THING}\s+${DELIVERY_GAP}(?:is|was|are|were|has\s+been|have\s+been|had\s+been|got|gets|get)\s+${DELIVERY_GAP}${DELIVERY_VERB}\b`, 'i'), noun: 1, fallback: 'sent' },
  // "All set, sir" and "It is all done and dusted" are CHE reporting on her own task, so they are claims only when the request
  // asked CHE to act: "what is on my calendar? All set" names nothing done. Removed, they take the request's own verb.
  { re: /^\s*all\s+set\b/i, label: 'done', gated: true, person: 'first' },
  { re: /\b(?:(?:it['’]?s|it\s+is|it\s+was|that['’]?s|that\s+is|everything['’]?s|everything\s+is)\s+)?(?:all\s+)?(?:now\s+|already\s+)?done\s+and\s+dusted\b/i, label: 'done', gated: true, person: 'first' },
  // A receipt number CHE never got: removed, with no verb claimed in the note.
  { re: /\bconfirmation\s+(?:number|no\.?|code|id|#)\s*[:#]?\s*[A-Z0-9-]*\d[A-Z0-9-]*/i, label: null },
];
// Spanish: the past ("pagué", "envié", "compré", "he pagado", "ha pagado") is a claim, and so are "listo" / "hecho" /
// "enviado" at the start of a sentence (a generic claim, gated on a request to act). A negation before them ("no lo he
// pagado") is not a claim.
const SPANISH_STEM = [[/^(?:pag|transfer)/, 'paid'], [/^(?:env|mand)/, 'sent'], [/^(?:compr)/, 'bought'], [/^(?:borr|elimin)/, 'deleted'], [/^(?:reserv|program)/, 'scheduled'], [/^(?:public|sub)/, 'uploaded']];
// Each entry names its person: first ("pagué", "he pagado") is CHE's own action; third ("pagó", "ha pagado", "fue enviado")
// is a claim about someone or something else. "Ya está hecho" is CHE reporting a finished task, so it is a claim only when
// the request asks CHE to act (review of PR #356, round 2: "¿el café ya está hecho?" is an ordinary question).
const SPANISH_CLAIMS = [
  { re: /\b(?:yo\s+)?(pagu[ée]|transfer[ií]|envié|mandé|compr[ée]|borr[ée]|elimin[ée]|reserv[ée]|subí)(?![a-záéíóúñ])/i, person: 'first' },
  { re: /\b(pagó|transfirió|envió|mandó|compró|borró|eliminó|reservó|subió)(?![a-záéíóúñ])/i, person: 'third' },
  { re: /\b(?:he|hemos)\s+(?:ya\s+)?(pagado|pagada|transferido|enviado|enviada|mandado|comprado|comprada|borrado|borrada|eliminado|eliminada|reservado|reservada|publicado|publicada|subido|subida)\b/i, person: 'first' },
  { re: /\b(?:has|ha|han)\s+(?:ya\s+)?(pagado|pagada|transferido|enviado|enviada|mandado|comprado|comprada|borrado|borrada|eliminado|eliminada|reservado|reservada|publicado|publicada|subido|subida)\b/i, person: 'third' },
  { re: /\b(?:ya\s+)?(?:est[áa]|estaba|fue|qued[óo])\s+(?:ya\s+)?(enviad[oa]|pagad[oa]|comprad[oa]|borrad[oa]|eliminad[oa]|transferid[oa]|reservad[oa]|publicad[oa])\b/i, person: 'third' },
  { re: /\b(?:ya\s+)?(?:est[áa]|qued[óo])\s+(?:ya\s+)?(hech[oa])\b/i, person: 'first', gated: true },
];
const SPANISH_DONE_START = /^\s*(listo|lista|hecho|hecha|enviado|enviada|comprado|comprada|pagado|pagada|borrado|borrada|eliminado|eliminada)\s*(?:[,.:!]|$)/i;
function spanishLabel(word) {
  const w = String(word || '').toLowerCase();
  for (const [re, label] of SPANISH_STEM) if (re.test(w)) return label;
  return 'done';
}
// The outcome the owner's request names, in its own word: "send sarah the report" -> "sent", "pay the bill" -> "paid".
// A generic "All set" or "Ya está hecho" then says what did not happen ("Nothing was sent, sir"). Empty when the
// request names no action, so the note falls back to "done".
const REQUEST_OUTCOME = {
  send: 'sent', sends: 'sent', sending: 'sent', text: 'sent', texts: 'sent', texting: 'sent',
  post: 'uploaded', posts: 'uploaded', posting: 'uploaded', upload: 'uploaded', uploads: 'uploaded', uploading: 'uploaded',
  publish: 'uploaded', publishes: 'uploaded', publishing: 'uploaded',
  buy: 'bought', buys: 'bought', buying: 'bought',
  pay: 'paid', pays: 'paid', paying: 'paid',
  order: 'ordered', orders: 'ordered', ordering: 'ordered',
  delete: 'deleted', deletes: 'deleted', deleting: 'deleted',
  sell: 'sold', sells: 'sold', selling: 'sold',
  book: 'scheduled', books: 'scheduled', booking: 'scheduled', schedule: 'scheduled', schedules: 'scheduled', scheduling: 'scheduled',
};
// Spanish action words, accents dropped: "envía el informe a Sarah" asks for the act that "send Sarah the report" does.
const SPANISH_ACTION = {
  envia: 'sent', envie: 'sent', enviar: 'sent', enviame: 'sent', enviale: 'sent', manda: 'sent', mande: 'sent', mandar: 'sent', mandame: 'sent',
  paga: 'paid', pague: 'paid', pagar: 'paid', pagame: 'paid',
  compra: 'bought', compre: 'bought', comprar: 'bought',
  borra: 'deleted', borre: 'deleted', borrar: 'deleted', elimina: 'deleted', elimine: 'deleted', eliminar: 'deleted',
  reserva: 'scheduled', reserve: 'scheduled', reservar: 'scheduled',
  publica: 'uploaded', publique: 'uploaded', publicar: 'uploaded', sube: 'uploaded', suba: 'uploaded', subir: 'uploaded',
  vende: 'sold', venda: 'sold', vender: 'sold',
  ordena: 'ordered', ordene: 'ordered', ordenar: 'ordered',
};
// Only the table's own keys count: a plain object would answer for "constructor" or "toString".
const tableWord = (table, word) => (Object.hasOwn(table, word) ? table[word] : '');
function foldSpanish(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
// What the owner's request asks CHE to do, and the outcome it names: { asked, outcome }. "send sarah the report" asks,
// with outcome "sent". "what does this text say?" and "¿está listo el café?" ask for nothing. `asked` gates the generic
// claims; `outcome` is the word a generic "done" takes.
function requestAction(message) {
  const words = foldSpanish(message).match(/[a-z]+/g) || [];
  const asked = requestNamesAction(message) || words.some((w) => tableWord(SPANISH_ACTION, w));
  let outcome = '';
  for (let i = 0; asked && i < words.length && !outcome; i++) {
    // "in order to send the report" names no order.
    if (words[i] === 'order' && /^(?:to|of|by|in|that)$/.test(words[i + 1] || '')) continue;
    outcome = tableWord(REQUEST_OUTCOME, words[i]) || tableWord(SPANISH_ACTION, words[i]);
  }
  return { asked, outcome };
}

// Every claim in one sentence, by who makes it. Returns null when there is none, otherwise { first, third }: the labels
// of CHE's own actions and of claims about someone or something else. A label is missing for a receipt CHE does not have.
// `asked` gates the generic claims (CHE reporting "All set" or "Ya está hecho" on a request to act); they count as first.
// `outcome` is the request's verb, which a generic "done" takes.
function phraseClaims(sentence, { asked = false, outcome = '' } = {}) {
  const first = [];
  const third = [];
  let found = false;
  const add = (person, label) => {
    found = true;
    if (label) (person === 'first' ? first : third).push(label);
  };
  for (const claim of CLAIM_PHRASES) {
    if (claim.gated && !asked) continue;
    const m = claim.re.exec(sentence);
    const before = m ? sentence.slice(0, m.index) : '';
    if (!m || NOT_A_CLAIM.test(before) || quoted(sentence, m.index)) continue;
    if (claim.gated && NEG_BEFORE.test(before)) continue;
    // "is with errors", "is with no attachments": a delivery goes to a person, named with a capital letter.
    if (claim.name && !/^[A-Z]/.test(m[claim.name] || '')) continue;
    const label = claim.label === null ? null : (claim.label ?? nounLabel(m[claim.noun] || '', claim.fallback));
    add(claim.person === 'first' ? 'first' : 'third', label);
  }
  for (const claim of SPANISH_CLAIMS) {
    if (claim.gated && !asked) continue;
    const m = claim.re.exec(sentence);
    const before = m ? sentence.slice(0, m.index) : '';
    // A negation ("no lo he pagado") and a question ("¿Ya está hecho?") claim nothing.
    if (!m || /\bno\s+(?:\S+\s+){0,2}$/i.test(before) || /¿[^?]*$/.test(before) || quoted(sentence, m.index)) continue;
    add(claim.person, spanishLabel(m[1]));
  }
  const start = SPANISH_DONE_START.exec(sentence);
  if (start && asked && !quoted(sentence, start.index)) add('first', spanishLabel(start[1]));
  if (!found) return null;
  // "Listo, señor: pagué la factura" claims a payment, not just "done": the specific claim is the one named.
  // A generic "done" takes the request's own verb when there is one.
  const pick = (labels) => {
    const specific = labels.filter((label) => label !== 'done');
    const chosen = specific.length ? specific : labels.map((label) => (label === 'done' && outcome ? outcome : label));
    return [...new Set(chosen)];
  };
  return { first: pick(first), third: pick(third) };
}

function quoted(sentence, index) {
  const before = sentence.slice(0, index);
  return ((before.match(/["“”]/g) || []).length % 2 === 1) || /['‘]\s*[^'’]*$/.test(before) && /^[^'’]*['’](?:\s|$|[,.!?])/.test(sentence.slice(index));
}

export function guardClaimedOwnerActions(reply, { message = '', acted = false } = {}) {
  const text = String(reply || '');
  // A story, a role-play or text the owner asked CHE to write may say "I sent it" in its own voice. A request
  // that also asks CHE to act (storyRequested and the draft test both check for one) is not exempt.
  if (acted || storyRequested(message)) return { text, removed: [] };
  // A reply that opens "Done, sir." reports on itself, not a draft, so all of it is checked.
  const drafting = WRITING_REQUEST.test(String(message || '')) && !requestNamesAction(message) && !DONE_RE.test(text.trim());
  const removed = [];
  // CHE's own actions ("I sent it"): the note denies each one by name.
  const claimed = new Set();
  // Claims about someone or something else, or a sentence CHE cannot confirm: the note says that, never a denial.
  let unconfirmed = false;
  const kept = [];
  const { asked, outcome } = requestAction(message);
  for (const sentence of splitSentences(text)) {
    const plain = sentence.trim();
    let hit = null;
    // A question claims nothing: "All set? Should I send it now, sir?" asks the owner, it does not report (review of PR #356, round 3).
    if (/\?\s*$/.test(plain)) { kept.push(sentence); continue; }
    if (drafting && !/\bsir\b/i.test(plain) && !DONE_RE.test(plain)) { kept.push(sentence); continue; }
    for (const re of [STRONG_RE, WEAK_RE, MADE_RE, PASSIVE_RE]) {
      const m = re.exec(plain);
      const verb = m ? m[1].toLowerCase().replace(/\s+/g, ' ') : '';
      if (m && !NOT_A_CLAIM.test(plain.slice(0, m.index)) && !quoted(plain, m.index)
        && !NOT_AN_ACTION_AFTER[verb]?.test(plain.slice(m.index + m[0].length))) {
        hit = STRONG_DONE[verb] || WEAK_DONE[verb] || 'made';
        if (re === PASSIVE_RE) {
          // "It was sent", "your notes were deleted": about a thing, not CHE's own action.
          unconfirmed = true;
        } else {
          claimed.add(hit);
          for (const more of plain.slice(m.index + m[0].length).matchAll(MORE_DONE)) claimed.add(STRONG_DONE[more[1].toLowerCase()]);
        }
        break;
      }
    }
    if (!hit) {
      const phrase = phraseClaims(plain, { asked, outcome });
      if (phrase) {
        hit = phrase.first[0] || phrase.third[0] || 'claim';
        for (const label of phrase.first) claimed.add(label);
        if (!phrase.first.length) unconfirmed = true;
      }
    }
    if (!hit && plain && DONE_RE.test(plain)) hit = 'done';
    if (hit) {
      removed.push(plain);
      continue;
    }
    kept.push(sentence);
  }
  if (!removed.length) return { text, removed };
  // A generic "done" is dropped when a specific claim is named in the same reply: "All set. The report is with Sarah"
  // says "sent", not "done or sent".
  const specific = [...claimed].filter((verb) => verb !== 'done');
  const verbs = specific.length ? specific : [...claimed];
  const list = verbs.length > 1 ? `${verbs.slice(0, -1).join(', ')} or ${verbs[verbs.length - 1]}` : verbs[0];
  // The denial names only CHE's own action ("I sent it"). A claim about someone or something else, or a generic "done" with no
  // request for CHE to act, gets a neutral note: CHE cannot confirm it, and "nothing was sent" would be false for a real email.
  const note = list
    ? `Nothing was ${list}, sir: I have no record of doing that.`
    : unconfirmed
      ? 'I cannot confirm that from my record, sir.'
      : 'I have no record of doing anything for that, sir, so I will not say it is done.';
  const rest = kept.join('').replace(/\n{3,}/g, '\n\n').trim();
  return { text: rest ? `${rest} ${note}` : note, removed };
}
