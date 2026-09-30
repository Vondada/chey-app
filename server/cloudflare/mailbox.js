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

export async function sendMail(env, { from = 'che', to, text, replyTo = '' }, fetcher = fetch) {
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
  const message = { id: crypto.randomUUID(), at: new Date().toISOString(), from: sender, to: recipient, text: body, reply_to: String(replyTo || '') };
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
