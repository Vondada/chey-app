// CHE Music business (owner, 2026-10-22): clients, managed artists, services, quotes, revisions,
// delivery, beats and per-artist money, inside Music. One source of truth:
//   - a client or a lead is the existing Client Pipeline deal (pipeline.js, data.pipeline);
//   - money moves only through the pipeline's Stripe link, and "paid" only when Stripe says so;
//   - songs are ordinary projects (data.projects) tagged with the workspace they belong to.
//
// Isolation. Every client, managed artist and collaboration is a workspace (data.music_workspaces).
// A project, beat sale, agreement or money record carries exactly one workspace id; the owner's own
// music carries none. Views read one workspace at a time, so one artist's files, money, contracts or
// strategy never appear in another's, and client music never enters the owner's catalog or taste.
//
// Authority. CHE prepares; the owner decides. Nothing here sends a quote, charges, refunds, signs,
// releases, transfers rights or sells an exclusive without an explicit owner approval on the record.

import { addLead, approveProposal } from './pipeline.js';
import { releaseReadiness } from './music_rights.js';

export const WORKSPACE_KINDS = Object.freeze(['CLIENT', 'MANAGED_ARTIST', 'COLLABORATION']);
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const money = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };
const lists = (data) => {
  data.music_workspaces = Array.isArray(data.music_workspaces) ? data.music_workspaces : [];
  data.music_services = Array.isArray(data.music_services) ? data.music_services : [];
  data.music_beats = Array.isArray(data.music_beats) ? data.music_beats : [];
  data.music_ledger = Array.isArray(data.music_ledger) ? data.music_ledger : [];
  data.projects = Array.isArray(data.projects) ? data.projects : [];
  data.pipeline = Array.isArray(data.pipeline) ? data.pipeline : [];
  return data;
};

// ─── Workspaces ───────────────────────────────────────────────────────────

export function addWorkspace(data, { kind, name, contact = '', notes = '' }, now = new Date().toISOString()) {
  lists(data);
  if (!WORKSPACE_KINDS.includes(kind)) return { ok: false, why: `A workspace is one of ${WORKSPACE_KINDS.join(', ')}.` };
  const clean = clip(name, 120);
  if (clean.length < 2) return { ok: false, why: 'The artist or client needs a name.' };
  const existing = data.music_workspaces.find((w) => w.kind === kind && w.name.toLowerCase() === clean.toLowerCase());
  if (existing) return { ok: true, workspace: existing, existing: true };
  const ws = { id: `ws_${crypto.randomUUID()}`, kind, name: clean, contact: clip(contact, 200), notes: clip(notes, 2000), created_at: now, deal_ids: [], agreement: null, outreach: 'NOT_CONTACTED' };
  data.music_workspaces.unshift(ws);
  return { ok: true, workspace: ws };
}

export function workspaceById(data, id) {
  return lists(data).music_workspaces.find((w) => w.id === id) || null;
}

/// Everything that belongs to one workspace, and nothing else.
export function workspaceView(data, id) {
  const ws = workspaceById(data, id);
  if (!ws) return null;
  const projects = data.projects.filter((p) => p?.music?.workspace_id === id);
  return {
    workspace: ws,
    projects,
    deals: data.pipeline.filter((d) => d.music_workspace_id === id),
    beats_sold: data.music_beats.flatMap((b) => (b.sales || []).filter((s) => s.workspace_id === id).map((s) => ({ beat: b.name, ...s }))),
    ledger: data.music_ledger.filter((r) => r.workspace_id === id),
  };
}

/// A song inside a workspace. Client and managed-artist songs never enter the owner's catalog.
/// A song is bound to the quote that covers it: the deal named, or the workspace's only quote.
export function addWorkspaceSong(data, workspaceId, title, { deal_id = null } = {}, now = new Date().toISOString()) {
  const ws = workspaceById(data, workspaceId);
  if (!ws) return { ok: false, why: 'No such client or artist.' };
  const quotes = data.pipeline.filter((d) => d.music_workspace_id === ws.id && d.music_quote);
  if (deal_id && !quotes.some((d) => d.id === deal_id)) return { ok: false, why: `That quote is not ${ws.name}'s.` };
  const dealId = deal_id || (quotes.length === 1 ? quotes[0].id : null);
  const project = { id: `song_${crypto.randomUUID()}`, type: 'music', title: clip(title, 160), status: 'new', created_at: now, brief: `${ws.kind === 'CLIENT' ? 'Client' : ws.kind === 'MANAGED_ARTIST' ? 'Managed artist' : 'Collaboration'}: ${ws.name}`, music: { workspace_id: ws.id, deal_id: dealId, context: ws.kind, purpose: 'CLIENT_SONG', versions: [], samples: [], splits: [], metadata: { title: clip(title, 160), artist: ws.name }, artwork: '', feedback: [], use_for_owner_taste: false } };
  data.projects.unshift(project);
  return { ok: true, project };
}

