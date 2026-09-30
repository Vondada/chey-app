// Bounded research → Durable Object memory write-back.
//
// When Office agents (esp. Atlas / Iris) finish a scout or research-style job,
// CHE distills title + short bullets + source URLs into owner-visible memory
// notes. Secrets never land; notes stay short and listable via /api/state and
// the existing /api/memory/add path.

import { classifyItem } from './privacy_policy.js';

const MAX_MEMORIES = 100;
const MAX_NOTES = 80;
const MAX_BULLETS = 6;
const MAX_SOURCES = 6;
const SENSITIVE_RE = /password|passcode|security code|social security|credit card|api[_ -]?key|private key|seed phrase|session cookie|fiverr\s+password|auth\s+token/i;

function clip(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Same gate as /api/memory/add — non-sensitive only. */
export function isSafeMemoryText(text) {
  const memory = clip(text, 500);
  if (!memory) return false;
  if (SENSITIVE_RE.test(memory)) return false;
  if (classifyItem(memory) === 'secret') return false;
  return true;
}

/**
 * Push into data.memories (Durable Object). Reused by /api/memory/add and
 * research write-back so there is one owner-visible list path.
 */
export function addOwnerMemory(data, text) {
  data.memories = Array.isArray(data.memories) ? data.memories : [];
  const memory = clip(text, 500);
  if (!isSafeMemoryText(memory)) return { added: false, reason: 'rejected_sensitive_or_empty' };
  if (data.memories.some((item) => String(item).toLowerCase() === memory.toLowerCase())) {
    return { added: false, reason: 'duplicate', memory };
  }
  data.memories.push(memory);
  data.memories = data.memories.slice(-MAX_MEMORIES);
  return { added: true, memory };
}

export function listMemoryNotes(data) {
  return Array.isArray(data.memory_notes) ? data.memory_notes.slice(0, MAX_NOTES) : [];
}

const RESEARCH_KINDS = new Set([
  'fiverr_scout',
  'opportunity_scout',
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
  data.memory_notes = data.memory_notes.slice(0, MAX_NOTES);

  const mem = addOwnerMemory(data, memoryText);

  const lesson = clip(`${note.title}: ${note.bullets[0] || ''}`, 700);
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
    memory_added: mem.added,
    memory: mem.memory || memoryText,
  };
}
