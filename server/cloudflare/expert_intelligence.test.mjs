import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DOMAINS, SOURCE_TIERS, tierOf, addExpertSource, domainCoverage, speakCoverage, redFlags, readLabs, labelInteractions,
  openCase, addToCase, addProfessionalNote, professionalBrief, bringList, referralsFor, questionsFor, runExam,
  expertPromptContext, expertIntent, upgradePlan, sumRecords, specialtyAsk, HIGH_STAKES_CONTRACT, domainsIn,
} from './expert_intelligence.js';
import { KnowledgeLibrary, KNOWLEDGE_CATEGORIES } from './knowledge_library.js';
import { legalAnswer } from './legal_intelligence.js';
import { analyzeContract } from './legal_contracts.js';

async function storage() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  return { sql: { exec: (q, ...p) => {
    const stmt = db.prepare(q);
    return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []);
  } } };
}
const TODAY = new Date('2026-10-22');
const STATUTE = 'Fair use is decided case by case on four factors: purpose and character, nature of the work, amount used, and market effect. '.repeat(4);

test('source quality: authority tiers rank primary law above videos and articles', () => {
  assert.equal(tierOf('primary_law'), 1);
  assert.ok(tierOf('clinical_guideline') < tierOf('peer_reviewed'));
  assert.ok(tierOf('video') > tierOf('specialist_publication') && tierOf('article') > tierOf('video'));
  assert.equal(SOURCE_TIERS.length, 12);
});

test('domains: law and medicine carry the full study maps; every domain has a freshness rule', () => {
  assert.equal(DOMAINS.law.curriculum.length, 23);
  assert.ok(DOMAINS.law.curriculum.includes('entertainment and music law'));
  assert.equal(DOMAINS.health.curriculum.length, 27);
  for (const [id, d] of Object.entries(DOMAINS)) assert.ok(d.freshness?.rule && d.curriculum.length && d.sources.length, id);
  assert.equal(KNOWLEDGE_CATEGORIES.length, 20, 'the owner\'s 20 categories are unchanged');
});

test('Knowledge Library integration: read versus catalogued is tracked, licence decides, coverage counts only what was read', async () => {
  const s = await storage();
  const read = addExpertSource(s, { domain: 'law', title: '17 U.S.C. § 107', creator: 'U.S. Congress', kind: 'documentation', license: 'public_domain', source_type: 'primary_law', specialty: 'intellectual property', jurisdiction: 'us', text: STATUTE });
  assert.equal(read.access, 'indexed');
  assert.equal(read.tier, 1);
  const textbook = addExpertSource(s, { domain: 'law', title: 'A Contracts Casebook', creator: 'Someone', kind: 'book', license: 'all_rights_reserved', source_type: 'textbook', specialty: 'contracts', text: 'Offer, acceptance and consideration form a contract. '.repeat(5) });
  assert.equal(textbook.access, 'cataloged', 'a copyrighted textbook is not stored without permission');
  assert.match(textbook.index_error, /stays catalogued/);
  const c = domainCoverage(s, 'law');
  assert.equal(c.indexed, 1);
  assert.equal(c.cataloged, 1);
  assert.equal(c.curriculum.covered, 1, 'intellectual property has a read source; contracts does not');
  assert.ok(c.curriculum.gaps.includes('contracts'));
  assert.match(speakCoverage(c), /1 indexed source I have read, 1 only catalogued \(not read\)/);
  assert.match(speakCoverage(c), /A test score is not a licence/);
  assert.equal(domainCoverage(s, 'engineering').level, 'not built', 'no sources, no claim');
  const kl = new KnowledgeLibrary(s);
  assert.equal(kl.search('four factors fair use', { category: 'expert_law' }).hits.length, 1);
});

test('competency: exams run against CHE\'s own engines and store a dated score, never a credential', () => {
  const law = runExam('law');
  assert.equal(law.total, 8);
  assert.equal(law.passed, law.total, JSON.stringify(law.results.filter((r) => !r.ok)));
  const health = runExam('health');
  assert.equal(health.passed, health.total, JSON.stringify(health.results.filter((r) => !r.ok)));
  const fin = runExam('finance');
  assert.equal(fin.passed, fin.total);
  assert.equal(runExam('engineering').score, null, 'no exam, no score');
});

test('LAW: current rule, contract analysis, outdated law, legal alternative', () => {
  assert.match(legalAnswer('Can I record a call I am on?', { jurisdictionId: 'us-ca', facts: { party_to_conversation: true }, date: TODAY }).text, /Cal\. Penal Code § 632/);
  assert.equal(analyzeContract('This agreement is made by and between A and B. A assigns all right, title and interest in the work to B. B shall pay A $100.', { name: 'x' }).flags.find((f) => f.term === 'ownership').level, 'HIGH RISK');
  assert.match(legalAnswer('Can I collect customer data?', { jurisdictionId: 'de', date: TODAY }).text, /95\/46\/EC was repealed/);
  assert.ok(legalAnswer('Can we use this sample?', { jurisdictionId: 'us-la', date: TODAY }).alternatives.length >= 3);
});

