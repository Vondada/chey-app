// CHE truth layer: claim <= verified_execution_state.
//
// Model output may PROPOSE an action ("I should ask Claude"); only real
// execution records (receipts) can make CHE SAY it happened. This module:
//  - stores receipts for real actions (mail sent/received, jobs, study,
//    proposals, PRs, merges, deploys, CI);
//  - builds the verified state CHE is allowed to report;
//  - strips unsupported action claims and owner "homework" from
//    model-generated owner replies before they reach chat or voice.

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
  return /^(?:(?:che|chay|chey|shay)[,:]?\s*)?(?:what(?:'s| has| have)?\s+(?:you\s+)?changed(?:\s+(?:lately|recently|in you|about you))?|what\s+did\s+you\s+(?:change|update)(?:\s+(?:lately|recently|in yourself))?|(?:show|read|tell)\s+(?:me\s+)?(?:your\s+|the\s+)?(?:change|update)\s+(?:history|log)|(?:your\s+)?(?:change|update)\s+(?:history|log)|what\s+updates?\s+(?:did\s+you\s+(?:get|make|do)|have\s+you\s+(?:had|made)))[?.!]*$/i.test(text);
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
  };
}

const shortId = (id) => String(id || '').slice(0, 8);
const peerLabel = (peer) => ({ chatgpt: 'ChatGPT', claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grok: 'Grok', copilot: 'Copilot', cursor: 'Cursor' }[peer] || peer);

// Deterministic owner-facing status built only from receipts and jobs.
export function verifiedStatusText(state) {
  const lines = [];
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
export function guardGroundedFacts(reply, { paths = [], repo = '', jobIds = [] } = {}) {
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
    const job = /\bjob\s+(?:id\s+|under\s+id\s+)?([A-Za-z0-9][\w-]{7,})\b/i.exec(s);
    if (job && /\d/.test(job[1]) && !ids.has(job[1])) return `unknown_job:${job[1]}`;
    return '';
  };
  const parts = splitSentences(reply);
  const kept = [];
  for (const sentence of parts) {
    const why = paths.length || repo || jobIds.length ? badFact(sentence) : '';
    if (why) { removed.push({ rule: why, sentence: sentence.trim() }); continue; }
    kept.push(sentence);
  }
  const text = (removed.length ? kept.filter((s) => !/\b(?:verified|confirmed|checked)\b/i.test(s)) : kept).join('').replace(/\n{3,}/g, '\n\n').trim();
  return { text, removed };
}
