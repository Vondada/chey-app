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
export function addWorkspaceSong(data, workspaceId, title, now = new Date().toISOString()) {
  const ws = workspaceById(data, workspaceId);
  if (!ws) return { ok: false, why: 'No such client or artist.' };
  const project = { id: `song_${crypto.randomUUID()}`, type: 'music', title: clip(title, 160), status: 'new', created_at: now, brief: `${ws.kind === 'CLIENT' ? 'Client' : ws.kind === 'MANAGED_ARTIST' ? 'Managed artist' : 'Collaboration'}: ${ws.name}`, music: { workspace_id: ws.id, context: ws.kind, purpose: 'CLIENT_SONG', versions: [], samples: [], splits: [], metadata: { title: clip(title, 160), artist: ws.name }, artwork: '', feedback: [], use_for_owner_taste: false } };
  data.projects.unshift(project);
  return { ok: true, project };
}

// ─── Services, packages and quotes ────────────────────────────────────────

/// The owner's own services. There are no built-in prices: every number comes from the owner.
export function setService(data, s) {
  lists(data);
  const name = clip(s.name, 80);
  if (!name) return { ok: false, why: 'A service needs a name.' };
  const price = money(s.price_usd);
  if (price === null) return { ok: false, why: `Set your price for ${name}.` };
  const service = {
    id: s.id || `svc_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    name, price_usd: price, deposit_usd: money(s.deposit_usd) ?? 0,
    turnaround_days: Number.isFinite(Number(s.turnaround_days)) ? Number(s.turnaround_days) : null,
    revisions: Number.isInteger(Number(s.revisions)) ? Number(s.revisions) : null,
    deliverables: (Array.isArray(s.deliverables) ? s.deliverables : []).map((d) => clip(d, 60)).filter(Boolean),
  };
  const i = data.music_services.findIndex((x) => x.id === service.id);
  if (i >= 0) data.music_services[i] = service; else data.music_services.push(service);
  return { ok: true, service };
}

/// A draft quote on the client's pipeline deal. Nothing is sent: the owner approves it first.
export function draftQuote(data, { workspace_id, service_id, price_usd, service_name, deposit_usd, deliverables, revisions, due, notes }, now = new Date().toISOString()) {
  lists(data);
  const ws = workspaceById(data, workspace_id);
  if (!ws) return { ok: false, why: 'No such client.' };
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
    deposit_usd: money(deposit_usd ?? svc?.deposit_usd) ?? 0,
    deliverables: (deliverables || svc?.deliverables || []).map((d) => clip(d, 60)),
    revisions: Number.isInteger(Number(revisions ?? svc?.revisions)) ? Number(revisions ?? svc?.revisions) : null,
    due: clip(due, 40) || null, notes: clip(notes, 1000), created_at: now,
  };
  deal.price_usd = price;
  deal.proposal_text = quoteText(ws, deal.music_quote);
  deal.stage = 'proposal';
  ws.deal_ids.push(deal.id);
  return { ok: true, deal, quote: deal.music_quote };
}

export function quoteText(ws, q) {
  return [
    `Quote for ${ws.name}: ${q.service}, $${q.price_usd.toFixed(2)}.`,
    q.deposit_usd ? `Deposit: $${q.deposit_usd.toFixed(2)}.` : 'No deposit.',
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

function dealFor(data, project) {
  return data.pipeline.find((d) => d.music_workspace_id === project.music.workspace_id && d.music_quote) || null;
}

export function revisionsAllowed(data, project) {
  return dealFor(data, project)?.music_quote?.revisions ?? null;
}

/// The delivery package: only what the quote lists, from approved versions, and only after Stripe has
/// confirmed payment on the deal (pipeline.checkPaid sets deal.payment.paid).
export function deliveryPackage(data, project) {
  const deal = dealFor(data, project);
  if (!deal) return { ok: false, why: 'This song has no quote, so there is nothing agreed to deliver.' };
  if (deal.music_quote.status !== 'approved') return { ok: false, why: 'The quote has not been approved yet.' };
  if (!(deal.payment?.paid === true && deal.stage === 'paid')) return { ok: false, why: 'Waiting for payment. Stripe has not confirmed it, so nothing is delivered yet.' };
  const versions = project.music.versions || [];
  const wanted = deal.music_quote.deliverables.map((d) => d.toLowerCase());
  const kindFor = (d) => (/master|wav/.test(d) ? 'master' : /instrumental/.test(d) ? 'instrumental' : /clean/.test(d) ? 'clean' : /stem/.test(d) ? 'stem' : /mp3|preview/.test(d) ? 'preview' : /mix/.test(d) ? 'mix' : null);
  const files = [];
  const missing = [];
  for (const d of wanted) {
    const kind = kindFor(d);
    const v = versions.filter((x) => x.kind === kind && x.approved_at).at(-1);
    if (v) files.push({ deliverable: d, version: v.label || v.kind, sha256: v.sha256 }); else missing.push(d);
  }
  return { ok: missing.length === 0, files, missing, why: missing.length ? `Not ready: no approved ${missing.join(', ')} yet.` : null };
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
  const at = AGREEMENT_STEPS.indexOf(step);
  const cur = a.step ? AGREEMENT_STEPS.indexOf(a.step) : -1;
  if (at < 0) return { ok: false, why: 'Unknown agreement step.' };
  if (at !== cur + 1) return { ok: false, why: `The next step is ${AGREEMENT_STEPS[cur + 1] || 'none'}, not ${step}.` };
  if (step === 'draft') a.terms = { ...(evidence.terms || {}) };
  if (step === 'legal_review' && !clip(evidence.legal_notes, 4000)) return { ok: false, why: 'Legal review needs its notes on record.' };
  if (step === 'owner_approved' && evidence.owner !== true) return { ok: false, why: 'Only the owner can approve this agreement.' };
  if (step === 'sent' && evidence.owner_sent !== true) return { ok: false, why: 'Sending an agreement needs the owner to do it or say so.' };
  if (step === 'executed' && !(evidence.signed_by_both === true && clip(evidence.document_ref, 300))) return { ok: false, why: 'Executed needs the document signed by both sides on record. CHE does not sign.' };
  a.step = step;
  a.history.push({ step, at, ...(evidence.legal_notes ? { legal_notes: clip(evidence.legal_notes, 4000) } : {}), ...(evidence.document_ref ? { document_ref: clip(evidence.document_ref, 300) } : {}) });
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
  return null;
}
