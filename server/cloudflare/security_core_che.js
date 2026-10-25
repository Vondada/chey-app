// CHE's product layer over the portable Security Core (security_core/). Everything CHE-specific lives here: where
// CHE keeps its security state, which of CHE's systems appear in the Cyber World, what CHE's lockdown really does,
// CHE's agents and the owner's chain of command. The core itself never imports this file or any CHE module.
import { SECURITY_CHIEF_NAME, SECURITY_CHIEF_TITLE } from './security_chief.js';
import { access, agent, brain, createSecurityCore, detection, events as coreEvents, incidents as coreIncidents, knowledge as coreKnowledge, physical, policies, readiness, simulation, workflows } from './security_core/index.js';
import { USABLE } from './capability_registry.js';
import { BrainLedger } from './brain_ledger.js';
import { registerCategories } from './knowledge_library.js';
import { appendArchive, archiveSummary, readArchive } from './security_archive.js';

export const CORE_KEY = 'che:security_core_v1';
export const CHE_TENANT = 'owner';
const MAX_SIMULATIONS = 5;
// A Durable Object value holds at most 128 KB; the core store is kept well under it.
const MAX_STORE_BYTES = 100_000;

// The product name and agent name come from configuration, never from the core.
export const CHE_SECURITY = createSecurityCore({ config: { product_name: 'Security', agent_name: SECURITY_CHIEF_NAME, host_product: 'CHE', default_tenant: CHE_TENANT, max_events_per_tenant: 120, max_incidents_per_tenant: 30 } });

// Security knowledge categories in CHE's Brain: the Knowledge Library takes them as categories, and the Brain
// Population Ledger (brain_ledger.js) files every security knowledge write under Security → its subcategory.
export const registeredBrainHooks = [...brain.registerSecurityCategories({ knowledge_library: registerCategories }), 'brain_ledger'];
export const LEDGER_SUBCATEGORY = Object.freeze({
  security_threats: 'Threat Detection',
  security_incidents: 'Incidents',
  security_policies: 'Policies',
  security_access: 'Access',
  security_code: 'Repository Security',
  security_devices: 'Devices',
  security_simulations: 'Simulations',
});

const LEDGER_EVENT = { PRIVATE: 'KNOWLEDGE_SAVED', PROMOTED: 'KNOWLEDGE_UPDATED', REJECTED: 'REJECTED' };

/**
 * One Brain Ledger record for a security knowledge write or a resolved real incident: category Security, the mapped
 * subcategory, timestamped, with no secret or identifier (the item is already redacted; the ledger scrubs again).
 */
export function ledgerEntryFor(kind, item, now = new Date()) {
  if (kind === 'incident') {
    return { category: 'Security', subcategory: 'Incidents', event_type: 'KNOWLEDGE_SAVED', knowledge_type: 'incident', title: `Incident resolved: ${item.title}`, summary: `${item.severity} incident, ${item.steps.length} recorded steps from detection to resolution.`, source_type: 'SYSTEM EVENT', source_reference: `security_core:${item.incident_id}`, record_id: item.incident_id, agent: 'security', knowledge_scope: 'owner-global', reason_saved: 'A real security incident was resolved.', verification_status: 'verified', at: now.toISOString() };
  }
  const cat = brain.securityCategory(item.category);
  const promoted = item.stage === 'PROMOTED';
  return {
    category: 'Security', subcategory: LEDGER_SUBCATEGORY[cat.id] || 'Threat Detection',
    event_type: LEDGER_EVENT[item.stage] || 'KNOWLEDGE_UPDATED', knowledge_type: 'security_knowledge',
    title: promoted ? item.general?.title || item.title : item.title,
    summary: promoted ? `Promoted to shared security knowledge (${item.portability}).` : item.stage === 'REJECTED' ? `Not shared: ${item.history.at(-1)?.note || 'rejected'}.` : `Captured as ${item.portability}.`,
    source_type: 'SYSTEM EVENT', source_reference: `security_core:${item.knowledge_id}`, record_id: item.knowledge_id, agent: 'security',
    knowledge_scope: item.portability === 'CUSTOMER_PRIVATE' || item.portability === 'RESTRICTED' ? 'private' : 'owner-global',
    reason_saved: 'Security knowledge pipeline step.', verification_status: promoted ? 'tested' : '', at: now.toISOString(),
  };
}