test('MEDICINE: urgent red flags first, ordinary symptoms not alarmed', () => {
  assert.equal(redFlags('My dad\'s face is drooping and his speech is slurred speech')[0].id, 'stroke');
  assert.match(redFlags('I have chest pain and shortness of breath')[0].action, /Call 911/);
  assert.deepEqual(redFlags('I have a mild headache and a runny nose'), []);
  assert.deepEqual(redFlags('Have you seen Suicide Squad?'), [], 'a movie title is not a crisis');
  assert.equal(redFlags('I keep thinking about suicide')[0].id, 'suicide');
});

test('MEDICINE: labs judged only by the report\'s own range', () => {
  const labs = readLabs('Hemoglobin A1c 6.8 % (4.0-5.6)\nLDL 92 mg/dL (0-99)\nCRP 12 mg/L');
  assert.deepEqual(labs.map((l) => [l.name, l.flag]), [['Hemoglobin A1c', 'HIGH'], ['LDL', 'in range'], ['CRP', 'no range on report']]);
});

test('MEDICINE: medication interactions come from FDA labels, quoted; silence is not safety', async () => {
  const seen = [];
  const fetcher = async (url) => {
    seen.push(String(url));
    if (String(url).includes('warfarin')) return new Response(JSON.stringify({ results: [{ drug_interactions: ['Drugs that increase bleeding risk: concomitant use of NSAIDs such as ibuprofen with warfarin increases the risk of bleeding.'] }] }));
    if (String(url).includes('ibuprofen')) return new Response(JSON.stringify({ results: [{ warnings: ['Stomach bleeding warning.'] }] }));
    return new Response('{}', { status: 404 });
  };
  const r = await labelInteractions(['Warfarin', 'Ibuprofen'], { fetcher });
  assert.ok(seen.every((u) => u.startsWith('https://api.fda.gov/drug/label.json')));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].label, 'warfarin');
  assert.match(r.findings[0].quote, /ibuprofen with warfarin increases the risk of bleeding/);
  assert.match(r.note, /does not make it safe/);
  const offline = await labelInteractions(['a-drug', 'b-drug'], { fetcher: async () => { throw new Error('offline'); } });
  assert.deepEqual(offline.findings, []);
  assert.deepEqual(offline.unread, ['a-drug', 'b-drug'], 'unread labels are reported, not treated as safe');
});

test('MEDICINE: Doctor Brief from the record only, with missing parts, questions, what to bring and a fitting specialist', () => {
  const state = { cases: [], audit: [] };
  const c = openCase(state, { kind: 'MEDICAL', title: 'Back and leg' }).case;
  addToCase(state, c.id, 'reason', 'Low back pain spreading to the left leg');
  addToCase(state, c.id, 'symptoms', 'low back pain, numbness in the left foot');
  addToCase(state, c.id, 'timeline', { date: '2026-09-02', text: 'Lifted a speaker at a show; pain started next morning' });
  addToCase(state, c.id, 'results', { name: 'Vitamin D', value: 18, unit: 'ng/mL', range: [30, 100], flag: 'LOW', date: '2026-10-01', source: 'lab report 2026-10-01' });
  addToCase(state, c.id, 'documents', { text: 'X-ray report', ref: 'project:xray-2026-09' });
  const b = professionalBrief(c);
  assert.equal(b.title, 'Doctor Brief');
  assert.match(b.text, /Reason for visit: Low back pain spreading to the left leg/);
  assert.match(b.text, /Vitamin D: 18 ng\/mL \(report range 30–100, LOW\)/);
  assert.match(b.text, /Current medications: none on file\./);
  assert.ok(b.missing.includes('current medications'));
  assert.match(b.text, /What diagnoses best explain these symptoms\?/);
  assert.ok(b.referrals.some((r) => /orthopedist/.test(r.who)) && b.referrals.some((r) => r.who === 'neurologist'));
  assert.ok(!/diagnosed with|you have (?:a|an) /i.test(b.text), 'never a diagnosis');
  assert.match(bringList(c)[0], /none recorded yet/);
  assert.equal(state.cases[0].documents[0].ref, 'project:xray-2026-09', 'documents are references, not copies');
});

