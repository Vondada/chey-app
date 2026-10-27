// Security Core: the knowledge engine and its promotion pipeline. What one deployment learns privately can become
// shared security knowledge only after it is generalized, stripped of identifiers, reviewed and tested:
//   PRIVATE → GENERALIZED → DEIDENTIFIED → REVIEWED → TESTED → PROMOTED   (or REJECTED at any gate)
// CUSTOMER_PRIVATE and RESTRICTED items never leave their tenant; CHE_ONLY items stay in the host product.
import { clip, shortId } from './config.js';
import { tenantState } from './events.js';
import { scanSecrets, redact } from './secrets.js';

export const PORTABILITY = Object.freeze(['CHE_ONLY', 'SHARED_SECURITY', 'PRODUCT_GENERAL', 'CUSTOMER_PRIVATE', 'RESTRICTED']);
export const PROMOTABLE = new Set(['SHARED_SECURITY', 'PRODUCT_GENERAL']);
export const PIPELINE = Object.freeze(['PRIVATE', 'GENERALIZED', 'DEIDENTIFIED', 'REVIEWED', 'TESTED', 'PROMOTED']);

// Identifiers removed before anything is shared: e-mail addresses, IP addresses, host names, UUIDs, long hex ids,
// phone numbers and file paths under a home directory. Callers add names they know (device, account, repository).
const IDENTIFIER_PATTERNS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[uuid]'],
  [/\b[0-9a-f]{16,}\b/gi, '[id]'],
  [/\+?\d[\d\s().-]{8,}\d/g, '[phone]'],
  [/(?:\/Users|\/home|C:\\Users)[\\/][^\s/\\]+/g, '[home]'],
  [/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|ai|co|cloud|workers\.dev)\b/gi, '[host]'],
];

function stripText(text, extra = []) {
  let out = redact(String(text ?? '')).text;
  for (const [re, label] of IDENTIFIER_PATTERNS) out = out.replace(re, label);
  for (const name of extra) if (name && String(name).length >= 3) out = out.split(String(name)).join('[name]');
  return out;
}

function remainingIdentifiers(text, extra = []) {
  const hits = [];
  if (scanSecrets(text).length) hits.push('secret');
  for (const [re, label] of IDENTIFIER_PATTERNS) { re.lastIndex = 0; if (re.test(text)) hits.push(label); re.lastIndex = 0; }
  for (const name of extra) if (name && String(name).length >= 3 && String(text).includes(String(name))) hits.push('[name]');
  return hits;
}

function stage(item, to, note, now) {
  item.stage = to;
  item.history.push({ stage: to, at: now, note: clip(note, 200) });
  return { ok: true, item };
}

function reject(item, reason, now) {
  item.stage = 'REJECTED';
  item.history.push({ stage: 'REJECTED', at: now, note: reason });
  return { ok: false, reason, item };
}

/** Private experience from one tenant: what happened and how it was handled. Stored redacted. */
export function captureExperience(store, tenant_id, { title, body, portability = 'CUSTOMER_PRIVATE', category = 'security.knowledge', source_event_ids = [] } = {}, now = new Date().toISOString()) {
  const item = {
    knowledge_id: shortId('kn_'),
    tenant_id,
    title: clip(redact(String(title || '')).text, 160),
    body: clip(redact(String(body || '')).text, 2000),
    portability: PORTABILITY.includes(portability) ? portability : 'CUSTOMER_PRIVATE',
    category: clip(category, 60),
    source_event_ids: [].concat(source_event_ids).slice(0, 20),
    stage: 'PRIVATE',
    history: [{ stage: 'PRIVATE', at: now, note: 'captured' }],
    rule: null,
  };
  tenantState(store, tenant_id).knowledge.unshift(item);
  return item;
}

const gate = (item, want) => item && item.stage === want;

/** Turns a specific case into a reusable pattern: a title, a lesson, and optionally a detection rule. */
export function generalize(item, { title, lesson, rule = null } = {}, now = new Date().toISOString()) {
  if (!gate(item, 'PRIVATE')) return { ok: false, reason: 'wrong_stage' };
  if (!PROMOTABLE.has(item.portability)) return reject(item, `${item.portability} knowledge never leaves its scope`, now);
  if (!String(lesson || '').trim()) return { ok: false, reason: 'lesson_required' };
  item.general = { title: clip(title || item.title, 160), lesson: clip(lesson, 1000) };
  if (rule && typeof rule === 'object') item.rule = { event_type: clip(rule.event_type, 60), min_severity: clip(rule.min_severity || 'info', 10), contains: clip(rule.contains || '', 80) };
  return stage(item, 'GENERALIZED', 'generalized into a reusable lesson', now);
}