/** Writes the entry to CHE's Brain Ledger; a ledger failure never blocks the security action. */
export async function recordInLedger(storage, kind, item) {
  try { return await new BrainLedger(storage).record(ledgerEntryFor(kind, item)); } catch (_) { return null; }
}

// What CHE's lockdown really enforces today (resilience.js setLockdown and the Worker gates that read it).
export const CHE_LOCKDOWN_MECHANISMS = Object.freeze([
  { id: 'remote_engines', effect: 'Chat to remote AI engines pauses; CHE answers with her on-phone brain.' },
  { id: 'key_changes', effect: 'Adding, changing or removing keys (Keys tab and the memory database) is refused.' },
  { id: 'ai_mail', effect: 'Outgoing AI mail is frozen.' },
]);
export const CHE_LOCKDOWN_KEEPS = Object.freeze([
  'Paired devices stay paired.',
  'The password vault stays on your phone and is not touched.',
  'Nothing is deleted.',
  'To end it: say "end lockdown", or use the Security page with Face ID.',
]);

export async function loadCore(storage) {
  let saved = null;
  try { saved = await storage.get(CORE_KEY); } catch (_) { saved = null; }
  const store = saved && typeof saved === 'object' && saved.tenants ? saved : coreEvents.emptyStore();
  store.simulations ||= [];
  store.shared ||= [];
  return store;
}

/**
 * Trims oldest drills, then resolved incidents, then oldest events until the store fits one storage value. Real
 * evidence that leaves the live store is returned in `moved` for the archive; only drills are discarded (they are
 * labelled practice, never evidence).
 */
export function fitStore(store, max = MAX_STORE_BYTES, moved = []) {
  store.simulations = (store.simulations || []).slice(0, MAX_SIMULATIONS);
  const size = () => JSON.stringify(store).length;
  for (const [tenant, part] of Object.entries(store.tenants || {})) {
    if (part.overflow?.length) moved.push(...part.overflow.map((e) => ({ type: 'event', tenant, record: e })));
    delete part.overflow;
    while (size() > max && store.simulations.length) store.simulations.pop();
    while (size() > max && part.incidents.some((i) => i.stage === 'RESOLVED')) moved.push({ type: 'incident', tenant, record: part.incidents.splice(part.incidents.map((i) => i.stage).lastIndexOf('RESOLVED'), 1)[0] });
    while (size() > max && part.events.length > 20) moved.push(...part.events.splice(-10).map((e) => ({ type: 'event', tenant, record: e })));
    while (size() > max && part.knowledge.length > 5) moved.push({ type: 'knowledge', tenant, record: part.knowledge.pop() });
  }
  return size();
}

export async function saveCore(storage, store) {
  const moved = [];
  fitStore(store, MAX_STORE_BYTES, moved);
  await storage.put(CORE_KEY, store);
  if (moved.length) await appendArchive(storage, 'security_core', moved).catch(() => 0);
}

/**
 * The owner's decision on one security event (open, acknowledged, resolved). Owner-only at the route; never deletes.
 * A Protected Event needs no decision, so it cannot be "resolved" into looking like a closed threat.
 */