test('after the appointment: the professional\'s words are kept verbatim; new orders and deadlines are added and named', () => {
  const state = { cases: [], audit: [] };
  const med = openCase(state, { kind: 'MEDICAL', title: 'Back' }).case;
  const said = 'Ordered an MRI of the lumbar spine and started physical therapy twice a week.';
  const r = addProfessionalNote(state, med.id, { who: 'Dr. Lee', text: said });
  assert.equal(med.professional_notes[0].verbatim, said);
  assert.match(r.said, /Ordered an MRI of the lumbar spine/);
  assert.match(r.said, /started physical therapy/);
  const law = openCase(state, { kind: 'LEGAL', title: 'Label dispute' }).case;
  const r2 = addProfessionalNote(state, law.id, { who: 'Ms. Grant', text: 'You must file the claim within one year of the release date.' });
  assert.equal(law.deadlines.length, 1);
  assert.match(r2.said, /deadline: .*within one year/);
  assert.ok(state.audit.length >= 4, 'important changes are audited');
});

test('LAW handoff: Attorney Brief with authority, uncertainty, the right attorney type and missing facts', () => {
  const state = { cases: [], audit: [] };
  const c = openCase(state, { kind: 'LEGAL', title: 'Sample claim' }).case;
  addToCase(state, c.id, 'reason', 'A label says my song uses their sample without a licence');
  addToCase(state, c.id, 'timeline', { date: '2026-08-01', text: 'Released Night Shift with the sample' });
  addToCase(state, c.id, 'timeline', { date: '2026-10-10', text: 'Received a letter from the label about copyright' });
  const research = legalAnswer('Can we use this sample?', { jurisdictionId: 'us-la', date: TODAY });
  const b = professionalBrief(c, { legal: research });
  assert.equal(b.title, 'Attorney Brief');
  assert.match(b.text, /17 U\.S\.C\. § 106/);
  assert.match(b.text, /Uncertainty: conflicting authority/);
  assert.ok(b.missing.includes('jurisdiction'));
  assert.ok(b.referrals.some((r) => /entertainment or IP attorney/.test(r.who)));
  assert.match(questionsFor(c)[1], /What deadlines apply\?/);
  assert.match(b.text, /2026-08-01: Released.*\n- 2026-10-10: Received/, 'timeline in date order');
});

test('FINANCE: calculations only from records; no records is unknown; tax rules must be fresh', () => {
  assert.equal(sumRecords([{ amount_usd: 1200 }, { amount_usd: -200.5 }]), 999.5);
  assert.equal(sumRecords([]), null);
  assert.ok(DOMAINS.accounting_tax.freshness.days <= 30);
  assert.match(DOMAINS.finance.freshness.rule, /never use remembered account data/);
});

