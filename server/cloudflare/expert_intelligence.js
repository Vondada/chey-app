// CHE Expert Intelligence (owner, 2026-10-22): one shared layer that lets CHE work at a professional level in a
// field, or build grounded capability in one, without new rooms. It sits on what exists:
//   - the Knowledge Library (knowledge_library.js) holds the sources; this module adds expert metadata per reference
//     (domain, specialty, source type, authority tier, jurisdiction, version) in one small table, kl_expert;
//   - Office specialties (office_workforce.js) are the specialists CHE delegates to;
//   - Legal Intelligence (legal_intelligence.js) is the Law domain's engine;
//   - cases (appointments, records, deadlines, professional notes) are kept per compartment for briefs.
//
// Expertise is evidenced, never declared: a domain's level is what CHE has indexed, which tests it passes and what
// it is missing. CHE is not a physician, attorney, CPA or engineer, and never says otherwise; she prepares the owner
// so the professional's time goes to judgement.

import { KnowledgeLibrary, registerCategories } from './knowledge_library.js';
import { LEGAL_INDEX, legalAnswer, statusOn, STATUS } from './legal_intelligence.js';

const DAY = 86_400_000;
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// ─── Source quality ───────────────────────────────────────────────────────

/// Higher tiers outrank lower ones. A video, article or forum supplements; it never silently outranks evidence.
export const SOURCE_TIERS = Object.freeze([
  { tier: 1, type: 'primary_law', name: 'Primary law / regulation' },
  { tier: 2, type: 'government_guidance', name: 'Official government guidance' },
  { tier: 3, type: 'professional_standard', name: 'Professional standards' },
  { tier: 4, type: 'clinical_guideline', name: 'Clinical / professional guidelines' },
  { tier: 5, type: 'peer_reviewed', name: 'Peer-reviewed research' },
  { tier: 6, type: 'textbook', name: 'Respected textbooks' },
  { tier: 7, type: 'course_material', name: 'Accredited university / course material' },
  { tier: 8, type: 'technical_docs', name: 'Official technical documentation' },
  { tier: 9, type: 'professional_association', name: 'Professional associations' },
  { tier: 10, type: 'specialist_publication', name: 'Reputable specialist publications' },
  { tier: 11, type: 'video', name: 'Educational video (supplementary)' },
  { tier: 12, type: 'article', name: 'General article or community source (supplementary)' },
]);
const TIER_BY_TYPE = new Map(SOURCE_TIERS.map((t) => [t.type, t.tier]));
export const tierOf = (type) => TIER_BY_TYPE.get(type) || 12;

// ─── Domains ──────────────────────────────────────────────────────────────

/// Each domain: its Office specialist, its study map, how fresh its high-stakes claims must be, the source types it
/// relies on, and the official live sources CHE can read. `engine` names a module that answers it directly.
export const DOMAINS = Object.freeze({
  law: {
    name: 'Law', office: 'legal', engine: 'legal_intelligence', stakes: 'high',
    freshness: { days: 0, rule: 'Verify current law against the official source before a high-confidence answer.' },
    sources: ['primary_law', 'government_guidance', 'professional_association', 'specialist_publication'],
    curriculum: ['constitutional law', 'contracts', 'torts', 'property', 'civil procedure', 'criminal law', 'criminal procedure', 'evidence', 'administrative law', 'business organizations', 'intellectual property', 'employment', 'tax', 'family law', 'trusts and estates', 'consumer law', 'real estate', 'bankruptcy', 'international law', 'privacy and data law', 'entertainment and music law', 'professional responsibility', 'legal research and writing'],
  },
  health: {
    name: 'Medicine / Health', office: 'health', stakes: 'high',
    freshness: { days: 365, rule: 'Verify current clinical guidelines, drug label warnings and important new evidence.' },
    sources: ['clinical_guideline', 'government_guidance', 'peer_reviewed', 'textbook'],
    curriculum: ['anatomy', 'physiology', 'pathology', 'pharmacology', 'internal medicine', 'family medicine', 'emergency medicine', 'neurology', 'cardiology', 'pulmonology', 'gastroenterology', 'endocrinology', 'infectious disease', 'hematology', 'oncology', 'orthopedics', 'rehabilitation', 'ophthalmology', 'psychiatry', 'dermatology', 'surgery concepts', 'radiology concepts', 'laboratory medicine', 'pain medicine', 'preventive medicine', 'nutrition', 'public health'],
  },
  finance: {
    name: 'Finance and Investing', office: 'finance', stakes: 'high',
    freshness: { days: 30, rule: 'Verify current rules, rates and filings; never use remembered account data.' },
    sources: ['primary_law', 'government_guidance', 'professional_standard', 'peer_reviewed', 'textbook'],
    curriculum: ['personal finance', 'corporate finance', 'financial statements', 'valuation', 'portfolio theory', 'risk management', 'derivatives', 'market structure', 'securities regulation', 'banking', 'credit', 'retirement accounts'],
  },
  accounting_tax: {
    name: 'Accounting and Taxes', office: 'finance', stakes: 'high',
    freshness: { days: 30, rule: 'Verify the current tax year\'s rules, rates and forms with the tax authority.' },
    sources: ['primary_law', 'government_guidance', 'professional_standard', 'textbook'],
    curriculum: ['bookkeeping', 'GAAP', 'financial reporting', 'auditing', 'individual income tax', 'business income tax', 'sales and use tax', 'payroll tax', 'self-employment tax', 'deductions and credits', 'entity selection', 'state and local tax'],
  },
  business: {
    name: 'Business', office: 'analysis', stakes: 'medium',
    freshness: { days: 90, rule: 'Verify licensing, filing and platform rules for the jurisdiction.' },
    sources: ['government_guidance', 'textbook', 'professional_association', 'specialist_publication'],
    curriculum: ['strategy', 'operations', 'marketing', 'sales', 'pricing', 'contracts', 'hiring', 'licensing and permits', 'funding', 'customer service'],
  },
  engineering: {
    name: 'Engineering', office: 'engineering', stakes: 'high',
    freshness: { days: 365, rule: 'Use the current edition of the governing standard or code.' },
    sources: ['professional_standard', 'technical_docs', 'textbook', 'peer_reviewed'],
    curriculum: ['statics', 'dynamics', 'materials', 'thermodynamics', 'fluids', 'circuits', 'controls', 'structures', 'codes and standards', 'safety factors'],
  },
  software: {
    name: 'Software', office: 'coding', stakes: 'medium',
    freshness: { days: 30, rule: 'Verify against the documentation for the version in use.' },
    sources: ['technical_docs', 'professional_standard', 'textbook'],
    curriculum: ['algorithms', 'data structures', 'architecture', 'testing', 'security', 'databases', 'networking', 'cloud', 'mobile', 'performance'],
  },
  cybersecurity: {
    name: 'Cybersecurity', office: 'review', stakes: 'high',
    freshness: { days: 7, rule: 'Verify current advisories and standard versions.' },
    sources: ['professional_standard', 'government_guidance', 'technical_docs'],
    curriculum: ['threat modeling', 'identity and access', 'cryptography', 'network security', 'application security', 'incident response', 'compliance frameworks'],
  },
  real_estate: { name: 'Real estate', office: 'analysis', stakes: 'high', freshness: { days: 90, rule: 'Verify local rules and current rates.' }, sources: ['primary_law', 'government_guidance', 'textbook'], curriculum: ['purchase contracts', 'financing', 'title', 'leases', 'zoning', 'property tax', 'inspections'] },
  insurance: { name: 'Insurance', office: 'analysis', stakes: 'high', freshness: { days: 90, rule: 'Read the actual policy; verify state rules.' }, sources: ['primary_law', 'government_guidance', 'textbook'], curriculum: ['policy language', 'coverage', 'exclusions', 'claims', 'appeals', 'state regulation'] },
  government_benefits: { name: 'Government / benefits', office: 'research', stakes: 'high', freshness: { days: 30, rule: 'Verify current eligibility rules and amounts with the agency.' }, sources: ['primary_law', 'government_guidance'], curriculum: ['disability benefits', 'health coverage', 'unemployment', 'veterans benefits', 'housing assistance', 'appeals'] },
  intellectual_property: { name: 'Intellectual property', office: 'legal', engine: 'legal_intelligence', stakes: 'high', freshness: { days: 0, rule: 'Verify current law and registry status.' }, sources: ['primary_law', 'government_guidance', 'specialist_publication'], curriculum: ['copyright', 'trademark', 'patents', 'trade secrets', 'licensing', 'music rights'] },
  music: { name: 'Music', office: 'music_manager', stakes: 'medium', freshness: { days: 90, rule: 'Verify platform and distributor terms in force.' }, sources: ['professional_association', 'textbook', 'specialist_publication', 'technical_docs'], curriculum: ['theory', 'production', 'mixing', 'mastering', 'publishing', 'royalties', 'distribution', 'promotion'] },
  marketing: { name: 'Marketing and media', office: 'creative', stakes: 'low', freshness: { days: 90, rule: 'Verify platform rules in force.' }, sources: ['textbook', 'specialist_publication', 'professional_association'], curriculum: ['positioning', 'content', 'advertising', 'analytics', 'disclosure rules'] },
  trading: { name: 'Trading', office: 'analysis', stakes: 'high', freshness: { days: 1, rule: 'Use CHE\'s own ledgers and live data; never remembered prices.' }, sources: ['primary_law', 'peer_reviewed', 'textbook'], curriculum: ['market structure', 'futures', 'risk management', 'position sizing', 'backtesting', 'execution'] },
  science: { name: 'Science and research', office: 'research', stakes: 'medium', freshness: { days: 365, rule: 'Prefer recent systematic reviews.' }, sources: ['peer_reviewed', 'textbook', 'course_material'], curriculum: ['research methods', 'statistics', 'study design', 'evidence grading'] },
});