export function setEventResolution(store, { event_id, status, note = '' } = {}, now = new Date().toISOString()) {
  const bus = CHE_SECURITY.bus(store, CHE_TENANT);
  const e = bus.get(String(event_id || ''));
  if (!e) return { ok: false, reason: 'no_event' };
  if (e.verification === 'simulation') return { ok: false, reason: 'simulation' };
  if (e.status === 'protected') return { ok: false, reason: 'protected_event_needs_no_action' };
  const r = bus.resolve(e.event_id, { status, by: 'owner', note, now });
  if (!r) return { ok: false, reason: 'bad_status', allowed: coreEvents.OWNER_RESOLUTIONS };
  if (status === 'resolved' && r.status !== 'resolved') bus.update(r.event_id, { status: 'resolved' });
  if (status === 'open' && r.status === 'resolved') bus.update(r.event_id, { status: 'open' });
  return { ok: true, event: r, spoken: `Marked ${status}: ${r.summary || r.event_type}. The evidence stays on record.` };
}

/** Security records routes (owner-only at the Worker): an event decision, and the evidence archive. Null = not ours. */
export async function securityRecordsApi(storage, store, action, request, body = {}) {
  if (action === 'event/status' && request.method === 'POST') return setEventResolution(store, body);
  if (action === 'archive') return { summary: await archiveSummary(storage), ...(await readArchive(storage, body.page ?? new URL(request.url).searchParams.get('page'))) };
  return null;
}

const SEVERITY = { info: 'info', low: 'low', medium: 'medium', high: 'high', critical: 'critical' };
const STATUS = { benign: 'resolved', contained: 'contained', suspicious: 'open' };

/** Mirrors Security Intelligence's events (#464) into the core bus once each, keyed by their original id. */
export function syncLegacyEvents(store, sec) {
  const bus = CHE_SECURITY.bus(store, CHE_TENANT);
  let added = 0;
  // A watermark keeps an event that was trimmed from the bus from being mirrored in again.
  const since = store.legacy_synced_at ? Date.parse(store.legacy_synced_at) : 0;
  for (const e of [...(sec?.events || [])].reverse()) {
    const id = `si_${e.id}`;
    if (Date.parse(e.at) < since || bus.get(id)) continue;
    if (!store.legacy_synced_at || Date.parse(e.at) > Date.parse(store.legacy_synced_at)) store.legacy_synced_at = e.at;
    bus.publish({
      event_id: id, timestamp: e.at, event_type: `che.${e.type}`, source: e.source || 'security_intelligence',
      affected_resource: e.source || '', severity: SEVERITY[e.severity] || 'info',
      confidence: e.classification === 'suspicious' ? 0.7 : 0.9, summary: e.evidence,
      evidence_refs: [`security_intelligence:${e.id}`], status: STATUS[e.classification] || 'open', verification: 'verified',
    });
    added++;
  }
  return added;
}

/** Every open high or critical real event not yet in an incident opens one (DETECTED). */
export function openIncidentsForEvents(store, now = new Date().toISOString()) {
  const part = coreEvents.tenantState(store, CHE_TENANT);
  const linked = new Set(part.incidents.flatMap((i) => i.event_ids));
  const opened = [];
  for (const e of part.events) {
    if (linked.has(e.event_id) || e.verification === 'simulation' || e.status !== 'open' || !['high', 'critical'].includes(e.severity)) continue;
    opened.push(coreIncidents.openIncident(store, CHE_TENANT, { title: e.summary || e.event_type, severity: e.severity, event_ids: [e.event_id], by: 'security', now }));
  }
  return opened;
}

