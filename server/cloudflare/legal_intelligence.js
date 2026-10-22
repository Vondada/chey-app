// CHE Legal Intelligence (owner, 2026-10-22): a quiet legal layer behind Music, Business, Projects, contracts and
// everyday questions. It is an advisor first: when a first idea looks restricted it says why, how sure it is, and
// the closest lawful way to reach the same goal. CHE's own execution rules (money, deletes, app permission) are
// unchanged: advice never executes anything.
//
// Not a frozen law dump. Three parts, kept apart on purpose:
//   - JURISDICTIONS: who makes law where, and how much of it CHE can actually read (coverage is never overstated);
//   - SOURCES: the official or reputable places law is read from, ranked by authority;
//   - LEGAL_INDEX: the small set of records CHE has structured so far. Each record names its citation, level,
//     dates and source, and summarises the rule in CHE's own words. A summary is never presented as statute text:
//     only a live fetch from the official source supplies quoted text (verifyRecord).
// Anything outside the index is answered as a coverage gap with the official place to check, never from memory.

const DAY = 86_400_000;
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// ─── Vocabulary ───────────────────────────────────────────────────────────

export const COVERAGE = Object.freeze({
  full: 'FULL OFFICIAL COVERAGE',
  partial: 'PARTIAL OFFICIAL COVERAGE',
  secondary: 'SECONDARY COVERAGE',
  none: 'NOT YET INDEXED',
});
export const STATUS = Object.freeze({
  effective: 'CURRENTLY EFFECTIVE',
  future: 'FUTURE EFFECTIVE',
  repealed: 'REPEALED',
  uncertain: 'UNCERTAIN / LITIGATED',
  unknown: 'UNKNOWN',
});
export const RISK_LEVELS = Object.freeze({
  permitted: 'CLEARLY PERMITTED',
  likely_permitted: 'LIKELY PERMITTED',
  uncertain: 'UNCERTAIN',
  likely_restricted: 'LIKELY RESTRICTED',
  prohibited: 'CLEARLY PROHIBITED',
  lawyer: 'LAWYER REVIEW',
});
/// What kind of rule it is. A platform rule or a contract term is not a law, and the answer says which.
export const RESTRICTION_KINDS = Object.freeze({
  LAW: 'law', REGULATION: 'regulation', COURT: 'court decision', AGENCY_GUIDANCE: 'agency guidance',
  LOCAL_CODE: 'local ordinance', CONTRACT: 'contract term', PLATFORM_RULE: 'platform rule',
  COMPANY_POLICY: 'company policy', BEST_PRACTICE: 'best practice',
});
/// What could follow. Criminal exposure is named only when the source says so.
export const EXPOSURE = Object.freeze({
  criminal: 'criminal exposure', civil: 'civil liability', regulatory: 'regulatory penalty',
  licensing: 'licensing consequence', contract: 'contract consequence', platform: 'platform action',
});
export const PRIORITY = Object.freeze({ critical: 'CRITICAL', important: 'IMPORTANT', fyi: 'FYI' });

// ─── Jurisdictions ────────────────────────────────────────────────────────

// U.S. states, D.C. and territories. Each one exists in the registry; coverage is what CHE has actually indexed.
const US_STATES = [
  ['al', 'Alabama'], ['ak', 'Alaska'], ['az', 'Arizona'], ['ar', 'Arkansas'], ['ca', 'California'], ['co', 'Colorado'],
  ['ct', 'Connecticut'], ['de', 'Delaware'], ['dc', 'District of Columbia'], ['fl', 'Florida'], ['ga', 'Georgia'],
  ['hi', 'Hawaii'], ['id', 'Idaho'], ['il', 'Illinois'], ['in', 'Indiana'], ['ia', 'Iowa'], ['ks', 'Kansas'],
  ['ky', 'Kentucky'], ['la', 'Louisiana'], ['me', 'Maine'], ['md', 'Maryland'], ['ma', 'Massachusetts'],
  ['mi', 'Michigan'], ['mn', 'Minnesota'], ['ms', 'Mississippi'], ['mo', 'Missouri'], ['mt', 'Montana'],
  ['ne', 'Nebraska'], ['nv', 'Nevada'], ['nh', 'New Hampshire'], ['nj', 'New Jersey'], ['nm', 'New Mexico'],
  ['ny', 'New York'], ['nc', 'North Carolina'], ['nd', 'North Dakota'], ['oh', 'Ohio'], ['ok', 'Oklahoma'],
  ['or', 'Oregon'], ['pa', 'Pennsylvania'], ['ri', 'Rhode Island'], ['sc', 'South Carolina'], ['sd', 'South Dakota'],
  ['tn', 'Tennessee'], ['tx', 'Texas'], ['ut', 'Utah'], ['vt', 'Vermont'], ['va', 'Virginia'], ['wa', 'Washington'],
  ['wv', 'West Virginia'], ['wi', 'Wisconsin'], ['wy', 'Wyoming'],
];
const US_TERRITORIES = [['pr', 'Puerto Rico'], ['gu', 'Guam'], ['vi', 'U.S. Virgin Islands'], ['as', 'American Samoa'], ['mp', 'Northern Mariana Islands']];
// Federal judicial circuits, because a court decision binds only its own circuit.
const CIRCUITS = {
  1: ['me', 'ma', 'nh', 'ri', 'pr'], 2: ['ct', 'ny', 'vt'], 3: ['de', 'nj', 'pa', 'vi'], 4: ['md', 'nc', 'sc', 'va', 'wv'],
  5: ['la', 'ms', 'tx'], 6: ['ky', 'mi', 'oh', 'tn'], 7: ['il', 'in', 'wi'], 8: ['ar', 'ia', 'mn', 'mo', 'ne', 'nd', 'sd'],
  9: ['ak', 'az', 'ca', 'hi', 'id', 'mt', 'nv', 'or', 'wa', 'gu', 'mp'], 10: ['co', 'ks', 'nm', 'ok', 'ut', 'wy'],
  11: ['al', 'fl', 'ga'], dc: ['dc'],
};
export function circuitOf(stateId) {
  const code = String(stateId || '').replace(/^us-/, '').slice(0, 2);
  for (const [c, states] of Object.entries(CIRCUITS)) if (states.includes(code)) return c;
  return null;
}

// EU member states: EU law applies on top of each one's national law.
const EU_MEMBERS = [
  ['at', 'Austria'], ['be', 'Belgium'], ['bg', 'Bulgaria'], ['hr', 'Croatia'], ['cy', 'Cyprus'], ['cz', 'Czechia'],
  ['dk', 'Denmark'], ['ee', 'Estonia'], ['fi', 'Finland'], ['fr', 'France'], ['de', 'Germany'], ['gr', 'Greece'],
  ['hu', 'Hungary'], ['ie', 'Ireland'], ['it', 'Italy'], ['lv', 'Latvia'], ['lt', 'Lithuania'], ['lu', 'Luxembourg'],
  ['mt', 'Malta'], ['nl', 'Netherlands'], ['pl', 'Poland'], ['pt', 'Portugal'], ['ro', 'Romania'], ['sk', 'Slovakia'],
  ['si', 'Slovenia'], ['es', 'Spain'], ['se', 'Sweden'],
];

/// Coverage per layer: statutes, regulations, courts, local law. A layer is 'indexed' only when records exist
/// in LEGAL_INDEX for it, 'live' when an official source can be read live, 'none' otherwise.
const cov = (statutes, regulations, courts, local, source) => ({ statutes, regulations, courts, local, official_source: source || null });