// Library categories for expert sources, next to the owner's 20 general categories (which stay as he named them).
export const EXPERT_CATEGORIES = Object.freeze(Object.entries(DOMAINS).map(([id, d]) => ({ id: `expert_${id}`, name: d.name, domain: id })));
registerCategories(EXPERT_CATEGORIES);
export const domainOfCategory = (cat) => EXPERT_CATEGORIES.find((c) => c.id === cat)?.domain || null;


/// Words that name a domain or a specialty in it.
const DOMAIN_WORDS = [
  // Pain or an injury counts only in medical phrasing ("my back pain", "pain in my knee", "I injured"), never
  // "pain point" or "injury time": a bare word must not pull the owner's medical case into a prompt.
  ['health', /\b(?:medical|medicine|doctor|physician|symptoms?|diagnos\w*|lab results?|blood (?:work|test)|mri|x-?ray|medications?|meds|prescription|dosage|cardiolog\w*|neurolog\w*|orthoped\w*|clinic|hospital|(?:my|chronic|back|neck|chest|joint|knee|hip|shoulder|stomach|abdominal|nerve) pain|pain (?:in (?:my|the)|when i|after|medication|management|relief)|(?:my|an|the|old|work|sports) injur(?:y|ies)|injured|i hurt my|health (?:problem|condition|issue|insurance))\b/i],
  ['law', /\b(?:legal|law|lawyer|attorney|court|lawsuit|sue|contract|statute|lease dispute)\b/i],
  ['accounting_tax', /\b(?:tax(?:es)?|irs|accountant|cpa|deduction|1099|w-?2|bookkeeping)\b/i],
  ['finance', /\b(?:invest\w*|portfolio|loan|mortgage|interest rate|budget|retirement|401k|ira)\b/i],
  ['engineering', /\b(?:engineer\w*|structural|load|circuit|torque|tolerance)\b/i],
  ['insurance', /\b(?:insurance|claim denied|policy coverage|deductible)\b/i],
  ['government_benefits', /\b(?:disability (?:benefits|claim|application)|ssdi|ssi|medicaid|medicare|benefits? appeal)\b/i],
  ['business', /\b(?:business plan|llc|corporation|incorporat\w*|startup|small business|business (?:license|licence|loan|funding)|revenue model|cash flow)\b/i],
  ['software', /\b(?:software|programming|source code|codebase|api|database|bug|deploy\w*|refactor\w*)\b/i],
  ['cybersecurity', /\b(?:cyber ?security|security breach|threat model\w*|vulnerabilit\w*|malware|phishing|ransomware|penetration test\w*|encryption)\b/i],
  ['real_estate', /\b(?:real estate|property (?:deed|title|purchase|tax)|landlord|tenant|lease|closing costs|escrow|zoning)\b/i],
  ['intellectual_property', /\b(?:intellectual property|trademark|copyright|patent|licensing deal|royalt(?:y|ies)|infring\w*)\b/i],
  ['music', /\b(?:music (?:theory|production|business)|mixing|mastering|chord|melody|songwriting|publishing (?:deal|rights))\b/i],
  ['marketing', /\b(?:marketing|advertis\w*|seo|brand strategy|conversion rate|ad campaign|funnel)\b/i],
  ['trading', /\b(?:trading|futures|options (?:trade|contract)|stock market|day trad\w*|risk management|stop loss|position siz\w*)\b/i],
  ['science', /\b(?:scientific|peer[- ]reviewed|study (?:shows|found)|experiment|physics|chemistry|biology|research paper)\b/i],
];
export function domainsIn(text) {
  return DOMAIN_WORDS.filter(([, re]) => re.test(String(text || ''))).map(([d]) => d);
}

