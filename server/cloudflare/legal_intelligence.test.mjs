import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGAL_INDEX, JURISDICTIONS, COVERAGE, STATUS, RISK_LEVELS, jurisdictionChain, placeIn, legalAnswer, statusOn, versionOn,
  verifyRecord, findAlternatives, recordsFor, legalDifferences, legalIntent, defenseArguments, releaseLegalCheck,
  checkUpdates, subscribe, recordDecision, circuitOf,
} from './legal_intelligence.js';
import { analyzeContract, FLAG } from './legal_contracts.js';
import { evaluateSample } from './music_rights.js';
import { addBeat, recordBeatSale, exclusiveCheck } from './music_business.js';

const TODAY = new Date('2026-10-22T12:00:00Z');

// Every case records what the owner asked for in the report: place, date, source, citation, answer, confidence and
// whether the official source was read live.
const report = [];
function row(name, a, { live = false } = {}) {
  assert.ok(a.jurisdiction, `${name}: jurisdiction`);
  assert.ok(a.date, `${name}: date`);
  assert.ok(a.text, `${name}: answer`);
  report.push({ test: name, jurisdiction: a.jurisdiction, date: a.date, sources: (a.sources || []).map((s) => s.citation || s.name), answer: a.text, confidence: a.confidence, live_verified: Boolean(a.live_verified) || live });
}

// Test-only records for layers CHE has not indexed from an official source yet. They exercise the engine; they are
// not law and never ship in LEGAL_INDEX.
const FIXTURE = (r) => ({ confidence: 'high', amended: null, repealed: null, url: null, applies: '', fixture: true, ...r });
const PARISH = FIXTURE({ id: 'fx-orleans-noise', jurisdiction: 'us-la-orleans', level: 'parish', kind: 'LOCAL_CODE', source: 'municode', citation: 'FIXTURE Orleans Parish noise rule', title: 'Amplified sound after 10 p.m.', effective: '2020-01-01', rules: [{ activity: 'alcohol', effect: 'requires', what: 'a parish permit for amplified sound after 10 p.m. (fixture)', exposure: ['regulatory'] }] });
const CITY = FIXTURE({ id: 'fx-nola-home-business', jurisdiction: 'us-la-new-orleans', level: 'city', kind: 'LOCAL_CODE', source: 'municode', citation: 'FIXTURE New Orleans home occupation rule', title: 'Home occupations', effective: '2019-01-01', rules: [{ activity: 'business_license', effect: 'requires', what: 'an occupational licence and a home-occupation permit (fixture)', exposure: ['licensing'] }], alternatives: { business_license: [{ option: 'Apply through One Stop', steps: ['file the occupational licence', 'file the home-occupation permit'], approver: 'City of New Orleans', documents: ['ID', 'LLC filing'] }] } });
const PLATFORM = FIXTURE({ id: 'fx-platform', jurisdiction: 'us', level: 'federal', kind: 'PLATFORM_RULE', source: 'ftc', citation: 'FIXTURE streaming platform paid-promotion setting', title: 'Platform disclosure setting', effective: '2020-01-01', rules: [{ activity: 'endorsement', effect: 'requires', what: 'ticking the platform\'s paid-promotion box (fixture)', exposure: ['platform'] }] });

// A fake official source: returns fixed text per host, counting reads.
function officialSources(pages) {
  const seen = [];
  const fetcher = async (url) => {
    const u = String(url);
    seen.push(u);
    const hit = Object.entries(pages).find(([k]) => u.includes(k));
    if (!hit) return new Response('not found', { status: 404 });
    return new Response(hit[1], { status: 200 });
  };
  return { fetcher, seen };
}

test('the jurisdiction registry: layered U.S. places, the EU over its members, and honest coverage', () => {
  assert.deepEqual(jurisdictionChain('us-la-new-orleans').map((j) => j.level), ['city', 'parish', 'state', 'federal']);
  assert.deepEqual(jurisdictionChain('fr').map((j) => j.id), ['fr', 'eu']);
  assert.equal(JURISDICTIONS.filter((j) => /^us-[a-z]{2}$/.test(j.id)).length, 56, '50 states, D.C. and 5 territories');
  assert.ok(!JURISDICTIONS.some((j) => j.status === COVERAGE.full), 'nothing claims full coverage');
  assert.equal(JURISDICTIONS.find((j) => j.id === 'us-wy').status, COVERAGE.none);
  assert.equal(circuitOf('us-la'), '5');
  assert.equal(placeIn('I am going to Texas'), 'us-tx');
  assert.equal(placeIn('in new orleans tonight'), 'us-la-new-orleans');
  assert.equal(placeIn('in a while or later'), null, 'small words are not states');
});