function buildJurisdictions() {
  const j = [
    { id: 'us', name: 'United States (federal)', level: 'federal', parent: null, country: 'us', coverage: cov('indexed+live', 'indexed+live', 'indexed', 'n/a', 'uscode.house.gov, ecfr.gov, federalregister.gov') },
  ];
  for (const [code, name] of US_STATES) j.push({ id: `us-${code}`, name, level: 'state', parent: 'us', country: 'us', coverage: cov('none', 'none', 'none', 'none', STATE_SOURCES[code] || null) });
  for (const [code, name] of US_TERRITORIES) j.push({ id: `us-${code}`, name, level: 'territory', parent: 'us', country: 'us', coverage: cov('none', 'none', 'none', 'none', null) });
  Object.assign(j.find((x) => x.id === 'us-la').coverage, { statutes: 'indexed', local: 'none' });
  Object.assign(j.find((x) => x.id === 'us-ca').coverage, { statutes: 'indexed+live' });
  j.push(
    { id: 'us-la-orleans', name: 'Orleans Parish', level: 'parish', parent: 'us-la', country: 'us', coverage: cov('n/a', 'n/a', 'none', 'none', 'library.municode.com/la/new_orleans') },
    { id: 'us-la-new-orleans', name: 'New Orleans', level: 'city', parent: 'us-la-orleans', country: 'us', coverage: cov('n/a', 'n/a', 'none', 'none', 'library.municode.com/la/new_orleans') },
    { id: 'us-la-east-baton-rouge', name: 'East Baton Rouge Parish', level: 'parish', parent: 'us-la', country: 'us', coverage: cov('n/a', 'n/a', 'none', 'none', null) },
    { id: 'us-la-baton-rouge', name: 'Baton Rouge', level: 'city', parent: 'us-la-east-baton-rouge', country: 'us', coverage: cov('n/a', 'n/a', 'none', 'none', null) },
    { id: 'us-ca-los-angeles-county', name: 'Los Angeles County', level: 'county', parent: 'us-ca', country: 'us', coverage: cov('n/a', 'n/a', 'none', 'none', 'library.municode.com/ca/los_angeles_county') },
    { id: 'us-ca-los-angeles', name: 'Los Angeles', level: 'city', parent: 'us-ca-los-angeles-county', country: 'us', coverage: cov('n/a', 'n/a', 'none', 'none', 'codelibrary.amlegal.com/codes/los_angeles') },
    { id: 'gb', name: 'United Kingdom', level: 'national', parent: null, country: 'gb', coverage: cov('indexed+live', 'live', 'none', 'none', 'legislation.gov.uk') },
    { id: 'gb-eng', name: 'England', level: 'nation', parent: 'gb', country: 'gb', coverage: cov('live', 'live', 'none', 'none', 'legislation.gov.uk') },
    { id: 'gb-sct', name: 'Scotland', level: 'nation', parent: 'gb', country: 'gb', coverage: cov('live', 'live', 'none', 'none', 'legislation.gov.uk') },
    { id: 'gb-wls', name: 'Wales', level: 'nation', parent: 'gb', country: 'gb', coverage: cov('live', 'live', 'none', 'none', 'legislation.gov.uk') },
    { id: 'gb-nir', name: 'Northern Ireland', level: 'nation', parent: 'gb', country: 'gb', coverage: cov('live', 'live', 'none', 'none', 'legislation.gov.uk') },
    { id: 'eu', name: 'European Union', level: 'supranational', parent: null, country: 'eu', coverage: cov('indexed+live', 'indexed+live', 'none', 'n/a', 'eur-lex.europa.eu') },
    { id: 'ca', name: 'Canada (federal)', level: 'federal', parent: null, country: 'ca', coverage: cov('indexed+live', 'live', 'none', 'n/a', 'laws-lois.justice.gc.ca') },
    { id: 'au', name: 'Australia (Commonwealth)', level: 'federal', parent: null, country: 'au', coverage: cov('live', 'live', 'none', 'n/a', 'legislation.gov.au') },
  );
  for (const [code, name] of EU_MEMBERS) j.push({ id: code, name, level: 'national', parent: 'eu', country: code, coverage: cov('none', 'none', 'none', 'none', EU_NATIONAL_SOURCES[code] || null) });
  return j.map((x) => ({ ...x, status: coverageStatus(x) }));
}

// Official state legislature sites CHE has registered. A state without one here says so instead of guessing.
const STATE_SOURCES = {
  la: 'legis.la.gov', ca: 'leginfo.legislature.ca.gov', tx: 'statutes.capitol.texas.gov', ny: 'nysenate.gov/legislation',
  fl: 'leg.state.fl.us/statutes',
};
const EU_NATIONAL_SOURCES = { fr: 'legifrance.gouv.fr', de: 'gesetze-im-internet.de', ie: 'irishstatutebook.ie' };

function coverageStatus(j) {
  const layers = [j.coverage.statutes, j.coverage.regulations, j.coverage.courts, j.coverage.local].filter((l) => l !== 'n/a');
  if (layers.every((l) => l === 'none')) return COVERAGE.none;
  // Nothing is FULL: no jurisdiction has every layer indexed and kept current.
  return COVERAGE.partial;
}

export const JURISDICTIONS = Object.freeze(buildJurisdictions());
const BY_ID = new Map(JURISDICTIONS.map((j) => [j.id, j]));
export const jurisdiction = (id) => BY_ID.get(id) || null;

/// The layers above a place, most local first: city → parish/county → state → federal; or member state → EU.
export function jurisdictionChain(id) {
  const chain = [];
  let cur = BY_ID.get(id);
  while (cur) { chain.push(cur); cur = cur.parent ? BY_ID.get(cur.parent) : null; }
  return chain;
}

const PLACE_ALIASES = new Map([
  ...JURISDICTIONS.map((j) => [j.name.toLowerCase(), j.id]),
  ...US_STATES.filter(([c]) => c !== 'dc').map(([c]) => [c, `us-${c}`]),
  ['nola', 'us-la-new-orleans'], ['la county', 'us-ca-los-angeles-county'], ['the uk', 'gb'], ['uk', 'gb'], ['britain', 'gb'],
  ['great britain', 'gb'], ['the eu', 'eu'], ['europe', 'eu'], ['the united states', 'us'], ['federal', 'us'], ['america', 'us'],
  ['the us', 'us'], ['usa', 'us'], ['washington dc', 'us-dc'], ['d.c.', 'us-dc'], ['dc', 'us-dc'], ['washington state', 'us-wa'],
]);

/// Finds a place the words name. Two-letter state codes count only in capitals ("LA", "TX") so "in" or "or"
/// never become Indiana or Oregon; "LA" alone is Louisiana unless the city context says Los Angeles.
export function placeIn(text) {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  let best = null;
  for (const [alias, id] of PLACE_ALIASES) {
    if (alias.length === 2) {
      if (!new RegExp(`\\b${alias.toUpperCase()}\\b`).test(raw)) continue;
    } else if (!new RegExp(`\\b${alias.replace(/[.]/g, '\\.')}\\b`, 'i').test(lower)) continue;
    if (!best || alias.length > best.alias.length) best = { alias, id };
  }
  return best ? best.id : null;
}

// ─── Sources ──────────────────────────────────────────────────────────────

/// Authority tiers, highest first. A blog is never presented as the law itself.
export const AUTHORITY_TIERS = Object.freeze([
  { tier: 1, name: 'Official legislation / statute' },
  { tier: 2, name: 'Official regulation' },
  { tier: 3, name: 'Official court source' },
  { tier: 4, name: 'Official agency guidance' },
  { tier: 5, name: 'Official local-government code' },
  { tier: 6, name: 'Reputable legal database' },
  { tier: 7, name: 'Reputable secondary analysis' },
]);