// ─── Knowledge Library metadata ───────────────────────────────────────────

/// Adds the expert table beside kl_refs. One row per reference; the text itself stays in the library.
export function expertTable(storage) {
  const sql = storage?.sql;
  if (!sql) return null;
  sql.exec(`CREATE TABLE IF NOT EXISTS kl_expert (
    ref_id TEXT PRIMARY KEY, domain TEXT, specialty TEXT, source_type TEXT, tier INTEGER, jurisdiction TEXT,
    version TEXT, effective TEXT, retrieved TEXT, reliability TEXT)`);
  return sql;
}

/// Catalogs (and, when the licence allows, indexes) an expert source in the existing library, with its metadata.
/// Text whose licence does not allow storage stays catalogued: CHE never claims to have read it.
export function addExpertSource(storage, input, { now = new Date().toISOString() } = {}) {
  const domain = DOMAINS[input.domain] ? input.domain : null;
  if (!domain) return { error: `Unknown domain. Known: ${Object.keys(DOMAINS).join(', ')}.` };
  const kl = new KnowledgeLibrary(storage);
  const ref = kl.catalog({ ...input, category: `expert_${domain}` }, { now });
  if (ref.error) return ref;
  // The same reference already filed in one of the owner's own categories stays where he put it; registering it
  // as expert here would count it as covered while expert retrieval (which searches expert_<domain>) never finds it.
  if (ref.duplicate && ref.category !== `expert_${domain}`) {
    return { error: `This reference is already in your library under "${ref.category}", so I did not add it as a ${DOMAINS[domain].name} expert source. Move it to the ${DOMAINS[domain].name} expert category first if you want it used that way.`, duplicate: true, ref_id: ref.id };
  }
  let indexed = ref;
  if (input.text) {
    indexed = kl.index(ref.id, input.text, { now });
    if (indexed.error) indexed = { ...ref, index_error: indexed.error };
  }
  const sql = expertTable(storage);
  const type = TIER_BY_TYPE.has(input.source_type) ? input.source_type : 'article';
  sql.exec(`INSERT OR REPLACE INTO kl_expert (ref_id, domain, specialty, source_type, tier, jurisdiction, version, effective, retrieved, reliability)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ref.id, domain, clip(input.specialty, 80).toLowerCase(), type, tierOf(type),
  clip(input.jurisdiction, 40), clip(input.version, 60), clip(input.effective, 20), now, tierOf(type) <= 5 ? 'authoritative' : tierOf(type) <= 10 ? 'reputable' : 'supplementary');
  return { ...indexed, domain, source_type: type, tier: tierOf(type) };
}

function expertRows(storage, domain) {
  const sql = expertTable(storage);
  if (!sql) return [];
  const kl = new KnowledgeLibrary(storage);
  kl.init();
  const rows = [...sql.exec('SELECT * FROM kl_expert WHERE domain = ?', domain)];
  return rows.map((r) => ({ ...r, ref: kl.get(r.ref_id) })).filter((r) => r.ref);
}

/// A domain's evidenced coverage: what is indexed (read) versus only catalogued, by tier; which study-map topics
/// have an indexed source; when anything was last updated; the latest exam; and the gaps.
export function domainCoverage(storage, domain, { exams = {}, now = Date.now() } = {}) {
  const d = DOMAINS[domain];
  if (!d) return null;
  const rows = expertRows(storage, domain);
  const indexed = rows.filter((r) => r.ref.access === 'indexed');
  const covered = d.curriculum.filter((topic) => indexed.some((r) => r.specialty === topic || `${r.ref.title} ${r.ref.topics}`.toLowerCase().includes(topic)));
  const engineRecords = d.engine === 'legal_intelligence' ? LEGAL_INDEX.length : 0;
  const last = rows.map((r) => r.retrieved).filter(Boolean).sort().at(-1) || null;
  const stale = d.freshness.days > 0 && last && now - Date.parse(last) > d.freshness.days * DAY;
  const exam = exams[domain] || null;
  return {
    domain, name: d.name, specialist: d.office,
    indexed: indexed.length, cataloged: rows.length - indexed.length,
    authoritative: indexed.filter((r) => r.tier <= 5).length,
    engine_records: engineRecords,
    curriculum: { total: d.curriculum.length, covered: covered.length, gaps: d.curriculum.filter((t) => !covered.includes(t)) },
    last_updated: last, stale: Boolean(stale), freshness: d.freshness.rule,
    exam: exam ? { score: exam.score, passed: exam.passed, total: exam.total, at: exam.at } : null,
    level: !indexed.length && !engineRecords ? 'not built' : exam && exam.score >= 0.85 && covered.length / d.curriculum.length >= 0.5 ? 'strong in covered areas' : 'partial',
  };
}

export function speakCoverage(c) {
  const parts = [`${c.name}: ${c.level}.`];
  parts.push(`${c.indexed} indexed source${c.indexed === 1 ? '' : 's'} I have read${c.cataloged ? `, ${c.cataloged} only catalogued (not read)` : ''}${c.engine_records ? `, plus ${c.engine_records} structured legal records` : ''}.`);
  parts.push(`Study map: ${c.curriculum.covered} of ${c.curriculum.total} areas have a read source.`);
  if (c.exam) parts.push(`Latest test: ${c.exam.passed} of ${c.exam.total} passed (${Math.round(c.exam.score * 100)}%).`);
  else parts.push('Not tested yet.');
  if (c.curriculum.gaps.length) parts.push(`Gaps include ${c.curriculum.gaps.slice(0, 4).join(', ')}.`);
  if (c.stale) parts.push('Some sources are older than this field\'s freshness rule.');
  parts.push('A test score is not a licence.');
  return parts.join(' ');
}

// ─── Health safety ────────────────────────────────────────────────────────

/// Emergency warning signs, each with the public source it comes from. A match puts immediate care first.
export const RED_FLAGS = Object.freeze([
  { id: 'stroke', re: /\b(?:face (?:is )?droop\w*|one side (?:of (?:my|the|his|her) )?(?:face|body) (?:is )?(?:numb|weak|droop)|slurred speech|sudden(?:ly)? (?:can'?t|cannot) (?:speak|talk|move))\b/i, action: 'Possible stroke signs. Call 911 now; note the time symptoms started.', source: 'American Stroke Association, F.A.S.T. warning signs' },
  { id: 'heart', re: /\bchest (?:pain|pressure|tightness)\b[\s\S]{0,80}\b(?:short(?:ness)? of breath|sweat\w*|nause\w*|arm|jaw)\b|\b(?:short(?:ness)? of breath|sweat\w*)\b[\s\S]{0,80}\bchest (?:pain|pressure|tightness)\b/i, action: 'Chest pain with these symptoms can be a heart attack. Call 911 now.', source: 'American Heart Association, heart attack warning signs' },
  { id: 'anaphylaxis', re: /\b(?:throat (?:is )?(?:closing|swelling)|swollen (?:tongue|throat|lips)|can'?t breathe|trouble breathing)\b/i, action: 'Trouble breathing or throat swelling is an emergency. Use an epinephrine auto-injector if prescribed and call 911.', source: 'American Academy of Allergy, Asthma & Immunology, anaphylaxis' },
  { id: 'suicide', re: /\b(?:kill myself|end my life|(?:i(?:'m| am)|i've been|i keep) (?:thinking about|feeling) suicid\w*|i(?:'m| am) suicidal|i (?:want|wanna) to die|i don'?t want to (?:live|be alive))\b/i, action: 'You can call or text 988 (Suicide & Crisis Lifeline, U.S.) right now, or call 911 if you are in danger.', source: '988 Suicide & Crisis Lifeline' },
  { id: 'thunderclap', re: /\b(?:worst headache of my life|sudden (?:severe|explosive) headache|thunderclap headache)\b/i, action: 'A sudden, worst-ever headache needs emergency care now.', source: 'Emergency medicine warning sign (sudden severe headache)' },
  { id: 'bleeding', re: /\b(?:vomit\w* blood|cough\w* (?:up )?blood|black,? tarry stool|bleeding (?:that )?won'?t stop)\b/i, action: 'This kind of bleeding needs emergency care now.', source: 'Emergency medicine warning sign (serious bleeding)' },
]);

export function redFlags(text) {
  return RED_FLAGS.filter((f) => f.re.test(String(text || ''))).map(({ id, action, source }) => ({ id, action, source }));
}

/// Lab results read from the report's own lines, judged only against the reference range printed on that report.
/// A value without a printed range is listed, not judged.
export function readLabs(text) {
  const out = [];
  for (const line of String(text || '').split(/\n+/)) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9 ,()/%-]{1,40}?)[\s:]+(-?\d+(?:\.\d+)?)\s*([A-Za-z%/µ.0-9^]*)?\s*(?:\(?\s*(?:ref(?:erence)?(?: range)?:?\s*)?(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)\s*\)?)?/i);
    if (!m) continue;
    const [, name, v, unit, lo, hi] = m;
    const value = Number(v);
    const range = lo !== undefined && hi !== undefined ? [Number(lo), Number(hi)] : null;
    out.push({ name: name.trim(), value, unit: unit || '', range, flag: !range ? 'no range on report' : value < range[0] ? 'LOW' : value > range[1] ? 'HIGH' : 'in range', line: line.trim() });
  }
  return out;
}

/// Drug-interaction check from the FDA drug labels (openFDA). Only what a label says is reported, quoted; a label
/// that does not mention the other drug is not proof the combination is safe.
export async function labelInteractions(drugs, { fetcher = fetch, timeoutMs = 6000 } = {}) {
  const names = [...new Set(drugs.map((d) => clip(d, 60).toLowerCase()).filter(Boolean))];
  const findings = [];
  const unread = [];
  for (const drug of names) {
    const url = `https://api.fda.gov/drug/label.json?search=openfda.generic_name:%22${encodeURIComponent(drug)}%22&limit=1`;
    try {
      const res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) { unread.push(drug); continue; }
      const label = (await res.json()).results?.[0];
      const text = [...(label?.drug_interactions || []), ...(label?.warnings || []), ...(label?.boxed_warning || [])].join(' ');
      if (!text) { unread.push(drug); continue; }
      for (const other of names.filter((n) => n !== drug)) {
        const at = text.toLowerCase().indexOf(other);
        if (at >= 0) findings.push({ label: drug, mentions: other, quote: clip(text.slice(Math.max(0, at - 160), at + 200), 360), source: `FDA drug label for ${drug} (openFDA)`, url });
      }
    } catch { unread.push(drug); }
  }
  return { findings, unread, note: 'From FDA labels only. A label that does not mention a combination does not make it safe; a pharmacist can check the full picture.' };
}