test('1. U.S. federal rule: recording a call you are on, federal law alone', () => {
  const a = legalAnswer('Can I record a call I am on?', { jurisdictionId: 'us', facts: { party_to_conversation: true }, date: TODAY });
  assert.equal(a.risk, RISK_LEVELS.permitted);
  assert.match(a.text, /18 U\.S\.C\. § 2511\(2\)\(d\)/);
  row('U.S. federal rule', a);
});

test('2. U.S. state law: California needs everyone\'s consent, with a lawful option, criminal and civil exposure named', () => {
  const a = legalAnswer('Can I record a call I am on?', { jurisdictionId: 'us-ca', facts: { party_to_conversation: true }, date: TODAY });
  assert.equal(a.risk, RISK_LEVELS.likely_restricted);
  assert.match(a.text, /Cal\. Penal Code § 632/);
  assert.match(a.text, /criminal exposure and civil liability/);
  assert.match(a.text, /Legal option: Ask everyone for consent/);
  row('U.S. state law', a);
});

test('3-4. Parish and city ordinances: the most local rule governs and is cited', () => {
  const records = [...LEGAL_INDEX, PARISH, CITY];
  const parish = legalAnswer('Can I play amplified music with alcohol here late?', { jurisdictionId: 'us-la-new-orleans', date: TODAY, records, activity: 'alcohol' });
  assert.match(parish.text, /Orleans Parish local ordinance \(FIXTURE Orleans Parish noise rule\)/);
  row('Parish ordinance', parish);
  const city = legalAnswer('Can I run this business from home?', { jurisdictionId: 'us-la-new-orleans', date: TODAY, records });
  assert.match(city.text, /New Orleans local ordinance \(FIXTURE New Orleans home occupation rule\) requires an occupational licence/);
  assert.match(city.text, /Legal option: Apply through One Stop/);
  row('City ordinance', city);
});

test('5. Federal regulation, verified live against eCFR', async () => {
  const rec = LEGAL_INDEX.find((r) => r.id === 'us-16cfr255');
  const { fetcher, seen } = officialSources({ 'ecfr.gov/api/versioner/v1/versions/title-16.json': JSON.stringify({ content_versions: [{ identifier: '255.1', amendment_date: '2023-07-26' }, { identifier: '255.5', amendment_date: '2023-07-26' }] }) });
  const v = await verifyRecord(rec, { fetcher, now: TODAY });
  assert.equal(v.verified, true);
  assert.equal(v.amended, '2023-07-26');
  assert.match(seen[0], /title-16\.json\?part=255/);
  const a = legalAnswer('Do I need to disclose a sponsored post?', { jurisdictionId: 'us-tx', date: TODAY, verified: { [rec.id]: v } });
  assert.match(a.text, /^Yes, it is required\. United States federal agency guidance \(16 C\.F\.R\. Part 255\)/);
  assert.match(a.text, /Checked live today against Electronic Code of Federal Regulations/);
  assert.match(a.text, /I have not indexed Texas law/);
  assert.equal(a.live_verified, true);
  row('Federal regulation', a, { live: true });
});

test('6. Contract-specific question: the contract changes the answer, and flags quote the contract', () => {
  const contract = `MANAGEMENT AGREEMENT. This agreement is made by and between Night Shift Management LLC ("Manager") and Erica Jones ("Artist"), effective as of January 1, 2027.
The term of this agreement shall be in perpetuity.
Artist grants Manager the exclusive right to represent Artist worldwide.
Manager shall receive a commission of 25% of Artist's gross income, and the commission shall continue after the term on recordings made during the term.
Artist shall indemnify Manager against all claims.
Any dispute shall be resolved by binding arbitration in Los Angeles.
This agreement shall be governed by the laws of the State of California.`;
  const r = analyzeContract(contract, { name: 'Erica management', home: 'Louisiana' });
  assert.equal(r.ok, true);
  assert.equal(r.terms.commission.percent, 25);
  assert.equal(r.terms.governing_law.place, 'California');
  const high = r.flags.filter((f) => f.level === FLAG.high).map((f) => f.term);
  assert.ok(high.includes('term') && high.includes('commission'), 'perpetual exclusive term and post-term commission');
  assert.ok(r.flags.every((f) => !f.quote || contract.replace(/\s+/g, ' ').includes(f.quote)), 'every quote is the contract\'s own words');
  assert.ok(r.flags.some((f) => f.level === FLAG.question && f.term === 'termination'), 'a missing termination clause is a question, never invented');
  assert.ok(r.missing.includes('Termination'));
  assert.match(r.spoken, /attorney/);
});