export const SOURCES = Object.freeze([
  { id: 'us_code', name: 'United States Code (Office of the Law Revision Counsel)', tier: 1, jurisdiction: 'us', base: 'https://uscode.house.gov', adapter: 'page' },
  { id: 'ecfr', name: 'Electronic Code of Federal Regulations', tier: 2, jurisdiction: 'us', base: 'https://www.ecfr.gov', adapter: 'ecfr' },
  { id: 'federal_register', name: 'Federal Register (rule changes)', tier: 2, jurisdiction: 'us', base: 'https://www.federalregister.gov', adapter: 'federal_register' },
  { id: 'us_courts', name: 'Federal court opinions (published reporters)', tier: 3, jurisdiction: 'us', base: 'https://www.courtlistener.com', adapter: null },
  { id: 'ftc', name: 'Federal Trade Commission guidance', tier: 4, jurisdiction: 'us', base: 'https://www.ftc.gov', adapter: 'page' },
  { id: 'sba', name: 'U.S. Small Business Administration licensing guide', tier: 4, jurisdiction: 'us', base: 'https://www.sba.gov/business-guide/launch-your-business/apply-licenses-permits', adapter: null },
  { id: 'la_legislature', name: 'Louisiana State Legislature (Revised Statutes)', tier: 1, jurisdiction: 'us-la', base: 'https://legis.la.gov', adapter: null },
  { id: 'la_geauxbiz', name: 'Louisiana Secretary of State business filings (geauxBIZ)', tier: 4, jurisdiction: 'us-la', base: 'https://geauxbiz.sos.la.gov', adapter: null },
  { id: 'nola_onestop', name: 'City of New Orleans One Stop (permits and licences)', tier: 5, jurisdiction: 'us-la-new-orleans', base: 'https://onestopapp.nola.gov', adapter: null },
  { id: 'municode', name: 'Municode Library (official codes for many cities and parishes)', tier: 5, jurisdiction: null, base: 'https://library.municode.com', adapter: null },
  { id: 'ca_leginfo', name: 'California Legislative Information', tier: 1, jurisdiction: 'us-ca', base: 'https://leginfo.legislature.ca.gov', adapter: 'page' },
  { id: 'uk_legislation', name: 'legislation.gov.uk (The National Archives)', tier: 1, jurisdiction: 'gb', base: 'https://www.legislation.gov.uk', adapter: 'uk' },
  { id: 'eurlex', name: 'EUR-Lex (Official Journal of the EU)', tier: 1, jurisdiction: 'eu', base: 'https://eur-lex.europa.eu', adapter: 'page' },
  { id: 'ca_justice', name: 'Justice Laws Website (Government of Canada)', tier: 1, jurisdiction: 'ca', base: 'https://laws-lois.justice.gc.ca', adapter: 'page' },
  { id: 'au_legislation', name: 'Federal Register of Legislation (Australia)', tier: 1, jurisdiction: 'au', base: 'https://www.legislation.gov.au', adapter: 'page' },
  { id: 'legifrance', name: 'Légifrance', tier: 1, jurisdiction: 'fr', base: 'https://www.legifrance.gouv.fr', adapter: null },
  { id: 'de_gesetze', name: 'Gesetze im Internet (Federal Ministry of Justice)', tier: 1, jurisdiction: 'de', base: 'https://www.gesetze-im-internet.de', adapter: null },
  { id: 'ie_statutes', name: 'Irish Statute Book', tier: 1, jurisdiction: 'ie', base: 'https://www.irishstatutebook.ie', adapter: null },
]);
const SOURCE_BY_ID = new Map(SOURCES.map((s) => [s.id, s]));
export const source = (id) => SOURCE_BY_ID.get(id) || null;

// ─── Activities ───────────────────────────────────────────────────────────

/// What the owner is doing, from his words. Alert categories (settings) map onto these.
export const ACTIVITIES = Object.freeze({
  recording: { name: 'Recording people', category: 'recording_privacy', words: /\b(?:record(?:ing)?\s+(?:a |the |my |this )?(?:call|conversation|phone call|someone|somebody|people|him|her|them|meeting)|record (?:somebody|someone) here|secretly record|wiretap)\b/i },
  sampling: { name: 'Using samples', category: 'music', words: /\b(?:samples?|sampling|interpolat\w*|flip (?:this|that|a) (?:song|record))\b/i },
  copyright_use: { name: 'Using someone else\'s work', category: 'music', words: /\b(?:fair use|fair dealing|copyright(?:ed)?|use (?:this|that|their|his|her) (?:song|clip|video|photo|image|lyrics|beat|art))\b/i },
  endorsement: { name: 'Paid promotion and endorsements', category: 'business', words: /\b(?:sponsored|sponsorship|paid promotion|endorse\w*|influencer|affiliate links?|ad disclosure|promote (?:a|their) product)\b/i },
  personal_data: { name: 'Collecting personal data', category: 'business', words: /\b(?:personal data|gdpr|privacy law|mailing list|collect (?:emails|email addresses|phone numbers|data)|customer data)\b/i },
  ai_systems: { name: 'Building or deploying AI systems', category: 'business', words: /\b(?:ai act|high[- ]risk ai|ai system)\b/i },
  business_license: { name: 'Business licensing and permits', category: 'licensing', words: /\b(?:business licen[cs]e|occupational licen[cs]e|need a permit|permits?|run (?:this|a|my) business|business from home|home business|register (?:a|my) business|llc)\b/i },
  sales_tax: { name: 'Sales tax', category: 'taxes', words: /\b(?:sales tax|collect tax|tax registration)\b/i },
  trademark: { name: 'Names and trademarks', category: 'business', words: /\b(?:trademark|stage name|artist name|brand name|band name)\b/i },
  limitation: { name: 'Deadlines to sue', category: 'contracting', words: /\b(?:statute of limitations|how long (?:do|does) (?:i|they|he|she) have to sue|deadline to sue)\b/i },
  weapons: { name: 'Weapons', category: 'weapons', words: /\b(?:carry (?:a |my )?(?:gun|firearm|pistol|knife)|concealed carry|open carry|firearms?)\b/i },
  alcohol: { name: 'Alcohol', category: 'alcohol', words: /\b(?:alcohol|liquor|open container|sell (?:beer|wine|drinks))\b/i },
  cannabis: { name: 'Cannabis', category: 'cannabis', words: /\b(?:cannabis|marijuana|weed|thc|cbd)\b/i },
  driving: { name: 'Driving', category: 'driving', words: /\b(?:driv(?:e|ing)|speed limit|phone while driving|hands[- ]free|traffic)\b/i },
  employment: { name: 'Employment', category: 'employment', words: /\b(?:hire|employee|contractor|1099|w-?2|minimum wage|overtime)\b/i },
});
export const ALERT_CATEGORIES = Object.freeze(['driving', 'business', 'music', 'weapons', 'alcohol', 'cannabis', 'recording_privacy', 'employment', 'taxes', 'licensing', 'consumer', 'contracting']);

export function activitiesIn(text) {
  return Object.entries(ACTIVITIES).filter(([, a]) => a.words.test(String(text || ''))).map(([id]) => id);
}

// ─── The index ────────────────────────────────────────────────────────────
//
// Each record: who made it, at what level, the citation, when it took effect, its status and source. `summary` is
// CHE's plain-language reading, labelled as such. `rules` say what it means for an activity: effect is 'permits',
// 'requires' or 'prohibits'; `when` names the fact it depends on; `exposure` lists only what the source supports.
// `retrieved` stays null until a live check reads the official text (verifyRecord); until then answers say
// "from CHE's index, not checked live".