test('ENGINEERING and GENERAL: no indexed source means the model is told to say so; specialist framing never overrides facts', async () => {
  const s = await storage();
  const ctx = expertPromptContext(s, 'What torque spec does a structural engineer use for this bolt?');
  assert.match(ctx, /HIGH-STAKES FIELD/);
  assert.match(ctx, /Engineering: CHE has no indexed source for this question\. Say so/);
  const cardio = expertPromptContext(s, 'Think like a cardiology specialist about my palpitations');
  assert.equal(specialtyAsk('Think like a cardiology specialist about my palpitations'), 'cardiology');
  assert.match(cardio, /Do not role-play being the owner's own clinician/);
  assert.match(HIGH_STAKES_CONTRACT, /Never invent a law, case citation, diagnosis, drug interaction/);
});

test('privacy: a case reaches the model only for a question in its own compartment', async () => {
  const s = await storage();
  const state = { cases: [], audit: [] };
  const med = openCase(state, { kind: 'MEDICAL', title: 'Back' }).case;
  addToCase(state, med.id, 'medications', 'naproxen 500 mg');
  assert.match(expertPromptContext(s, 'Can my back pain medication cause stomach issues?', { cases: state.cases }), /naproxen 500 mg/);
  assert.doesNotMatch(expertPromptContext(s, 'Can I deduct studio rent on my taxes?', { cases: state.cases }), /naproxen/);
  assert.equal(expertPromptContext(s, 'Write a hook about summer nights', { cases: state.cases }), '', 'ordinary requests carry no expert context at all');
});

test('owner words: briefs, bring lists, notes, coverage, upgrades, tests and medicines', () => {
  assert.deepEqual(expertIntent("CHE, I have a doctor's appointment tomorrow. Prepare me for my doctor's appointment"), { kind: 'brief', case_kind: 'MEDICAL' });
  assert.deepEqual(expertIntent('Prepare me for my lawyer appointment'), { kind: 'brief', case_kind: 'LEGAL' });
  assert.equal(expertIntent('What should I bring to my attorney?').case_kind, 'LEGAL');
  assert.deepEqual(expertIntent('My doctor said start physical therapy twice a week'), { kind: 'note', who: 'doctor', text: 'start physical therapy twice a week' });
  assert.deepEqual(expertIntent('How good are you at law?'), { kind: 'coverage', domain: 'law' });
  assert.equal(expertIntent('CHE, get better at contract law').domain, 'law');
  assert.equal(expertIntent('Test your medical knowledge').domain, 'health');
  assert.deepEqual(expertIntent('Can I take warfarin with ibuprofen?').drugs, ['warfarin', 'ibuprofen']);
  assert.equal(expertIntent('Open a medical case called Back and leg').case_kind, 'MEDICAL');
  assert.equal(expertIntent('What time is it?'), null);
});

test('upgrade: an evidence-based plan from current coverage, not a claim of new expertise', async () => {
  const s = await storage();
  const p = upgradePlan(s, 'law', 'contracts');
  assert.deepEqual(p.targets, ['contracts']);
  assert.equal(p.before.indexed, 0);
  assert.match(p.steps[1], /catalogue the rest as not read/);
});

// ─── Codex review of #459 ───────────────────────────────────────────────────

test('a bare "pain" or "injury" is not a medical question: no medical case reaches the prompt', async () => {
  const s = await storage();
  const state = { cases: [], audit: [] };
  const c = openCase(state, { kind: 'MEDICAL', title: 'Back' }).case;
  addToCase(state, c.id, 'symptoms', 'numb left leg');
  addToCase(state, c.id, 'medications', { text: 'gabapentin' });
  for (const q of ['What does pain point mean in marketing?', 'How much injury time was added in the match?']) {
    assert.ok(!domainsIn(q).includes('health'), q);
    assert.doesNotMatch(expertPromptContext(s, q, { cases: state.cases }), /gabapentin|numb left leg/, q);
  }
  for (const q of ['My back pain is worse today', 'I injured my knee', 'Pain in my shoulder when I lift']) assert.ok(domainsIn(q).includes('health'), q);
  assert.match(expertPromptContext(s, 'My back pain is worse today', { cases: state.cases }), /gabapentin/);
});

test('every declared domain is recognised, so its high-stakes contract and sources apply', async () => {
  const samples = {
    cybersecurity: 'What does my cybersecurity source say about threat modeling?', trading: 'How should I size a position in futures?',
    real_estate: 'What are typical closing costs on a real estate purchase?', intellectual_property: 'Can I trademark my band name?',
    software: 'How do I refactor this database query?', business: 'Should my startup be an LLC?', marketing: 'How do I improve my conversion rate?',
    music: 'How do I get better at mixing and mastering?', science: 'What did the peer-reviewed study find?',
  };
  for (const [d, q] of Object.entries(samples)) assert.ok(domainsIn(q).includes(d), `${d}: ${q}`);
  for (const id of Object.keys(DOMAINS)) assert.ok(Object.values(samples).concat(['legal contract', 'my doctor', 'tax deduction', 'mortgage rate', 'structural load', 'insurance claim denied', 'ssdi appeal']).some((q) => domainsIn(q).includes(id)), `${id} is recognised`);
  const s = await storage();
  assert.match(expertPromptContext(s, samples.cybersecurity), /HIGH-STAKES FIELD|Cybersecurity/);
});

test('briefs follow the case kind: tax, insurance and funding get no medical sections', () => {
  const state = { cases: [], audit: [] };
  for (const [kind, title, pro] of [['TAX', 'Tax Brief', 'accountant'], ['INSURANCE', 'Insurance Claim Brief', 'insurance adjuster or attorney'], ['BUSINESS_FUNDING', 'Funding Brief', 'lender or investor']]) {
    const c = openCase(state, { kind, title: `${kind} matter` }).case;
    const b = professionalBrief(c);
    assert.equal(b.title, title);
    assert.doesNotMatch(b.text, /Symptoms|medications|clinician|DOCTOR BRIEF/i, kind);
    assert.match(b.text, new RegExp(`for your ${pro}\\. Not professional advice\\.$`));
  }
  const d = professionalBrief(openCase(state, { kind: 'DISABILITY', title: 'SSDI' }).case);
  assert.equal(d.title, 'Disability Claim Brief');
  assert.match(d.text, /^DISABILITY CLAIM BRIEF: SSDI[\s\S]*Current medications[\s\S]*for your disability representative/);
});

test('a reference already filed in the owner\'s own category is not silently counted as an expert source', async () => {
  const s = await storage();
  const kl = new KnowledgeLibrary(s);
  kl.catalog({ title: 'Threat Modeling', creator: 'Adam Shostack', kind: 'book', category: KNOWLEDGE_CATEGORIES[0].id, license: 'all_rights_reserved' });
  const out = addExpertSource(s, { domain: 'cybersecurity', title: 'Threat Modeling', creator: 'Adam Shostack', kind: 'book', source_type: 'textbook', license: 'all_rights_reserved' });
  assert.match(out.error, /already in your library under/);
  assert.equal(domainCoverage(s, 'cybersecurity').indexed ?? 0, 0);
});
