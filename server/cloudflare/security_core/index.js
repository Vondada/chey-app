// Security Core — the portable security engine. A product layer (CHE today, a standalone security product later)
// embeds it with a configuration and adapters; the core never imports product code. See docs/CHE_SECURITY_CORE.md.
import * as access from './access.js';
import * as agent from './agent.js';
import * as brain from './brain.js';
import * as capabilitySecurity from './capability_security.js';
import { ENGINE_NAMES, SECURITY_CORE_VERSION, productConfig } from './config.js';
import * as detection from './detection.js';
import * as events from './events.js';
import * as identity from './identity.js';
import * as incidents from './incidents.js';
import * as knowledge from './knowledge.js';
import * as physical from './physical.js';
import * as policies from './policies.js';
import * as readiness from './readiness.js';
import * as secrets from './secrets.js';
import * as simulation from './simulation.js';
import * as supplyChain from './supply_chain.js';
import * as workflows from './workflows.js';

export { ENGINE_NAMES, SECURITY_CORE_VERSION, productConfig };
export { access, agent, brain, capabilitySecurity, detection, events, identity, incidents, knowledge, physical, policies, readiness, secrets, simulation, supplyChain, workflows };

// The thirteen engines and the functions that make each one.
export const ENGINES = Object.freeze({
  threat: { evaluate: detection.evaluateThreats, rules: detection.DEFAULT_THREAT_RULES },
  malware: { inspectFile: supplyChain.inspectFile, inspectArtifacts: supplyChain.inspectArtifacts, mayExecute: supplyChain.mayExecute },
  identity: { checkTarget: identity.checkTargetIdentity, reviewSessions: identity.reviewSessions },
  access: { principal: access.principal, allowed: access.allowed, review: access.reviewAccess, previewLockdown: access.previewLockdown, confirmLockdown: access.confirmLockdown, checkToolAccess: supplyChain.checkToolAccess },
  device: { review: detection.reviewDevices, physical },
  repository: { scan: detection.scanRepository, scanSecrets: secrets.scanSecrets },
  dependency: { review: detection.reviewDependencies },
  incident: { open: incidents.openIncident, advance: incidents.advanceIncident, replay: incidents.replayIncident, simulate: simulation.runSimulation },
  knowledge: { capture: knowledge.captureExperience, generalize: knowledge.generalize, strip: knowledge.stripIdentifiers, review: knowledge.reviewKnowledge, test: knowledge.testKnowledge, promote: knowledge.promoteKnowledge },
  policies: { list: policies.POLICIES, version: policies.POLICY_VERSION, evaluate: policies.evaluateAction, overclaims: policies.overclaims },
  event_model: { fields: events.EVENT_FIELDS, create: events.createEvent, openBus: events.openBus },
  capability_security: { veto: capabilitySecurity.vetoCapability },
  workflow_library: { list: workflows.SECURITY_WORKFLOWS, confirmationsNeeded: workflows.confirmationsNeeded },
});

// What a product layer may supply. Every adapter is optional; an engine without its adapter reports "not measured"
// rather than guessing.
export const ADAPTER_INTERFACES = Object.freeze({
  storage: ['get', 'put'],      // persistence for the core store (one JSON value per tenant set)
  telemetry: ['metrics'],       // normalised counters for the threat engine
  devices: ['list'],            // paired digital devices
  principals: ['list'],         // agents, tools, apps and devices with their scopes
  lockdown: ['mechanisms', 'activate'], // what the host's lockdown really enforces, and turning it on
  notifier: ['notify'],         // telling the owner (never auto-speaking; the host decides how)
});

/** Checks adapters against the interfaces; returns the names that are missing methods. */
export function validateAdapters(adapters = {}) {
  const problems = [];
  for (const [name, impl] of Object.entries(adapters)) {
    const want = ADAPTER_INTERFACES[name];
    if (!want) { problems.push(`${name}: unknown adapter`); continue; }
    for (const m of want) if (typeof impl?.[m] !== 'function') problems.push(`${name}.${m} missing`);
  }
  return problems;
}

/** A Security Core instance for one product layer. */
export function createSecurityCore({ config = {}, adapters = {} } = {}) {
  const cfg = productConfig(config);
  const problems = validateAdapters(adapters);
  if (problems.length) throw new Error(`Invalid adapters: ${problems.join('; ')}`);
  return {
    version: SECURITY_CORE_VERSION,
    config: cfg,
    engines: ENGINES,
    engine_names: ENGINE_NAMES,
    adapters: Object.keys(adapters),
    bus: (store, tenant) => events.openBus(store, tenant || cfg.default_tenant, cfg),
    describe() {
      return { product_name: cfg.product_name, edition: cfg.edition, version: SECURITY_CORE_VERSION, engines: ENGINE_NAMES, policy_version: policies.POLICY_VERSION, adapters: Object.keys(adapters) };
    },
  };
}
