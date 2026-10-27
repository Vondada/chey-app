// CHE Capability Engine (owner, 2026-10-22: "knowledge must become capability").
//
// One path from a permitted source to a reusable, verified internal capability:
//   SOURCE → inspect → verify → index → understand → connect → derive procedure → implement → test → verify → store →
//   retrieve later → reuse.
//
// Layers, and where each lives (nothing here is a second store of the same thing):
//   source      the Knowledge Library reference and its approved text (knowledge_library.js, kl_refs + CheLibrary)
//   indexed     concepts and facts extracted from it                      (ce_items, layer 'indexed')
//   procedure   how-to steps, with applicability                           (ce_items, layer 'procedure')
//   capability  what CHE can actually do                                   (capability_registry.js; the only claimable layer)
//   experience  verified outcomes, failures, owner corrections            (ce_items, layer 'experience')
//   project     project decisions and reusable project methods            (ce_items, layer 'project', scoped)
//
// Internal tools are programs over a fixed set of pure primitives (PRIMITIVES), run by an interpreter with step, size
// and time limits and no access to storage, network or credentials. CHE never evaluates generated code. A capability
// that needs new code goes through the reviewed self-development path (capability_gap.js), never straight to production.
import { KnowledgeLibrary, textAllowed } from './knowledge_library.js';
import { fromKnowledgeItem, BrainLedger } from './brain_ledger.js';
import {
  EXECUTION, EXECUTION_ORDER, PROMOTION_CHECKS, USABLE, executionAllowed, loadRegistry, promote, recordCheck, recordUse,
  register, rollback, saveRegistry, serving,
} from './capability_registry.js';

export const POLICY_KEY = 'che:capability_policy';
export const TOOLS_KEY = 'che:internal_tools';
export const LAST_USED_KEY = 'che:last_knowledge_used';

export const LAYERS = Object.freeze(['source', 'indexed', 'procedure', 'capability', 'experience', 'project']);
export const SCOPES = Object.freeze(['owner-global', 'project-only', 'client-only', 'session-only', 'security-restricted', 'private', 'temporary', 'shareable', 'non-exportable']);
const STALE_DAYS = 180;
const DAY = 86_400_000;

const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]+/g, ' ').slice(0, n);
const STOP = new Set('a an and are as at be but by can do does for from has have how i if in into is it its not of on or so than that the then this to use used uses using was were when which while with without you your each first second next finally step steps'.split(' '));
export function tokens(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9+#. ]+/g, ' ').split(/\s+/)
    .map((w) => w.replace(/\.+$/, '').replace(/(?<=[a-z]{3})s$/, ''))
    .filter((w) => w.length > 2 && !STOP.has(w));
}
const keyOf = (text) => tokens(text).join(' ').slice(0, 240);
const overlap = (a, b) => { const x = new Set(a); let n = 0; for (const w of new Set(b)) if (x.has(w)) n++; return n; };

// ─── Owner policy ───────────────────────────────────────────────────────────

export function defaultPolicy() {
  return {
    internal_only: false, no_external_api: false, no_paid: false, require_approval_external_code: true,
    approved_external: [], no_export_projects: [], memory: { method_only: false, private_clients: true, project_scope_default: false },
    updated_at: null,
  };
}
// Internal-only has one source of truth: Security Intelligence's egress policy, which guards every outbound fetch.
const EGRESS_POLICY_KEY = 'che:egress_policy';
export async function loadPolicy(storage) {
  let p = null;
  let egress = null;
  try { p = await storage.get(POLICY_KEY); } catch (_) { p = null; }
  try { egress = await storage.get(EGRESS_POLICY_KEY); } catch (_) { egress = null; }
  const base = defaultPolicy();
  const merged = p ? { ...base, ...p, memory: { ...base.memory, ...(p.memory || {}) } } : base;
  return { ...merged, internal_only: egress?.internal_only === true, no_external_api: egress?.internal_only === true };
}
export async function savePolicy(storage, p) { await storage.put(POLICY_KEY, { ...p, updated_at: new Date().toISOString() }); }