export const LEGAL_INDEX = Object.freeze([
  {
    id: 'us-17usc106', jurisdiction: 'us', level: 'federal', kind: 'LAW', source: 'us_code',
    citation: '17 U.S.C. § 106', title: 'Exclusive rights in copyrighted works', subjects: ['copyright', 'music'],
    effective: '1978-01-01', amended: null, repealed: null, applies: 'United States',
    url: 'https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title17-section106&num=0&edition=prelim', confidence: 'high',
    summary: 'The copyright owner controls copying, making derivative works, distribution and public performance. A recorded song carries two copyrights: the composition (publishing) and the sound recording (master).',
    rules: [
      { activity: 'sampling', effect: 'requires', what: 'permission from both the master owner and the publisher before using the sample in a release', exposure: ['civil'], note: 'Willful commercial infringement can also be criminal under 17 U.S.C. § 506, which is rare for ordinary sampling disputes.' },
      { activity: 'copyright_use', effect: 'requires', what: 'the owner\'s permission unless an exception such as fair use applies', exposure: ['civil'] },
    ],
    alternatives: {
      sampling: [
        { option: 'Clear the sample', steps: ['master-use licence from the label or master owner', 'mechanical/publishing licence from the publisher'], approver: 'master owner and publisher', documents: ['signed master licence', 'signed publishing licence'] },
        { option: 'Interpolate (re-record the part)', steps: ['publishing licence only; no master licence needed because the original recording is not used'], approver: 'publisher', documents: ['signed publishing licence'] },
        { option: 'Use a licensed sample pack', steps: ['confirm the pack\'s licence allows commercial release', 'keep the licence and receipt'], approver: 'none beyond the licence terms', documents: ['licence text', 'receipt'] },
        { option: 'Make an original part in the same style', steps: ['compose new material; a style is not protected, specific melodies and recordings are'], approver: 'none', documents: ['dated project files'] },
      ],
    },
  },
  {
    id: 'us-17usc107', jurisdiction: 'us', level: 'federal', kind: 'LAW', source: 'us_code',
    citation: '17 U.S.C. § 107', title: 'Fair use', subjects: ['copyright', 'defenses'],
    effective: '1978-01-01', amended: null, repealed: null, applies: 'United States',
    url: 'https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title17-section107&num=0&edition=prelim', confidence: 'high',
    summary: 'Fair use is a defence decided case by case on four factors: the purpose and character of the use, the nature of the work, the amount used, and the effect on the market for the original.',
    rules: [{ activity: 'copyright_use', effect: 'permits', what: 'some uses without permission when the four factors favour fair use', exposure: [], uncertain: true }],
  },
  {
    id: 'us-17usc507b', jurisdiction: 'us', level: 'federal', kind: 'LAW', source: 'us_code',
    citation: '17 U.S.C. § 507(b)', title: 'Limitations on civil copyright actions', subjects: ['copyright', 'deadlines'],
    effective: '1978-01-01', amended: null, repealed: null, applies: 'United States',
    url: 'https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title17-section507&num=0&edition=prelim', confidence: 'high',
    summary: 'A civil copyright claim must be started within three years after it accrued.',
    rules: [{ activity: 'limitation', effect: 'requires', what: 'a civil copyright suit to be filed within three years after the claim accrued', exposure: [] }],
  },
  {
    id: 'us-bridgeport-2005', jurisdiction: 'us', level: 'federal', kind: 'COURT', source: 'us_courts', circuit: '6',
    citation: 'Bridgeport Music, Inc. v. Dimension Films, 410 F.3d 792 (6th Cir. 2005)', title: 'No de minimis defence for sampled sound recordings', subjects: ['sampling', 'copyright'],
    effective: '2005-06-03', amended: null, repealed: null, applies: 'Sixth Circuit: Kentucky, Michigan, Ohio, Tennessee', url: null, confidence: 'high',
    summary: 'In the Sixth Circuit, copying any part of a sound recording, however small, can infringe the master. "Get a license or do not sample."',
    rules: [{ activity: 'sampling', effect: 'prohibits', what: 'relying on a sample being too short to matter (no de minimis defence for the master)', exposure: ['civil'] }],
    conflicts_with: ['us-vmg-2016'],
  },
  {
    id: 'us-vmg-2016', jurisdiction: 'us', level: 'federal', kind: 'COURT', source: 'us_courts', circuit: '9',
    citation: 'VMG Salsoul, LLC v. Ciccone, 824 F.3d 871 (9th Cir. 2016)', title: 'De minimis copying of a sound recording can be lawful', subjects: ['sampling', 'copyright'],
    effective: '2016-06-02', amended: null, repealed: null, applies: 'Ninth Circuit: Alaska, Arizona, California, Hawaii, Idaho, Montana, Nevada, Oregon, Washington, Guam, Northern Mariana Islands', url: null, confidence: 'high',
    summary: 'In the Ninth Circuit, a sample so small that an average listener would not recognise it can be a non-infringing de minimis use.',
    rules: [{ activity: 'sampling', effect: 'permits', what: 'a truly unrecognisable, trivial sample as de minimis (master side)', exposure: [], uncertain: true }],
    conflicts_with: ['us-bridgeport-2005'],
  },
  {
    id: 'us-18usc2511', jurisdiction: 'us', level: 'federal', kind: 'LAW', source: 'us_code',
    citation: '18 U.S.C. § 2511(2)(d)', title: 'Federal Wiretap Act: one-party consent', subjects: ['recording', 'privacy'],
    effective: '1968-06-19', amended: null, repealed: null, applies: 'United States',
    url: 'https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title18-section2511&num=0&edition=prelim', confidence: 'high',
    summary: 'Federal law allows recording a conversation you are part of, or one where one party consented, unless the recording is made to commit a crime or a tort.',
    rules: [
      { activity: 'recording', effect: 'permits', what: 'recording a conversation you take part in', when: { party_to_conversation: true }, exposure: [] },
      { activity: 'recording', effect: 'prohibits', what: 'recording a conversation you are not part of without anyone\'s consent', when: { party_to_conversation: false }, exposure: ['criminal', 'civil'] },
    ],
  },
  {
    id: 'us-la-15-1303', jurisdiction: 'us-la', level: 'state', kind: 'LAW', source: 'la_legislature',
    citation: 'La. R.S. 15:1303', title: 'Louisiana Electronic Surveillance Act: interception and its exceptions', subjects: ['recording', 'privacy'],
    effective: null, amended: null, repealed: null, applies: 'Louisiana', url: null, confidence: 'medium',
    summary: 'Louisiana follows a one-party consent rule: a person who is a party to the conversation, or has one party\'s consent, may record it, unless it is done to commit a crime or tort.',
    rules: [
      { activity: 'recording', effect: 'permits', what: 'recording a conversation you take part in', when: { party_to_conversation: true }, exposure: [] },
      { activity: 'recording', effect: 'prohibits', what: 'intercepting a conversation you are not part of without consent', when: { party_to_conversation: false }, exposure: ['criminal', 'civil'] },
    ],
  },
  {
    id: 'us-ca-pen-632', jurisdiction: 'us-ca', level: 'state', kind: 'LAW', source: 'ca_leginfo',
    citation: 'Cal. Penal Code § 632', title: 'Eavesdropping on or recording confidential communications', subjects: ['recording', 'privacy'],
    effective: '1967-01-01', amended: null, repealed: null, applies: 'California',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PEN&sectionNum=632', confidence: 'high',
    summary: 'California requires the consent of every party before recording a confidential communication, even one you take part in. Penal Code § 637.2 also gives the people recorded a civil claim.',
    rules: [{ activity: 'recording', effect: 'requires', what: 'the consent of everyone in a confidential conversation, even when you are part of it', exposure: ['criminal', 'civil'] }],
    alternatives: {
      recording: [
        { option: 'Ask everyone for consent at the start', steps: ['say the call is being recorded and get a yes before recording'], approver: 'every party', documents: ['the consent captured at the start of the recording'] },
        { option: 'Take notes instead', steps: ['write notes during or right after the conversation, dated'], approver: 'none', documents: ['dated notes'] },
        { option: 'Move it to writing', steps: ['confirm what was said by email or text so there is a written record'], approver: 'none', documents: ['the written confirmation'] },
      ],
    },
  },
  {
    id: 'us-16cfr255', jurisdiction: 'us', level: 'federal', kind: 'AGENCY_GUIDANCE', source: 'ecfr',
    citation: '16 C.F.R. Part 255', title: 'FTC Guides Concerning the Use of Endorsements and Testimonials in Advertising', subjects: ['advertising', 'endorsements'],
    effective: '1980-01-18', amended: '2023-07-26', repealed: null, applies: 'United States', ecfr: { title: 16, part: 255 },
    url: 'https://www.ecfr.gov/current/title-16/chapter-I/subchapter-B/part-255', confidence: 'high',
    summary: 'The FTC\'s endorsement guides say a paid or otherwise material connection between an endorser and a brand must be disclosed clearly. They are guidance on how the FTC applies Section 5 of the FTC Act, so the exposure is regulatory enforcement, not a crime.',
    rules: [{ activity: 'endorsement', effect: 'requires', what: 'a clear, hard-to-miss disclosure of any paid or material connection in the post itself', exposure: ['regulatory'] }],
    alternatives: { endorsement: [{ option: 'Disclose plainly', steps: ['put "Ad" or "Paid partnership with <brand>" where viewers see it before the "more" cut', 'also say it in a video, not only in the description'], approver: 'none', documents: ['the brand agreement'] }] },
  },
  {
    id: 'us-15usc1125a', jurisdiction: 'us', level: 'federal', kind: 'LAW', source: 'us_code',
    citation: '15 U.S.C. § 1125(a)', title: 'Lanham Act: false designation of origin', subjects: ['trademark', 'names'],
    effective: '1947-07-05', amended: null, repealed: null, applies: 'United States',
    url: 'https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title15-section1125&num=0&edition=prelim', confidence: 'high',
    summary: 'Using a name or mark in commerce that is likely to confuse people about who is behind a product or service can be challenged, even if the other side never registered it.',
    rules: [{ activity: 'trademark', effect: 'requires', what: 'a name that is not likely to be confused with someone already using a similar name for similar goods or services', exposure: ['civil'] }],
    alternatives: { trademark: [{ option: 'Search before you commit', steps: ['search the USPTO trademark database and streaming services for the name', 'pick a name with no confusingly similar use in music'], approver: 'none', documents: ['search results, dated'] }, { option: 'Register it', steps: ['file a federal trademark application for the name in your class of goods and services'], approver: 'USPTO', documents: ['application', 'specimens of use'] }] },
  },
  {
    id: 'gb-cdpa-s30', jurisdiction: 'gb', level: 'national', kind: 'LAW', source: 'uk_legislation',
    citation: 'Copyright, Designs and Patents Act 1988, s. 30', title: 'Criticism, review, quotation and news reporting', subjects: ['copyright', 'defenses'],
    effective: '1989-08-01', amended: '2014-10-01', repealed: null, applies: 'United Kingdom',
    url: 'https://www.legislation.gov.uk/ukpga/1988/48/section/30', confidence: 'high',
    summary: 'UK "fair dealing" is narrower than U.S. fair use: specific purposes only (criticism, review, quotation, news reporting), with sufficient acknowledgement, and the use must be fair.',
    versions: [
      { from: '1989-08-01', to: '2014-09-30', summary: 'Fair dealing for criticism or review, and news reporting. No general quotation exception.' },
      { from: '2014-10-01', to: null, summary: 'A general quotation exception was added (The Copyright and Rights in Performances (Quotation and Parody) Regulations 2014, SI 2014/2356).' },
    ],
    rules: [{ activity: 'copyright_use', effect: 'permits', what: 'quoting or using a work for criticism, review, quotation or news reporting, if fair and acknowledged', exposure: [], uncertain: true }],
  },
  {
    id: 'eu-gdpr', jurisdiction: 'eu', level: 'supranational', kind: 'REGULATION', source: 'eurlex',
    citation: 'Regulation (EU) 2016/679 (GDPR)', title: 'General Data Protection Regulation', subjects: ['privacy', 'personal data'],
    effective: '2018-05-25', amended: null, repealed: null, applies: 'EU member states, and businesses elsewhere that offer goods or services to, or monitor, people in the EU',
    url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679', confidence: 'high',
    summary: 'Personal data of people in the EU needs a lawful basis (Article 6), clear information to the people concerned, and security. Fines are administrative (Article 83).',
    rules: [{ activity: 'personal_data', effect: 'requires', what: 'a lawful basis such as consent, clear privacy information, and a way for people to exercise their rights', exposure: ['regulatory', 'civil'] }],
    alternatives: { personal_data: [{ option: 'Collect with clear consent', steps: ['an unticked opt-in with a plain explanation', 'a privacy notice linked at the point of collection', 'an unsubscribe and delete path'], approver: 'none', documents: ['privacy notice', 'consent records'] }] },
  },
  {
    id: 'eu-dir-95-46', jurisdiction: 'eu', level: 'supranational', kind: 'LAW', source: 'eurlex',
    citation: 'Directive 95/46/EC', title: 'Data Protection Directive', subjects: ['privacy', 'personal data'],
    effective: '1995-12-13', amended: null, repealed: '2018-05-25', repealed_by: 'Regulation (EU) 2016/679 (GDPR), Article 94', applies: 'European Union',
    url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:31995L0046', confidence: 'high',
    summary: 'The EU\'s earlier data-protection directive. Repealed when the GDPR applied.',
    rules: [{ activity: 'personal_data', effect: 'requires', what: 'national data-protection compliance (historical)', exposure: ['regulatory'] }],
  },
  {
    id: 'eu-ai-act-art6-1', jurisdiction: 'eu', level: 'supranational', kind: 'REGULATION', source: 'eurlex',
    citation: 'Regulation (EU) 2024/1689 (AI Act), Article 6(1)', title: 'High-risk AI in products covered by EU product-safety law', subjects: ['ai', 'product safety'],
    effective: '2027-08-02', amended: null, repealed: null, applies: 'European Union',
    url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689', confidence: 'medium',
    pending_change: 'A 2025 European Commission proposal would postpone some high-risk obligations; check live before relying on this date.',
    summary: 'AI systems that are safety components of products already regulated by EU product-safety law are high-risk, with obligations applying from 2 August 2027 under Article 113.',
    rules: [{ activity: 'ai_systems', effect: 'requires', what: 'high-risk AI obligations (risk management, documentation, conformity assessment) for covered products', exposure: ['regulatory'] }],
  },
  {
    id: 'ca-copyright-s29', jurisdiction: 'ca', level: 'federal', kind: 'LAW', source: 'ca_justice',
    citation: 'Copyright Act, R.S.C. 1985, c. C-42, s. 29', title: 'Fair dealing for research, private study, education, parody or satire', subjects: ['copyright', 'defenses'],
    effective: '1985-01-01', amended: '2012-11-07', repealed: null, applies: 'Canada',
    url: 'https://laws-lois.justice.gc.ca/eng/acts/C-42/section-29.html', confidence: 'high',
    summary: 'Canada allows fair dealing for research, private study, education, parody or satire; education, parody and satire were added by the Copyright Modernization Act in 2012.',
    rules: [{ activity: 'copyright_use', effect: 'permits', what: 'dealing with a work for research, private study, education, parody or satire, if fair', exposure: [], uncertain: true }],
  },
]);