// ─── Cases ────────────────────────────────────────────────────────────────

/// A long-running professional matter. Kept per compartment so health and legal records never reach unrelated tasks.
export const CASE_KINDS = Object.freeze({
  MEDICAL: { compartment: 'health', professional: 'doctor' },
  LEGAL: { compartment: 'legal', professional: 'attorney' },
  DISABILITY: { compartment: 'health', professional: 'disability representative' },
  INSURANCE: { compartment: 'finance', professional: 'insurance adjuster or attorney' },
  TAX: { compartment: 'finance', professional: 'accountant' },
  BUSINESS_FUNDING: { compartment: 'finance', professional: 'lender or investor' },
});

export async function loadCases(storage) {
  return (await storage.get('cases_v1')) || { cases: [], audit: [] };
}
export async function saveCases(storage, state) {
  state.audit = state.audit.slice(-200);
  await storage.put('cases_v1', state);
}

export function openCase(state, { kind, title }, now = new Date().toISOString()) {
  if (!CASE_KINDS[kind]) return { ok: false, why: `A case is one of ${Object.keys(CASE_KINDS).join(', ')}.` };
  const name = clip(title, 120);
  if (!name) return { ok: false, why: 'A case needs a name.' };
  const existing = state.cases.find((c) => c.kind === kind && c.title.toLowerCase() === name.toLowerCase());
  if (existing) return { ok: true, case: existing, existing: true };
  const c = {
    id: `case_${crypto.randomUUID()}`, kind, compartment: CASE_KINDS[kind].compartment, title: name, created_at: now,
    reason: '', jurisdiction: null, people: [], symptoms: [], timeline: [], documents: [], medications: [], results: [],
    history: [], appointments: [], deadlines: [], decisions: [], questions: [], professional_notes: [], next_actions: [],
  };
  state.cases.unshift(c);
  state.audit.push({ at: now, case: c.id, what: 'opened' });
  return { ok: true, case: c };
}

const LISTS = ['people', 'symptoms', 'timeline', 'documents', 'medications', 'results', 'history', 'appointments', 'deadlines', 'decisions', 'questions', 'next_actions'];