test('7. UK legislation, read live from legislation.gov.uk', async () => {
  const rec = LEGAL_INDEX.find((r) => r.id === 'gb-cdpa-s30');
  const { fetcher, seen } = officialSources({ 'legislation.gov.uk/ukpga/1988/48/section/30/data.xml': '<Legislation><dc:modified>2024-03-01</dc:modified><P1>Fair dealing with a work for the purpose of criticism or review, of that or another work, does not infringe any copyright in the work provided that it is accompanied by a sufficient acknowledgement.</P1></Legislation>' });
  const v = await verifyRecord(rec, { fetcher, now: TODAY });
  assert.equal(v.verified, true);
  assert.equal(v.amended, '2024-03-01');
  assert.match(seen[0], /data\.xml$/);
  const a = legalAnswer('Is it fair use to use this clip in a review?', { jurisdictionId: 'gb-eng', date: TODAY, verified: { [rec.id]: v } });
  assert.match(a.text, /Copyright, Designs and Patents Act 1988, s\. 30/);
  assert.equal(a.risk, RISK_LEVELS.uncertain, 'fair dealing is case by case');
  row('UK legislation', a, { live: true });
});

test('8. EU-level rule applies in a member state, with the member\'s own law marked not indexed', () => {
  const a = legalAnswer('Can I collect emails for a mailing list legally?', { jurisdictionId: 'fr', date: TODAY });
  assert.match(a.text, /European Union regulation \(Regulation \(EU\) 2016\/679 \(GDPR\)\)/);
  assert.match(a.text, /I have not indexed France law \(official source: legifrance\.gouv\.fr\)/);
  row('EU-level rule', a);
});

test('9. Another country with an official source: Canada, read live from Justice Laws', async () => {
  const rec = LEGAL_INDEX.find((r) => r.id === 'ca-copyright-s29');
  const { fetcher } = officialSources({ 'laws-lois.justice.gc.ca': '<html><body><p>Last amended on June 22, 2023</p><p>29 Fair dealing for the purpose of research, private study, education, parody or satire does not infringe copyright.</p></body></html>' });
  const v = await verifyRecord(rec, { fetcher, now: TODAY });
  assert.equal(v.verified, true);
  assert.equal(v.amended, 'June 22, 2023');
  const a = legalAnswer('Is it fair use to use this clip for parody?', { jurisdictionId: 'ca', date: TODAY, verified: { [rec.id]: v } });
  assert.match(a.text, /Copyright Act, R\.S\.C\. 1985, c\. C-42, s\. 29/);
  row('Canada (official source)', a, { live: true });
});

test('10. A law that changed over time: the version on the date asked', () => {
  const rec = LEGAL_INDEX.find((r) => r.id === 'gb-cdpa-s30');
  assert.match(versionOn(rec, new Date('2013-06-01')).summary, /No general quotation exception/);
  assert.match(versionOn(rec, TODAY).summary, /quotation exception was added/);
});

test('11-12. Future-effective and repealed laws are never presented as current', () => {
  const ai = LEGAL_INDEX.find((r) => r.id === 'eu-ai-act-art6-1');
  assert.equal(statusOn(ai, TODAY), STATUS.future);
  assert.equal(statusOn(ai, new Date('2027-09-01')), STATUS.effective);
  const a = legalAnswer('Is this AI system legal?', { jurisdictionId: 'eu', date: TODAY, activity: 'ai_systems' });
  assert.match(a.text, /^Not yet: the rule is not in force\. .*takes effect on 2027-08-02.*check live/);
  row('Future-effective law', a);
  const old = LEGAL_INDEX.find((r) => r.id === 'eu-dir-95-46');
  assert.equal(statusOn(old, TODAY), STATUS.repealed);
  assert.equal(statusOn(old, new Date('2010-01-01')), STATUS.effective);
  const g = legalAnswer('Can I collect customer data legally?', { jurisdictionId: 'de', date: TODAY });
  assert.match(g.text, /Directive 95\/46\/EC was repealed on 2018-05-25.*no longer applies/);
  assert.ok(!g.sources.some((s) => /95\/46/.test(s.citation)), 'the repealed directive is not a source for the current answer');
  row('Repealed law', g);
});