// Official places to check for activities the index does not cover yet, per jurisdiction. Never a rule.
const WHERE_TO_CHECK = {
  business_license: { us: ['sba'], 'us-la': ['la_geauxbiz'], 'us-la-new-orleans': ['nola_onestop', 'municode'] },
  sales_tax: { us: ['sba'] },
};

// ─── Time ─────────────────────────────────────────────────────────────────

/// The status of a record on a date. A pending change or litigation makes it uncertain, never silently current.
export function statusOn(record, date = new Date()) {
  const day = new Date(date).toISOString().slice(0, 10);
  if (record.repealed && record.repealed <= day) return STATUS.repealed;
  if (record.expires && record.expires <= day) return STATUS.repealed;
  if (record.enjoined) return STATUS.uncertain;
  if (!record.effective) return record.confidence === 'high' ? STATUS.effective : STATUS.unknown;
  if (record.effective > day) return STATUS.future;
  return STATUS.effective;
}

/// The version of a record that applied on a date, when the index keeps versions.
export function versionOn(record, date = new Date()) {
  const day = new Date(date).toISOString().slice(0, 10);
  return (record.versions || []).find((v) => v.from <= day && (!v.to || v.to >= day)) || null;
}

// ─── Retrieval ────────────────────────────────────────────────────────────

/// Records about an activity that apply in a place: its own layer and every layer above it. A court decision
/// counts only in its own circuit; it is still returned for other places as a conflict note, marked not binding.
export function recordsFor(activity, jurisdictionId, { records = LEGAL_INDEX } = {}) {
  const chain = jurisdictionChain(jurisdictionId).map((j) => j.id);
  const state = chain.find((id) => /^us-[a-z]{2}$/.test(id));
  const circuit = state ? circuitOf(state) : null;
  return records
    .filter((r) => (r.rules || []).some((rule) => rule.activity === activity) || (r.alternatives && r.alternatives[activity]))
    .filter((r) => chain.includes(r.jurisdiction))
    .map((r) => ({ ...r, binding: r.kind === 'COURT' && r.circuit ? r.circuit === circuit : true }));
}

// ─── Live verification ────────────────────────────────────────────────────

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const stripTags = (html) => String(html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/// Reads a record's official source now. Returns what was read, when, a hash of the text, an amendment date
/// when the source states one, and whether the text changed since the last check. A failed read says so; the
/// answer then falls back to "last verified" or "not checked live", never to "current".
export async function verifyRecord(record, { fetcher = fetch, now = new Date(), previous = null, timeoutMs = 8000 } = {}) {
  const src = source(record.source);
  if (!src?.adapter || !record.url) {
    return { id: record.id, verified: false, why: src ? `${src.name} has no live reader in CHE yet` : 'no official source registered', retrieved: null };
  }
  const url = src.adapter === 'ecfr' && record.ecfr
    ? `https://www.ecfr.gov/api/versioner/v1/versions/title-${record.ecfr.title}.json?part=${record.ecfr.part}`
    : src.adapter === 'uk' ? `${record.url}/data.xml` : record.url;
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'CHE legal research (owner assistant)' } });
    if (!res.ok) return { id: record.id, verified: false, why: `${src.name} answered ${res.status}`, retrieved: null };
    const body = await res.text();
    let amended = null;
    let text = '';
    if (src.adapter === 'ecfr') {
      const versions = JSON.parse(body).content_versions || [];
      amended = versions.map((v) => v.amendment_date || v.date).filter(Boolean).sort().at(-1) || null;
      text = JSON.stringify(versions.map((v) => [v.identifier, v.amendment_date || v.date]));
    } else if (src.adapter === 'uk') {
      amended = (body.match(/<dc:modified>([^<]+)<\/dc:modified>/) || [])[1] || null;
      text = stripTags(body);
    } else {
      text = stripTags(body);
      const stated = text.match(/(?:Last amended on|Amended by Stats\.?|Effective)\s+([A-Z][a-z]+ \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2})/);
      amended = stated ? stated[1] : null;
    }
    if (src.adapter === 'ecfr' ? text === '[]' : text.length < 40) return { id: record.id, verified: false, why: `${src.name} returned no readable text`, retrieved: null };
    const hash = await sha256(text);
    return {
      id: record.id, verified: true, source: src.name, url, retrieved: new Date(now).toISOString(), hash, amended,
      changed: previous?.hash ? previous.hash !== hash : false,
      excerpt: clip(text, 1200),
    };
  } catch (err) {
    return { id: record.id, verified: false, why: `${src.name} could not be reached (${clip(err?.message || err, 80)})`, retrieved: null };
  }
}