/** The owner's natural-language policies → structured changes. Returns null when the words are not a policy. */
export function policyIntent(message = '') {
  const t = String(message || '').trim().toLowerCase().replace(/[’]/g, "'").replace(/^(?:che|chay|chey)[,\s]+/, '').replace(/[.!]+$/, '');
  // "Use only your internal capabilities" and "do not call any external API" are Security Intelligence's (one switch).
  if (/^(?:turn off|disable|stop|exit|leave) internal[- ]only(?: mode)?$|^you (?:may|can) use external (?:apis|services|tools) again$/.test(t)) return { set: { internal_only: false }, said: '' };
  if (/^(?:(?:turn on|enable|use) internal[- ]only(?: mode)?|only use your (?:own|internal) (?:tools|capabilities))$/.test(t)) return { set: { internal_only: true }, said: 'Internal-only mode is on: I call no outside service, only my own runtime and the compute you control, and I tell you when something cannot be done internally.' };
  if (/^(?:do not|don't|never) use paid apis?(?: or services)?$/.test(t)) return { set: { no_paid: true }, said: 'Paid services are off. Free and internal capabilities only.' };
  if (/^(?:do not|don't|never) send (?:this|my|the) project outside (?:che|of che|you)$/.test(t)) return { set: { no_export_projects: ['*'] }, said: 'Projects stay inside CHE: nothing from them is sent to an external service.' };
  if (/^remember the method,? not the (?:private )?files$/.test(t)) return { memory: { method_only: true }, said: 'From now on I keep the method of a verified result, never the files themselves.' };
  if (/^(?:do not|don't) remember private client data$/.test(t)) return { memory: { private_clients: true }, said: 'Private client data is never kept beyond its client.' };
  if (/^keep this knowledge inside this project$/.test(t)) return { memory: { project_scope_default: true }, said: 'New knowledge from a project stays in that project unless you make it global.' };
  if (/^require my approval before installing external code$|^never install external code without (?:asking|my approval)$/.test(t)) return { set: { require_approval_external_code: true }, said: 'External code is never installed without your yes; it is security-checked first.' };
  return null;
}

export function applyPolicy(policy, intent) {
  const next = { ...policy, ...(intent.set || {}), memory: { ...policy.memory, ...(intent.memory || {}) } };
  if (intent.set?.no_export_projects) next.no_export_projects = [...new Set([...(policy.no_export_projects || []), ...intent.set.no_export_projects])];
  return next;
}

// ─── Knowledge items (indexed / procedure / experience / project layers) ────

export class KnowledgeItems {
  constructor(storage) { this.storage = storage; this.sql = storage?.sql || null; this.ready = false; }
  init() {
    if (this.ready) return Boolean(this.sql);
    if (!this.sql) return false;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ce_items (
      id TEXT PRIMARY KEY, key TEXT, layer TEXT, kind TEXT, title TEXT, body TEXT, domain TEXT, scope TEXT, project_id TEXT,
      provenance TEXT, confidence REAL, applicability TEXT, status TEXT, version INTEGER, conflicts TEXT, links TEXT,
      freshness TEXT, steps TEXT, created TEXT, updated TEXT)`);
    this.ready = true;
    return true;
  }
  row(r) {
    if (!r) return null;
    const j = (v, d) => { try { return v ? JSON.parse(v) : d; } catch (_) { return d; } };
    return { ...r, provenance: j(r.provenance, {}), applicability: j(r.applicability, {}), conflicts: j(r.conflicts, []), links: j(r.links, []), freshness: j(r.freshness, {}), steps: j(r.steps, []) };
  }
  all({ layer = '' } = {}) {
    if (!this.init()) return [];
    return [...this.sql.exec(layer ? 'SELECT * FROM ce_items WHERE layer = ?' : 'SELECT * FROM ce_items', ...(layer ? [layer] : []))].map((r) => this.row(r));
  }
  get(id) { if (!this.init()) return null; return this.row([...this.sql.exec('SELECT * FROM ce_items WHERE id = ?', id)][0]); }
  byKey(key, scope, project_id) {
    if (!this.init()) return null;
    return this.row([...this.sql.exec('SELECT * FROM ce_items WHERE key = ? AND scope = ? AND project_id = ?', key, scope, project_id || '')][0]);
  }
  put(item) {
    if (!this.init()) return null;
    const previous = this.get(item.id);
    const s = (v) => JSON.stringify(v ?? null);
    this.sql.exec(`INSERT OR REPLACE INTO ce_items (id, key, layer, kind, title, body, domain, scope, project_id, provenance, confidence, applicability, status, version, conflicts, links, freshness, steps, created, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    item.id, item.key, item.layer, item.kind, item.title, item.body, item.domain, item.scope, item.project_id || '', s(item.provenance), item.confidence,
    s(item.applicability), item.status, item.version, s(item.conflicts), s(item.links), s(item.freshness), s(item.steps), item.created, item.updated);
    // Brain Population Ledger: each layer change (source → indexed → procedure …) is its own timestamped event.
    try { fromKnowledgeItem(this.storage, previous, item, { now: item.updated }); } catch (_) { /* never blocks the write */ }
    return item;
  }
  remove(id) {
    if (!this.init()) return;
    const previous = this.get(id);
    this.sql.exec('DELETE FROM ce_items WHERE id = ?', id);
    // Removal keeps metadata only; the item's earlier ledger text is scrubbed.
    if (previous) {
      try {
        const ledger = new BrainLedger(this.storage);
        ledger.scrub(id);
        ledger.record({ event_type: 'REMOVED', knowledge_type: 'knowledge', title: 'Removed item', record_id: id, category: previous.project_id ? 'Projects' : '', domain: previous.domain, project_id: previous.project_id || '', knowledge_scope: previous.scope, new_state: 'REMOVED', reason_saved: 'Owner request' });
      } catch (_) { /* never blocks the removal */ }
    }
  }
}

const TRUST_CONFIDENCE = { owner: 0.9, official: 0.85, open: 0.7, catalog_only: 0.4, unknown: 0.5 };
const DOMAIN_WORDS = [
  ['data', /\b(csv|json|table|column|row|parse|convert|spreadsheet|field)\b/i],
  ['video', /\b(video|caption|subtitle|frame|timeline|render|transition)\b/i],
  ['rendering', /\b(render|scene|pixel|lighting|shader|raster|sky|horizon)\b/i],
  ['security', /\b(security|malware|secret|credential|vulnerab|attack|phishing)\b/i],
  ['music', /\b(song|music|beat|tempo|bpm|mix|master)\b/i],
  ['writing', /\b(word|sentence|paragraph|essay|text)\b/i],
];
export function classify(text) {
  return DOMAIN_WORDS.find(([, re]) => re.test(text))?.[0] || 'general';
}

/** Facts, concepts, procedures and applicability from approved text. Deterministic: no model call. */
export function extract(text) {
  const body = String(text || '').replace(/\r/g, '');
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const procedures = [];
  let current = null;
  for (const line of lines) {
    const head = /^(?:#+\s*)?(?:how to|to)\s+(.{3,120}?)\s*:?\s*$/i.exec(line);
    if (head && !/^\d+[.)]/.test(line)) { current = { title: head[1].replace(/:$/, ''), steps: [], examples: [], notes: [] }; procedures.push(current); continue; }
    const step = /^(?:\d+[.)]|[-*•])\s+(.+)$/.exec(line);
    if (current && step) { current.steps.push(step[1]); continue; }
    const ex = /^example\s+input\s*:\s*(.+)$/i.exec(line);
    if (current && ex) { current.examples.push({ input: ex[1].replace(/\\n/g, '\n') }); continue; }
    const out = /^expected\s+output\s*:\s*(.+)$/i.exec(line);
    if (current && out && current.examples.length) { current.examples[current.examples.length - 1].output = out[1]; continue; }
    if (current && /^(?:requires?|needs?|only|does not|doesn't|fails? (?:if|when)|limitations?)\b/i.test(line)) current.notes.push(line);
  }
  const sentences = body.replace(/\n+/g, ' ').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 15 && s.length < 400);
  const facts = sentences.filter((s) => /\b(?:is|are|means|uses|requires|produces|returns|contains|was|has)\b/i.test(s) && !/^\d+[.)]/.test(s)).slice(0, 60);
  const freq = new Map();
  for (const w of tokens(body)) freq.set(w, (freq.get(w) || 0) + 1);
  const concepts = [...freq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([w]) => w);
  return {
    facts, concepts,
    procedures: procedures.filter((p) => p.steps.length).map((p) => ({
      ...p,
      applicability: {
        prerequisites: p.notes.filter((n) => /^(?:requires?|needs?)\b/i.test(n)),
        limitations: p.notes.filter((n) => /^(?:only|does not|doesn't|limitations?)\b/i.test(n)),
        failure_modes: p.notes.filter((n) => /^fails?\b/i.test(n)),
        inputs: /csv/i.test(p.title) ? ['csv text'] : /text|words|caption/i.test(p.title) ? ['text'] : [],
        outputs: /json/i.test(p.title) ? ['json'] : /caption|timing/i.test(p.title) ? ['caption cues'] : /count/i.test(p.title) ? ['number'] : [],
      },
    })),
  };
}

// The subject of a fact ("X is Y" → X), for conflict detection.
function factSubject(f) {
  const m = /^(?:the\s+)?(.{3,60}?)\s+(?:is|are|means|uses|requires|returns)\s+(.+)$/i.exec(f.replace(/[.!?]$/, ''));
  return m ? { subject: keyOf(m[1]), claim: keyOf(m[2]) } : null;
}

/**
 * Population pipeline: source (Knowledge Library) → extract → dedupe → classify → connect → provenance → confidence →
 * uses → procedures. Knowledge from a project or client is scoped there; nothing is globally retrievable unless allowed.
 */
export function populate(storage, input = {}, { now = new Date().toISOString(), policy = defaultPolicy() } = {}) {
  const kl = new KnowledgeLibrary(storage);
  const items = new KnowledgeItems(storage);
  if (!items.init()) return { error: 'Knowledge storage is not available.' };
  const text = String(input.text || '');
  const license = input.license || 'owner';
  if (!textAllowed(license)) return { error: `Only owner, public-domain or openly licensed text is learned from (licence: ${license}).` };
  const domain = input.domain || classify(`${input.title} ${text}`);
  let scope = SCOPES.includes(input.scope) ? input.scope : 'owner-global';
  if (input.client_id && policy.memory.private_clients) scope = 'client-only';
  else if (input.project_id && policy.memory.project_scope_default && scope === 'owner-global') scope = 'project-only';
  // Raw source layer. Global knowledge goes to the existing Knowledge Library (catalogue + approved text + Brain record).
  // Scoped knowledge (project, client, session, private, security) never enters those global indexes: its source is a
  // scoped 'source' item here, so no library search or Brain query can return it outside its scope.
  const global = ['owner-global', 'shareable', 'non-exportable'].includes(scope);
  let ref;
  if (global) {
    const category = { data: 'software_engineering', video: 'marketing_video', rendering: 'animation_games', security: 'cybersecurity', music: 'creative_writing', writing: 'creative_writing' }[domain] || 'software_engineering';
    ref = kl.catalog({ title: input.title || 'Untitled source', creator: input.creator, kind: input.kind || 'documentation', license, category, source_url: input.source_url, note: input.note });
    if (ref.error) return ref;
    const indexed = kl.index(ref.id, text, { now });
    if (indexed.error) return indexed;
  } else {
    if (text.trim().length < 20) return { error: 'There was nothing readable to index.' };
    const sid = crypto.randomUUID();
    ref = { id: sid, key: `src:${sid}`, title: clip(input.title || 'Untitled source', 200), source_url: clip(input.source_url, 500) };
    items.put({ id: sid, key: ref.key, layer: 'source', kind: 'source', title: ref.title, body: clip(text, 20000), domain, scope,
      project_id: String(input.project_id || input.client_id || ''), provenance: { license, source_url: ref.source_url, session_id: input.session_id || '' },
      confidence: 1, applicability: {}, status: 'source', version: 1, conflicts: [], links: [], freshness: { last_indexed: now }, steps: [], created: now, updated: now });
  }
  const confidence = TRUST_CONFIDENCE[input.trust] ?? (license === 'owner' ? TRUST_CONFIDENCE.owner : TRUST_CONFIDENCE.open);
  const provenance = { ref_id: ref.id, ref_key: ref.key, title: ref.title, source_url: ref.source_url || '', license, trust: input.trust || (license === 'owner' ? 'owner' : 'open'), indexed_at: now, ...(input.session_id ? { session_id: input.session_id } : {}) };
  const found = extract(text);
  const out = { source: ref.id, added: [], updated: [], conflicts: [], procedures: [] };
  const project_id = scope === 'project-only' || scope === 'client-only' ? String(input.project_id || input.client_id || '') : '';
  const save = (layer, kind, title, body, extra = {}) => {
    const key = keyOf(`${kind} ${title} ${body}`);
    const existing = items.byKey(key, scope, project_id);
    if (existing) {
      // Dedupe: the same knowledge again strengthens it and refreshes it; it never makes a second copy.
      existing.confidence = Math.min(0.99, Math.max(existing.confidence, confidence) + 0.02);
      existing.freshness = { ...existing.freshness, last_indexed: now, last_reviewed: now };
      existing.provenance = { ...existing.provenance, also: [...new Set([...(existing.provenance.also || []), ref.id])].slice(0, 10) };
      existing.updated = now;
      items.put(existing);
      out.updated.push(existing.id);
      return existing;
    }
    const item = {
      id: crypto.randomUUID(), key, layer, kind, title: clip(title, 200), body: clip(body, 2000), domain, scope, project_id,
      provenance, confidence, applicability: { domain, ...(extra.applicability || {}) }, status: extra.status || 'indexed', version: 1,
      conflicts: [], links: [], freshness: { last_indexed: now, last_reviewed: now, last_tested: null, last_used: null, source_version: input.version || '' },
      steps: extra.steps || [], created: now, updated: now,
    };
    items.put(item);
    out.added.push(item.id);
    return item;
  };
  for (const f of found.facts) {
    const fact = save('indexed', 'fact', f.slice(0, 80), f);
    // Conflict: the same subject with a different claim. Both are kept and marked; nothing is overwritten.
    const me = factSubject(f);
    if (!me) continue;
    for (const other of items.all({ layer: 'indexed' })) {
      if (other.id === fact.id || other.kind !== 'fact') continue;
      const o = factSubject(other.body);
      if (o && o.subject === me.subject && o.claim !== me.claim && overlap(tokens(o.claim), tokens(me.claim)) < Math.min(tokens(o.claim).length, tokens(me.claim).length)) {
        if (!fact.conflicts.includes(other.id)) fact.conflicts.push(other.id);
        if (!other.conflicts.includes(fact.id)) { other.conflicts.push(fact.id); items.put(other); }
        items.put(fact);
        out.conflicts.push([fact.id, other.id]);
      }
    }
  }
  for (const c of found.concepts) save('indexed', 'concept', c, `${c} (from ${ref.title})`);
  for (const p of found.procedures) {
    const proc = save('procedure', 'procedure', p.title, p.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), {
      steps: p.steps, applicability: { ...p.applicability, examples: p.examples }, status: 'procedure',
    });
    out.procedures.push(proc.id);
  }
  connect(items, [...out.added, ...out.updated]);
  return out;
}

/** Links items that share at least two concepts, both ways. */
function connect(items, ids) {
  const all = items.all();
  for (const id of ids) {
    const a = all.find((x) => x.id === id);
    if (!a) continue;
    const ta = tokens(`${a.title} ${a.body}`);
    for (const b of all) {
      if (b.id === a.id || a.links.includes(b.id)) continue;
      if (overlap(ta, tokens(`${b.title} ${b.body}`)) >= 2) {
        a.links.push(b.id);
        if (!b.links.includes(a.id)) { b.links.push(a.id); b.links = b.links.slice(-40); items.put(b); }
      }
    }
    a.links = a.links.slice(-40);
    items.put(a);
  }
}

// ─── Retrieval loop ─────────────────────────────────────────────────────────

/** May this item be used for this task? Scope is checked before anything is retrieved. */
export function inScope(item, ctx = {}) {
  switch (item.scope) {
    case 'owner-global': case 'shareable': case 'non-exportable': return true;
    case 'project-only': case 'client-only': return Boolean(ctx.project_id) && item.project_id === ctx.project_id;
    case 'session-only': case 'temporary': return Boolean(ctx.session_id) && item.provenance?.session_id === ctx.session_id;
    case 'security-restricted': return ctx.security === true;
    case 'private': return ctx.private === true;
    default: return false;
  }
}

export function isStale(item, now = Date.now()) {
  const last = Date.parse(item.freshness?.last_reviewed || item.freshness?.last_indexed || item.created || 0);
  return !last || now - last > STALE_DAYS * DAY;
}

/**
 * INTERNAL KNOWLEDGE RETRIEVAL LOOP: intent → entities → domain → concepts, procedures, capabilities, project
 * knowledge, verified outcomes and prior failures → ranked by match × confidence × freshness → scope-checked context.
 */
export function retrieve(storage, registry, query, ctx = {}, now = Date.now()) {
  const items = new KnowledgeItems(storage);
  const q = tokens(query);
  const domain = classify(query);
  const scored = [];
  for (const it of items.all()) {
    if (!inScope(it, ctx)) continue;
    const m = overlap(q, tokens(`${it.title} ${it.body} ${(it.steps || []).join(' ')}`));
    if (!m) continue;
    const stale = isStale(it, now);
    const score = m * (0.5 + it.confidence) * (stale ? 0.6 : 1) * (it.domain === domain ? 1.2 : 1) * (it.conflicts.length ? 0.8 : 1);
    scored.push({ item: it, score, stale });
  }
  scored.sort((a, b) => b.score - a.score);
  const pick = (layer, kind) => scored.filter((s) => s.item.layer === layer && (!kind || s.item.kind === kind)).slice(0, 6);
  const caps = Object.values(registry?.capabilities || {}).map((c) => serving(registry, c.capability_id)).filter(Boolean)
    .map((c) => ({ cap: c, score: overlap(q, tokens(`${c.name} ${c.description} ${c.category}`)) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const experience = pick('experience');
  return {
    query: clip(query, 200), domain,
    facts: pick('indexed', 'fact'), concepts: pick('indexed', 'concept'), procedures: pick('procedure'),
    capabilities: caps.slice(0, 6), project: pick('project'),
    outcomes: experience.filter((s) => s.item.status === 'verified'), failures: experience.filter((s) => s.item.status === 'failed'),
    conflicts: scored.filter((s) => s.item.conflicts.length).slice(0, 4),
    stale: scored.filter((s) => s.stale).slice(0, 4),
    sufficient: scored.length > 0 || caps.length > 0,
  };
}

// ─── Internal tools: pure primitives, sandboxed interpreter ─────────────────

const PRIM = {
  lines: (x) => String(x).split(/\r?\n/),
  trim: (x) => (Array.isArray(x) ? x.map((s) => (Array.isArray(s) ? s.map((v) => String(v).trim()) : String(s).trim())) : String(x).trim()),
  drop_empty: (x) => x.filter((s) => (Array.isArray(s) ? s.some((v) => String(v).length) : String(s).length)),
  split: (x, sep = ',') => x.map((s) => String(s).split(sep)),
  header_objects: (rows) => { const [head, ...rest] = rows; return rest.map((r) => Object.fromEntries(head.map((h, i) => [String(h).trim(), r[i] ?? '']))); },
  numbers: (objs) => objs.map((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, /^-?\d+(?:\.\d+)?$/.test(String(v).trim()) ? Number(v) : v]))),
  words: (x) => String(x).split(/\s+/).filter(Boolean),
  count: (x) => x.length,
  chunk: (x, n = 7) => { const out = []; for (let i = 0; i < x.length; i += Number(n)) out.push(x.slice(i, i + Number(n))); return out; },
  timings: (chunks, wps = 2.5) => { let t = 0; return chunks.map((c) => { const d = Math.max(1, c.length / Number(wps)); const cue = { start: Math.round(t * 100) / 100, end: Math.round((t + d) * 100) / 100, text: c.join(' ') }; t += d; return cue; }); },
  join: (x, sep = ' ') => x.join(sep),
  lower: (x) => String(x).toLowerCase(),
  upper: (x) => String(x).toUpperCase(),
  unique: (x) => [...new Set(x)],
  sort: (x) => [...x].sort(),
  json: (x) => JSON.stringify(x),
};
export const PRIMITIVES = Object.freeze(Object.keys(PRIM));

// Step phrases → primitives. Deterministic; a step that maps to nothing makes the procedure not implementable
// internally (feasibility = needs a reviewed code change), never a guessed program.
const STEP_RULES = [
  [/\bsplit (?:the )?(?:text|input) into lines\b|\beach line\b(?!.*comma)|\bread (?:the )?lines\b/i, () => [['lines'], ['trim'], ['drop_empty']]],
  [/\bsplit (?:each )?(?:line|row) (?:by|on|at) (?:a |the )?comma/i, () => [['split', ',']]],
  [/\bsplit (?:each )?(?:line|row) (?:by|on|at) (?:a |the )?(?:semicolon)/i, () => [['split', ';']]],
  [/\b(?:trim|strip) (?:each )?(?:field|value|cell)s?\b/i, () => [['trim']]],
  [/\b(?:the )?first (?:row|line) (?:is|holds|gives) the (?:header|column names)\b|\buse the header\b/i, () => [['header_objects']]],
  [/\bconvert (?:numeric|number) (?:values|fields)\b|\bnumbers? (?:become|as) numbers?\b/i, () => [['numbers']]],
  [/\b(?:output|return|write) (?:it |them )?as json\b|\bserialize (?:to|as) json\b/i, () => [['json']]],
  [/\bsplit (?:the )?(?:text|transcript) into words\b/i, () => [['words']]],
  [/\bcount (?:the )?(?:words|items|lines)\b/i, () => [['count']]],
  [/\bgroup (?:the )?words into (?:chunks|groups) of (\d+)\b/i, (m) => [['chunk', Number(m[1])]]],
  [/\b(?:time|assign timing to) each (?:chunk|group|caption) at (\d+(?:\.\d+)?) words per second\b/i, (m) => [['timings', Number(m[1])]]],
  [/\blower ?case\b/i, () => [['lower']]],
  [/\bupper ?case\b/i, () => [['upper']]],
  [/\bremove duplicates?\b/i, () => [['unique']]],
  [/\bsort (?:them|the items|alphabetically)\b/i, () => [['sort']]],
];

/** A program from a procedure's steps, or the steps that could not be implemented internally. */
export function deriveProgram(steps = []) {
  const program = [];
  const unmapped = [];
  for (const s of steps) {
    const rule = STEP_RULES.find(([re]) => re.test(s));
    if (!rule) { unmapped.push(s); continue; }
    program.push(...rule[1](rule[0].exec(s)));
  }
  return { program, unmapped, feasible: program.length > 0 && unmapped.length === 0 };
}

/**
 * Sandbox: runs a program over the pure primitives only. No storage, network, credentials or code evaluation is
 * reachable from here; steps, input/output size and time are bounded, and every failure is returned, not thrown.
 */
export function runTool(program, input, { maxSteps = 40, maxBytes = 200_000, timeoutMs = 250 } = {}) {
  const started = Date.now();
  if (!Array.isArray(program) || !program.length) return { ok: false, error: 'empty program' };
  if (program.length > maxSteps) return { ok: false, error: 'too many steps' };
  if (String(typeof input === 'string' ? input : JSON.stringify(input)).length > maxBytes) return { ok: false, error: 'input too large' };
  let value = input;
  try {
    for (const [name, ...args] of program) {
      if (!Object.hasOwn(PRIM, name)) return { ok: false, error: `unknown primitive ${String(name).slice(0, 40)}` };
      value = PRIM[name](value, ...args);
      if (Date.now() - started > timeoutMs) return { ok: false, error: 'timed out' };
      if (JSON.stringify(value ?? null).length > maxBytes) return { ok: false, error: 'output too large' };
    }
  } catch (err) {
    return { ok: false, error: `failed: ${String(err?.message || err).slice(0, 120)}` };
  }
  return { ok: true, output: value, ms: Date.now() - started };
}

const normalizeOut = (v) => (typeof v === 'string' ? v.replace(/\s+/g, '') : JSON.stringify(v).replace(/\s+/g, ''));

async function loadTools(storage) { try { return (await storage.get(TOOLS_KEY)) || {}; } catch (_) { return {}; } }

// ─── Capability acquisition loop (knowledge → skill → tool → verified capability) ─

export function capabilityIdFor(operation) {
  return `tool.${keyOf(operation).replace(/\s+/g, '_').slice(0, 60) || 'unnamed'}`;
}

/**
 * CAPABILITY ACQUISITION LOOP: goal → existing capability (reuse) → internal knowledge → feasibility → candidate
 * internal tool → sandbox → functional, security, resource, license, output, regression and rollback checks →
 * promote or reject. A procedure is never reported as a capability unless it was promoted here.
 */
export async function acquire(storage, operation, { now = new Date().toISOString(), ctx = {}, sample = null, rebuild = false, procedure = null } = {}) {
  const registry = await loadRegistry(storage);
  const id = capabilityIdFor(operation);
  const existing = serving(registry, id);
  // An improvement (rebuild) is a new candidate version; the verified one keeps serving until the candidate passes.
  if (existing && !rebuild) return { ok: true, reused: true, capability: existing, said: `I already have a verified internal tool for that: ${existing.name}, version ${existing.version}.` };
  const knowledge = retrieve(storage, registry, operation, ctx);
  // An explicit procedure (an improvement from a newer source) is used as given; otherwise the best-ranked one.
  const proc = (procedure && new KnowledgeItems(storage).get(procedure)) || knowledge.procedures[0]?.item;
  if (!proc) {
    return { ok: false, stage: 'knowledge', gap: true, said: `I have no indexed procedure for "${clip(operation, 80)}" yet, so I have not built anything. Give me permitted documentation or steps and I will learn it, build it and test it.` };
  }
  const derived = deriveProgram(proc.steps);
  if (!derived.feasible) {
    return { ok: false, stage: 'feasibility', needs_code_change: true, procedure: proc.id, unmapped: derived.unmapped,
      said: `I know the procedure "${proc.title}", but these steps need new code before I can do them myself: ${derived.unmapped.slice(0, 3).join('; ')}. That is a reviewed code change, not something I can claim now.` };
  }
  const examples = (proc.applicability?.examples || []).filter((e) => e.input && e.output);
  const cap = register(registry, {
    id, name: proc.title.replace(/^\w/, (c) => c.toUpperCase()), description: `Internal tool derived from "${proc.title}" (${proc.provenance?.title || 'indexed procedure'}).`,
    category: 'internal_tool', inputs: proc.applicability?.inputs || [], outputs: proc.applicability?.outputs || [],
    implementation_location: 'capability_engine.js runTool (pure primitives)', execution: EXECUTION.INTERNAL,
    required_runtime: 'cloudflare-worker', required_compute: 'worker-cpu', risk_level: 'low', approval_policy: 'none',
    license_profile: `derived from ${proc.provenance?.license || 'unknown'} text; original CHE implementation`,
    known_limitations: [...(proc.applicability?.limitations || []), 'Runs only the steps CHE can implement with her built-in primitives.'],
    related_knowledge: [proc.id, ...(proc.links || []).slice(0, 10)], related_loops: ['capability_acquisition', 'knowledge_to_tool'],
  }, now);
  const tools = await loadTools(storage);
  // The baseline is the version that serves now (after a rollback that is the older one), never a rolled-back tool.
  const prevTool = toolForVersion(tools[id], existing?.version) || null;
  // Functional: every example from the knowledge must reproduce exactly.
  const results = examples.map((e) => ({ e, r: runTool(derived.program, e.input) }));
  const functional = results.length > 0 && results.every(({ e, r }) => r.ok && normalizeOut(r.output) === normalizeOut(e.output));
  recordCheck(registry, id, 'functional', { ok: functional, evidence: results.length ? `${results.filter(({ e, r }) => r.ok && normalizeOut(r.output) === normalizeOut(e.output)).length}/${results.length} examples reproduced` : 'no worked example in the knowledge to test against' });
  recordCheck(registry, id, 'security', { ok: derived.program.every(([n]) => PRIMITIVES.includes(n)), evidence: 'pure primitives only; no network, storage or credential access; no code evaluation' });
  const slowest = Math.max(0, ...results.map(({ r }) => r.ms || 0));
  recordCheck(registry, id, 'resource', { ok: derived.program.length <= 40 && slowest < 250, evidence: `${derived.program.length} steps, slowest run ${slowest} ms` });
  recordCheck(registry, id, 'license', { ok: textAllowed(proc.provenance?.license || ''), evidence: `source licence ${proc.provenance?.license || 'unknown'}` });
  const real = sample != null ? runTool(derived.program, sample) : results[0]?.r;
  recordCheck(registry, id, 'output', { ok: Boolean(real?.ok && real.output != null && normalizeOut(real.output).length > 0), evidence: real?.ok ? `real output ${normalizeOut(real.output).slice(0, 80)}` : `no output: ${real?.error || 'not run'}` });
  const regress = (prevTool?.examples || []).map((e) => runTool(derived.program, e.input)).every((r, i) => r.ok && normalizeOut(r.output) === normalizeOut(prevTool.examples[i].output));
  recordCheck(registry, id, 'regression', { ok: regress, evidence: prevTool ? `${prevTool.examples.length} earlier examples re-run` : 'first version; nothing earlier to regress' });
  recordCheck(registry, id, 'rollback', { ok: true, evidence: prevTool ? `version ${prevTool.version} kept for rollback` : 'first version: rollback = turn the tool off' });
  const promoted = promote(registry, id, now);
  const items = new KnowledgeItems(storage);
  if (promoted.ok) {
    tools[id] = { version: promoted.cap.version, program: derived.program, examples, previous: prevTool ? { version: prevTool.version, program: prevTool.program, examples: prevTool.examples } : null, procedure: proc.id };
    await storage.put(TOOLS_KEY, tools);
    proc.status = 'implemented';
    proc.freshness = { ...proc.freshness, last_tested: now };
    items.put(proc);
  }
  await saveRegistry(storage, registry);
  await storage.put(LAST_USED_KEY, { at: now, what: `acquire ${operation}`, items: [proc.id], sources: [proc.provenance] });
  if (!promoted.ok) {
    const failed = promoted.failed || promoted.missing || [];
    return { ok: false, stage: 'verification', rejected: true, capability: registry.capabilities[id], failed,
      said: `I built a candidate for "${proc.title}", but it failed ${failed.join(', ')}, so it is rejected and I cannot claim it. ${(registry.capabilities[id].checks[failed[0]] || {}).evidence || ''}`.trim() };
  }
  return { ok: true, capability: promoted.cap, output: real?.output,
    said: `Built and verified an internal tool: ${promoted.cap.name}. It passed ${PROMOTION_CHECKS.length} checks, runs inside CHE with no external service or key, and I will reuse it.` };
}

/** Uses a verified internal tool. Internal-only and approval policy are enforced; the result is recorded as experience. */
export async function useTool(storage, id, input, { now = new Date().toISOString(), policy = null } = {}) {
  const registry = await loadRegistry(storage);
  const cap = serving(registry, id);
  if (!cap) return { ok: false, said: 'I do not have a verified tool for that, so I did not pretend to run one.' };
  const allowed = executionAllowed(cap, policy || await loadPolicy(storage));
  if (!allowed.ok) return { ok: false, said: `I did not run it: ${allowed.reason}.` };
  const tools = await loadTools(storage);
  const tool = toolForVersion(tools[id], cap.version);
  if (!tool) return { ok: false, said: 'The verified version of that tool is missing, so nothing ran.' };
  const r = runTool(tool.program, input);
  recordUse(registry, id, r.ok, now);
  await saveRegistry(storage, registry);
  const items = new KnowledgeItems(storage);
  if (items.init()) {
    items.put({ id: crypto.randomUUID(), key: keyOf(`experience ${id} ${now}`), layer: 'experience', kind: 'tool_run', title: `${cap.name} ${r.ok ? 'worked' : 'failed'}`, body: r.ok ? `Ran ${cap.name} v${cap.version} successfully.` : `Failed: ${r.error}`, domain: 'tools', scope: 'owner-global', project_id: '', provenance: { capability: id }, confidence: 1, applicability: {}, status: r.ok ? 'verified' : 'failed', version: 1, conflicts: [], links: [], freshness: { last_used: now }, steps: [], created: now, updated: now });
  }
  await storage.put(LAST_USED_KEY, { at: now, what: `use ${id}`, items: [tool.procedure], capability: id });
  return { ok: r.ok, output: r.output, said: r.ok ? `Done with ${cap.name} (internal, version ${cap.version}).` : `${cap.name} failed: ${r.error}.` };
}

export async function rollbackTool(storage, id, now = new Date().toISOString()) {
  const registry = await loadRegistry(storage);
  const out = rollback(registry, id, now);
  if (out.ok) {
    await saveRegistry(storage, registry);
    // The stored program follows the registry: the serving version becomes the current tool.
    const tools = await loadTools(storage);
    const back = toolForVersion(tools[id], out.cap.version);
    if (back) { tools[id] = { ...back, previous: null }; await storage.put(TOOLS_KEY, tools); }
  }
  return out;
}

/** The stored program for one version of a tool (current or its kept previous), or null. */
function toolForVersion(entry, version) {
  if (!entry || version == null) return null;
  if (entry.version === version) return entry;
  return entry.previous?.version === version ? entry.previous : null;
}

// ─── Project no-export (enforced by Security Intelligence's single egress guard, holdEgress) ───────────────

/** Does this request carry a project the owner said must not leave CHE? */
export function projectBlocked(policy, projectId) {
  const list = policy?.no_export_projects || [];
  return Boolean(projectId) && (list.includes('*') || list.includes(String(projectId)));
}

// ─── External dependency decision loop ──────────────────────────────────────

/**
 * Picks where a need is met: a verified capability, best tier first (internal → local → owner compute → approved free
 * → approved paid). Internal-only and no-paid are enforced here; anything blocked is said plainly, never faked.
 */
export function decideExecution(registry, need, policy = defaultPolicy()) {
  const q = tokens(need);
  const candidates = Object.values(registry.capabilities || {}).map((c) => serving(registry, c.capability_id)).filter(Boolean)
    .filter((c) => overlap(q, tokens(`${c.name} ${c.description} ${c.category}`)) > 0)
    .sort((a, b) => EXECUTION_ORDER.indexOf(a.execution) - EXECUTION_ORDER.indexOf(b.execution));
  const blocked = [];
  for (const c of candidates) {
    const ok = executionAllowed(c, policy);
    if (ok.ok) return { ok: true, capability: c, tier: c.execution, blocked };
    blocked.push({ id: c.capability_id, reason: ok.reason, needs_approval: ok.needs_approval === true });
  }
  return {
    ok: false, blocked,
    said: candidates.length
      ? `I have no allowed way to do that right now: ${blocked.map((b) => b.reason).join('; ')}.${blocked.some((b) => b.needs_approval) ? ' Say "approve" for that service if you want it used.' : ''}`
      : 'I have no verified capability for that yet. I can try to build one internally from what I know.',
  };
}

// ─── Project knowledge loop ─────────────────────────────────────────────────

/** A project's working context: its own knowledge plus what is globally allowed, never another project's. */
export function projectContext(storage, registry, project = {}) {
  return retrieve(storage, registry, `${project.title || ''} ${project.goal || ''} ${project.domain || ''}`, { project_id: project.id });
}

/**
 * A verified project result becomes reusable knowledge per the owner's memory policy: the method always, files and
 * private details only when allowed. Unverified results are never stored as knowledge.
 */
export function learnFromOutcome(storage, outcome = {}, { policy = defaultPolicy(), now = new Date().toISOString() } = {}) {
  if (outcome.verified !== true) return { ok: false, said: 'That result is not verified, so it was not stored as knowledge.' };
  const items = new KnowledgeItems(storage);
  if (!items.init()) return { ok: false, said: 'Knowledge storage is not available.' };
  const files = policy.memory.method_only ? [] : (outcome.files || []).slice(0, 10);
  const scope = outcome.client_id && policy.memory.private_clients ? 'client-only' : outcome.reusable === false || policy.memory.project_scope_default ? 'project-only' : 'owner-global';
  const item = {
    id: crypto.randomUUID(), key: keyOf(`project ${outcome.method}`), layer: scope === 'owner-global' ? 'experience' : 'project', kind: 'method',
    title: clip(outcome.title || 'Verified method', 200), body: clip(`${outcome.method}${files.length ? `\nFiles: ${files.join(', ')}` : ''}`, 2000),
    domain: outcome.domain || classify(outcome.method), scope, project_id: scope === 'owner-global' ? '' : String(outcome.client_id || outcome.project_id || ''),
    provenance: { project_id: outcome.project_id || '', verified_by: clip(outcome.verified_by || 'project verification', 120) }, confidence: 0.9,
    applicability: { domain: outcome.domain || '' }, status: 'verified', version: 1, conflicts: [], links: [],
    freshness: { last_tested: now, last_used: now }, steps: [], created: now, updated: now,
  };
  items.put(item);
  connect(items, [item.id]);
  return { ok: true, item, said: `Saved the verified method${scope === 'owner-global' ? ' for every future project' : ' inside this project only'}${policy.memory.method_only ? ', without the files' : ''}.` };
}

// ─── Speech ─────────────────────────────────────────────────────────────────

export function capabilityIntent(message = '') {
  const t = String(message || '').trim().toLowerCase().replace(/[’]/g, "'").replace(/^(?:hey\s+)?(?:che|chay|chey)[,\s]+/, '').replace(/[?.!]+$/, '');
  let m;
  if (/^what can you actually do$|^what are your verified capabilities$|^what can you really do$/.test(t)) return { action: 'capabilities' };
  if ((m = /^what (?:did|have) you learn(?:ed)? about (.{2,120})$/.exec(t))) return { action: 'learned', topic: m[1] };
  if (/^which knowledge (?:informed|did you use for) (?:that|this)$|^what knowledge did you use$/.test(t)) return { action: 'informed' };
  if ((m = /^(?:build|create|make) (?:yourself )?(?:an? )?internal tool (?:to|that can|for) (.{3,120})$|^learn (?:how )?to (.{3,120}?) (?:internally|yourself)$/.exec(t))) return { action: 'acquire', operation: m[1] || m[2] };
  const p = policyIntent(message);
  if (p) return { action: 'policy', policy: p };
  return null;
}

export function speakCapabilities(registry) {
  const usable = Object.values(registry.capabilities || {}).map((c) => serving(registry, c.capability_id)).filter(Boolean);
  if (!usable.length) return 'I have no verified internal capabilities registered yet. Anything I can only describe is not something I claim to do.';
  const where = { internal: 'inside CHE', local: 'on your device', owner_compute: 'on compute you control', external_free: 'on an approved free service', external_paid: 'on an approved paid service' };
  return `I can actually do ${usable.length} verified thing${usable.length === 1 ? '' : 's'}: ${usable.slice(0, 8).map((c, i) => `${i + 1}. ${c.name}, ${where[c.execution]}, ${c.runs ? `${c.successes} of ${c.runs} runs worked` : 'verified, not used yet'}`).join('; ')}.`;
}

/** Indexed vs procedure vs verified capability, said separately: knowing is not doing. */
export function speakLearned(k) {
  const parts = [];
  const sources = new Set([...k.facts, ...k.concepts, ...k.procedures].map((s) => s.item.provenance?.title).filter(Boolean));
  if (k.facts.length || k.concepts.length) parts.push(`Indexed: ${k.facts.length} facts and ${k.concepts.length} concepts from ${[...sources].slice(0, 3).join(', ') || 'my library'}.`);
  if (k.procedures.length) parts.push(`Procedures I can retrieve: ${k.procedures.slice(0, 3).map((p) => p.item.title).join('; ')}.`);
  if (k.capabilities.length) parts.push(`Verified capabilities: ${k.capabilities.slice(0, 3).map((c) => c.cap.name).join('; ')}.`);
  else if (k.procedures.length) parts.push('None of that is a verified capability yet: I know the steps, but I have not built and tested a tool for them.');
  if (k.conflicts.length) parts.push(`${k.conflicts.length} item${k.conflicts.length === 1 ? '' : 's'} conflict with other sources; both versions are kept.`);
  if (k.stale.length) parts.push(`${k.stale.length} may be outdated.`);
  return parts.length ? parts.join(' ') : `I have nothing indexed about ${k.query} yet.`;
}

export async function engineSummary(storage) {
  const registry = await loadRegistry(storage);
  const items = new KnowledgeItems(storage);
  const all = items.all();
  const caps = Object.values(registry.capabilities).map((c) => ({
    id: c.capability_id, name: c.name, status: c.status, execution: c.execution, version: c.version, runs: c.runs, successes: c.successes,
    last_verified: c.last_verified, limitations: c.known_limitations, checks: Object.fromEntries(Object.entries(c.checks || {}).map(([k, v]) => [k, v.ok])),
    serving_version: serving(registry, c.capability_id)?.version || null,
  }));
  let last = null;
  try { last = await storage.get(LAST_USED_KEY); } catch (_) { last = null; }
  return {
    policy: await loadPolicy(storage),
    capabilities: caps,
    knowledge: Object.fromEntries(LAYERS.map((l) => [l, all.filter((i) => i.layer === l).length])),
    conflicts: all.filter((i) => i.conflicts.length).length,
    stale: all.filter((i) => isStale(i)).length,
    external_dependencies: caps.filter((c) => ['external_free', 'external_paid'].includes(c.execution)),
    knowledge_used: last,
  };
}

export { USABLE };