// ─── Services, packages and quotes ────────────────────────────────────────

// The pipeline's Stripe link bills the deal's full price once, after review, so a deposit could be
// promised but never collected. Quotes carry no deposit until the payment link can take one.
const NO_DEPOSITS = 'Deposits are not supported yet: the payment link bills the full price once the work is in review. Quote without a deposit.';

/// The owner's own services. There are no built-in prices: every number comes from the owner.
export function setService(data, s) {
  lists(data);
  const name = clip(s.name, 80);
  if (!name) return { ok: false, why: 'A service needs a name.' };
  const price = money(s.price_usd);
  if (price === null) return { ok: false, why: `Set your price for ${name}.` };
  if (Number(s.deposit_usd) > 0) return { ok: false, why: NO_DEPOSITS };
  const service = {
    id: s.id || `svc_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    name, price_usd: price,
    turnaround_days: Number.isFinite(Number(s.turnaround_days)) ? Number(s.turnaround_days) : null,
    revisions: Number.isInteger(Number(s.revisions)) ? Number(s.revisions) : null,
    deliverables: (Array.isArray(s.deliverables) ? s.deliverables : []).map((d) => clip(d, 60)).filter(Boolean),
  };
  const i = data.music_services.findIndex((x) => x.id === service.id);
  if (i >= 0) data.music_services[i] = service; else data.music_services.push(service);
  return { ok: true, service };
}

/// A draft quote on the client's pipeline deal. Nothing is sent: the owner approves it first.
export function draftQuote(data, { workspace_id, project_id, service_id, price_usd, service_name, deposit_usd, deliverables, revisions, due, notes }, now = new Date().toISOString()) {
  lists(data);
  const ws = workspaceById(data, workspace_id);
  if (!ws) return { ok: false, why: 'No such client.' };
  if (Number(deposit_usd) > 0) return { ok: false, why: NO_DEPOSITS };
  const song = project_id ? data.projects.find((p) => p.id === project_id && p.music?.workspace_id === ws.id) : null;
  if (project_id && !song) return { ok: false, why: `That song is not in ${ws.name}'s workspace.` };
  const svc = service_id ? data.music_services.find((s) => s.id === service_id) : null;
  const price = money(price_usd ?? svc?.price_usd);
  if (price === null) return { ok: false, why: 'A quote needs the price you want to charge.' };
  const name = clip(service_name || svc?.name, 80) || 'Music service';
  const lead = addLead(data, { client_name: ws.name, contact: ws.contact, need: `${name} for ${ws.name}`, source: 'music', added_by: 'CHE' });
  if (lead.status !== 200) return { ok: false, why: lead.detail };
  const deal = lead.deal;
  deal.music_workspace_id = ws.id;
  deal.music_quote = {
    status: 'draft', service: name, price_usd: price,
    deliverables: (deliverables || svc?.deliverables || []).map((d) => clip(d, 60)),
    revisions: Number.isInteger(Number(revisions ?? svc?.revisions)) ? Number(revisions ?? svc?.revisions) : null,
    due: clip(due, 40) || null, notes: clip(notes, 1000), created_at: now,
  };
  deal.price_usd = price;
  deal.proposal_text = quoteText(ws, deal.music_quote);
  deal.stage = 'proposal';
  ws.deal_ids.push(deal.id);
  if (song) song.music.deal_id = deal.id;
  return { ok: true, deal, quote: deal.music_quote };
}

export function quoteText(ws, q) {
  return [
    `Quote for ${ws.name}: ${q.service}, $${q.price_usd.toFixed(2)}.`,
    q.deliverables.length ? `Deliverables: ${q.deliverables.join(', ')}.` : 'Deliverables: to be agreed.',
    q.revisions === null ? 'Revisions: to be agreed.' : `Revisions included: ${q.revisions}.`,
    q.due ? `Due: ${q.due}.` : '',
    q.notes,
  ].filter(Boolean).join(' ');
}

/// The owner's approval of a quote, through the existing pipeline approval. It is then his to send.
export function approveQuote(data, dealId) {
  const deal = data.pipeline.find((d) => d.id === dealId && d.music_quote);
  if (!deal) return { ok: false, why: 'No such quote.' };
  const r = approveProposal(deal, { price_usd: deal.music_quote.price_usd });
  if (r.status !== 200) return { ok: false, why: r.detail };
  deal.music_quote.status = 'approved';
  return { ok: true, deal };
}

// ─── Revisions, approval and delivery ─────────────────────────────────────

/// Client feedback on a version. Counts against the quote's revisions; never silently over the limit.
export function recordFeedback(data, project, { version_id, text, approved = false }, now = new Date().toISOString()) {
  const m = project.music;
  const version = (m.versions || []).find((v) => v.id === version_id);
  if (!version) return { ok: false, why: 'No such version.' };
  m.feedback ||= [];
  if (approved) {
    version.approved_at = now;
    m.feedback.push({ version_id, approved: true, at: now });
    return { ok: true, approved: true, used: revisionsUsed(project), allowed: revisionsAllowed(data, project) };
  }
  const allowed = revisionsAllowed(data, project);
  const used = revisionsUsed(project);
  if (allowed !== null && used >= allowed) {
    return { ok: false, over_limit: true, why: `All ${allowed} included revision${allowed === 1 ? ' is' : 's are'} used. Another one needs your OK and, if you charge for it, a new quote.` };
  }
  m.feedback.push({ version_id, text: clip(text, 2000), at: now });
  return { ok: true, used: used + 1, allowed };
}

export function revisionsUsed(project) {
  return (project.music.feedback || []).filter((f) => !f.approved).length;
}

// The quote that covers this song: the one it is bound to, else the workspace's only quote. With
// several quotes and no binding there is no answer, rather than borrowing another project's terms.
function dealFor(data, project) {
  const quotes = data.pipeline.filter((d) => d.music_workspace_id === project.music.workspace_id && d.music_quote);
  if (project.music.deal_id) return quotes.find((d) => d.id === project.music.deal_id) || null;
  return quotes.length === 1 ? quotes[0] : null;
}

export function revisionsAllowed(data, project) {
  return dealFor(data, project)?.music_quote?.revisions ?? null;
}

/// The delivery package: only what the quote lists, from approved versions, and only after Stripe has
/// confirmed payment on the deal (pipeline.checkPaid sets deal.payment.paid).
export function deliveryPackage(data, project) {
  const deal = dealFor(data, project);
  if (!deal) return { ok: false, why: 'This song is not tied to one quote, so there is nothing agreed to deliver. Say which quote covers it.' };
  if (deal.music_quote.status !== 'approved') return { ok: false, why: 'The quote has not been approved yet.' };
  if (!(deal.payment?.paid === true && deal.stage === 'paid')) return { ok: false, why: 'Waiting for payment. Stripe has not confirmed it, so nothing is delivered yet.' };
  const versions = project.music.versions || [];
  const wanted = deal.music_quote.deliverables.map((d) => d.toLowerCase());
  const kindFor = deliverableKind;
  const files = [];
  const missing = [];
  for (const d of wanted) {
    const kind = kindFor(d);
    const v = versions.filter((x) => x.kind === kind && x.approved_at).at(-1);
    if (v) files.push({ deliverable: d, version: v.label || v.kind, sha256: v.sha256 }); else missing.push(d);
  }
  return { ok: missing.length === 0, files, missing, why: missing.length ? `Not ready: no approved ${missing.join(', ')} yet.` : null };
}

/// What a deliverable asks for. The content (instrumental, stems, mix...) decides; a file format such as
/// WAV only means master when nothing else is named.
export function deliverableKind(d) {
  const t = String(d).toLowerCase();
  return /instrumental/.test(t) ? 'instrumental' : /clean/.test(t) ? 'clean' : /stem/.test(t) ? 'stem'
    : /master/.test(t) ? 'master' : /preview|mp3/.test(t) ? 'preview' : /mix/.test(t) ? 'mix' : /wav/.test(t) ? 'master' : null;
}

// ─── Beats ────────────────────────────────────────────────────────────────

export const BEAT_STATES = Object.freeze(['AVAILABLE', 'LEASED', 'EXCLUSIVE_SOLD', 'RETIRED']);

export function addBeat(data, b) {
  lists(data);
  const name = clip(b.name, 120);
  if (!name) return { ok: false, why: 'A beat needs a name.' };
  const licenses = (b.licenses || []).map((l) => ({ id: clip(l.id || l.name, 40).toLowerCase().replace(/[^a-z0-9]+/g, '_'), name: clip(l.name, 60), price_usd: money(l.price_usd), exclusive: l.exclusive === true, terms_ref: clip(l.terms_ref, 300) || null, legal_reviewed: l.legal_reviewed === true }));
  if (licenses.some((l) => l.price_usd === null)) return { ok: false, why: 'Every licence needs your price.' };
  const beat = { id: `beat_${crypto.randomUUID()}`, name, bpm: Number(b.bpm) || null, key: clip(b.key, 12) || null, mood: clip(b.mood, 60) || null, stems_available: b.stems_available === true, provenance: b.provenance || 'OWNER_ORIGINAL', licenses, state: 'AVAILABLE', sales: [] };
  data.music_beats.unshift(beat);
  return { ok: true, beat };
}

/// Licences that can still be offered. An exclusive sale ends every offer; a lease ends the exclusive offer
/// only once Legal has confirmed the lease terms allow it.
export function offers(beat) {
  if (['EXCLUSIVE_SOLD', 'RETIRED'].includes(beat.state)) return [];
  return beat.licenses.filter((l) => !(l.exclusive && beat.sales.length && !l.legal_reviewed));
}

/// Records a sale. Every sale needs a buyer and a payment reference; an exclusive also needs a signed
/// agreement reference and the owner's approval, and is refused while it would conflict.
export function recordBeatSale(data, beat, { license_id, buyer, payment_ref, agreement_ref, owner_approved = false, workspace_id = null }, now = new Date().toISOString()) {
  const lic = beat.licenses.find((l) => l.id === license_id);
  if (!lic) return { ok: false, why: 'No such licence on this beat.' };
  if (beat.state === 'EXCLUSIVE_SOLD') return { ok: false, conflict: true, why: `${beat.name} was sold exclusively. No further licence can be sold.` };
  if (beat.state === 'RETIRED') return { ok: false, why: `${beat.name} is retired.` };
  if (!clip(buyer, 120) || !clip(payment_ref, 200)) return { ok: false, why: 'A sale needs the buyer and the payment reference.' };
  if (lic.exclusive) {
    if (!owner_approved) return { ok: false, needs_owner: true, why: 'An exclusive sale needs your approval.' };
    if (!clip(agreement_ref, 300)) return { ok: false, why: 'An exclusive sale needs the signed agreement on record.' };
    if (beat.sales.length && !lic.legal_reviewed) return { ok: false, conflict: true, needs_legal: true, why: `${beat.name} already has ${beat.sales.length} lease${beat.sales.length === 1 ? '' : 's'}. Legal must check those lease terms before an exclusive can be sold.` };
  }
  const sale = { license: lic.name, exclusive: lic.exclusive, buyer: clip(buyer, 120), payment_ref: clip(payment_ref, 200), agreement_ref: clip(agreement_ref, 300) || null, at: now, workspace_id };
  beat.sales.push(sale);
  beat.state = lic.exclusive ? 'EXCLUSIVE_SOLD' : 'LEASED';
  if (workspace_id) data.music_ledger.push({ workspace_id, kind: 'beat_sale', amount_usd: lic.price_usd, source: 'beat_sale', ref: sale.payment_ref, at: now });
  return { ok: true, sale, state: beat.state };
}

/// A storefront listing from stored fields only. Nothing is published.
export function beatListing(beat) {
  return {
    title: `${beat.name}${beat.bpm ? ` · ${beat.bpm} BPM` : ''}${beat.key ? ` · ${beat.key}` : ''}`,
    tags: [beat.mood, beat.bpm ? `${beat.bpm} bpm` : null, beat.key].filter(Boolean),
    licenses: offers(beat).map((l) => ({ name: l.name, price_usd: l.price_usd, exclusive: l.exclusive, terms: l.terms_ref || 'terms not written yet' })),
    stems: beat.stems_available,
    publishable: offers(beat).length > 0 && offers(beat).every((l) => l.terms_ref),
  };
}

// ─── Managed artists: agreements and money ────────────────────────────────

const AGREEMENT_STEPS = ['draft', 'legal_review', 'owner_approved', 'sent', 'executed'];

/// Agreement workflow for a managed artist. CHE never signs: "executed" needs the owner's approval
/// earlier in the chain and a signed document reference from both parties.
export function advanceAgreement(ws, step, evidence = {}, now = new Date().toISOString()) {
  ws.agreement ||= { step: null, terms: {}, history: [] };
  const a = ws.agreement;
  const idx = AGREEMENT_STEPS.indexOf(step);
  const cur = a.step ? AGREEMENT_STEPS.indexOf(a.step) : -1;
  if (idx < 0) return { ok: false, why: 'Unknown agreement step.' };
  if (idx !== cur + 1) return { ok: false, why: `The next step is ${AGREEMENT_STEPS[cur + 1] || 'none'}, not ${step}.` };
  if (step === 'draft') a.terms = { ...(evidence.terms || {}) };
  if (step === 'legal_review' && !clip(evidence.legal_notes, 4000)) return { ok: false, why: 'Legal review needs its notes on record.' };
  if (step === 'owner_approved' && evidence.owner !== true) return { ok: false, why: 'Only the owner can approve this agreement.' };
  if (step === 'sent' && evidence.owner_sent !== true) return { ok: false, why: 'Sending an agreement needs the owner to do it or say so.' };
  if (step === 'executed' && !(evidence.signed_by_both === true && clip(evidence.document_ref, 300))) return { ok: false, why: 'Executed needs the document signed by both sides on record. CHE does not sign.' };
  a.step = step;
  a.history.push({ step, at: now, ...(evidence.legal_notes ? { legal_notes: clip(evidence.legal_notes, 4000) } : {}), ...(evidence.document_ref ? { document_ref: clip(evidence.document_ref, 300) } : {}) });
  return { ok: true, step };
}

/// A money record. It must name where it came from; nothing is estimated or invented.
export function addLedger(data, r, now = new Date().toISOString()) {
  lists(data);
  const sources = ['stripe', 'invoice', 'distributor_statement', 'platform_report', 'beat_sale', 'owner_entered'];
  if (!sources.includes(r.source)) return { ok: false, why: `A money record needs its source: ${sources.join(', ')}.` };
  if (!clip(r.ref, 200)) return { ok: false, why: 'A money record needs its reference (receipt, statement or invoice id).' };
  const amount = Number(r.amount_usd);
  if (!Number.isFinite(amount)) return { ok: false, why: 'A money record needs an amount.' };
  if (r.kind === 'management_fee') {
    const ws = workspaceById(data, r.workspace_id);
    if (ws?.agreement?.step !== 'executed') return { ok: false, why: 'A management fee needs an executed agreement on record.' };
  }
  const rec = { workspace_id: r.workspace_id || null, kind: clip(r.kind, 40) || 'income', amount_usd: Math.round(amount * 100) / 100, source: r.source, ref: clip(r.ref, 200), at: r.at || now };
  data.music_ledger.push(rec);
  return { ok: true, record: rec };
}

/// The music-business dashboard from real records only. Unknown is shown as unknown, not as zero.
export function businessDashboard(data, { month = new Date().toISOString().slice(0, 7) } = {}) {
  lists(data);
  const paidDeals = data.pipeline.filter((d) => d.music_workspace_id && d.payment?.paid === true && String(d.updated_at || '').startsWith(month));
  const ledger = data.music_ledger.filter((r) => String(r.at).startsWith(month) && r.workspace_id);
  const records = paidDeals.length + ledger.length;
  const revenue = paidDeals.reduce((s, d) => s + Number(d.payment.amount_total || 0) / 100, 0) + ledger.filter((r) => r.amount_usd > 0).reduce((s, r) => s + r.amount_usd, 0);
  const active = data.music_workspaces.filter((w) => w.kind === 'CLIENT' && data.projects.some((p) => p?.music?.workspace_id === w.id && p.status !== 'delivered'));
  return {
    month,
    revenue_usd: records ? Math.round(revenue * 100) / 100 : null,
    revenue_note: records ? `${records} recorded payment${records === 1 ? '' : 's'}` : 'No payments recorded this month.',
    active_clients: active.length,
    managed_artists: data.music_workspaces.filter((w) => w.kind === 'MANAGED_ARTIST').length,
    projects: data.projects.filter((p) => p?.music?.workspace_id).length,
    invoices_due: data.pipeline.filter((d) => d.music_workspace_id && d.stage === 'invoiced').length,
    beats_available: data.music_beats.filter((b) => b.state === 'AVAILABLE' || b.state === 'LEASED').length,
  };
}

/// One artist's management report: their songs only.
export function artistReport(data, workspaceId, now = Date.now()) {
  const v = workspaceView(data, workspaceId);
  if (!v) return null;
  const songs = v.projects.map((p) => ({ title: p.title, ...releaseReadiness(p, now) }));
  const ready = songs.filter((s) => s.ready).length;
  const income = v.ledger.filter((r) => r.amount_usd > 0);
  return {
    artist: v.workspace.name,
    songs: songs.length, ready,
    needs_attention: songs.filter((s) => !s.ready).map((s) => `${s.title}: ${s.primary_action}`),
    agreement: v.workspace.agreement?.step || 'none',
    money: income.length ? { total_usd: Math.round(income.reduce((s, r) => s + r.amount_usd, 0) * 100) / 100, records: income.length } : null,
  };
}

// ─── Owner words ──────────────────────────────────────────────────────────

/// "Quote Jay R $250 for a mix and master", "I'm managing Erica now", "add a client called Jay R".
export function musicBusinessIntent(message) {
  const t = String(message || '').trim().replace(/[.!?]+$/, '');
  let m = t.match(/\bquote\s+(.+?)\s+\$\s?(\d+(?:\.\d{1,2})?)\s+for\s+(?:a\s+|an\s+)?(.+)$/i);
  if (m) return { kind: 'quote', name: m[1].trim(), price_usd: Number(m[2]), service: m[3].trim() };
  m = t.match(/\b(?:somebody|someone|an? artist|(.+?))\s+wants me to\s+(mix|master|mix and master)\s+(?:their|his|her)\s+song\s+for\s+\$\s?(\d+(?:\.\d{1,2})?)/i);
  if (m) return { kind: 'quote', name: m[1] ? m[1].trim() : null, price_usd: Number(m[3]), service: m[2] };
  m = t.match(/\bi(?:'m| am)\s+(?:now\s+)?managing\s+(.+?)(?:\s+now)?$/i);
  if (m) return { kind: 'managed_artist', name: m[1].trim() };
  m = t.match(/\badd\s+(?:a\s+)?(?:new\s+)?(?:music\s+)?client\s+(?:called|named)\s+(.+)$/i);
  if (m) return { kind: 'client', name: m[1].trim() };
  if (/\b(?:how(?:'s| is) my music business|music business (?:summary|dashboard|status))\b/i.test(t)) return { kind: 'dashboard' };
  return spokenAction(t);
}

const NUM = '(\\d+(?:\\.\\d{1,2})?)';
const SPOKEN = [
  // "Set my mix and master price to $250 with 2 revisions"
  ['service', new RegExp(`^(?:set\\s+)?my\\s+(.+?)\\s+price\\s+(?:is|to)\\s+\\$\\s?${NUM}(?:\\s+with\\s+(\\d+)\\s+revisions?)?$`, 'i'), (m) => ({ service: m[1], price_usd: Number(m[2]), revisions: m[3] === undefined ? null : Number(m[3]) })],
  // "Approve the quote for Jay R"
  ['approve_quote', /\bapprove\s+(?:the\s+|my\s+)?quote\s+for\s+(.+)$/i, (m) => ({ name: m[1] })],
  // "Add a song called Night Drive for Jay R"
  ['song', /\badd\s+(?:a\s+)?song\s+(?:called|named)\s+(.+?)\s+for\s+(?:client\s+|artist\s+)?(.+)$/i, (m) => ({ title: m[1], name: m[2] })],
  // "Jay R wants changes on Night Drive: vocal louder"
  ['feedback', /^(.+?)\s+wants\s+changes\s+(?:on|to)\s+(.+?)\s*[:,\u2014-]\s*(.+)$/i, (m) => ({ name: m[1], title: m[2], text: m[3] })],
  // "Jay R approved the master of Night Drive" / "Jay R approved Night Drive"
  ['approve_version', /^(.+?)\s+approved\s+(?:the\s+)?(?:(mix|master|preview|instrumental|stems?|clean)\s+(?:of|for|on)\s+)?(.+)$/i, (m) => ({ name: m[1], version_kind: m[2] ? m[2].toLowerCase().replace(/s$/, '') : null, title: m[3] })],
  // "Is Night Drive ready to deliver?" / "Delivery status for Night Drive"
  ['delivery', /^(?:is\s+)?(.+?)\s+ready\s+(?:to\s+deliver|for\s+delivery)$|^delivery\s+(?:status\s+)?for\s+(.+)$/i, (m) => ({ title: m[1] || m[2] })],
  // "Add a beat called Smoke, 145 BPM, basic lease $30, exclusive $500"
  ['beat', /^add\s+(?:a\s+)?beat\s+(?:called|named)\s+(.+)$/i, (m) => parseBeat(m[1])],
  // "Sold a basic lease of Smoke to Mike, payment cs_123" (an exclusive also names "agreement <ref>")
  ['beat_sale', /\bsold\s+(?:a|an|the)\s+(.+?)\s+(?:licen[cs]e\s+)?(?:of|for|on)\s+(.+?)\s+to\s+(.+?)[,;]?\s+payment\s+(?:ref(?:erence)?\s+)?(\S+?)(?:[,;]?\s+agreement\s+(\S+))?$/i, (m) => ({ license: m[1], beat: m[2], buyer: m[3], payment_ref: m[4], agreement_ref: m[5] || null })],
  // Agreement steps for a managed artist.
  ['agreement', new RegExp(`^draft\\s+(?:a\\s+)?management\\s+agreement\\s+for\\s+(.+?)(?:\\s+at\\s+${NUM}\\s*(?:%|percent))?(?:\\s+for\\s+(\\d+)\\s+months)?$`, 'i'), (m) => ({ step: 'draft', name: m[1], terms: { ...(m[2] ? { commission_pct: Number(m[2]) } : {}), ...(m[3] ? { term_months: Number(m[3]) } : {}) } })],
  ['agreement', /^legal\s+notes\s+(?:for|on)\s+(.+?)'s\s+agreement\s*[:,\u2014-]\s*(.+)$/i, (m) => ({ step: 'legal_review', name: m[1], evidence: { legal_notes: m[2] } })],
  ['agreement', /^i\s+approve\s+(.+?)'s\s+(?:management\s+)?agreement$/i, (m) => ({ step: 'owner_approved', name: m[1], evidence: { owner: true } })],
  ['agreement', /^i\s+(?:sent|have sent|'ve sent)\s+(.+?)'s\s+(?:management\s+)?agreement$/i, (m) => ({ step: 'sent', name: m[1], evidence: { owner_sent: true } })],
  ['agreement', /^(.+?)'s\s+(?:management\s+)?agreement\s+is\s+signed\s+by\s+both(?:\s+sides)?[,;]?\s+document\s+(\S+)$/i, (m) => ({ step: 'executed', name: m[1], evidence: { signed_by_both: true, document_ref: m[2] } })],
  // "Record $150 management fee from Erica, invoice inv-1"
  ['ledger', new RegExp(`^record\\s+\\$\\s?${NUM}\\s+(management fee|income|royalt(?:y|ies)|beat sale|streaming income)\\s+(?:from|for)\\s+(.+?)[,;]?\\s+(stripe|invoice|distributor statement|platform report|owner entered)\\s+(?:ref(?:erence)?\\s+)?(\\S+)$`, 'i'), (m) => ({ amount_usd: Number(m[1]), ledger_kind: m[2].toLowerCase().replace(/\s+/g, '_').replace(/^royalt(?:y|ies)$/, 'royalty'), name: m[3], source: m[4].toLowerCase().replace(/\s+/g, '_'), ref: m[5] })],
];

function spokenAction(t) {
  const clean = t.replace(/^(?:che|hey che)[,\s]+/i, '');
  for (const [kind, re, pick] of SPOKEN) {
    const m = clean.match(re);
    if (m) { const v = pick(m); if (v) return { kind, ...v }; }
  }
  return null;
}

function parseBeat(text) {
  const parts = text.split(/\s*,\s*/);
  const name = parts.shift();
  const beat = { name, licenses: [] };
  for (const p of parts) {
    let m = p.match(/^(\d{2,3})\s*bpm$/i);
    if (m) { beat.bpm = Number(m[1]); continue; }
    m = p.match(/^(?:in\s+)?([A-G][#b]?\s+(?:major|minor))$/i);
    if (m) { beat.key = m[1]; continue; }
    m = p.match(/^(.+?)\s+\$\s?(\d+(?:\.\d{1,2})?)$/);
    if (m) beat.licenses.push({ name: m[1], price_usd: Number(m[2]), exclusive: /exclusive/i.test(m[1]) });
  }
  return name ? beat : null;
}

const findByName = (list, name, key = 'name') => {
  const n = String(name || '').trim().toLowerCase();
  return list.find((x) => String(x[key] || '').toLowerCase() === n) || null;
};

/// Resolves a spoken action against the stored records without changing anything. Null means the
/// words named no client, artist, song or beat CHE knows, so the sentence was not meant for here.
export function resolveSpokenBusiness(data, ask) {
  lists(data);
  if (ask.kind === 'service' || ask.kind === 'beat') return {};
  if (ask.kind === 'delivery') {
    const song = data.projects.find((p) => p?.music?.workspace_id && p.title.toLowerCase() === ask.title.trim().toLowerCase());
    return song ? { song } : null;
  }
  if (ask.kind === 'beat_sale') {
    const beat = findByName(data.music_beats, ask.beat);
    return beat ? { beat } : null;
  }
  const ws = findByName(data.music_workspaces, ask.name);
  if (!ws) return null;
  if (ask.kind === 'feedback' || ask.kind === 'approve_version') {
    const song = data.projects.find((p) => p?.music?.workspace_id === ws.id && p.title.toLowerCase() === ask.title.trim().toLowerCase());
    return song ? { ws, song } : null;
  }
  if (ask.kind === 'agreement' && ws.kind !== 'MANAGED_ARTIST') return null;
  return { ws };
}

const $ = (n) => `$${Number(n).toFixed(2)}`;

/// Carries out a resolved spoken action and says what actually happened.
export function applySpokenBusiness(data, ask, target, now = new Date().toISOString()) {
  const fail = (text) => ({ ok: false, changed: false, text });
  const done = (text) => ({ ok: true, changed: true, text });
  if (ask.kind === 'service') {
    const r = setService(data, { name: ask.service, price_usd: ask.price_usd, revisions: ask.revisions });
    return r.ok ? done(`${r.service.name} is set at ${$(r.service.price_usd)}${r.service.revisions === null ? '' : ` with ${r.service.revisions} revision${r.service.revisions === 1 ? '' : 's'}`}, sir.`) : fail(r.why);
  }
  if (ask.kind === 'approve_quote') {
    const drafts = data.pipeline.filter((d) => d.music_workspace_id === target.ws.id && d.music_quote?.status === 'draft');
    if (!drafts.length) return fail(`${target.ws.name} has no draft quote waiting for approval.`);
    if (drafts.length > 1) return fail(`${target.ws.name} has ${drafts.length} draft quotes: ${drafts.map((d) => `${d.music_quote.service} at ${$(d.music_quote.price_usd)}`).join('; ')}. Approve that one in Clients, or remove the extra one first.`);
    const r = approveQuote(data, drafts[0].id);
    return r.ok ? done(`Approved the quote for ${target.ws.name}: ${drafts[0].music_quote.service}, ${$(drafts[0].music_quote.price_usd)}. It is yours to send. Nothing was sent.`) : fail(r.why);
  }
  if (ask.kind === 'song') {
    const r = addWorkspaceSong(data, target.ws.id, ask.title, {}, now);
    if (!r.ok) return fail(r.why);
    return done(`Added ${r.project.title} to ${target.ws.name}'s workspace. ${r.project.music.deal_id ? 'It is tied to their quote.' : 'It is not tied to a quote yet, so revisions and delivery wait until one covers it.'}`);
  }
  if (ask.kind === 'feedback' || ask.kind === 'approve_version') {
    const versions = (target.song.music.versions || []).filter((v) => !ask.version_kind || v.kind === ask.version_kind);
    const v = versions.at(-1);
    if (!v) return fail(`${target.song.title} has no ${ask.version_kind ? `${ask.version_kind} ` : ''}version on record yet.`);
    const r = recordFeedback(data, target.song, { version_id: v.id, text: ask.text, approved: ask.kind === 'approve_version' }, now);
    if (!r.ok) return fail(r.why);
    if (r.approved) return done(`Recorded ${target.ws.name}'s approval of ${v.label || v.kind} for ${target.song.title}.`);
    return done(`Recorded ${target.ws.name}'s changes on ${v.label || v.kind}. That is revision ${r.used}${r.allowed === null ? '; the quote does not set a limit' : ` of ${r.allowed}`}.`);
  }
  if (ask.kind === 'delivery') {
    const r = deliveryPackage(data, target.song);
    return { ok: r.ok, changed: false, text: r.ok ? `${target.song.title} is ready to deliver: ${r.files.map((f) => `${f.deliverable} from ${f.version}`).join(', ')}. Nothing has been sent.` : r.why };
  }
  if (ask.kind === 'beat') {
    const r = addBeat(data, ask);
    return r.ok ? done(`Added the beat ${r.beat.name}${r.beat.licenses.length ? ` with ${r.beat.licenses.map((l) => `${l.name} at ${$(l.price_usd)}`).join(', ')}` : ' with no licences priced yet'}. Nothing is listed or published.`) : fail(r.why);
  }
  if (ask.kind === 'beat_sale') {
    const lic = target.beat.licenses.find((l) => l.name.toLowerCase() === ask.license.toLowerCase()) || target.beat.licenses.find((l) => l.name.toLowerCase().includes(ask.license.toLowerCase()));
    if (!lic) return fail(`${target.beat.name} has no ${ask.license} licence. It has ${target.beat.licenses.map((l) => l.name).join(', ') || 'none'}.`);
    // The owner saying he sold it is his approval; an exclusive still needs the signed agreement.
    const r = recordBeatSale(data, target.beat, { license_id: lic.id, buyer: ask.buyer, payment_ref: ask.payment_ref, agreement_ref: ask.agreement_ref, owner_approved: true }, now);
    return r.ok ? done(`Recorded the ${lic.name} of ${target.beat.name} to ${r.sale.buyer}, payment ${r.sale.payment_ref}. ${r.state === 'EXCLUSIVE_SOLD' ? 'It is now sold exclusively; nothing else can be sold for it.' : 'It is now leased.'}`) : fail(r.why);
  }
  if (ask.kind === 'agreement') {
    const r = advanceAgreement(target.ws, ask.step, ask.step === 'draft' ? { terms: ask.terms } : ask.evidence, now);
    const said = { draft: 'Drafted', legal_review: 'Recorded Legal\'s notes on', owner_approved: 'Recorded your approval of', sent: 'Recorded that you sent', executed: 'Recorded the signed' }[ask.step];
    return r.ok ? done(`${said} ${target.ws.name}'s management agreement.${ask.step === 'draft' ? ' Legal reviews it next. CHE does not sign anything.' : ''}`) : fail(r.why);
  }
  if (ask.kind === 'ledger') {
    const r = addLedger(data, { workspace_id: target.ws.id, kind: ask.ledger_kind, amount_usd: ask.amount_usd, source: ask.source, ref: ask.ref }, now);
    return r.ok ? done(`Recorded ${$(r.record.amount_usd)} ${r.record.kind.replace(/_/g, ' ')} for ${target.ws.name}, ${r.record.source.replace(/_/g, ' ')} ${r.record.ref}.`) : fail(r.why);
  }
  return null;
}