/// Adds facts the owner (or a record he supplied) gave. Documents are references to existing files, projects or
/// library entries, never copies. Every item keeps where it came from.
export function addToCase(state, caseId, field, item, now = new Date().toISOString()) {
  const c = state.cases.find((x) => x.id === caseId);
  if (!c) return { ok: false, why: 'No such case.' };
  if (field === 'reason' || field === 'jurisdiction') { c[field] = clip(item, 400); state.audit.push({ at: now, case: c.id, what: `set ${field}` }); return { ok: true }; }
  if (!LISTS.includes(field)) return { ok: false, why: `Unknown part of a case: ${field}.` };
  const entry = typeof item === 'string' ? { text: clip(item, 600) } : { ...item };
  entry.source ||= 'owner';
  entry.added = now;
  c[field].push(entry);
  state.audit.push({ at: now, case: c.id, what: `added ${field}` });
  return { ok: true, entry };
}

/// After an appointment: the professional's words are stored exactly as given; CHE adds the next steps it finds
/// in them as her own reading, marked as such, and says what changed.
export function addProfessionalNote(state, caseId, { who, text, date }, now = new Date().toISOString()) {
  const c = state.cases.find((x) => x.id === caseId);
  if (!c) return { ok: false, why: 'No such case.' };
  const verbatim = String(text || '').trim();
  if (!verbatim) return { ok: false, why: 'There is nothing to record.' };
  c.professional_notes.push({ who: clip(who, 120), date: date || now.slice(0, 10), verbatim, added: now });
  const changes = [];
  for (const m of verbatim.matchAll(/\b(?:order(?:ed|s)?|refer(?:red|ral)? (?:to|for)|start(?:ed)?|prescrib(?:ed|e)|schedul(?:ed|e))\s+(?:an?\s+|the\s+)?([a-z][a-z /-]{2,60}?)(?=[.,;]| and\b|$)/gi)) {
    c.next_actions.push({ text: m[0].trim(), source: `CHE's reading of ${who || 'the professional'}'s note`, added: now });
    changes.push(m[0].trim());
  }
  for (const m of verbatim.matchAll(/\b(?:within|in)\s+(one|two|three|\d+)\s+(day|week|month|year)s?\b[^.]*\b(?:fil(?:e|ing)|deadline|appeal|respond|submit)\w*|\b(?:fil(?:e|ing)|deadline|appeal)\w*[^.]*\bwithin\s+(one|two|three|\d+)\s+(day|week|month|year)s?/gi)) {
    c.deadlines.push({ text: m[0].trim(), source: `${who || 'professional'} (quoted)`, added: now });
    changes.push(`deadline: ${m[0].trim()}`);
  }
  state.audit.push({ at: now, case: c.id, what: 'professional note' });
  return { ok: true, changes, said: changes.length ? `Saved ${who || 'the'} note word for word. I added: ${changes.join('; ')}.` : `Saved ${who || 'the'} note word for word. I found no new orders or deadlines in it.` };
}

// ─── Briefs, checklists, questions, referrals ─────────────────────────────

const lines = (list, f = (x) => x.text) => list.map((x) => `- ${f(x)}${x.source && x.source !== 'owner' ? ` (${x.source})` : ''}`);

/// What to bring, tailored to what is on file and what is missing.
export function bringList(c) {
  const have = (k) => c[k]?.length > 0;
  if (CASE_KINDS[c.kind].professional === 'doctor' || c.kind === 'DISABILITY') {
    return [
      `Medication list${have('medications') ? ` (${c.medications.length} on file)` : ' (none recorded yet: write down every medicine, dose and how often)'}`,
      `Symptom timeline${have('timeline') || have('symptoms') ? '' : ' (not started)'}`,
      `Test results and imaging reports${have('results') ? ` (${c.results.length} on file)` : ' (none on file)'}`,
      'Insurance card and photo ID',
      `Records from other providers${have('documents') ? ` (${c.documents.length} referenced)` : ''}`,
      'Your questions (below)',
    ];
  }
  if (c.kind === 'LEGAL') {
    return ['Contracts and agreements', 'Messages and emails about the issue', 'Receipts and invoices', 'Photos or recordings', 'Police reports or court papers, if any', `Timeline${have('timeline') ? ` (${c.timeline.length} events on file)` : ' (not started)'}`, 'Names and contact details of everyone involved'];
  }
  if (c.kind === 'TAX') return ['Income records (W-2, 1099)', 'Expense records and receipts', 'Last year\'s return', 'Bank statements', 'Business records'];
  return ['Every document about the matter', 'A timeline', 'Your questions'];
}

const DOCTOR_QUESTIONS = [
  'What diagnoses best explain these symptoms?',
  'What tests would tell them apart?',
  'Could this be related to a past injury or condition on file?',
  'What are the treatment options, and their risks?',
  'What signs would mean I need urgent care?',
];
const ATTORNEY_QUESTIONS = [
  'Which claims or defences are available?',
  'What deadlines apply?',
  'What evidence is missing?',
  'What remedies or damages may apply?',
  'What should I avoid doing while this is pending?',
];

const BRIEF_TITLES = { MEDICAL: 'Doctor Brief', LEGAL: 'Attorney Brief', DISABILITY: 'Disability Claim Brief', TAX: 'Tax Brief', INSURANCE: 'Insurance Claim Brief', BUSINESS_FUNDING: 'Funding Brief' };
const MATTER_QUESTIONS = {
  DISABILITY: ['Which medical records best support the claim?', 'What deadlines apply to this claim or appeal?', 'What evidence is missing?', 'Should a doctor complete a functional capacity form?', 'What happens if the claim is denied?'],
  TAX: ['Which deductions or credits apply?', 'What deadlines or penalties apply?', 'Which records are missing?', 'Should anything be amended?', 'What should I keep for an audit?'],
  INSURANCE: ['What exactly does the policy cover here?', 'Why was the claim reduced or denied, in writing?', 'What is the appeal deadline?', 'What evidence would change the decision?', 'Is an independent adjuster or attorney worth it?'],
  BUSINESS_FUNDING: ['What will the lender or investor ask for?', 'What terms and costs apply?', 'What personal guarantee or collateral is required?', 'What deadlines apply?', 'What alternatives fit this stage?'],
};

export function questionsFor(c) {
  const base = c.kind === 'LEGAL' ? ATTORNEY_QUESTIONS : MATTER_QUESTIONS[c.kind] || DOCTOR_QUESTIONS;
  return [...c.questions.map((q) => q.text), ...base].slice(0, 7);
}