/** CHE's agents, tools, apps and devices as access principals with the scopes they really hold. */
export function chePrincipals({ data = {}, registry = { capabilities: {} }, appsGranted = [] } = {}) {
  const list = [
    access.principal({ id: 'che', kind: 'agent', name: 'CHE', scopes: ['chat', 'memory', 'apps:granted', 'money:ask_first', 'delete:ask_first'], note: 'Lead assistant; asks first before money or deletion.' }),
    access.principal({ id: 'security', kind: 'agent', name: SECURITY_CHIEF_NAME, scopes: ['security:read', 'sessions:revoke', 'lockdown:preview', 'incidents:manage'], note: `${SECURITY_CHIEF_TITLE}, reporting to CHE; lockdown needs the owner's confirmation.` }),
    access.principal({ id: 'atlas', kind: 'agent', name: 'Atlas', scopes: ['code:repository', 'github:pull_requests'], note: 'Coding agent; separate from the security chain.' }),
  ];
  for (const cap of Object.values(registry.capabilities || {})) {
    const p = cap.permissions || {};
    const scopes = [...(p.network || []).map((h) => `network:${h}`), ...(p.credentials || []).map((c) => `credentials:${c}`), ...(p.actions || []).map((a) => `action:${a}`), ...(p.files || []).map((f) => `files:${f}`)];
    if ([].concat(p.network || [], p.credentials || []).includes('*')) scopes.push('*');
    list.push(access.principal({ id: `tool:${cap.capability_id}`, kind: 'tool', name: cap.name, scopes, status: USABLE.has(cap.status) ? 'active' : 'inactive', last_used_at: cap.last_used_at || null }));
  }
  for (const app of appsGranted) list.push(access.principal({ id: `app:${app}`, kind: 'app', name: app, scopes: ['open', 'act_with_permission'] }));
  for (const d of Object.values(data.platform?.devices || {})) {
    if (!d) continue;
    list.push(access.principal({ id: `device:${d.id}`, kind: 'device', name: d.name, scopes: d.access === 'full' ? ['owner'] : ['private'], status: d.revoked_at ? 'revoked' : 'active', last_used_at: d.last_seen_at || null }));
  }
  return list;
}

/**
 * The Cyber World: one node per real CHE system, with its status from real events in the last day. Nothing is
 * invented: a system CHE cannot observe is 'unknown'.
 */
export function cyberWorld({ store, data = {}, registry = { capabilities: {} }, lockedDown = false, internalOnly = false, repo = '', now = Date.now() }) {
  const day = coreEvents.tenantState(store, CHE_TENANT).events.filter((e) => e.verification !== 'simulation' && now - Date.parse(e.timestamp) < 86_400_000);
  const touching = (match) => day.filter((e) => match.test(`${e.event_type} ${e.source} ${e.affected_resource}`));
  const status = (evs) => (evs.some((e) => e.status === 'open' && ['high', 'critical'].includes(e.severity)) ? 'alert' : evs.some((e) => e.status === 'open' && e.severity === 'medium') ? 'warning' : 'ok');
  const node = (id, kind, label, evs, extra = {}) => ({ id, kind, label, status: extra.status || status(evs), events_24h: evs.length, last_event_at: evs[0]?.timestamp || null, simulated: false, ...extra });
  const nodes = [
    node('worker', 'server', 'CHE server (Cloudflare Worker)', touching(/worker|deploy|error|auth|pairing/i), { detail: lockedDown ? 'Lockdown on' : internalOnly ? 'Internal-only mode' : 'Running' }),
    node('repository', 'repository', repo ? `Code repository (${repo.split('/').pop()})` : 'Code repository', touching(/repository|dependency|deploy/i), repo ? {} : { status: 'unknown', detail: 'GitHub not connected' }),
    node('capabilities', 'registry', 'Internal tools', touching(/capabilit/i), { detail: `${Object.keys(registry.capabilities || {}).length} registered` }),
    node('vault', 'vault', 'Password vault (on your phone)', [], { status: 'unknown', detail: 'Kept only on the phone; the server cannot see it.' }),
    node('egress', 'network', 'Outside services', touching(/egress|external/i), { detail: internalOnly ? 'Blocked (internal-only)' : 'Allowed when needed' }),
  ];
  for (const d of Object.values(data.platform?.devices || {})) {
    if (!d || d.revoked_at) continue;
    nodes.push(node(`device:${d.id}`, 'device', d.name || 'Paired device', touching(new RegExp(`device|${String(d.name || '').replace(/[^\w ]/g, '')}`, 'i')), { detail: `last seen ${d.last_seen_at ? d.last_seen_at.slice(0, 10) : 'unknown'}` }));
  }
  const links = nodes.filter((n) => n.id !== 'worker').map((n) => ({ from: 'worker', to: n.id }));
  // A pulse is a real open event on the node it concerns; the page animates only these.
  const nodeFor = (e) => {
    const t = `${e.event_type} ${e.source}`;
    if (/repository|dependency/i.test(t)) return 'repository';
    if (/capabilit/i.test(t)) return 'capabilities';
    if (/egress|external/i.test(t)) return 'egress';
    if (/device/i.test(t)) return nodes.find((n) => n.kind === 'device' && e.affected_resource.includes(n.label))?.id || 'worker';
    return 'worker';
  };
  const pulses = day.filter((e) => e.status === 'open').slice(0, 20).map((e) => ({ event_id: e.event_id, node: nodeFor(e), severity: e.severity, at: e.timestamp }));
  return { nodes, links, pulses, simulated: false };
}

