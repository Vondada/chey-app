// Security Core: safe simulations. A drill runs entirely inside a fresh, throwaway store under the 'simulation'
// tenant. It receives no adapters, so it cannot reach a real system, and every event and incident it produces is
// labelled SIMULATION.
import { emptyStore, openBus } from './events.js';
import { advanceIncident, openIncident, replayIncident } from './incidents.js';

export const SIMULATION_TENANT = 'simulation';

export const SCENARIOS = Object.freeze([
  { id: 'leaked_credential', name: 'A credential pasted into chat', event: { event_type: 'secret.redacted', severity: 'medium', summary: 'A credential-shaped value was redacted from a message.', affected_resource: 'chat' } },
  { id: 'pairing_flood', name: 'Repeated wrong pairing codes', event: { event_type: 'threat.auth_failures', severity: 'high', summary: '25 wrong pairing codes in one hour.', affected_resource: 'pairing' } },
  { id: 'malicious_dependency', name: 'A dependency with a known advisory', event: { event_type: 'dependency.advisory', severity: 'critical', summary: 'A package version matches a malicious-package advisory.', affected_resource: 'npm:example@0.0.0' } },
  { id: 'unexpected_deploy', name: 'An unexpected deployment', event: { event_type: 'threat.unexpected_deploy', severity: 'high', summary: 'The running server reports a commit that is not on the main branch.', affected_resource: 'server' } },
  { id: 'unreviewed_capability', name: 'A tool marked usable without review', event: { event_type: 'capability.unreviewed', severity: 'high', summary: 'A tool is marked usable without a passing security review.', affected_resource: 'capability registry' } },
]);

const PLAYBOOK = [
  ['TRIAGED', 'Severity and scope assessed from the event.'],
  ['INVESTIGATING', 'Related events and recent changes reviewed.'],
  ['CONTAINING', 'Containment steps chosen (simulated: nothing real was changed).'],
  ['CONTAINED', 'Containment confirmed in the simulation.'],
  ['RECOVERING', 'Recovery steps listed.'],
  ['RECOVERED', 'Simulated systems back to normal.'],
  ['RESOLVED', 'Drill finished; lessons can be captured.'],
];

/** Runs one scenario end to end and returns its labelled events, incident and replay. */
export function runSimulation(scenarioId, { now = Date.now(), stepMs = 1000 } = {}) {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) return { ok: false, reason: 'unknown_scenario', scenarios: SCENARIOS.map((s) => s.id) };
  const store = emptyStore();
  const bus = openBus(store, SIMULATION_TENANT);
  const at = (i) => new Date(now + i * stepMs).toISOString();
  const event = bus.publish({ ...scenario.event, source: 'simulation', verification: 'simulation', confidence: 1, timestamp: at(0) });
  const incident = openIncident(store, SIMULATION_TENANT, { title: `SIMULATION: ${scenario.name}`, severity: scenario.event.severity, event_ids: [event.event_id], simulation: true, now: at(0) });
  PLAYBOOK.forEach(([stage, note], i) => advanceIncident(incident, stage, { by: 'security (simulation)', note, now: at(i + 1) }));
  bus.update(event.event_id, { status: 'resolved', action: 'drill completed' });
  return { ok: true, label: 'SIMULATION', scenario: scenario.id, name: scenario.name, events: bus.query({ includeSimulations: true }), incident, replay: replayIncident(incident), touched_real_systems: false };
}