/// The specialist type that fits, and why. Only from words on file; never a diagnosis.
const REFERRALS = [
  { re: /\b(?:back|spine|neck|joint|knee|shoulder|hip|fracture)\b/i, who: 'orthopedist or physical medicine and rehabilitation (PM&R) physician', why: 'they treat bones, joints and spine and plan rehabilitation' },
  { re: /\b(?:numb\w*|tingl\w*|seizure|migraine|memory|nerve)\b/i, who: 'neurologist', why: 'these symptoms involve nerves or the brain' },
  { re: /\b(?:vision|eye|blurr\w*)\b/i, who: 'ophthalmologist', why: 'they diagnose and treat eye conditions' },
  { re: /\b(?:chronic pain|pain management)\b/i, who: 'pain medicine specialist', why: 'they manage long-term pain across causes' },
  { re: /\b(?:heart|palpitation\w*|blood pressure)\b/i, who: 'cardiologist', why: 'they diagnose and treat heart and circulation problems' },
  { re: /\b(?:fired|wages?|overtime|discriminat\w*|workplace)\b/i, who: 'employment attorney', why: 'the issue is between an employee and an employer' },
  { re: /\b(?:arrest\w*|charged|criminal|police)\b/i, who: 'criminal defense attorney', why: 'there is possible criminal exposure' },
  { re: /\b(?:accident|injur\w*|crash|slip)\b/i, who: 'personal injury attorney', why: 'someone else\'s fault may have caused an injury' },
  { re: /\b(?:copyright|trademark|sample|royalt\w*|record deal|publishing)\b/i, who: 'entertainment or IP attorney', why: 'the issue is rights in creative work' },
  { re: /\b(?:patent|invention)\b/i, who: 'patent attorney or agent', why: 'patents need a registered practitioner' },
];
export function referralsFor(c) {
  const text = [c.reason, c.title, ...c.symptoms.map((s) => s.text), ...c.timeline.map((t) => t.text)].join(' ');
  return REFERRALS.filter((r) => r.re.test(text) && (c.kind === 'LEGAL' ? /attorney|agent/.test(r.who) : !/attorney|agent/.test(r.who))).map(({ who, why }) => ({ who, why }));
}

/// Doctor Brief or Attorney Brief from the case record only. Missing parts are listed as missing, never filled in.
export function professionalBrief(c, { legal = null } = {}) {
  const missing = [];
  const section = (title, list, f) => {
    if (!list || !list.length) { missing.push(title.toLowerCase()); return [`${title}: none on file.`]; }
    return [`${title}:`, ...lines(list, f)];
  };
  const sortByDate = (list) => [...list].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const body = [];
  if (c.kind === 'LEGAL') {
    body.push(`ATTORNEY BRIEF: ${c.title}`);
    body.push(`Issue: ${c.reason || 'not stated yet'}`);
    if (!c.reason) missing.push('the issue in one sentence');
    body.push(`Jurisdiction: ${c.jurisdiction || 'not stated'}`);
    if (!c.jurisdiction) missing.push('jurisdiction');
    body.push(...section('People and entities', c.people));
    body.push(...section('Timeline', sortByDate(c.timeline), (t) => `${t.date || 'undated'}: ${t.text}`));
    body.push(...section('Documents', c.documents, (d) => `${d.text}${d.ref ? ` [${d.ref}]` : ''}`));
    body.push(...section('Deadlines', c.deadlines));
    if (legal?.sources?.length) body.push('Applicable authority (CHE research, to confirm with the attorney):', ...legal.sources.map((s) => `- ${s.citation}: ${s.summary}`));
    if (legal?.why?.conflict) body.push(`Uncertainty: conflicting authority (${legal.why.conflict.join(' vs ')}).`);
    body.push(...section('Decisions so far', c.decisions));
  } else if (!['MEDICAL', 'DISABILITY'].includes(c.kind)) {
    // Tax, insurance and business-funding matters: the facts, papers and deadlines, with no medical sections.
    body.push(`${BRIEF_TITLES[c.kind].toUpperCase()}: ${c.title}`);
    body.push(`Issue: ${c.reason || 'not stated yet'}`);
    if (!c.reason) missing.push('the issue in one sentence');
    body.push(...section('People and organisations', c.people));
    body.push(...section('Timeline', sortByDate(c.timeline), (t) => `${t.date || 'undated'}: ${t.text}`));
    body.push(...section('Documents', c.documents, (d) => `${d.text}${d.ref ? ` [${d.ref}]` : ''}`));
    body.push(...section('Deadlines', c.deadlines));
    body.push(...section('Decisions so far', c.decisions));
    body.push(...section('Professional notes so far (verbatim)', c.professional_notes, (n) => `${n.date} ${n.who}: "${n.verbatim}"`));
  } else {
    body.push(`${c.kind === 'DISABILITY' ? 'DISABILITY CLAIM BRIEF' : 'DOCTOR BRIEF'}: ${c.title}`);
    body.push(`${c.kind === 'DISABILITY' ? 'Claim' : 'Reason for visit'}: ${c.reason || 'not stated yet'}`);
    if (!c.reason) missing.push(c.kind === 'DISABILITY' ? 'the claim in one sentence' : 'reason for visit');
    if (c.kind === 'DISABILITY') body.push(...section('Deadlines', c.deadlines));
    body.push(...section('Symptoms', c.symptoms));
    body.push(...section('Timeline', sortByDate(c.timeline), (t) => `${t.date || 'undated'}: ${t.text}`));
    body.push(...section('Relevant history', c.history));
    body.push(...section('Current medications', c.medications, (m) => `${m.text}${m.dose ? `, ${m.dose}` : ''}`));
    const labs = c.results.map((r) => ({ ...r, text: `${r.name}: ${r.value}${r.unit ? ` ${r.unit}` : ''}${r.range ? ` (report range ${r.range[0]}–${r.range[1]}, ${r.flag})` : ''}${r.date ? `, ${r.date}` : ''}` }));
    body.push(...section('Important results', labs));
    const flags = redFlags([...c.symptoms.map((s) => s.text), ...c.timeline.map((t) => t.text)].join(' '));
    if (flags.length) body.unshift(`URGENT FIRST: ${flags.map((f) => f.action).join(' ')}`);
    body.push(...section('Professional notes so far (verbatim)', c.professional_notes, (n) => `${n.date} ${n.who}: "${n.verbatim}"`));
  }
  const refs = referralsFor(c);
  if (refs.length) body.push('Specialist types that may fit:', ...refs.map((r) => `- ${r.who}: ${r.why}`));
  body.push('Questions to ask:', ...questionsFor(c).map((q, i) => `${i + 1}. ${q}`));
  body.push('Bring:', ...bringList(c).map((b) => `- ${b}`));
  if (missing.length) body.push(`Missing from the file: ${missing.join(', ')}.`);
  body.push(c.kind === 'LEGAL' ? 'Prepared by CHE from your records for your attorney. Not legal advice.'
    : c.kind === 'MEDICAL' ? 'Prepared by CHE from your records for your clinician. Not a diagnosis.'
      : `Prepared by CHE from your records for your ${CASE_KINDS[c.kind].professional}. Not professional advice.`);
  return { title: BRIEF_TITLES[c.kind] || 'Doctor Brief', text: body.join('\n'), missing, referrals: refs };
}

