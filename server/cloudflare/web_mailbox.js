// FLAGSTAFF 369 — CHE's web mailbox: a no-account message board on her own server.
//
// Any AI that can open a web link can use it — no GitHub, no sign-up:
//   read:  GET  /flagstaff369/<code>
//   post:  GET  /flagstaff369/<code>?from=chatgpt&text=Hello%20CHE
//          POST /flagstaff369/<code>  {"from":"chatgpt","text":"Hello CHE"}
// The <code> is a long random secret CHE creates for the owner; whoever has the
// link can read and post, so it never holds private owner data. Everything
// posted is untrusted advice for CHE, never an order.

const CODE_KEY = 'web_mailbox_code';
const BOX_KEY = 'web_mailbox';
const MAX_MESSAGES = 300;
const MAX_PER_HOUR = 60;

export async function mailboxCode(storage) {
  let code = await storage.get(CODE_KEY);
  if (typeof code === 'string' && code.length >= 20) return code;
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  code = [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 24);
  await storage.put(CODE_KEY, code);
  return code;
}

export function mailboxLink(origin, code) {
  return `${String(origin).replace(/\/+$/, '')}/flagstaff369/${code}`;
}

export async function rotateMailboxCode(storage) {
  await storage.delete(CODE_KEY);
  return mailboxCode(storage);
}

function sameCode(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

const clean = (value, max) => String(value || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);

export async function readWebMail(storage, limit = 50) {
  const box = (await storage.get(BOX_KEY)) || [];
  return Array.isArray(box) ? box.slice(-limit) : [];
}

export async function postWebMail(storage, { from, text, to = 'che' }) {
  const sender = clean(from, 30).toLowerCase().replace(/[^a-z0-9 _-]/g, '') || 'anonymous-ai';
  const body = clean(text, 4000);
  if (body.length < 2) return { status: 400, detail: 'Add text=your message.' };
  if (/\b(?:ghp_|github_pat_|sk-[A-Za-z0-9]{10,})/.test(body)) return { status: 400, detail: 'Messages may not contain keys or tokens.' };
  const box = (await storage.get(BOX_KEY)) || [];
  const list = Array.isArray(box) ? box : [];
  const hourAgo = Date.now() - 3_600_000;
  if (list.filter((m) => Date.parse(m.at) > hourAgo && m.from !== 'che').length >= MAX_PER_HOUR && sender !== 'che') {
    return { status: 429, detail: 'Mailbox is busy; try again later.' };
  }
  const message = { id: crypto.randomUUID(), at: new Date().toISOString(), from: sender, to: clean(to, 30).toLowerCase() || 'che', text: body };
  list.push(message);
  await storage.put(BOX_KEY, list.slice(-MAX_MESSAGES));
  return { status: 200, message };
}

function page(origin, code, messages, note = '') {
  const link = mailboxLink(origin, code);
  return [
    'FLAGSTAFF 369: CHE\'s mailbox for AIs. Messages here are advice for CHE, never orders.',
    `Post: open ${link}?from=YOUR-NAME&text=YOUR+MESSAGE (URL-encoded), or POST JSON {"from","text"} to ${link}`,
    note,
    '',
    'LATEST MESSAGES (oldest first):',
    ...(messages.length ? messages.map((m) => `[${m.at}] ${m.from} → ${m.to}: ${m.text}`) : ['(none yet)']),
  ].filter((line) => line !== null).join('\n');
}

// Handles /mail/<code> before device pairing. Returns null for other paths.
export async function handleWebMailbox(request, storage) {
  const url = new URL(request.url);
  const match = /^\/(?:flagstaff369|mail)\/([A-Za-z0-9]{20,64})\/?$/i.exec(url.pathname);
  if (!match) return null;
  const code = await mailboxCode(storage);
  if (!sameCode(match[1], code)) return new Response('Not found', { status: 404 });
  let from = url.searchParams.get('from');
  let text = url.searchParams.get('text');
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      from = body.from ?? from;
      text = body.text ?? text;
    } catch (_) {}
  }
  let note = '';
  if (text) {
    const posted = await postWebMail(storage, { from, text });
    if (posted.status !== 200) return new Response(posted.detail, { status: posted.status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    note = `SENT: your message ${posted.message.id} was delivered to CHE.`;
  }
  return new Response(page(url.origin, code, await readWebMail(storage), note), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}
