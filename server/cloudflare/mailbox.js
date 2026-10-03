// CHE ↔ other AIs mailbox, carried by GitHub.
//
// Any AI that can read/write this repo (Claude, ChatGPT/Codex, Gemini, Cursor,
// Copilot…) can talk with CHE here. Messages live on the `che-mailbox` branch
// so they never trigger app or Worker builds. One JSON line per message in
// mailbox/<peer>.jsonl:
//   {"id","at","from","to","text","reply_to"}
//
// Messages from other AIs are information, never commands: CHE may use them as
// advice, but owner permissions (money, deleting, app access) still apply.

export const MAILBOX_BRANCH = 'che-mailbox';
export const KNOWN_PEERS = ['claude', 'chatgpt', 'codex', 'gemini', 'cursor', 'copilot', 'grok'];

function repoOf(env) {
  const repo = String(env.CHE_GITHUB_REPO || '').trim();
  if (!env.CHE_GITHUB_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return repo;
}

async function gh(env, method, path, body, fetcher = fetch) {
  const repo = repoOf(env);
  if (!repo) return { ok: false, status: 503, data: null };
  const response = await fetcher(`https://api.github.com/repos/${repo}${path}`, {
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
  let data = null;
  try { data = await response.json(); } catch (_) {}
  return { ok: response.ok, status: response.status, data };
}

const b64encode = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
};
const b64decode = (value) => new TextDecoder().decode(Uint8Array.from(atob(String(value || '').replace(/\s+/g, '')), (c) => c.charCodeAt(0)));

export function normalizePeer(name) {
  const peer = String(name || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
  return peer || null;
}

export function parseMail(text) {
  return String(text || '').split('\n').map((line) => {
    try { return JSON.parse(line); } catch (_) { return null; }
  }).filter((m) => m && typeof m.text === 'string');
}

async function ensureBranch(env, fetcher) {
  const existing = await gh(env, 'GET', `/git/ref/heads/${MAILBOX_BRANCH}`, null, fetcher);
  if (existing.ok) return true;
  const repo = await gh(env, 'GET', '', null, fetcher);
  const base = String(repo.data?.default_branch || 'main');
  const ref = await gh(env, 'GET', `/git/ref/heads/${base}`, null, fetcher);
  if (!ref.ok) return false;
  const made = await gh(env, 'POST', '/git/refs', { ref: `refs/heads/${MAILBOX_BRANCH}`, sha: ref.data.object.sha }, fetcher);
  return made.ok || made.status === 422;
}

export async function mailboxHead(env, fetcher = fetch) {
  if (!repoOf(env)) return { error: 'Mailbox needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO.', head: '' };
  if (!(await ensureBranch(env, fetcher))) return { error: 'Could not open the mailbox branch on GitHub.', head: '' };
  const found = await gh(env, 'GET', `/git/ref/heads/${MAILBOX_BRANCH}`, null, fetcher);
  if (!found.ok) return { error: `Mailbox head read failed (${found.status}).`, head: '' };
  return { head: String(found.data?.object?.sha || '') };
}

export async function readThread(env, peer, fetcher = fetch) {
  const who = normalizePeer(peer);
  if (!repoOf(env)) return { error: 'Mailbox needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO.', messages: [] };
  if (!who) return { error: 'Name who the thread is with.', messages: [] };
  const found = await gh(env, 'GET', `/contents/mailbox/${who}.jsonl?ref=${MAILBOX_BRANCH}`, null, fetcher);
  if (found.status === 404) return { messages: [], sha: null };
  if (!found.ok) return { error: `Mailbox read failed (${found.status}).`, messages: [] };
  return { messages: parseMail(b64decode(found.data.content)), sha: found.data.sha };
}

export async function listThreads(env, fetcher = fetch) {
  if (!repoOf(env)) return { error: 'Mailbox needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO.', threads: [] };
  const dir = await gh(env, 'GET', `/contents/mailbox?ref=${MAILBOX_BRANCH}`, null, fetcher);
  if (!dir.ok) return { threads: [] };
  const threads = [];
  for (const item of (Array.isArray(dir.data) ? dir.data : []).slice(0, 12)) {
    const m = /^([a-z0-9-]+)\.jsonl$/.exec(String(item?.name || ''));
    if (!m) continue;
    const thread = await readThread(env, m[1], fetcher);
    const last = thread.messages[thread.messages.length - 1];
    threads.push({ peer: m[1], count: thread.messages.length, last: last || null });
  }
  return { threads };
}

export async function sendMail(env, { from = 'che', to, text, replyTo = '', id = '' }, fetcher = fetch) {
  const sender = normalizePeer(from) || 'che';
  const recipient = normalizePeer(to);
  const body = String(text || '').trim().slice(0, 4000);
  if (!repoOf(env)) return { status: 503, detail: 'Mailbox needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO.' };
  if (!recipient || !body) return { status: 400, detail: 'Say who the message is for and what it says.' };
  if (/\b(?:ghp_|github_pat_|sk-[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{12,})|(?:password|passcode|pair code)\s*[:=]/i.test(body)) {
    return { status: 400, detail: 'That message looks like it contains a secret, so CHE did not send it.' };
  }
  if (!(await ensureBranch(env, fetcher))) return { status: 502, detail: 'Could not open the mailbox branch on GitHub.' };
  const peer = sender === 'che' ? recipient : sender;
  const message = { id: String(id || '') || crypto.randomUUID(), at: new Date().toISOString(), from: sender, to: recipient, text: body, reply_to: String(replyTo || '') };
  for (let attempt = 0; attempt < 3; attempt++) {
    const thread = await readThread(env, peer, fetcher);
    if (thread.error) return { status: 502, detail: thread.error };
    const lines = [...thread.messages, message].slice(-300).map((m) => JSON.stringify(m)).join('\n') + '\n';
    const put = await gh(env, 'PUT', `/contents/mailbox/${peer}.jsonl`, {
      message: `mailbox: ${sender} → ${recipient}`,
      content: b64encode(lines),
      branch: MAILBOX_BRANCH,
      ...(thread.sha ? { sha: thread.sha } : {}),
    }, fetcher);
    if (put.ok) return { status: 200, message };
    if (put.status !== 409 && put.status !== 422) return { status: 502, detail: `Mailbox write failed (${put.status}).` };
  }
  return { status: 502, detail: 'Mailbox was busy; try again.' };
}

// Every message in every thread (except the lock-archive thread), oldest
// first. This is the shared Flagstaff 369 mailbox as GitHub sees it, so CHE's
// web board and any AI working in the repo read exactly the same messages.
export const ARCHIVE_PEER = 'flagstaff369';
export function hasGitHubMailbox(env) { return Boolean(env && repoOf(env)); }

export async function readAllMail(env, fetcher = fetch) {
  if (!repoOf(env)) return { error: 'Mailbox needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO.', messages: [] };
  const dir = await gh(env, 'GET', `/contents/mailbox?ref=${MAILBOX_BRANCH}`, null, fetcher);
  if (dir.status === 404) return { messages: [] };
  if (!dir.ok) return { error: `Mailbox read failed (${dir.status}).`, messages: [] };
  const peers = (Array.isArray(dir.data) ? dir.data : [])
    .map((item) => /^([a-z0-9-]+)\.jsonl$/.exec(String(item?.name || ''))?.[1])
    .filter((peer) => peer && peer !== ARCHIVE_PEER)
    .slice(0, 25);
  const threads = await Promise.all(peers.map((peer) => readThread(env, peer, fetcher).catch(() => ({ messages: [] }))));
  const messages = threads.flatMap((t) => t.messages || [])
    .filter((m) => m && m.id && m.at)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { messages };
}

// Owner phrases: "tell Claude …", "message ChatGPT: …", "ask Codex to …",
// "check the mailbox", "any messages from Claude?"
export function mailboxIntent(message) {
  const text = String(message || '').trim();
  const peers = KNOWN_PEERS.join('|');
  const send = new RegExp(`^(?:che,?\\s+)?(?:please\\s+)?(?:tell|message|ask|send(?:\\s+a\\s+message)?\\s+to|let)\\s+(${peers})\\b[,:]?\\s*(?:that\\s+|to\\s+)?([\\s\\S]{3,})$`, 'i').exec(text);
  if (send) return { kind: 'send', to: send[1].toLowerCase(), text: send[2].trim() };
  const read = /\b(?:check|read|open)\b[\s\S]{0,20}\b(?:mail ?box|flag ?staff(?: ?369)?)\b|\b(?:any|new)\s+(?:messages?|replies?|mail)\b/i.test(text);
  if (read) {
    const from = new RegExp(`\\b(?:from|with)\\s+(${peers})\\b`, 'i').exec(text);
    return { kind: 'read', peer: from ? from[1].toLowerCase() : '' };
  }
  return null;
}

export function speakThreads(threads) {
  const withMail = threads.filter((t) => t.last);
  if (!withMail.length) return 'The mailbox is empty, sir. No AI has written to me yet.';
  const lines = withMail.map((t, i) => `${i + 1}. ${t.peer}: last from ${t.last.from}, "${String(t.last.text).slice(0, 220)}"`);
  return `Mailbox, sir. ${withMail.length} conversation${withMail.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

// New replies from an AI (default Claude) since CHE last told the owner.
// Checked at most every 5 minutes so chat stays fast.
export async function unseenReplies(env, storage, peer = 'claude', fetcher = fetch) {
  if (!repoOf(env) || !storage?.get) return [];
  const now = Date.now();
  const checkKey = `mail_check_at:${peer}`;
  const seenKey = `mail_seen:${peer}`;
  const last = Number(await storage.get(checkKey)) || 0;
  if (now - last < 5 * 60 * 1000) return [];
  await storage.put(checkKey, now);
  const thread = await readThread(env, peer, fetcher).catch(() => ({ messages: [] }));
  const seen = String((await storage.get(seenKey)) || '');
  const theirs = thread.messages.filter((m) => m.from === peer);
  if (!theirs.length) return [];
  const idx = seen ? theirs.findIndex((m) => m.id === seen) : -1;
  const fresh = idx >= 0 ? theirs.slice(idx + 1) : (seen ? theirs.slice(-1) : theirs.slice(-3));
  if (fresh.length) await storage.put(seenKey, fresh[fresh.length - 1].id);
  return fresh;
}

// When CHE relays the owner's words to another AI, "you" (meaning CHE) would
// confuse the recipient. Rewrite second person → CHE so the message makes
// sense to whoever reads it.
export function relayText(ownerText) {
  let t = ` ${String(ownerText || '').trim()} `;
  t = t.replace(/\byourself\b/gi, 'herself (CHE)')
       .replace(/\byou're\b/gi, 'CHE is')
       .replace(/\byou are\b/gi, 'CHE is')
       .replace(/\byour\b/gi, "CHE's")
       .replace(/\byou\b/gi, 'CHE');
  return t.trim();
}

// "CHE, do Claude's handoff" / "continue ChatGPT's handoff": the owner tells
// CHE to act on the latest handoff another AI left her. Short commands only.
export function handoffIntent(text) {
  const t = String(text || '').trim();
  if (t.length > 120) return null;
  const m = t.match(/\b(?:do|start|run|work on|continue|pick up|take|finish)\b[\s\S]{0,25}?\b(claude|chatgpt|codex|gemini|cursor|copilot|grok)(?:'s|s)?\s+(?:handoff|hand-off|work split|split|brief|task)\b/i);
  return m ? { peer: m[1].toLowerCase() } : null;
}

// Latest message that peer addressed to CHE, or null.
export function latestHandoff(messages, peer) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (m?.from === peer && m?.to === 'che' && m?.id && String(m.text || '').trim()) return m;
  }
  return null;
}
