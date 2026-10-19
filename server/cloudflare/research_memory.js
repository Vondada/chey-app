// Bounded research → Durable Object memory write-back.
//
// When Office agents (esp. Atlas / Iris) finish a scout or research-style job,
// CHE distills title + short bullets + source URLs into owner-visible memory
// notes. Secrets never land; notes stay short and listable via /api/state and
// the existing /api/memory/add path.

import { classifyItem } from './privacy_policy.js';

const MAX_MEMORIES = 100;
const MAX_NOTES = Number.POSITIVE_INFINITY; // Brain room: no artificial cap on learned nodes
const MAX_NOTES_SOFT = 50000; // Durable Object safety only
const MAX_BULLETS = 6;
const MAX_SOURCES = 6;
export const SENSITIVE_RE = /password|passcode|security code|social security|credit card|api[_ -]?key|private key|seed phrase|session cookie|fiverr\s+password|auth\s+token/i;

function clip(value, max) {
  // Trimmed after the cut too, so clipping a clipped value changes nothing (the Brain's displayCopy relies on it).
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/** A title cut at a word boundary: a hard cut can end on a fragment ("pin|nacle") the secret gate reads as a key word. */
function clipWords(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : cut).trim();
}

/** Same gate as /api/memory/add — non-sensitive only. */
// A broker API key ID (Alpaca live keys start AK, paper keys PK, then 16-38 capitals or digits).
// A bare key carries no "secret" word, so it is matched by its shape (review of #348).
export const BROKER_KEY_RE = /\b[AP]K[A-Z0-9]{16,38}\b/;

