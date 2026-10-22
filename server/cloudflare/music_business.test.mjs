import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  addWorkspace, workspaceView, addWorkspaceSong, setService, draftQuote, approveQuote, recordFeedback, revisionsUsed,
  deliveryPackage, addBeat, recordBeatSale, offers, beatListing, advanceAgreement, addLedger, businessDashboard, artistReport,
  musicBusinessIntent,
} from './music_business.js';
import { markStage, createPaymentLink, checkPaid } from './pipeline.js';
import { applyRightsAction } from './music_rights.js';
import { myCatalog, proposeCollection } from './music_catalog.js';
import { encodeWav, analyzeWav } from './music_audio.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const FS = 22050;
function stem({ bpm = 140, amp = 0.3, tone = 200, seconds = 10 } = {}) {
  const n = seconds * FS; const x = new Float32Array(n); const p = Math.round((60 / bpm) * FS);
  for (let i = 0; i < n; i++) x[i] = amp * 0.25 * Math.sin((2 * Math.PI * tone * i) / FS);
  for (let s = 0; s < n; s += p) for (let i = 0; i < 300 && s + i < n; i++) x[s + i] += amp * Math.exp(-i / 60) * Math.sin(i / 3);
  return encodeWav([x, x], FS);
}
function fakeStripe({ paid }) {
  return async (url) => {
    const u = String(url);
    const body = u.includes('/products') ? { id: 'prod_1', default_price: 'price_1' }
      : u.includes('/payment_links') ? { id: 'plink_1', url: 'https://buy.stripe.com/test_1' }
      : u.includes('/checkout/sessions') ? { data: paid ? [{ id: 'cs_1', payment_status: 'paid', amount_total: 25000 }] : [] } : {};
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
}
const ENV = { STRIPE_SECRET_KEY: 'sk_test_example' };
function version(data, project, kind, label, bytes) {
  return applyRightsAction(data, { action: 'add_version', project_id: project.id, version: { kind, label, sha256: sha(bytes), inputs: [{ provenance: 'OWNER_ORIGINAL' }] } }).body.version;
}

test('client workflow: client, quote (draft until approved), song, stems analysed, mix v1, revision, mix v2, master, Stripe-verified payment, delivery', async () => {
  const data = { projects: [], pipeline: [] };
  // 1. Add a client.
  const ws = addWorkspace(data, { kind: 'CLIENT', name: 'Jay R', contact: 'jay@example.com' }).workspace;
  // Services have no built-in price; the owner sets it.
  assert.equal(setService(data, { name: 'Mix + Master' }).ok, false);
  const svc = setService(data, { name: 'Mix + Master', price_usd: 250, deposit_usd: 100, revisions: 2, deliverables: ['Master WAV', 'MP3 preview'] }).service;
  // 2. A quote is a draft on the existing pipeline deal; nothing is sent.
  const q = draftQuote(data, { workspace_id: ws.id, service_id: svc.id, due: '2026-11-01' });
  assert.equal(q.quote.status, 'draft');
  assert.equal(q.deal.stage, 'proposal');
  assert.match(q.deal.proposal_text, /Mix \+ Master, \$250\.00\. Deposit: \$100\.00\. Deliverables: Master WAV, MP3 preview\. Revisions included: 2/);
  // 3. The client's song is a project in the client's workspace, never in the owner's catalog.
  const song = addWorkspaceSong(data, ws.id, 'Night Drive').project;
  assert.equal(myCatalog(data.projects).length, 0);
  assert.equal(song.music.use_for_owner_taste, false);
  // 4-5. Stems are analysed from their audio.
  const vox = stem({ tone: 900 }); const beat = stem({ tone: 120, amp: 0.4 });
  const stems = [analyzeWav(vox), analyzeWav(beat)];
  assert.ok(stems.every((a) => a.analysed && Number.isFinite(a.loudness_lufs)));
  // 6-8. Mix v1, client feedback, mix v2, approval. Nothing is overwritten.
  const v1 = version(data, song, 'mix', 'Mix v1', stem({ amp: 0.31 }));
  assert.equal(recordFeedback(data, song, { version_id: v1.id, text: 'Vocal louder.' }).used, 1);
  const v2 = version(data, song, 'mix', 'Mix v2', stem({ amp: 0.32 }));
  assert.equal(recordFeedback(data, song, { version_id: v2.id, text: 'A bit more low end.' }).used, 2);
  const third = recordFeedback(data, song, { version_id: v2.id, text: 'One more change.' });
  assert.equal(third.ok, false, 'never silently over the quoted revisions');
  assert.match(third.why, /All 2 included revisions are used/);
  assert.equal(recordFeedback(data, song, { version_id: v2.id, approved: true }).approved, true);
  assert.equal(revisionsUsed(song), 2);
  // 9. Master, approved.
  const master = version(data, song, 'master', 'Master v1', stem({ amp: 0.4 }));
  const preview = version(data, song, 'preview', 'MP3 preview', stem({ amp: 0.2 }));
  recordFeedback(data, song, { version_id: master.id, approved: true });
  recordFeedback(data, song, { version_id: preview.id, approved: true });
  assert.equal(song.music.versions.length, 4, 'every version is kept');
  // Delivery is blocked before the quote is approved and before Stripe confirms payment.
  assert.match(deliveryPackage(data, song).why, /not been approved/);
  assert.equal(approveQuote(data, q.deal.id).ok, true);
  assert.match(deliveryPackage(data, song).why, /Waiting for payment/);
  // 10-11. Invoice through the existing pipeline Stripe link; paid only when Stripe says so.
  markStage(q.deal, 'building'); markStage(q.deal, 'review');
  assert.equal((await createPaymentLink(ENV, q.deal, fakeStripe({ paid: false }))).status, 400, 'the owner must confirm a payment link');
  assert.equal((await createPaymentLink(ENV, q.deal, fakeStripe({ paid: false }), { confirmed: true })).status, 200);
  assert.equal((await checkPaid(ENV, q.deal, fakeStripe({ paid: false }))).paid, false);
  assert.match(deliveryPackage(data, song).why, /Stripe has not confirmed/);
  assert.equal((await checkPaid(ENV, q.deal, fakeStripe({ paid: true }))).paid, true);
  // 12. Delivery: only the quoted deliverables, from approved versions.
  const pack = deliveryPackage(data, song);
  assert.equal(pack.ok, true);
  assert.deepEqual(pack.files.map((f) => f.deliverable), ['master wav', 'mp3 preview']);
  assert.ok(!pack.files.some((f) => /mix/i.test(f.version)), 'no mixes or stems that were not contracted');
  // 25. The dashboard counts only that real Stripe payment.
  const dash = businessDashboard(data, { month: q.deal.updated_at.slice(0, 7) });
  assert.equal(dash.revenue_usd, 250);
  assert.equal(dash.revenue_note, '1 recorded payment');
});

test('beats: owner-priced licences, sales need proof, exclusives need approval and an agreement, conflicts are refused', () => {
  const data = { projects: [] };
  assert.equal(addBeat(data, { name: 'Smoke', licenses: [{ name: 'Basic lease' }] }).ok, false, 'no invented prices');
  const beat = addBeat(data, {
    name: 'Smoke', bpm: 145, key: 'F# minor', mood: 'dark', stems_available: true,
    licenses: [{ name: 'Basic lease', price_usd: 30, terms_ref: 'lease-v1.pdf' }, { name: 'Exclusive', price_usd: 500, exclusive: true, terms_ref: 'exclusive-v1.pdf' }],
  }).beat;
  assert.equal(beatListing(beat).publishable, true);
  assert.equal(recordBeatSale(data, beat, { license_id: 'basic_lease', buyer: 'A' }).ok, false, 'a sale needs a payment reference');
  assert.equal(recordBeatSale(data, beat, { license_id: 'basic_lease', buyer: 'A', payment_ref: 'cs_123' }).state, 'LEASED');
  assert.ok(!offers(beat).some((l) => l.exclusive), 'after a lease, the exclusive is not offered until Legal checks the lease terms');
  assert.equal(recordBeatSale(data, beat, { license_id: 'exclusive', buyer: 'B', payment_ref: 'cs_9', agreement_ref: 'signed.pdf' }).needs_owner, true);
  const blocked = recordBeatSale(data, beat, { license_id: 'exclusive', buyer: 'B', payment_ref: 'cs_9', agreement_ref: 'signed.pdf', owner_approved: true });
  assert.equal(blocked.needs_legal, true);
  beat.licenses.find((l) => l.exclusive).legal_reviewed = true;
  assert.equal(recordBeatSale(data, beat, { license_id: 'exclusive', buyer: 'B', payment_ref: 'cs_9', agreement_ref: 'signed.pdf', owner_approved: true }).state, 'EXCLUSIVE_SOLD');
  const again = recordBeatSale(data, beat, { license_id: 'basic_lease', buyer: 'C', payment_ref: 'cs_10' });
  assert.equal(again.conflict, true, 'nothing is sold after an exclusive');
  assert.deepEqual(offers(beat), []);
});

test('managed artists: isolated workspaces, catalog import, EP from their songs only, agreement needs Legal, owner and signatures', () => {
  const data = { projects: [], pipeline: [] };
  const a = addWorkspace(data, { kind: 'MANAGED_ARTIST', name: 'Erica' }).workspace;
  const b = addWorkspace(data, { kind: 'MANAGED_ARTIST', name: 'Dee' }).workspace;
  // 18. Import each artist's catalog into their own workspace, with real analysis.
  const songOf = (ws, title, spec) => {
    const p = addWorkspaceSong(data, ws.id, title).project;
    const bytes = stem(spec);
    p.music.versions.push({ id: `${p.id}-m`, kind: 'master', label: 'Master', sha256: sha(bytes), analysis: analyzeWav(bytes) });
    return p;
  };
  for (let i = 0; i < 6; i++) songOf(a, `Erica ${i + 1}`, { bpm: 140 + (i % 3), tone: 150 + i * 4 });
  for (let i = 0; i < 3; i++) songOf(b, `Dee ${i + 1}`, { bpm: 100, tone: 1500 });
  // 24. Each view holds only that artist's records.
  const va = workspaceView(data, a.id);
  const vb = workspaceView(data, b.id);
  assert.equal(va.projects.length, 6);
  assert.equal(vb.projects.length, 3);
  assert.ok(va.projects.every((p) => p.music.workspace_id === a.id));
  assert.equal(myCatalog(data.projects).length, 0, 'managed artists\' songs are not the owner\'s catalog');
  // 19-20. An EP recommendation from Erica's songs only.
  const ep = proposeCollection(data.projects, { kind: 'EP', size: 5, pool: va.projects });
  assert.equal(ep.ok, true);
  assert.ok(ep.tracks.every((t) => t.title.startsWith('Erica')));
  // 21. Rights in the artist report come from her own songs.
  const report = artistReport(data, a.id);
  assert.equal(report.songs, 6);
  assert.equal(report.money, null, 'no money shown without records');
  // 22-23. Agreement: draft → Legal → owner → sent → executed with signatures. CHE never signs.
  assert.equal(advanceAgreement(a, 'executed').ok, false);
  assert.equal(advanceAgreement(a, 'draft', { terms: { commission_pct: 15, term_months: 12 } }).ok, true);
  assert.equal(advanceAgreement(a, 'legal_review', {}).ok, false, 'Legal must leave notes');
  assert.equal(advanceAgreement(a, 'legal_review', { legal_notes: 'Exclusivity and termination need attorney review.' }).ok, true);
  assert.equal(advanceAgreement(a, 'owner_approved', {}).ok, false);
  assert.equal(advanceAgreement(a, 'owner_approved', { owner: true }).ok, true);
  assert.equal(advanceAgreement(a, 'sent', { owner_sent: true }).ok, true);
  // A management fee cannot be taken before the agreement is executed.
  assert.equal(addLedger(data, { workspace_id: a.id, kind: 'management_fee', amount_usd: 150, source: 'invoice', ref: 'inv-1' }).ok, false);
  assert.equal(advanceAgreement(a, 'executed', { signed_by_both: true }).ok, false);
  assert.equal(advanceAgreement(a, 'executed', { signed_by_both: true, document_ref: 'mgmt-signed.pdf' }).ok, true);
  assert.equal(addLedger(data, { workspace_id: a.id, kind: 'management_fee', amount_usd: 150, source: 'invoice', ref: 'inv-1' }).ok, true);
  // Money stays with its artist, and needs a source.
  assert.equal(addLedger(data, { workspace_id: b.id, amount_usd: 40, source: 'guess', ref: 'x' }).ok, false);
  assert.equal(workspaceView(data, b.id).ledger.length, 0, 'Erica\'s money never appears in Dee\'s workspace');
  assert.equal(artistReport(data, a.id).money.total_usd, 150);
});

test('the dashboard shows unknown, not zero, when nothing is recorded', () => {
  const d = businessDashboard({ projects: [], pipeline: [] });
  assert.equal(d.revenue_usd, null);
  assert.equal(d.revenue_note, 'No payments recorded this month.');
});

test('owner words: quotes, managed artists and clients', () => {
  assert.deepEqual(musicBusinessIntent('CHE, quote Jay R $250 for a mix and master'), { kind: 'quote', name: 'Jay R', price_usd: 250, service: 'mix and master' });
  assert.equal(musicBusinessIntent('Somebody wants me to mix their song for $200').price_usd, 200);
  assert.deepEqual(musicBusinessIntent("I'm managing Erica now"), { kind: 'managed_artist', name: 'Erica' });
  assert.deepEqual(musicBusinessIntent('Add a client called Jay R'), { kind: 'client', name: 'Jay R' });
  assert.equal(musicBusinessIntent('How is my music business?').kind, 'dashboard');
  assert.equal(musicBusinessIntent('What time is it?'), null);
});