// ─── Reasoning ────────────────────────────────────────────────────────────

const LEVEL_ORDER = { city: 0, parish: 1, county: 1, special_district: 1, state: 2, territory: 2, nation: 2, national: 3, federal: 3, supranational: 4 };

/// Applies the effective rules to the facts. Returns the risk level, the governing rules, the facts that would
/// change the answer and any conflict. Where both a state and a federal rule apply, the stricter one governs.
export function assess(activity, records, { facts = {}, date = new Date() } = {}) {
  const used = [];
  const notes = [];
  const askFor = new Set();
  let conflict = null;
  const live = records.filter((r) => {
    const st = statusOn(r, date);
    if (st === STATUS.repealed) { notes.push(`${r.citation} was repealed on ${r.repealed}${r.repealed_by ? ` (${r.repealed_by})` : ''}; it no longer applies.`); return false; }
    if (st === STATUS.future) { notes.push(`${r.citation} takes effect on ${r.effective}${r.pending_change ? `. ${r.pending_change}` : ''}; it does not apply yet.`); return false; }
    return true;
  });
  const effects = [];
  for (const r of live) {
    for (const rule of (r.rules || []).filter((x) => x.activity === activity)) {
      const cond = rule.when ? Object.entries(rule.when) : [];
      const unknown = cond.filter(([k]) => facts[k] === undefined || facts[k] === null);
      if (unknown.length) { unknown.forEach(([k]) => askFor.add(k)); continue; }
      if (cond.some(([k, v]) => facts[k] !== v)) continue;
      if (r.kind === 'COURT' && !r.binding) continue;
      effects.push({ record: r, rule });
      used.push(r);
    }
  }
  for (const r of records) {
    if (!r.conflicts_with) continue;
    const other = records.find((x) => r.conflicts_with.includes(x.id)) || LEGAL_INDEX.find((x) => r.conflicts_with.includes(x.id));
    if (other && !conflict) conflict = { a: r, b: other, binding: [r, other].filter((x) => x.binding !== false && records.some((y) => y.id === x.id && y.binding)) };
  }
  const restrictive = effects.filter((e) => e.rule.effect === 'prohibits' || e.rule.effect === 'requires');
  const permissive = effects.filter((e) => e.rule.effect === 'permits');
  let level;
  if (!effects.length) level = askFor.size ? RISK_LEVELS.uncertain : null;
  else if (restrictive.some((e) => e.rule.effect === 'prohibits' && e.record.confidence === 'high' && !e.rule.uncertain)) level = RISK_LEVELS.prohibited;
  else if (restrictive.length) level = RISK_LEVELS.likely_restricted;
  else if (permissive.some((e) => e.rule.uncertain)) level = RISK_LEVELS.uncertain;
  else level = permissive.every((e) => e.record.confidence === 'high') ? RISK_LEVELS.permitted : RISK_LEVELS.likely_permitted;
  // Conflicting courts unsettle a permission, never a requirement that a statute states on its own.
  if (conflict && !conflict.binding.length && [RISK_LEVELS.permitted, RISK_LEVELS.likely_permitted].includes(level)) level = RISK_LEVELS.uncertain;
  // The governing rule: the most local restrictive one, else the most local permissive one.
  const byLocal = (a, b) => (LEVEL_ORDER[a.record.level] ?? 9) - (LEVEL_ORDER[b.record.level] ?? 9);
  const governing = [...restrictive].sort(byLocal)[0] || [...permissive].sort(byLocal)[0] || null;
  return { level, governing, effects, used: [...new Set(used)], notes, ask: [...askFor], conflict };
}

const FACT_QUESTIONS = {
  party_to_conversation: 'Will you be part of the conversation you record?',
};

/// The lawful ways to reach the same goal, from the records that restrict the first idea.
export function findAlternatives({ activity, records, goal = null }) {
  const out = [];
  for (const r of records) for (const alt of (r.alternatives?.[activity] || [])) {
    if (!out.some((o) => o.option === alt.option)) out.push({ ...alt, basis: r.citation, cost_time: alt.cost_time || 'not verified; depends on the rights holder or agency' });
  }
  return { goal, alternatives: out };
}

// ─── Owner-facing answer ──────────────────────────────────────────────────

const exposureWords = (list) => [...new Set(list)].map((x) => EXPOSURE[x] || x).join(' and ');
const verdictLine = {
  [RISK_LEVELS.permitted]: 'Yes, this looks allowed.',
  [RISK_LEVELS.likely_permitted]: 'Probably yes.',
  [RISK_LEVELS.uncertain]: 'It depends.',
  [RISK_LEVELS.likely_restricted]: 'Likely not this way.',
  [RISK_LEVELS.prohibited]: 'No, not this way.',
  [RISK_LEVELS.lawyer]: 'This needs an attorney\'s review.',
};