/** Readiness metrics measured from CHE's real state. */
export function cheMetrics({ store, sec = {}, principals = [], registry = { capabilities: {} }, snapshot = null, lastAdvisories = null, now = Date.now() }) {
  const part = coreEvents.tenantState(store, CHE_TENANT);
  const real = part.events.filter((e) => e.verification !== 'simulation');
  const last = part.checks?.[0]?.at || null;
  return {
    last_check_age_h: last ? (now - Date.parse(last)) / 3_600_000 : null,
    open_incidents: coreIncidents.openIncidents(store, CHE_TENANT).length,
    open_high_events: real.filter((e) => e.status === 'open' && ['high', 'critical'].includes(e.severity)).length,
    wide_grants: access.reviewAccess(principals, now).findings.filter((f) => f.severity !== 'low').length,
    unreviewed_capabilities: Object.values(registry.capabilities || {}).filter((c) => USABLE.has(c.status) && !c.checks?.security?.ok).length,
    dependency_advisories: lastAdvisories == null ? null : lastAdvisories,
    snapshot_age_h: snapshot?.at ? (now - Date.parse(snapshot.at)) / 3_600_000 : null,
    secret_redactions_24h: (sec.events || []).filter((e) => e.type === 'secret_redacted' && now - Date.parse(e.at) < 86_400_000).length,
  };
}

/** Records a completed check (time and counts only). */
export function recordCheck(store, { findings = 0, advisories = null, deploy_checked = false } = {}, now = new Date().toISOString()) {
  const part = coreEvents.tenantState(store, CHE_TENANT);
  part.checks = [{ at: now, findings, advisories, deploy_checked: deploy_checked === true }, ...(part.checks || [])].slice(0, 20);
}

/** Runs a drill and keeps its labelled result apart from real state. */
export function runDrill(store, scenarioId) {
  const r = simulation.runSimulation(scenarioId);
  if (r.ok) store.simulations = [{ at: new Date().toISOString(), scenario: r.scenario, name: r.name, label: 'SIMULATION', incident: r.incident, events: r.events }, ...(store.simulations || [])].slice(0, MAX_SIMULATIONS);
  return r;
}

export function findAnyIncident(store, id) {
  return coreIncidents.findIncident(store, CHE_TENANT, id) || (store.simulations || []).map((s) => s.incident).find((i) => i?.incident_id === id) || null;
}

export function findKnowledge(store, id) {
  return coreEvents.tenantState(store, CHE_TENANT).knowledge.find((k) => k.knowledge_id === id) || null;
}