test('13 and 19. Unknown local rule and business licensing: a coverage gap with official places to check, never a guess', () => {
  const a = legalAnswer('Can I run this business from home?', { jurisdictionId: 'us-la-new-orleans', date: TODAY });
  assert.equal(a.status, 'coverage_gap');
  assert.match(a.text, /I don't have the rule .* indexed yet, so I won't guess/);
  assert.match(a.text, /geauxbiz\.sos\.la\.gov/);
  assert.match(a.text, /onestopapp\.nola\.gov/);
  assert.equal(a.confidence, 'none');
  report.push({ test: 'Unknown local rule / business licensing', jurisdiction: 'us-la-new-orleans', date: '2026-10-22', sources: a.sources.map((s) => s.name), answer: a.text, confidence: 'none', live_verified: false });
});

test('14. Location change: only differences for what the owner is doing, in categories he has on', () => {
  const diffs = legalDifferences({ from: 'us-la', to: 'us-ca', activities: ['recording', 'sampling', 'endorsement'], facts: { party_to_conversation: true }, date: TODAY });
  assert.deepEqual(diffs.map((d) => d.activity), ['recording'], 'sampling and endorsements are federal and the same in both');
  assert.equal(diffs[0].priority, 'IMPORTANT');
  assert.match(diffs[0].lawful_option, /Ask everyone for consent/);
  assert.deepEqual(legalDifferences({ from: 'us-la', to: 'us-ca', activities: ['recording'], categories: ['music'], facts: { party_to_conversation: true }, date: TODAY }), [], 'recording alerts switched off');
  assert.deepEqual(legalIntent("I'm in California now, is there anything relevant that changed?"), { kind: 'location', place: 'us-ca' });
});

test('15-16. Law versus platform rule, and criminal versus civil versus regulatory exposure', () => {
  const records = [...LEGAL_INDEX, PLATFORM];
  const found = recordsFor('endorsement', 'us', { records });
  assert.deepEqual(found.map((r) => r.kind).sort(), ['AGENCY_GUIDANCE', 'PLATFORM_RULE']);
  const a = legalAnswer('Do I need to disclose a sponsored post?', { jurisdictionId: 'us', date: TODAY, records });
  assert.ok(a.sources.some((s) => s.kind === 'platform rule') && a.sources.some((s) => s.kind === 'agency guidance'), 'each source says what kind of rule it is');
  assert.ok(!a.why.exposure.includes('criminal'), 'a disclosure rule is not a crime');
  assert.deepEqual(a.why.exposure.sort(), ['platform', 'regulatory']);
  const sample = legalAnswer('Can we use this sample?', { jurisdictionId: 'us-la', date: TODAY });
  assert.deepEqual(sample.why.exposure, ['civil'], 'ordinary sampling is civil');
  const rec = legalAnswer('Can I record a call I am not part of?', { jurisdictionId: 'us-la', facts: { party_to_conversation: false }, date: TODAY });
  assert.ok(rec.why.exposure.includes('criminal') && rec.why.exposure.includes('civil'));
  row('Legal versus platform policy', a);
});

test('17. Lawful alternatives keep the goal and change the method', () => {
  const alts = findAlternatives({ activity: 'sampling', records: recordsFor('sampling', 'us-la'), goal: 'use the vocal hook from an old record' });
  assert.deepEqual(alts.alternatives.map((x) => x.option), ['Clear the sample', 'Interpolate (re-record the part)', 'Use a licensed sample pack', 'Make an original part in the same style']);
  assert.ok(alts.alternatives.every((x) => x.approver && x.documents && x.basis));
  assert.match(alts.alternatives[0].cost_time, /not verified/, 'no invented prices or timelines');
  assert.equal(legalIntent('How can I use this sample legally?').kind, 'alternative');
});

test('18 and 21. Music sample clearance and conflicting authority', () => {
  const a = legalAnswer('Can we use this sample?', { jurisdictionId: 'us-la', date: TODAY });
  assert.equal(a.risk, RISK_LEVELS.likely_restricted);
  assert.match(a.text, /requires permission from both the master owner and the publisher/);
  assert.match(a.text, /I found conflicting authority: Bridgeport.* and VMG Salsoul.* disagree, and neither binds Louisiana/);
  row('Music sample clearance + conflicting authority', a);
  const ca = legalAnswer('Can we use this sample?', { jurisdictionId: 'us-ca', date: TODAY });
  assert.match(ca.text, /VMG Salsoul, LLC v\. Ciccone, 824 F\.3d 871 \(9th Cir\. 2016\) binds where you are/);
  const song = { title: 'Night Shift', music: { versions: [{ kind: 'master', sha256: 'a'.repeat(64) }], samples: [{ name: 'Soul vocal', provenance: 'LICENSED', source: 'old record' }], splits: [{ name: 'Dee', group: 'songwriting', role: 'producer', percent: 50 }] } };
  const d = defenseArguments({ project: song, jurisdictionId: 'us-la', samples: song.music.samples.map((s) => ({ s, e: evaluateSample(s) })) });
  assert.ok(d.arguments.some((x) => x.grade === 'Strong argument' && /Independent creation/.test(x.argument)));
  assert.ok(d.arguments.some((x) => x.grade === 'Unresolved' && /de minimis/.test(x.argument)), 'Louisiana is in the Fifth Circuit, which the index has no ruling for');
  assert.equal(d.attorney, true);
  assert.match(releaseLegalCheck(song).items[0].text, /No signed agreement with Dee/);
});