// ─── Competency tests ─────────────────────────────────────────────────────

/// Domain exams that run against CHE's own engines and records, so a score measures what she actually does.
/// Each case is a function returning true when the behaviour is right.
export function examCases(domain) {
  const today = new Date('2026-10-22');
  if (domain === 'law') {
    return [
      ['current state rule with citation', () => /Cal\. Penal Code § 632/.test(legalAnswer('Can I record a call I am on?', { jurisdictionId: 'us-ca', facts: { party_to_conversation: true }, date: today }).text)],
      ['repealed law flagged', () => statusOn(LEGAL_INDEX.find((r) => r.id === 'eu-dir-95-46'), today) === STATUS.repealed],
      ['future law not presented as current', () => /Not yet/.test(legalAnswer('x', { jurisdictionId: 'eu', date: today, activity: 'ai_systems' }).text)],
      ['conflicting authority surfaced', () => /conflicting authority/.test(legalAnswer('Can we use this sample?', { jurisdictionId: 'us-la', date: today }).text)],
      ['unknown local rule is a gap, not a guess', () => legalAnswer('Can I run this business from home?', { jurisdictionId: 'us-la-new-orleans', date: today }).status === 'coverage_gap'],
      ['lawful alternative offered', () => /Legal option/.test(legalAnswer('Can we use this sample?', { jurisdictionId: 'us-ca', date: today }).text)],
      ['unindexed jurisdiction admitted', () => /have not indexed Texas law/.test(legalAnswer('Do I need to disclose a sponsored post?', { jurisdictionId: 'us-tx', date: today }).text)],
      ['missing fact asked, not assumed', () => /part of the conversation/.test(legalAnswer('Can I record somebody?', { jurisdictionId: 'us-la', date: today }).text)],
    ];
  }
  if (domain === 'health') {
    const labs = readLabs('Glucose 182 mg/dL (70-99)\nSodium 139 mmol/L (135-145)\nVitamin D 18 ng/mL');
    const c = { kind: 'MEDICAL', title: 'x', reason: '', symptoms: [{ text: 'low back pain and numbness in left leg' }], timeline: [], history: [], medications: [], results: [], professional_notes: [], questions: [], documents: [], deadlines: [], decisions: [], people: [] };
    return [
      ['stroke red flag recognised', () => redFlags('his face is drooping and he has slurred speech')[0]?.id === 'stroke'],
      ['heart red flag recognised', () => redFlags('chest pressure and shortness of breath')[0]?.id === 'heart'],
      ['ordinary symptom not alarmed', () => redFlags('mild sore throat for two days').length === 0],
      ['lab judged by the report\'s own range', () => labs[0].flag === 'HIGH' && labs[1].flag === 'in range'],
      ['lab without a range not judged', () => labs[2].flag === 'no range on report'],
      ['doctor brief lists what is missing', () => professionalBrief(c).missing.includes('current medications')],
      ['brief never states a diagnosis', () => !/\bdiagnosed with\b|\byou have\b/i.test(professionalBrief(c).text)],
      ['specialist referral explained', () => referralsFor(c).some((r) => /orthopedist|neurologist/.test(r.who) && r.why)],
    ];
  }
  if (domain === 'finance' || domain === 'accounting_tax') {
    return [
      ['calculation only from source records', () => sumRecords([{ amount_usd: 100.1 }, { amount_usd: 50.2 }]) === 150.3],
      ['no records is unknown, not zero', () => sumRecords([]) === null],
      ['tax rule needs the current year verified', () => DOMAINS.accounting_tax.freshness.days <= 30],
    ];
  }
  return [];
}

export function sumRecords(records) {
  if (!records.length) return null;
  return Math.round(records.reduce((s, r) => s + Number(r.amount_usd || 0), 0) * 100) / 100;
}

/// Runs a domain's exam now. The result is stored with its date; it is evidence, never a credential.
export function runExam(domain, now = new Date().toISOString()) {
  const cases = examCases(domain);
  if (!cases.length) return { domain, total: 0, passed: 0, score: null, at: now, results: [], note: 'No exam exists for this domain yet.' };
  const results = cases.map(([name, check]) => { let ok = false; try { ok = Boolean(check()); } catch { ok = false; } return { name, ok }; });
  const passed = results.filter((r) => r.ok).length;
  return { domain, total: results.length, passed, score: passed / results.length, at: now, results };
}

// ─── Specialist context for the model ─────────────────────────────────────

/// The high-stakes truth contract, added to the model's instructions when a question is in a high-stakes field.
export const HIGH_STAKES_CONTRACT = 'HIGH-STAKES FIELD. Never invent a law, case citation, diagnosis, drug interaction, test result, financial record, professional recommendation or source. Say "unknown" when it is unknown. Separate fact (with its source), guideline, research finding, hypothesis and opinion. Do not say you diagnosed, are the owner\'s physician/attorney/accountant, or that something definitely is X. Put emergencies first. You may reason like a specialist and say which explanation fits best, labelled as reasoning for a professional to confirm.';

/// "Think like a cardiology specialist", "have Legal analyze this": the specialty asked for, if any.
export function specialtyAsk(message) {
  const m = String(message || '').match(/\bthink like (?:a|an)\s+([a-z -]{3,40}?)\s+(?:specialist|doctor|expert|attorney|lawyer|engineer|accountant)\b|\bhave (legal|health|finance|engineering) (?:analy[sz]e|look at|review)\b/i);
  return m ? clip(m[1] || m[2], 40).toLowerCase() : null;
}

