// Security Core: the incident engine. An incident moves forward through a fixed lifecycle; every step is recorded with
// who moved it, when, why and with what evidence, so it can be replayed exactly as it happened.
import { SEVERITIES, clip, productConfig, shortId } from './config.js';
import { tenantState } from './events.js';
import { redactDeep } from './secrets.js';

export const LIFECYCLE = Object.freeze(['DETECTED', 'TRIAGED', 'INVESTIGATING', 'CONTAINING', 'CONTAINED', 'RECOVERING', 'RECOVERED', 'RESOLVED']);
export const OPEN_STAGES = new Set(LIFECYCLE.slice(0, -1));

/** Opens an incident from one or more events of the same tenant. */
export function openIncident(store, tenant_id, { title, severity = 'medium', event_ids = [], simulation = false, by = 'security', now = new Date().toISOString() } = {}, config = productConfig()) {
  const part = tenantState(store, tenant_id);
  const known = new Set(part.events.map((e) => e.event_id));
  const linked = [].concat(event_ids).filter((id) => known.has(id)).slice(0, 50);
  const incident = {
    incident_id: shortId('inc_'),
    tenant_id,
    title: clip(redactDeep(String(title || 'Security incident')), 160),
    severity: SEVERITIES.includes(severity) ? severity : 'medium',
    stage: 'DETECTED',
    simulation: simulation === true,
    label: simulation === true ? 'SIMULATION' : null,
    event_ids: linked,
    opened_at: now,
    closed_at: null,
    steps: [{ stage: 'DETECTED', at: now, by: clip(by, 40), note: `Opened from ${linked.length} event(s).`, evidence_refs: linked }],
  };
  part.incidents = [incident, ...part.incidents].slice(0, config.max_incidents_per_tenant);
  return incident;
}

export function findIncident(store, tenant_id, incident_id) {
  return tenantState(store, tenant_id).incidents.find((i) => i.incident_id === incident_id) || null;
}

/**
 * Moves an incident forward. A step back or to the same stage is refused, and every step needs a note: the record
 * says what was done, not merely that the stage changed.
 */
export function advanceIncident(incident, to, { by = 'security', note = '', evidence_refs = [], now = new Date().toISOString() } = {}) {
  if (!incident) return { ok: false, reason: 'unknown_incident' };
  const from = LIFECYCLE.indexOf(incident.stage);
  const target = LIFECYCLE.indexOf(to);
  if (target < 0) return { ok: false, reason: 'unknown_stage' };
  if (target <= from) return { ok: false, reason: 'lifecycle_moves_forward_only' };
  if (!String(note).trim()) return { ok: false, reason: 'note_required' };
  incident.stage = to;
  incident.steps.push({ stage: to, at: now, by: clip(by, 40), note: clip(redactDeep(String(note)), 300), evidence_refs: [].concat(evidence_refs).slice(0, 20).map((r) => clip(r, 200)) });
  if (to === 'RESOLVED') incident.closed_at = now;
  return { ok: true, incident };
}

/** Frame-by-frame replay: each recorded step with its time offset from detection. Nothing is invented between steps. */
export function replayIncident(incident) {
  if (!incident) return null;
  const t0 = Date.parse(incident.steps[0]?.at || incident.opened_at);
  return {
    incident_id: incident.incident_id,
    title: incident.title,
    label: incident.simulation ? 'SIMULATION' : 'REAL EVENT',
    frames: incident.steps.map((s, i) => ({
      index: i,
      stage: s.stage,
      at: s.at,
      offset_ms: Math.max(0, Date.parse(s.at) - t0),
      by: s.by,
      note: s.note,
      evidence_refs: s.evidence_refs || [],
    })),
    complete: incident.stage === 'RESOLVED',
  };
}

export function openIncidents(store, tenant_id, { includeSimulations = false } = {}) {
  return tenantState(store, tenant_id).incidents.filter((i) => OPEN_STAGES.has(i.stage) && (includeSimulations || !i.simulation));
}