test('20. "Sell this beat exclusively": Music, Business and Legal in one answer, nothing sold', () => {
  const data = { projects: [] };
  const beat = addBeat(data, { name: 'Smoke', licenses: [{ name: 'Basic lease', price_usd: 30 }, { name: 'Exclusive', price_usd: 500, exclusive: true }] }).beat;
  recordBeatSale(data, beat, { license_id: 'basic_lease', buyer: 'Mike', payment_ref: 'cs_1' });
  const c = exclusiveCheck(beat);
  assert.equal(c.ready, false);
  assert.match(c.text, /Legal: 1 lease is already sold \(Mike\)/);
  assert.match(c.text, /Legal: write or attach the exclusive licence terms/);
  assert.equal(beat.state, 'LEASED', 'nothing was sold');
});

test('updates: only subscribed rules are re-read; a newer amendment is an alert for the project that relies on it', async () => {
  const state = { subscriptions: [], verified: {}, alerts: [], decisions: [] };
  subscribe(state, { jurisdiction: 'us', activity: 'endorsement', project: 'Brand deals' });
  const first = officialSources({ 'ecfr.gov': JSON.stringify({ content_versions: [{ identifier: '255.1', amendment_date: '2023-07-26' }] }) });
  const r1 = await checkUpdates(state, { fetcher: first.fetcher, now: TODAY });
  assert.equal(r1.verified, 1);
  assert.equal(state.alerts.length, 0);
  assert.equal(first.seen.length, 1, 'nothing outside the subscription is read');
  const later = officialSources({ 'ecfr.gov': JSON.stringify({ content_versions: [{ identifier: '255.1', amendment_date: '2027-03-01' }] }) });
  await checkUpdates(state, { fetcher: later.fetcher, now: new Date('2027-03-02') });
  assert.equal(state.alerts.length, 1);
  assert.match(state.alerts[0].text, /16 C\.F\.R\. Part 255 was amended \(2027-03-01\)\. It affects: Brand deals/);
  assert.equal(state.alerts[0].priority, 'IMPORTANT');
  // An unreachable source is reported, not treated as unchanged-and-current.
  const offline = await verifyRecord(LEGAL_INDEX[0], { fetcher: async () => { throw new Error('offline'); } });
  assert.equal(offline.verified, false);
  assert.match(offline.why, /could not be reached/);
  assert.equal(recordDecision(state, { project: 'Night Shift EP', issue: 'sample licence', decision: 'replaced sample', evidence: 'new stem sha 1a2b' }).ok, true);
});

test('owner words reach Legal without catching ordinary sentences', () => {
  assert.equal(legalIntent('Can I record somebody here?').kind, 'ask');
  assert.equal(legalIntent('Can I trade NQ now?'), null);
  assert.equal(legalIntent('What time is it?'), null);
  assert.deepEqual(legalIntent('Turn on location legal alerts'), { kind: 'setting', key: 'location_differences', value: true });
  assert.deepEqual(legalIntent('My home state is Louisiana'), { kind: 'home', place: 'us-la' });
  assert.equal(legalIntent('Is this legal?').kind, 'ask');
});

test('every seeded record names its citation, level, source, dates and confidence; none is a fixture', () => {
  for (const r of LEGAL_INDEX) {
    for (const k of ['id', 'jurisdiction', 'level', 'kind', 'source', 'citation', 'title', 'confidence', 'summary']) assert.ok(r[k], `${r.id}: ${k}`);
    assert.ok(!r.fixture);
    assert.ok(Object.hasOwn(r, 'effective') && Object.hasOwn(r, 'repealed'));
  }
  test.after?.(() => {});
  // The report the owner asked for, printed with the run.
  for (const r of report) console.log(`LEGAL TEST | ${r.test} | ${r.jurisdiction} | ${r.date} | ${r.sources.join('; ')} | confidence ${r.confidence} | live ${r.live_verified}`);
});