/// "Can I do this?" A compact answer: verdict, the rule in plain words, the lawful option, confidence and when
/// it was checked. Sources and the full reasoning are returned alongside for the Sources/Why views.
export function legalAnswer(question, { jurisdictionId = null, facts = {}, date = new Date(), records = LEGAL_INDEX, verified = {}, activity = null } = {}) {
  const act = activity || activitiesIn(question)[0] || null;
  const place = jurisdictionId ? jurisdiction(jurisdictionId) : null;
  if (!act) return { status: 'no_activity', text: 'What are you planning to do? Tell me the activity and where, and I will check the rule that applies.' };
  if (!place) return { status: 'need_place', activity: act, text: `Where will you be doing this? The answer for ${ACTIVITIES[act].name.toLowerCase()} depends on the state or country.` };
  const chain = jurisdictionChain(place.id);
  const found = recordsFor(act, place.id, { records });
  const day = new Date(date).toISOString().slice(0, 10);
  const gaps = chain.filter((j) => j.status === COVERAGE.none || ['city', 'parish', 'county'].includes(j.level) && j.coverage.local === 'none');
  const gapLine = gaps.length ? `I have not indexed ${gaps.map((j) => `${j.name}${['city', 'parish', 'county'].includes(j.level) ? ' local ordinances' : ' law'}`).join(' or ')}${gaps.some((g) => g.coverage.official_source) ? ` (official source: ${gaps.map((g) => g.coverage.official_source).filter(Boolean).join(', ')})` : ''}.` : '';
  if (!found.length) {
    const where = Object.entries(WHERE_TO_CHECK[act] || {}).filter(([j]) => chain.some((c) => c.id === j)).flatMap(([, ids]) => ids).map((id) => source(id)).filter(Boolean);
    return {
      status: 'coverage_gap', activity: act, jurisdiction: place.id, risk: RISK_LEVELS.uncertain, confidence: 'none',
      text: [
        `I don't have the rule for ${ACTIVITIES[act].name.toLowerCase()} in ${place.name} indexed yet, so I won't guess.`,
        where.length ? `Official places to check: ${where.map((s) => `${s.name} (${s.base})`).join('; ')}.` : 'I have no official source registered for it yet.',
        'I can research it live from official sources if you want.',
      ].join(' '),
      sources: where.map((s) => ({ name: s.name, url: s.base, tier: s.tier })), checked: null,
    };
  }
  const a = assess(act, found, { facts, date });
  const alts = findAlternatives({ activity: act, records: found });
  const used = a.used.length ? a.used : found.filter((r) => statusOn(r, date) === STATUS.effective);
  const live = used.filter((r) => verified[r.id]?.verified);
  const checked = live.length ? `Checked live today against ${[...new Set(live.map((r) => source(r.source)?.name))].join(', ')}` : used.some((r) => verified[r.id]?.retrieved) ? `Last verified ${used.map((r) => verified[r.id]?.retrieved).filter(Boolean).sort().at(-1).slice(0, 10)}` : 'From CHE\'s index; not checked live today';
  const confidence = !a.governing ? 'low' : a.conflict && !a.conflict.binding.length ? 'medium' : live.length && a.governing.record.confidence === 'high' ? 'high' : a.governing.record.confidence === 'high' ? 'medium-high' : 'medium';
  const lines = [];
  const needQuestion = /\b(?:do i need|do we need|must i|must we|have to|is it required|required to)\b/i.test(question);
  const effect = a.governing?.rule.effect;
  const notYet = !a.governing && !a.ask.length && a.notes.some((n) => /does not apply yet/.test(n));
  lines.push(a.ask.length && !a.governing ? 'It depends on one fact.'
    : notYet ? 'Not yet: the rule is not in force.'
    : needQuestion && effect === 'requires' ? 'Yes, it is required.'
    : needQuestion && effect === 'permits' ? 'No, it is not required.'
    : effect === 'requires' ? 'Not as is: there is a requirement first.'
    : verdictLine[a.level] || 'It depends.');
  if (a.governing) {
    const r = a.governing.record;
    const kind = RESTRICTION_KINDS[r.kind] || 'law';
    lines.push(`${(jurisdiction(r.jurisdiction)?.name || r.applies).replace(/ \((?:federal|Commonwealth)\)$/, '')} ${r.level === 'federal' && r.country !== 'ca' ? 'federal ' : ''}${kind} (${r.citation}) ${a.governing.rule.effect === 'permits' ? 'allows' : a.governing.rule.effect === 'requires' ? 'requires' : 'prohibits'} ${a.governing.rule.what}.`);
    const exp = a.effects.filter((e) => e.rule.effect !== 'permits').flatMap((e) => e.rule.exposure || []);
    if (exp.length) lines.push(`Exposure: ${exposureWords(exp)}.`);
  }
  for (const n of a.notes) lines.push(n);
  if (a.ask.length) lines.push(a.ask.map((k) => FACT_QUESTIONS[k] || `I need to know: ${k.replace(/_/g, ' ')}.`).join(' '));
  if (a.conflict) {
    const bind = a.conflict.binding.map((x) => x.citation);
    lines.push(bind.length
      ? `Courts disagree on this: ${a.conflict.a.citation} and ${a.conflict.b.citation}. ${bind.join(' and ')} binds where you are.`
      : `I found conflicting authority: ${a.conflict.a.citation} and ${a.conflict.b.citation} disagree, and neither binds ${place.name}. Plan as if the stricter rule applies.`);
  }
  if ([RISK_LEVELS.prohibited, RISK_LEVELS.likely_restricted].includes(a.level) && alts.alternatives.length) {
    lines.push(`Legal option: ${alts.alternatives[0].option}: ${alts.alternatives[0].steps.join('; ')}.`);
  }
  if (gapLine) lines.push(gapLine);
  lines.push(`Confidence: ${confidence}. ${checked}.`);
  return {
    status: 'answered', activity: act, jurisdiction: place.id, date: day, risk: a.level, confidence, live_verified: live.length > 0,
    text: lines.join(' '),
    why: { governing: a.governing ? { citation: a.governing.record.citation, effect: a.governing.rule.effect, what: a.governing.rule.what } : null, notes: a.notes, conflict: a.conflict ? [a.conflict.a.citation, a.conflict.b.citation] : null, ask: a.ask, exposure: [...new Set(a.effects.flatMap((e) => e.rule.exposure || []))] },
    sources: used.map((r) => ({ citation: r.citation, title: r.title, kind: RESTRICTION_KINDS[r.kind], jurisdiction: r.jurisdiction, effective: r.effective, status: statusOn(r, date), url: r.url, summary: r.summary, retrieved: verified[r.id]?.retrieved || null, confidence: r.confidence })),
    alternatives: alts.alternatives,
  };
}

// ─── Location: legal differences ──────────────────────────────────────────

/// Compares the rules for the owner's active activities between his usual place and where he is now. Returns
/// only differences that touch an activity he is actually doing and a category he has switched on.
export function legalDifferences({ from, to, activities = [], categories = ALERT_CATEGORIES, facts = {}, date = new Date(), records = LEGAL_INDEX }) {
  const out = [];
  for (const act of activities) {
    if (!ACTIVITIES[act] || !categories.includes(ACTIVITIES[act].category)) continue;
    const here = assess(act, recordsFor(act, to, { records }), { facts, date });
    const home = assess(act, recordsFor(act, from, { records }), { facts, date });
    const key = (x) => x.governing ? `${x.governing.rule.effect}:${x.governing.rule.what}` : 'none';
    if (key(here) === key(home)) continue;
    const toName = jurisdiction(to)?.name || to;
    const fromName = jurisdiction(from)?.name || from;
    const alts = findAlternatives({ activity: act, records: recordsFor(act, to, { records }) }).alternatives;
    out.push({
      activity: act,
      priority: here.level === RISK_LEVELS.prohibited || here.level === RISK_LEVELS.likely_restricted ? PRIORITY.important : PRIORITY.fyi,
      what: here.governing ? `In ${toName}, ${here.governing.record.citation} ${here.governing.rule.effect === 'requires' ? 'requires' : here.governing.rule.effect === 'prohibits' ? 'prohibits' : 'allows'} ${here.governing.rule.what}.` : `I have no indexed rule for this in ${toName}.`,
      why: home.governing ? `In ${fromName} the rule is: ${home.governing.rule.effect} ${home.governing.rule.what}.` : `I have no indexed rule for this in ${fromName}.`,
      lawful_option: alts[0] ? `${alts[0].option}: ${alts[0].steps[0]}.` : null,
      sources: [here.governing?.record.citation, home.governing?.record.citation].filter(Boolean),
    });
  }
  return out;
}

export function speakDifferences(diffs, toName) {
  if (!diffs.length) return `Nothing I have indexed for what you're doing changes in ${toName}.`;
  return diffs.map((d) => `Legal difference (${d.priority}): ${d.what} ${d.why}${d.lawful_option ? ` Lawful option: ${d.lawful_option}` : ''}`).join(' ');
}

// ─── Owner settings, decisions, subscriptions ─────────────────────────────

export const DEFAULT_SETTINGS = Object.freeze({
  proactive_warnings: true,
  location_differences: false,
  business_alerts: true,
  music_alerts: true,
  contract_alerts: true,
  update_checks: false,
  categories: ALERT_CATEGORIES,
  home: null,
  current: null,
});

export async function loadLegal(storage) {
  const saved = (await storage.get('legal_v1')) || {};
  return { settings: { ...DEFAULT_SETTINGS, ...(saved.settings || {}) }, decisions: saved.decisions || [], subscriptions: saved.subscriptions || [], verified: saved.verified || {}, alerts: saved.alerts || [], contracts: saved.contracts || [] };
}
export async function saveLegal(storage, state) {
  // Bounded so the record stays well under the Durable Object value limit.
  state.decisions = state.decisions.slice(-200);
  state.alerts = state.alerts.slice(-50);
  state.contracts = state.contracts.slice(-30);
  await storage.put('legal_v1', state);
}

/// A legal decision on a project: what the issue was, what was decided, and the evidence for it.
export function recordDecision(state, { project = '', issue, decision, evidence = '' }, now = new Date().toISOString()) {
  if (!clip(issue, 300) || !clip(decision, 300)) return { ok: false, why: 'A decision needs the issue and what was decided.' };
  const entry = { id: `ld_${crypto.randomUUID()}`, project: clip(project, 160), issue: clip(issue, 300), decision: clip(decision, 300), evidence: clip(evidence, 300), at: now };
  state.decisions.push(entry);
  return { ok: true, decision: entry };
}

/// Follows a jurisdiction and topic for an active project; update checks read only what is subscribed.
export function subscribe(state, { jurisdiction: jid, activity, project = '' }) {
  if (!jurisdiction(jid) || !ACTIVITIES[activity]) return { ok: false, why: 'A subscription needs a known place and activity.' };
  const key = `${jid}|${activity}|${project}`;
  if (!state.subscriptions.some((s) => s.key === key)) state.subscriptions.push({ key, jurisdiction: jid, activity, project: clip(project, 160) });
  return { ok: true, count: state.subscriptions.length };
}

