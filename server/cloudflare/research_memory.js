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
function memorySupersessionSlot(text) {
  let value = clip(text, 500).trim().toLowerCase();
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
  const memory = clip(text, 500);
  if (!isSafeMemoryText(memory)) return { added: false, reason: 'rejected_sensitive_or_empty' };
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
    id: cryptoRandomId(),
    text: memory,
    title: clip(opts.title || memory, 160),
    category: clip(opts.category || 'Memory', 60) || 'Memory',
    source: clip(opts.source || 'owner', 220) || 'owner',
    scope: opts.scope === 'general' ? 'general' : 'owner',
    confidence,
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


// ─── Brain room: neural nodes + related links ───────────────────────────────

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
export function buildBrainGraph(data = {}, { maxLinksPerNode = 4, minSimilarity = 0.12 } = {}) {
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
      title: clip(text, 160),
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