// Credentials no word list catches, found by their shape (review of #354): a private key block, a
// JWT or a piece of one (base64 JSON starts "eyJ"), a user:password pair, and a token that mixes
// letters, digits and symbols the way passwords and keys do. A commit SHA, an issue number, a
// date, a version, a URL, an address or a plain word is never one.
const PEM_RE = /-----BEGIN [A-Z0-9 ]{3,40}-----/;
const JWT_PIECE_RE = /\beyJ[A-Za-z0-9_-]{8,}/;
const USER_PASS_RE = /(?:^|[\s(])[A-Za-z0-9._%+-]{2,40}:(?=[^\s:/@"'{}[\],]*[A-Za-z])(?=[^\s:/@"'{}[\],]*[\d!@#$%^&*+=?~])[^\s:/@"'{}[\],]{6,}/;
const PASSWORD_SYMBOL = /[!@#$%^&*+=~?|\\]/;
// A commit SHA is 7-12 or exactly 40 hex characters. Any other hex run is a key or a token (review of
// #354: a 32-character hex key was read as a SHA). A UUID is an id, not a key.
const HEX_RE = /^[0-9a-f]+$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Slack and Discord webhooks carry the secret in the path itself, so the path is the secret.
const WEBHOOK_RE = /hooks\.slack\.com\/services\/|discord(?:app)?\.com\/api\/webhooks\//i;
const URL_RE = /:\/\/|^www\./i;
// A code is four or more hyphen-separated groups of three to eight letters and digits, and each group
// has a digit or all groups are capitals: "8F3K-9LQ2-7MZP-4XWD", "ABCDE1-FGHIJ2-KLMNO3-PQRST4",
// "AB1-CD2-EF3-GH4", "ABCD-EFGH-IJKL-MNOP" (fourth review of #354: the group length is {3,8}, not {4,5}).
// Ordinary words are not codes: "CHE-APP-V2-BETA" (a two-character group), "Form-1099-NEC-tax-2025" (not
// every group has a digit, and not all are capitals), "iPhone-15-Pro-Max" and "Sprint-12-week-3-retro"
// (two-character groups).
function groupedCode(token) {
  if (UUID_RE.test(token)) return false;
  const groups = token.split('-');
  if (groups.length < 4 || !groups.every((g) => /^[A-Za-z0-9]{3,8}$/.test(g))) return false;
  if (!/[A-Za-z]/.test(groups.join(''))) return false;
  return groups.every((g) => /\d/.test(g)) || groups.every((g) => /^[A-Z0-9]+$/.test(g));
}
// A hyphen-joined run of 20 or more characters with capitals, lower-case letters and digits is a random
// token too (fifth review of #354, owner default): "Q7mZ2kP9-xL4vN8wR3-tY6uB1c-7mZ2kP9xL4vN8wR" is
// withheld. A lower-case slug ("brain-sync-follow-up-plan") has no capitals and stays kept. Path segments only.
function hyphenatedRandomRun(piece) {
  return /^[A-Za-z0-9_-]{20,}$/.test(piece) && piece.includes('-') && /[a-z]/.test(piece) && /[A-Z]/.test(piece) && /\d/.test(piece);
}
// A long run of letters and digits: a key or a token. A hyphen makes a slug words
// ("issuecomment-1234567890"), so a slug is not one. A hex run is judged by the hex rule instead.
function randomRun(piece) {
  return /^[A-Za-z0-9_]{20,}$/.test(piece) && /[A-Za-z]/.test(piece) && /\d/.test(piece) && !HEX_RE.test(piece);
}
function plainSecret(trimmed) {
  if (groupedCode(trimmed)) return true;
  const token = trimmed.replace(/!+$/, '');
  if (token.length < 8 || !/[A-Za-z]/.test(token) || !/\d/.test(token)) return false;
  if (HEX_RE.test(token)) return token.length >= 13 && token.length !== 40;
  if (UUID_RE.test(token) || /^[\w.+-]+@[\w-]+\.[\w.]+$/.test(token)) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(token) || /^v?\d+(?:\.\d+)+/i.test(token) || /^#\d+/.test(token)) return false;
  // A trading figure is not a password: a signed decimal with an R or % unit ("+0.0125R", "-1.5%").
  if (/^[+\-−]?\$?\d+\.\d+(?:R|%)?$/.test(token) || /^[+\-−]\d+R$/.test(token)) return false;
  const mixedCase = /[a-z]/.test(token) && /[A-Z]/.test(token);
  if (PASSWORD_SYMBOL.test(token) || (mixedCase && trimmed !== token)) return true;
  const switches = (token.match(/[A-Za-z](?=\d)|\d(?=[A-Za-z])/g) || []).length;
  return mixedCase && ((token.length >= 12 && switches >= 3) || token.length >= 24);
}
// A document ID is an address, not a credential, so it is exempt from the random-run rule only, and only
// in Google's own shapes (fourth review of #354): "/document/d/<id>", "/spreadsheets/d/<id>",
// "/presentation/d/<id>", "/file/d/<id>", "/forms/d/<id>" and "/drive/folders/<id>", on docs.google.com or
// drive.google.com, with an ID of 28 to 64 characters. "/d/<secret>" with no type is not exempt. The hex
// rule and the link's userinfo and query checks still apply.
const GOOGLE_DOC_HOST_RE = /^(?:docs|drive)\.google\.com$/i;
const GOOGLE_DOC_TYPES = new Set(['document', 'spreadsheets', 'presentation', 'file', 'forms']);
const GOOGLE_DOC_ID_RE = /^[A-Za-z0-9_-]{28,64}$/;
function googleDocSegments(authority, segments) {
  const ids = new Set();
  const host = authority.slice(authority.lastIndexOf('@') + 1).split(':')[0];
  if (!GOOGLE_DOC_HOST_RE.test(host)) return ids;
  segments.forEach((segment, i) => {
    if (i < 2 || !GOOGLE_DOC_ID_RE.test(segment)) return;
    const before = segments[i - 2];
    const prev = segments[i - 1];
    if ((prev === 'd' && GOOGLE_DOC_TYPES.has(before)) || (prev === 'folders' && before === 'drive')) ids.add(i);
  });
  return ids;
}
// A password in the userinfo ("https://bob:hunter22@host") is withheld when it is six or more characters
// with a letter and a digit or a symbol (sixth review of #354). The plain token check missed "hunter22".
function userinfoPasswordShape(userinfo) {
  const colon = userinfo.indexOf(':');
  if (colon < 0) return false;
  const password = userinfo.slice(colon + 1);
  return password.length >= 6 && /[A-Za-z]/.test(password) && /[\d\W_]/.test(password);
}
// Percent-encoded characters read as the characters they stand for (sixth review of #354). A malformed
// escape is not a sequence, so it is left alone and cannot throw.
function decodePercent(text) {
  return text.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
// A link is judged by its parts. Its userinfo and query values get the full token check (a password
// or a code in a link is a secret); a path segment is a secret only as a long random run or a hex key.
// An ordinary path slug ("6-006-introduction-to-algorithms-2020") and a percent-encoded word are words.
function linkHasSecret(link) {
  const head = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)([^/?#]*)/i.exec(link);
  const authority = head ? head[1] : '';
  const rest = head ? link.slice(head[0].length) : link;
  const at = authority.lastIndexOf('@');
  if (at > 0 && authority.slice(0, at).split(':').some((piece) => piece && plainSecret(piece))) return true;
  if (at > 0 && userinfoPasswordShape(authority.slice(0, at))) return true;
  const path = rest.split(/[?#]/)[0];
  const query = rest.slice(path.length);
  // Percent-encoded characters are read first, so an encoded hyphen ("%2D") cannot cut a token apart.
  const segments = path.split('/').map(decodePercent);
  const docIds = googleDocSegments(authority, segments);
  if (segments.some((segment, i) => ((randomRun(segment) || hyphenatedRandomRun(segment)) && !docIds.has(i)) || (HEX_RE.test(segment) && plainSecret(segment)))) return true;
  return decodePercent(query).split(/[?&=#]+/).some((piece) => Boolean(piece) && (randomRun(piece) || plainSecret(piece)));
}
function secretToken(raw) {
  // Sentence punctuation is not part of a token; a closing "!" is, when the rest already mixes
  // cases and digits the way a password does ("Summer2026!").
  const trimmed = raw.replace(/^[("'“‘[<{]+/, '').replace(/[)"'”’\]>},.;:?]+$/, '');
  if (WEBHOOK_RE.test(trimmed)) return true;
  if (URL_RE.test(trimmed)) return linkHasSecret(trimmed);
  return plainSecret(trimmed);
}
export function hasSecretShape(text) {
  const value = String(text ?? '');
  if (PEM_RE.test(value) || JWT_PIECE_RE.test(value) || USER_PASS_RE.test(value) || BROKER_KEY_RE.test(value)) return true;
  return value.split(/[\s"“”,;(){}[\]<>]+/).some((piece) => piece && secretToken(piece));
}

export function isSafeMemoryText(text) {
  // The whole collapsed text, not the 500-character display window: a window can cut a word
  // ("pin|nacle") into something the classifier reads as a secret and refuse a clean memory.
  const whole = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!whole) return false;
  if (SENSITIVE_RE.test(whole) || BROKER_KEY_RE.test(whole) || hasSecretShape(whole)) return false;
  if (classifyItem(whole) === 'secret') return false;
  return true;
}

/**
 * Push into data.memories (Durable Object). Reused by /api/memory/add and
 * research write-back so there is one owner-visible list path.
 */
function memorySupersessionSlot(text) {
  const original = clip(text, 500).trim().toLowerCase();
  let value = original;
  // General owner corrections, not only "favorite X": a new "my X is Y"
  // supersedes the same subject while retaining the inactive audit record.
  // Avoid matching "my X" embedded in a research note or other narrative.
  const ownerFact = /^my\s+([a-z0-9][a-z0-9 '\-]{1,55}?)\s+(?:is|are|=)\s+\S/i.exec(original);
  if (ownerFact && !ownerFact[1].startsWith('favorite ')) {
    return `owner-fact:${ownerFact[1].trim().replace(/\s+/g, ' ')}`;
  }
  if (value.startsWith('my ')) value = value.slice(3);
  if (!value.startsWith('favorite ')) return '';
  const rest = value.slice('favorite '.length);
  for (const separator of [':', ' = ', ' is ']) {
    const index = rest.indexOf(separator);
    if (index > 0) {
      const key = rest.slice(0, index).trim();
      if (key && key.length <= 40) return `favorite:${key}`;
    }
  }
  return '';
}

export function addOwnerMemory(data, text, opts = {}) {
  data.memories = Array.isArray(data.memories) ? data.memories : [];
  data.memory_records = Array.isArray(data.memory_records) ? data.memory_records : [];
  // The whole text is gated, then clipped: the cut copy can end on a word fragment ("pin").
  if (!isSafeMemoryText(text)) return { added: false, reason: 'rejected_sensitive_or_empty' };
  const memory = clip(text, 500);
  const lower = memory.toLowerCase();
  if (data.memories.some((item) => String(item).toLowerCase() === lower)) {
    return { added: false, reason: 'duplicate', memory, replaced: [] };
  }

  const slot = memorySupersessionSlot(memory);
  const replaced = [];
  if (slot) {
    data.memories = data.memories.filter((item) => {
      if (memorySupersessionSlot(item) !== slot) return true;
      replaced.push(String(item));
      return false;
    });
    for (const record of data.memory_records) {
      if (record.active === false) continue;
      if (memorySupersessionSlot(record.text || '') !== slot) continue;
      record.active = false;
      record.superseded_at = new Date().toISOString();
      record.superseded_by = memory;
    }
  }

  const now = new Date().toISOString();
  const confidence = Number.isFinite(Number(opts.confidence))
    ? Math.max(0, Math.min(1, Number(opts.confidence)))
    : 1;
  const record = {
    // A memory first saved on the phone keeps the id its Brain record already has.
    id: clip(opts.id, 80) || cryptoRandomId(),
    text: memory,
    title: clipWords(opts.title || memory, 160),
    category: clip(opts.category || 'Memory', 60) || 'Memory',
    // No source means CHE's own code wrote it, not the owner: only the owner's
    // memory paths (chat "remember", the Memory screen, an approved
    // candidate) are recorded as his statements.
    source: clip(opts.source || 'che_note', 220) || 'che_note',
    scope: opts.scope === 'general' ? 'general' : 'owner',
    confidence,
    verification_status: opts.verification_status || (
      ['owner', 'owner_chat', 'explicit_memory', 'owner_approved'].includes(String(opts.source || ''))
        ? 'owner_attested' : 'unverified_reference'),
    created_at: now,
    last_verified_at: clip(opts.last_verified_at || now, 64),
    active: true,
    relationships: Array.isArray(opts.relationships)
      ? [...new Set(opts.relationships.map((item) => clip(item, 120)).filter(Boolean))].slice(0, 24)
      : [],
  };

  data.memories.push(memory);
  data.memories = data.memories.slice(-MAX_MEMORIES);
  data.memory_records.push(record);
  // Keep detailed history bounded independently from the active short-memory
  // list. Superseded records stay available as provenance/history.
  data.memory_records = data.memory_records.slice(-Math.max(MAX_MEMORIES * 4, 400));
  return { added: true, memory, replaced, record };
}

export function listMemoryNotes(data, { limit } = {}) {
  const notes = Array.isArray(data.memory_notes) ? data.memory_notes : [];
  if (limit != null && Number.isFinite(limit) && limit > 0) return notes.slice(0, limit);
  return notes.slice(); // unlimited for Brain room neural map
}

const RESEARCH_KINDS = new Set([
  'fiverr_scout',
  'opportunity_scout',
  'roblox_studio',
  'ml_eval',
  'translate',
  'research',
  'web_research',
  'scout',
]);

const RESEARCH_AGENTS = new Set(['atlas', 'iris', 'nova']);

/** True for scout / research-style Office jobs that should write memory notes. */
export function isResearchStyleJob(task = {}, agent = {}) {
  const kind = clip(task.kind || task.source, 40).toLowerCase();
  if (RESEARCH_KINDS.has(kind)) return true;
  const name = clip(agent.name || task.partner_name, 40).toLowerCase();
  if (RESEARCH_AGENTS.has(name) && /\b(scout|research|source|competitor|market|pinterest|fiverr|drop.?ship|middleman|opportunit)/i.test(
    `${task.task || ''} ${agent.role || ''} ${agent.specialty || ''}`,
  )) return true;
  const blob = `${task.task || ''} ${agent.role || ''} ${agent.specialty || ''}`.toLowerCase();
  if (/\b(fiverr|pinterest|drop.?ship|middleman|opportunity scout|forever scout)\b/.test(blob)) return true;
  if (/\b(research|scout|source gather|competitive check|public research)\b/.test(blob)
    && /research|ad studio|source/i.test(`${agent.role || ''} ${agent.specialty || ''}`)) {
    return true;
  }
  return false;
}

export function extractSourceUrls(text, extra = []) {
  const found = new Set();
  for (const item of extra || []) {
    const u = clip(item?.url || item, 500);
    if (/^https:\/\//i.test(u)) found.add(u);
  }
  const re = /https:\/\/[^\s)\]>"']+/gi;
  const raw = String(text || '');
  let m;
  while ((m = re.exec(raw)) && found.size < MAX_SOURCES) {
    found.add(clip(m[0].replace(/[.,;:]+$/, ''), 500));
  }
  return [...found].slice(0, MAX_SOURCES);
}

function lineBullets(text) {
  const lines = String(text || '').split(/\n+/);
  const bullets = [];
  for (const raw of lines) {
    const line = clip(raw.replace(/^[-*•\d.)\s]+/, ''), 220);
    if (!line || line.length < 12) continue;
    if (SENSITIVE_RE.test(line) || classifyItem(line) === 'secret') continue;
    if (/^https:\/\//i.test(line)) continue;
    bullets.push(line);
    if (bullets.length >= MAX_BULLETS) break;
  }
  if (bullets.length) return bullets;
  // Fallback: sentence-ish chunks from a dense paragraph.
  const flat = clip(text, 2000);
  const parts = flat.split(/(?<=[.!?])\s+/).map((p) => clip(p, 220)).filter((p) => p.length >= 24);
  return parts.filter((p) => !SENSITIVE_RE.test(p) && classifyItem(p) !== 'secret').slice(0, MAX_BULLETS);
}

function inferChannel(task, agent, result) {
  const blob = `${task?.kind || ''} ${task?.source || ''} ${task?.task || ''} ${result || ''}`.toLowerCase();
  if (/\bfiverr\b/.test(blob)) return 'fiverr';
  if (/\bpinterest\b/.test(blob)) return 'pinterest';
  if (/\bdrop.?ship|middleman|alibaba|cj\b/.test(blob)) return 'dropship_middleman';
  if (/\bupwork|etsy|freelancer|gumroad\b/.test(blob)) return 'marketplace';
  if (/\bopportunit|scout\b/.test(blob)) return 'multi';
  if (/iris/i.test(agent?.name || '')) return 'ad_studio';
  return 'research';
}

/**
 * Distill a completed scout/research result into a structured memory note.
 * Opportunity notes prefer channel / offer / why / URL fields when present.
 */
export function distillResearchNote({ result, task = {}, agent = {}, sources = [] } = {}) {
  const body = clip(result, 12000);
  if (!body || body.length < 40) {
    return { ok: false, reason: 'empty_result' };
  }
  if (SENSITIVE_RE.test(body) && classifyItem(body) === 'secret') {
    return { ok: false, reason: 'secret_blocked' };
  }

  const urls = extractSourceUrls(body, sources);
  const channel = inferChannel(task, agent, body);
  const agentName = clip(agent.name || task.partner_name || 'Office', 40) || 'Office';
  const queryHint = clip(
    String(task.task || '').replace(/^.*?\bfor:\s*/i, '').replace(/^.*?\bfor\s+/i, '').slice(0, 80),
    80,
  ) || clip(task.task, 60) || 'research';

  const channelMatch = /\bchannel\s*[:\-–]\s*([^\n|]+)/i.exec(body);
  const offerMatch = /\b(?:offer|service|product)\s*[:\-–]\s*([^\n|]+)/i.exec(body);
  const whyMatch = /\b(?:why|fit|reason)\s*[:\-–]\s*([^\n|]+)/i.exec(body);
  const urlField = /\b(?:url|link)\s*[:\-–]\s*(https:\/\/[^\s)\]]+)/i.exec(body);

  const opportunity = /scout|fiverr|pinterest|drop.?ship|middleman|opportunit/i.test(
    `${task.kind || ''} ${task.source || ''} ${task.task || ''} ${channel}`,
  );

  const title = opportunity
    ? clip(`Opportunity · ${channelMatch?.[1] || channel} · ${offerMatch?.[1] || queryHint}`, 140)
    : clip(`Research · ${agentName} · ${queryHint}`, 140);

  let bullets = lineBullets(body);
  if (opportunity) {
    const pref = [];
    pref.push(`Channel: ${clip(channelMatch?.[1] || channel, 80)}`);
    if (offerMatch) pref.push(`Offer: ${clip(offerMatch[1], 160)}`);
    else if (bullets[0]) pref.push(`Offer: ${bullets[0]}`);
    if (whyMatch) pref.push(`Why: ${clip(whyMatch[1], 180)}`);
    else if (bullets[1]) pref.push(`Why: ${bullets[1]}`);
    const link = urlField?.[1] || urls[0];
    if (link) pref.push(`URL: ${clip(link, 300)}`);
    pref.push('Owner gate: shortlist only — confirm before outreach, bids, purchases, spend, or Stripe. Legal money-making only.');
    bullets = [...new Set(pref)].slice(0, MAX_BULLETS);
  }

  if (!bullets.length) return { ok: false, reason: 'no_safe_bullets' };

  if (urlField?.[1] && !urls.includes(urlField[1])) urls.unshift(clip(urlField[1], 500));

  const memoryText = clip(
    [
      title,
      ...bullets.map((b) => `- ${b}`),
      urls.length ? `Sources: ${urls.join(' | ')}` : '',
    ].filter(Boolean).join('\n'),
    500,
  );

  if (!isSafeMemoryText(memoryText) && classifyItem(memoryText) === 'secret') {
    return { ok: false, reason: 'secret_blocked' };
  }

  return {
    ok: true,
    note: {
      id: crypto.randomUUID(),
      title,
      bullets,
      sources: urls.slice(0, MAX_SOURCES),
      kind: opportunity ? 'opportunity' : 'research',
      channel: opportunity ? (clip(channelMatch?.[1] || channel, 40) || channel) : channel,
      offer: opportunity ? clip(offerMatch?.[1] || bullets.find((b) => /^Offer:/i.test(b))?.replace(/^Offer:\s*/i, '') || '', 160) : '',
      why: opportunity ? clip(whyMatch?.[1] || bullets.find((b) => /^Why:/i.test(b))?.replace(/^Why:\s*/i, '') || '', 180) : '',
      url: urls[0] || '',
      agent: agentName,
      task_id: clip(task.id, 80),
      created_at: new Date().toISOString(),
      owner_confirm_required: opportunity,
    },
    memoryText,
  };
}

/**
 * Write distilled findings into DO memory (memories + memory_notes).
 * Never dumps raw PII; never invents secret storage.
 */
export function writeResearchMemoryNote(data, opts = {}) {
  data.memory_notes = Array.isArray(data.memory_notes) ? data.memory_notes : [];
  data.learned_knowledge = Array.isArray(data.learned_knowledge) ? data.learned_knowledge : [];

  if (!isResearchStyleJob(opts.task || {}, opts.agent || {}) && opts.force !== true) {
    return { written: false, reason: 'not_research_style' };
  }

  const distilled = distillResearchNote(opts);
  if (!distilled.ok) return { written: false, reason: distilled.reason };

  const { note, memoryText } = distilled;
  const dup = data.memory_notes.some(
    (item) => String(item.title || '').toLowerCase() === note.title.toLowerCase()
      && String(item.bullets?.[0] || '') === String(note.bullets[0] || ''),
  );
  if (dup) return { written: false, reason: 'duplicate_note', note };

  data.memory_notes.unshift(note);
  if (Number.isFinite(MAX_NOTES_SOFT) && data.memory_notes.length > MAX_NOTES_SOFT) {
    data.memory_notes = data.memory_notes.slice(0, MAX_NOTES_SOFT);
  }

  // Agent prose is a RESEARCH LEAD, not an owner-attested personal fact.
  // Keep it as a searchable research note, separate from data.memories;
  // even a cited URL is not proof an agent actually checked that page.
  note.verification_status = 'unverified_research_lead';
  const lesson = clip(`Unverified research lead — ${note.title}: ${note.bullets[0] || ''}`, 700);
  if (lesson && !data.learned_knowledge.includes(lesson)) {
    data.learned_knowledge.push(lesson);
    data.learned_knowledge = data.learned_knowledge.slice(-30);
  }

  if (opts.agent && Array.isArray(opts.agent.memory_refs)) {
    opts.agent.memory_refs = [...new Set([...opts.agent.memory_refs, note.id])].slice(-40);
  }

  return {
    written: true,
    note,
    memory_added: false,
    memory: memoryText,
  };
}


// ─── Brain room: neural nodes + related links ───────────────────────────────

// Live Office agent work as brain nodes. Only tasks that are really queued,
// running or under CHE review appear; anything else would be decoration.
const LIVE_TASK_STATUSES = new Set(['queued', 'running', 'reviewing']);
const MAX_LIVE_TASK_NODES = 20;

/**
 * Newest-first live agent tasks → brain-graph nodes (region "Office Agents").
 * Pure bookkeeping over data.team_tasks: no model calls, no invented work.
 */
export function buildAgentTaskNodes(data = {}, { max = MAX_LIVE_TASK_NODES } = {}) {
  const tasks = Array.isArray(data.team_tasks) ? data.team_tasks : [];
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.min(Number(max), 60) : MAX_LIVE_TASK_NODES;
  const active = tasks.filter((task) => LIVE_TASK_STATUSES.has(String(task?.status || '')));
  // Reserve a slot for each agent before filling the remaining visual slots.
  // Otherwise a large batch for Atlas could hide Sage's active work and CHE
  // would falsely announce that Sage is idle.
  const covered = new Set();
  const agentKeys = new Set();
  for (const task of active) {
    const key = String(task.partner_id || task.partner_name || 'Office agent').toLowerCase();
    if (agentKeys.has(key)) continue;
    covered.add(task);
    agentKeys.add(key);
  }
  const selected = [...active.filter((task) => covered.has(task)),
    ...active.filter((task) => !covered.has(task))].slice(0, cap);
  const nodes = [];
  for (const task of selected) {
    const status = String(task.status || '');
    const who = clip(task?.partner_name || 'Office agent', 40) || 'Office agent';
    const what = clip(task?.task || '', 120) || 'working';
    const detail = clip(task?.result || task?.error || '', 200);
    nodes.push({
      id: `agent-task-${clip(task?.id, 80) || nodes.length}`,
      title: clip(`${who} · ${what}`, 160),
      body: clip(`Status: ${status}. ${who} is working on: ${task?.task || ''}${detail ? ` — ${detail}` : ''}`, 500),
      kind: 'agent_task',
      locale: null,
      cluster_id: null,
      metrics: null,
      created_at: task?.created_at || null,
      region: 'Office Agents',
      agent: who,
      status,
      task_id: clip(task?.id, 80),
      updated_at: task?.updated_at || null,
    });
  }
  return nodes;
}

function noteTextBlob(note) {
  const bullets = Array.isArray(note?.bullets) ? note.bullets.join(' ') : '';
  return clip(`${note?.title || ''} ${bullets} ${note?.kind || ''} ${note?.locale || ''} ${note?.cluster_id || ''}`, 1200).toLowerCase();
}

function tokenSet(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Build Brain room graph: one node per memory_note (+ learned_knowledge tips),
 * plus related links from shared kind/cluster/locale or token overlap.
 * Phone visualizes nodes as neural dots.
 */
export function buildBrainGraph(data = {}, { maxLinksPerNode = 4, minSimilarity = 0.12, liveNodes = [] } = {}) {
  const notes = listMemoryNotes(data);
  const nodes = [];
  const links = [];
  const byId = new Map();

  for (const note of notes) {
    const id = String(note.id || note.title || cryptoRandomId());
    const kind = clip(note.kind || note.source || 'knowledge', 40) || 'knowledge';
    const cluster = note.cluster_id != null ? String(note.cluster_id) : (note.ml_cluster != null ? String(note.ml_cluster) : null);
    const node = {
      id,
      title: clip(note.title || 'Memory note', 160),
      body: clip((Array.isArray(note.bullets) ? note.bullets.join(' · ') : note.text || ''), 500),
      kind,
      locale: note.locale || null,
      cluster_id: cluster,
      metrics: note.metrics || null,
      created_at: note.created_at || null,
      region: kind.startsWith('ml') || kind === 'ml_eval' || kind === 'classification' || kind === 'clustering'
        ? 'ML Learning'
        : kind === 'translate' || kind === 'translation'
          ? 'Translation'
          : kind.includes('scout') || kind === 'research'
            ? 'Research'
            : 'Memory Notes',
    };
    nodes.push(node);
    byId.set(id, { node, tokens: tokenSet(noteTextBlob(note)) });
  }

  // learned_knowledge strings as lightweight nodes (dedupe against note titles)
  const knowledge = Array.isArray(data.learned_knowledge) ? data.learned_knowledge : [];
  const titleSet = new Set(nodes.map((n) => n.title.toLowerCase()));
  for (let i = 0; i < knowledge.length; i++) {
    const text = clip(knowledge[i], 500);
    if (!text) continue;
    if (titleSet.has(text.toLowerCase().slice(0, 160))) continue;
    const id = `lk-${i}-${hashShort(text)}`;
    nodes.push({
      id,
      title: clipWords(text, 160),
      body: text,
      kind: 'learned_knowledge',
      locale: null,
      cluster_id: null,
      metrics: null,
      created_at: null,
      region: 'Learned Knowledge',
    });
    byId.set(id, { node: nodes[nodes.length - 1], tokens: tokenSet(text) });
  }

  // Live nodes (e.g. active Office agent tasks): real activity only, linked
  // into the graph by the same token-overlap pass below.
  const live = Array.isArray(liveNodes) ? liveNodes : [];
  for (const item of live) {
    const id = clip(item?.id, 120);
    if (!id || byId.has(id)) continue;
    const node = {
      id,
      title: clip(item?.title || 'Live activity', 160),
      body: clip(item?.body || '', 500),
      kind: clip(item?.kind || 'live', 40) || 'live',
      locale: item?.locale || null,
      cluster_id: item?.cluster_id != null ? String(item.cluster_id) : null,
      metrics: item?.metrics || null,
      created_at: item?.created_at || null,
      region: clip(item?.region || 'Live', 40) || 'Live',
    };
    for (const [key, value] of Object.entries(item || {})) {
      if (!(key in node) && value != null && ['string', 'number', 'boolean'].includes(typeof value)) {
        node[key] = typeof value === 'string' ? clip(value, 120) : value;
      }
    }
    nodes.push(node);
    byId.set(id, { node, tokens: tokenSet(`${node.title} ${node.body} ${node.kind}`) });
  }

  // Related links: same cluster_id, same kind+locale, or token Jaccard
  const ids = [...byId.keys()];
  const linkKey = new Set();
  const degree = new Map(ids.map((id) => [id, 0]));

  function addLink(a, b, relation, weight) {
    if (a === b) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    const key = `${x}|${y}|${relation}`;
    if (linkKey.has(key)) return;
    if ((degree.get(a) || 0) >= maxLinksPerNode || (degree.get(b) || 0) >= maxLinksPerNode) return;
    linkKey.add(key);
    degree.set(a, (degree.get(a) || 0) + 1);
    degree.set(b, (degree.get(b) || 0) + 1);
    links.push({ source: a, target: b, relation, weight: Math.round(weight * 1000) / 1000 });
  }

  for (let i = 0; i < ids.length; i++) {
    const A = byId.get(ids[i]);
    for (let j = i + 1; j < ids.length; j++) {
      const B = byId.get(ids[j]);
      if (A.node.cluster_id && A.node.cluster_id === B.node.cluster_id) {
        addLink(ids[i], ids[j], 'cluster', 1);
        continue;
      }
      if (A.node.kind && A.node.kind === B.node.kind && A.node.kind !== 'knowledge') {
        const sim = jaccard(A.tokens, B.tokens);
        if (sim >= minSimilarity * 0.5) addLink(ids[i], ids[j], 'kind', Math.max(sim, 0.35));
      }
      if (A.node.locale && A.node.locale === B.node.locale) {
        addLink(ids[i], ids[j], 'locale', 0.4);
      }
      const sim = jaccard(A.tokens, B.tokens);
      if (sim >= minSimilarity) addLink(ids[i], ids[j], 'related', sim);
    }
  }

  // Explicit related[] on notes
  for (const note of notes) {
    const id = String(note.id || '');
    if (!id || !byId.has(id)) continue;
    for (const rel of (note.related || note.related_ids || [])) {
      const rid = String(rel);
      if (byId.has(rid)) addLink(id, rid, 'explicit', 1);
    }
  }

  return {
    nodes,
    links,
    counts: {
      nodes: nodes.length,
      links: links.length,
      memory_notes: notes.length,
      learned_knowledge: knowledge.length,
      live: live.length,
    },
  };
}

function hashShort(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).slice(0, 8);
}

function cryptoRandomId() {
  try {
    return crypto.randomUUID();
  } catch (_) {
    return `n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/** Attach cluster / related metadata onto a memory note (ML learning write-back). */
export function enrichNoteForBrain(note, { cluster_id, related = [], metrics, locale, kind } = {}) {
  const out = { ...(note || {}) };
  if (cluster_id != null) out.cluster_id = String(cluster_id);
  if (related?.length) out.related = [...new Set(related.map(String))].slice(0, 24);
  if (metrics) out.metrics = metrics;
  if (locale) out.locale = locale;
  if (kind) out.kind = kind;
  if (!out.id) out.id = cryptoRandomId();
  return out;
}

export { MAX_NOTES_SOFT };