/** Removes identifiers (and any secret) from the generalized text; the private original is dropped from the record. */
export function stripIdentifiers(item, { identifiers = [] } = {}, now = new Date().toISOString()) {
  if (!gate(item, 'GENERALIZED')) return { ok: false, reason: 'wrong_stage' };
  item.general = { title: stripText(item.general.title, identifiers), lesson: stripText(item.general.lesson, identifiers) };
  if (item.rule) item.rule.contains = stripText(item.rule.contains, identifiers);
  item.identifiers_checked = identifiers.length;
  item.body = '';
  item.source_event_ids = [];
  item._identifiers = identifiers.map((s) => String(s));
  return stage(item, 'DEIDENTIFIED', 'identifiers removed', now);
}

/** Security and privacy review: no secret, no identifier, a promotable scope. */
export function reviewKnowledge(item, now = new Date().toISOString()) {
  if (!gate(item, 'DEIDENTIFIED')) return { ok: false, reason: 'wrong_stage' };
  const text = `${item.general.title}\n${item.general.lesson}\n${item.rule?.contains || ''}`;
  const left = remainingIdentifiers(text, item._identifiers || []);
  if (left.length) return reject(item, `review found ${[...new Set(left)].join(', ')} still present`, now);
  if (!PROMOTABLE.has(item.portability)) return reject(item, `${item.portability} cannot be shared`, now);
  return stage(item, 'REVIEWED', 'security and privacy review passed', now);
}

export function ruleMatches(rule, event) {
  if (!rule || !event) return false;
  const sev = ['info', 'low', 'medium', 'high', 'critical'];
  return (!rule.event_type || event.event_type === rule.event_type)
    && sev.indexOf(event.severity) >= sev.indexOf(rule.min_severity || 'info')
    && (!rule.contains || `${event.summary || ''} ${event.affected_resource || ''}`.toLowerCase().includes(rule.contains.toLowerCase()));
}

/** A rule must catch every positive sample and none of the negatives; a lesson without a rule needs one reviewer note. */
export function testKnowledge(item, { positives = [], negatives = [], reviewer_note = '' } = {}, now = new Date().toISOString()) {
  if (!gate(item, 'REVIEWED')) return { ok: false, reason: 'wrong_stage' };
  if (item.rule) {
    if (!positives.length || !negatives.length) return { ok: false, reason: 'samples_required' };
    const missed = positives.filter((e) => !ruleMatches(item.rule, e)).length;
    const false_hits = negatives.filter((e) => ruleMatches(item.rule, e)).length;
    item.test = { positives: positives.length, negatives: negatives.length, missed, false_hits };
    if (missed || false_hits) return reject(item, `rule test failed: ${missed} missed, ${false_hits} false hit(s)`, now);
  } else {
    if (!String(reviewer_note).trim()) return { ok: false, reason: 'reviewer_note_required' };
    item.test = { reviewer_note: clip(reviewer_note, 300) };
  }
  return stage(item, 'TESTED', 'tested', now);
}

/** Copies the tested, de-identified lesson into the shared library. The tenant id does not travel with it. */
export function promoteKnowledge(store, item, now = new Date().toISOString()) {
  if (!gate(item, 'TESTED')) return { ok: false, reason: 'wrong_stage' };
  if (!PROMOTABLE.has(item.portability)) return reject(item, `${item.portability} never promotes`, now);
  store.shared ||= [];
  const shared = { knowledge_id: item.knowledge_id, title: item.general.title, lesson: item.general.lesson, rule: item.rule, portability: item.portability, category: item.category, promoted_at: now, test: item.test };
  store.shared = [shared, ...store.shared.filter((s) => s.knowledge_id !== item.knowledge_id)].slice(0, 500);
  delete item._identifiers;
  stage(item, 'PROMOTED', 'promoted to the shared security engine', now);
  return { ok: true, item, shared };
}

export function sharedKnowledge(store) { return store.shared || []; }