/** The whole Security page state. */
export function coreView({ store, sec = {}, data = {}, registry = { capabilities: {} }, appsGranted = [], lockedDown = false, internalOnly = false, repo = '', snapshot = null, legacyStatus = '', now = Date.now() }) {
  const principals = chePrincipals({ data, registry, appsGranted });
  const part = coreEvents.tenantState(store, CHE_TENANT);
  const lastAdvisories = part.checks?.[0]?.advisories ?? null;
  const metrics = cheMetrics({ store, sec, principals, registry, snapshot, lastAdvisories, now });
  const score = readiness.computeReadiness(metrics);
  const state = agent.agentState(store, CHE_TENANT, { lastCheckAt: part.checks?.[0]?.at || null, openHighEvents: metrics.open_high_events, now });
  const realEvents = part.events.filter((e) => e.verification !== 'simulation');
  const by = (re) => realEvents.filter((e) => re.test(e.event_type)).slice(0, 20);
  const world = cyberWorld({ store, data, registry, lockedDown, internalOnly, repo, now });
  return {
    core: CHE_SECURITY.describe(),
    status: legacyStatus,
    protection: { locked_down: lockedDown, internal_only: internalOnly, state: state.state, reason: state.reason },
    agent: { ...agent.hierarchy({ owner: 'Owner', lead: 'CHE', separate: [{ id: 'atlas', name: 'Atlas' }] }, CHE_SECURITY.config), state },
    readiness: score,
    world,
    defense: { active: coreIncidents.openIncidents(store, CHE_TENANT), recent: part.incidents.filter((i) => !coreIncidents.OPEN_STAGES.has(i.stage)).slice(0, 10) },
    sections: {
      threats: by(/threat|pairing|unknown_token|error_spike|unexpected_deploy|revoked/),
      identity: by(/identity|session|device/),
      code: by(/repository|deploy|capabilit/),
      dependencies: by(/dependency/),
      secrets: by(/secret/),
      malware: by(/malware|quarantine|artifact/),
    },
    systems: world.nodes,
    access: { principals, review: access.reviewAccess(principals, now) },
    backups: snapshot?.at ? { last_snapshot_at: snapshot.at, fingerprint: String(snapshot.sha256 || '').slice(0, 12) } : { last_snapshot_at: null },
    knowledge: { private: part.knowledge.map(({ _identifiers, ...k }) => k).slice(0, 20), shared: coreKnowledge.sharedKnowledge(store).slice(0, 20), portability: coreKnowledge.PORTABILITY, categories: brain.SECURITY_BRAIN_CATEGORIES, registered_in: registeredBrainHooks },
    policies: { version: policies.POLICY_VERSION, list: policies.POLICIES },
    workflows: workflows.SECURITY_WORKFLOWS.map((w) => ({ id: w.id, name: w.name, steps: w.steps.length, confirmations: workflows.confirmationsNeeded(w.id) })),
    simulations: { scenarios: simulation.SCENARIOS.map(({ id, name }) => ({ id, name })), recent: (store.simulations || []).map((s) => ({ at: s.at, scenario: s.scenario, name: s.name, label: 'SIMULATION', incident_id: s.incident?.incident_id })) },
    physical: physical.physicalView([]),
    lockdown: { active: lockedDown, mechanisms: CHE_LOCKDOWN_MECHANISMS, keeps: CHE_LOCKDOWN_KEEPS, requires_confirmation: true },
  };
}

/** Spoken summary: state, readiness and what to look at, never a claim of perfect safety. */
export function speakCore(view) {
  const r = view.readiness;
  const parts = [`Security is ${view.protection.state.toLowerCase()}: ${view.protection.reason}`];
  parts.push(r.score == null ? 'Readiness cannot be scored yet; run a security check.' : `Readiness ${r.score} out of 100 from ${r.components.length - r.unknown.length} measured checks.`);
  const weak = r.components.filter((c) => c.status === 'fail' || c.status === 'partial').slice(0, 3);
  if (weak.length) parts.push(`To improve: ${weak.map((c, i) => `${i + 1}. ${c.label} (${c.evidence})`).join('; ')}.`);
  parts.push(view.protection.locked_down ? 'Lockdown is on.' : 'Lockdown is off.');
  parts.push('This lowers risk; no system can be made unhackable.');
  return parts.join(' ');
}

export { access, coreEvents, coreIncidents, coreKnowledge, detection, simulation };