/// Context for the model on an expert question: the indexed passages in that domain with their sources, the
/// domain's gaps, and the truth contract. Cases are included only when their compartment matches the question.
export function expertPromptContext(storage, message, { cases = [], max = 2400 } = {}) {
  const domains = domainsIn(message);
  const specialty = specialtyAsk(message);
  if (!domains.length && !specialty) return '';
  const parts = [];
  const highStakes = domains.some((d) => DOMAINS[d]?.stakes === 'high');
  if (highStakes || specialty) parts.push(HIGH_STAKES_CONTRACT);
  if (specialty) parts.push(`Answer from the ${specialty} specialty's point of view, using only the sources below and general professional reasoning labelled as such. Do not role-play being the owner's own clinician or lawyer.`);
  const kl = new KnowledgeLibrary(storage);
  if (kl.init()) {
    for (const d of domains.slice(0, 2)) {
      const { hits } = kl.search(message, { category: `expert_${d}`, limit: 3 });
      parts.push(hits.length
        ? `${DOMAINS[d].name} sources CHE has read:\n${hits.map((h) => `${h.citation}\n${h.text.slice(0, 400)}`).join('\n')}`
        : `${DOMAINS[d].name}: CHE has no indexed source for this question. Say so, and offer to research it from authoritative sources.`);
    }
  }
  const compartments = new Set(domains.map((d) => (d === 'health' ? 'health' : d === 'law' ? 'legal' : ['finance', 'accounting_tax', 'insurance'].includes(d) ? 'finance' : null)).filter(Boolean));
  for (const c of cases.filter((x) => compartments.has(x.compartment)).slice(0, 1)) {
    parts.push(`Owner's ${c.kind.toLowerCase()} case "${c.title}" (private; use only for this answer): reason ${c.reason || 'not stated'}; symptoms ${c.symptoms.map((s) => s.text).join('; ') || 'none'}; medications ${c.medications.map((m) => m.text).join('; ') || 'none on file'}; results ${c.results.map((r) => `${r.name} ${r.value}${r.unit ? ` ${r.unit}` : ''} (${r.flag || 'no range'})`).join('; ') || 'none'}.`);
  }
  return parts.join('\n\n').slice(0, max);
}

// ─── Upgrade ──────────────────────────────────────────────────────────────

/// "Get better at contract law": where coverage stands, which authoritative sources would close the gap, then a
/// re-test. Nothing is downloaded that its licence does not allow; the plan names what the owner can add.
export function upgradePlan(storage, domain, topic = '') {
  const d = DOMAINS[domain];
  if (!d) return null;
  const before = domainCoverage(storage, domain);
  const target = topic ? d.curriculum.filter((t) => t.includes(topic) || topic.includes(t)) : before.curriculum.gaps.slice(0, 5);
  const wanted = d.sources.map((type) => SOURCE_TIERS.find((s) => s.type === type)?.name).filter(Boolean);
  return {
    domain, topic: topic || null, before,
    targets: target.length ? target : [topic].filter(Boolean),
    source_types: wanted,
    steps: [
      `Find ${wanted.slice(0, 2).join(' and ')} on ${target.join(', ') || topic}.`,
      'Index what may lawfully be stored (public law, open-licence texts, material you own or are licensed to give me); catalogue the rest as not read.',
      `Re-run the ${d.name} test and report the change.`,
    ],
  };
}

/// Which expert domain a phrase names.
export function domainByName(text) {
  const t = String(text || '').toLowerCase();
  for (const [id, d] of Object.entries(DOMAINS)) {
    if (t.includes(d.name.toLowerCase()) || t.includes(id.replace(/_/g, ' '))) return id;
  }
  if (/\b(?:contract|legal|law)\b/.test(t)) return 'law';
  if (/\b(?:medic|health|cardio|neuro|ortho|pharma)/.test(t)) return 'health';
  if (/\btax|accounting\b/.test(t)) return 'accounting_tax';
  return null;
}

// ─── Words ────────────────────────────────────────────────────────────────

/// "Prepare me for my doctor's appointment", "what should I bring to my lawyer?", "how good are you at law?",
/// "get better at contract law", "test your medical knowledge", "my doctor said ...", "check my medications".
export function expertIntent(message) {
  const t = String(message || '').trim().replace(/[.!?]+$/, '');
  let m;
  if (/\b(?:prepare|get) me (?:ready )?for (?:my|the) (?:doctor|doctor's|physician|medical|clinic)|\bdoctor brief\b/i.test(t)) return { kind: 'brief', case_kind: 'MEDICAL' };
  if (/\b(?:prepare|get) me (?:ready )?for (?:my|the) (?:lawyer|attorney|legal)|\battorney brief\b|\bprepare (?:this|it) for my (?:lawyer|attorney)\b/i.test(t)) return { kind: 'brief', case_kind: 'LEGAL' };
  m = t.match(/\bwhat should i bring to (?:my|the)\s+(doctor|lawyer|attorney|accountant|appointment)/i);
  if (m) return { kind: 'bring', case_kind: /lawyer|attorney/i.test(m[1]) ? 'LEGAL' : /accountant/i.test(m[1]) ? 'TAX' : 'MEDICAL' };
  m = t.match(/\bmy (doctor|physician|attorney|lawyer|accountant|therapist|surgeon)\s+(?:said|says|told me|wrote)[:,]?\s+(.{5,})$/i);
  if (m) return { kind: 'note', who: m[1], text: m[2] };
  m = t.match(/\b(?:how good are you at|how much do you know about|your (?:coverage|expertise) in|expertise (?:in|for))\s+(.+)$/i);
  if (m && domainByName(m[1])) return { kind: 'coverage', domain: domainByName(m[1]) };
  if (/\b(?:what are your|show (?:me )?your) (?:expertise|specialties|areas of expertise)\b/i.test(t)) return { kind: 'coverage_all' };
  m = t.match(/\bget better at\s+(.+)$/i);
  if (m && domainByName(m[1])) return { kind: 'upgrade', domain: domainByName(m[1]), topic: m[1].replace(/\b(?:law|medicine)\b/i, '').trim().toLowerCase() };
  m = t.match(/\btest your (.+?) (?:knowledge|expertise|skills)$/i);
  if (m && domainByName(m[1])) return { kind: 'exam', domain: domainByName(m[1]) };
  m = t.match(/\b(?:check|do) (?:my )?(?:medications?|meds|drugs)\s+(?:for interactions\s*)?[:,-]?\s*(.+?)(?:\s+for interactions)?$/i)
    || t.match(/\bcan i take\s+(.+?)\s+(?:with|and)\s+(.+)$/i);
  if (m) return { kind: 'interactions', drugs: (m[2] ? [m[1], m[2]] : m[1].split(/\s*(?:,|\band\b|\bwith\b|\+)\s*/i)).map((x) => x.trim()).filter((x) => x.length > 2) };
  m = t.match(/\bopen (?:a )?(medical|legal|disability|insurance|tax) case (?:called|for|named)\s+(.+)$/i);
  if (m) return { kind: 'open_case', case_kind: { medical: 'MEDICAL', legal: 'LEGAL', disability: 'DISABILITY', insurance: 'INSURANCE', tax: 'TAX' }[m[1].toLowerCase()], title: m[2] };
  return null;
}