/// Re-reads the official source of every record that matters to a subscription. A changed text or a newer
/// amendment date becomes an alert for the projects that rely on it; nothing else is re-read.
export async function checkUpdates(state, { fetcher = fetch, now = new Date(), records = LEGAL_INDEX } = {}) {
  const wanted = new Map();
  for (const s of state.subscriptions) for (const r of recordsFor(s.activity, s.jurisdiction, { records })) {
    if (!wanted.has(r.id)) wanted.set(r.id, { record: r, projects: new Set() });
    if (s.project) wanted.get(r.id).projects.add(s.project);
  }
  const results = [];
  for (const { record, projects } of wanted.values()) {
    const previous = state.verified[record.id] || null;
    const v = await verifyRecord(record, { fetcher, now, previous });
    results.push(v);
    if (!v.verified) continue;
    const amendedLater = v.amended && previous?.amended && String(v.amended) > String(previous.amended);
    if (v.changed || amendedLater) {
      state.alerts.push({
        id: `la_${crypto.randomUUID()}`, priority: amendedLater ? PRIORITY.important : PRIORITY.fyi, at: v.retrieved,
        text: `${record.citation} ${amendedLater ? `was amended (${v.amended})` : 'changed at its official source'}. ${projects.size ? `It affects: ${[...projects].join(', ')}.` : ''} Review the change before relying on earlier advice.`,
        record: record.id,
      });
    }
    state.verified[record.id] = { hash: v.hash, amended: v.amended, retrieved: v.retrieved, excerpt: v.excerpt };
  }
  return { checked: results.length, verified: results.filter((r) => r.verified).length, failed: results.filter((r) => !r.verified).map((r) => ({ id: r.id, why: r.why })), alerts: state.alerts.slice(-5) };
}

// ─── Defences ─────────────────────────────────────────────────────────────

/// "Can we defend this?" for a song: the arguments the records support, each graded, never a predicted outcome.
export function defenseArguments({ project, jurisdictionId = 'us', samples = [], date = new Date() }) {
  const m = project?.music || {};
  const out = [];
  const dated = (m.versions || []).filter((v) => v.sha256);
  out.push(dated.length
    ? { grade: 'Strong argument', argument: 'Independent creation and ownership', why: `${dated.length} dated file version${dated.length === 1 ? '' : 's'} with checksums show when the work existed.` }
    : { grade: 'Weak argument', argument: 'Independent creation and ownership', why: 'No dated source files are on record to prove when or how the work was made.' });
  for (const { s, e } of samples) {
    if (e.state === 'documented') out.push({ grade: 'Strong argument', argument: `Licence for ${s.name}`, why: `A documented licence (${s.license_type || 'licence'}) covers it${s.license_ref ? `: ${s.license_ref}` : ''}.` });
    else if (e.state === 'owner' || e.state === 'generated') out.push({ grade: 'Strong argument', argument: `${s.name} is original`, why: 'It is recorded as made by you or by CHE.' });
    else {
      const state = jurisdictionChain(jurisdictionId).find((j) => j.level === 'state');
      const circuit = state ? circuitOf(state.id) : null;
      const deMinimis = circuit === '9' ? 'Possible argument' : circuit === '6' ? 'Weak argument' : 'Unresolved';
      out.push({ grade: 'Weak argument', argument: `Use of ${s.name} without a documented licence`, why: e.problems.concat(e.missing.map((x) => `missing ${x}`)).join('; ') });
      out.push({ grade: deMinimis, argument: `${s.name} is too small to matter (de minimis)`, why: circuit === '9' ? 'VMG Salsoul v. Ciccone (9th Cir. 2016) allows it for unrecognisable uses.' : circuit === '6' ? 'Bridgeport v. Dimension Films (6th Cir. 2005) rejects it for sound recordings.' : 'The circuits are split (Bridgeport, 6th Cir. 2005; VMG Salsoul, 9th Cir. 2016) and your circuit has not decided it in CHE\'s index.' });
      out.push({ grade: 'Unresolved', argument: `Fair use for ${s.name}`, why: '17 U.S.C. § 107 is decided case by case; commercial sampling of a recognisable part rarely succeeds, and nothing on file shows commentary or transformation.' });
    }
  }
  if (m.dispute) out.push({ grade: 'Unresolved', argument: 'The open dispute', why: `${m.dispute}. Deadline note: a civil copyright claim must be filed within three years after it accrued (17 U.S.C. § 507(b)).` });
  const serious = out.some((a) => a.grade === 'Weak argument' && /without a documented licence/.test(a.argument)) || m.dispute;
  return { arguments: out, attorney: Boolean(serious), note: 'These are arguments the records support, not a prediction of how a court would rule.' };
}

/// The legal side of "can we release this?": the music rights checklist already covers samples and splits; this adds
/// agreements for every credited contributor and turns open items into one line each.
export function releaseLegalCheck(project) {
  const m = project?.music || {};
  const items = [];
  const credited = (m.splits || []).filter((r) => r && r.name && !/^(?:me|owner|myself)$/i.test(r.name));
  const agreements = m.agreements || [];
  for (const c of credited) {
    const has = agreements.some((a) => a.with && a.with.toLowerCase() === String(c.name).toLowerCase() && a.status === 'signed');
    if (!has && c.agreement !== 'signed') items.push({ priority: PRIORITY.important, text: `No signed agreement with ${c.name} (${c.role || c.group}).` });
  }
  if (m.distribution && m.distribution.terms_accepted_by_owner !== true) items.push({ priority: PRIORITY.important, text: `The ${m.distribution.name || 'distributor'} terms have not been accepted by you.` });
  return { ok: items.length === 0, items };
}

// ─── Words ────────────────────────────────────────────────────────────────

/// "Is this legal?", "Can I record somebody here?", "What law applies?", "How can I do this legally?",
/// "I'm going to Texas, does anything change?", legal settings, decisions and update checks.
export function legalIntent(message) {
  const t = String(message || '').trim().replace(/[.!?]+$/, '');
  if (!t) return null;
  if (/\b(?:turn|switch)\s+(on|off)\s+(?:the\s+)?(?:location[- ]aware |location )?legal (?:differences?|alerts?|warnings?)\b/i.test(t)) {
    return { kind: 'setting', key: /location/i.test(t) ? 'location_differences' : 'proactive_warnings', value: /\bon\b/i.test(t.match(/\b(on|off)\b/i)[0]) };
  }
  let m = t.match(/\bmy home (?:state|country|jurisdiction) is\s+(.+)$/i);
  if (m && placeIn(m[1])) return { kind: 'home', place: placeIn(m[1]) };
  m = t.match(/\bi(?:'m| am)\s+(?:now\s+)?(?:in|going to|traveling to|travelling to|heading to|driving to)\s+(.+?)(?:\s*[,;-]\s*|\s+)(?:(?:is|does|did)\s+)?(?:there\s+)?(?:anything|something)\b/i)
    || t.match(/\bi(?:'m| am)\s+(?:now\s+)?in\s+(.+?)\s+now\b/i);
  if (m && placeIn(m[1])) return { kind: 'location', place: placeIn(m[1]) };
  if (/\b(?:legal decisions?|legal history|legal log)\b/i.test(t)) return { kind: 'decisions' };
  if (/\b(?:check|any)\s+(?:for\s+)?legal (?:updates|changes)\b|\blaw changes?\b.*\b(?:my|our) (?:business|projects?)\b/i.test(t)) return { kind: 'updates' };
  m = t.match(/\blegal coverage (?:for|in)\s+(.+)$/i);
  if (m) return { kind: 'coverage', place: placeIn(m[1]) };
  const legalWords = /\b(?:legal(?:ly)?|illegal|lawful(?:ly)?|unlawful|law|laws|allowed to|permitted|permit|licen[cs]e|get (?:me )?in trouble|can i|can we|am i allowed|do i need|what applies)\b/i.test(t);
  const acts = activitiesIn(t);
  if (!legalWords || !acts.length) {
    if (/\b(?:is (?:this|that|it) legal|what law applies|is (?:this|that) allowed)\b/i.test(t)) return { kind: 'ask', activities: [], place: placeIn(t) };
    return null;
  }
  const alt = /\b(?:legal way|legally|lawful way|same (?:goal|thing) legally|how (?:can|could) i\b.*\blegal)/i.test(t);
  const facts = {};
  if (/\b(?:my own|i(?:'m| am) (?:on|part of|in) (?:the|that|this) (?:call|conversation)|(?:call|conversation|meeting)s? i(?:'m| am) (?:on|in|part of)|with me|between me and)\b/i.test(t)) facts.party_to_conversation = true;
  if (/\b(?:other people'?s|i(?:'m| am) not (?:on|part of|in))\b/i.test(t)) facts.party_to_conversation = false;
  return { kind: alt ? 'alternative' : 'ask', activities: acts, place: placeIn(t), here: /\bhere\b/i.test(t), facts };
}
