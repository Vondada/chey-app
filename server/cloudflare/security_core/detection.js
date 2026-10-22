// Security Core: the threat, repository, dependency and device engines. Each reads telemetry or content its host
// hands it (counters, files, lock files, device lists) and reports observations as events; none of them reaches out
// to a system on its own.
import { clip } from './config.js';
import { scanSecrets } from './secrets.js';
import { dependencyAdvisories, inspectFile } from './supply_chain.js';

/**
 * Threat engine: rule-based detection over normalised metrics. A rule fires when its metric reaches the threshold
 * and, if `baseline` is given, exceeds it by `factor`. Rules come from the host (defaults below) and from promoted
 * shared knowledge.
 */
export const DEFAULT_THREAT_RULES = Object.freeze([
  { id: 'auth_failures', metric: 'auth_failures_1h', threshold: 10, severity: 'high', summary: 'Repeated failed sign-in or pairing attempts' },
  { id: 'unknown_credentials', metric: 'unknown_tokens_1h', threshold: 20, severity: 'medium', summary: 'Requests with unknown credentials, all refused' },
  { id: 'revoked_device_use', metric: 'revoked_device_attempts_24h', threshold: 1, severity: 'medium', summary: 'A revoked device tried to connect' },
  { id: 'error_spike', metric: 'server_errors_1h', threshold: 10, factor: 5, baseline: 'server_errors_hourly_avg', severity: 'medium', summary: 'Server errors well above normal' },
  { id: 'egress_blocked', metric: 'egress_blocked', threshold: 1, severity: 'low', summary: 'Outbound calls refused by internal-only mode' },
]);

export function evaluateThreats(metrics = {}, rules = DEFAULT_THREAT_RULES) {
  const out = [];
  for (const r of rules) {
    const v = Number(metrics[r.metric]);
    if (!Number.isFinite(v) || v < r.threshold) continue;
    if (r.baseline && Number.isFinite(Number(metrics[r.baseline])) && v <= Number(metrics[r.baseline]) * (r.factor || 1)) continue;
    out.push({ event_type: `threat.${r.id}`, source: 'threat_engine', severity: r.severity, confidence: 0.8, summary: `${r.summary}: ${v} (${r.metric}).`, evidence_refs: [`metric:${r.metric}=${v}`] });
  }
  return out;
}

/** Repository engine: credential-shaped values and risky code in files the host supplies. Values are never echoed. */
export function scanRepository(files = []) {
  const out = [];
  for (const f of files.slice(0, 5000)) {
    const path = clip(f.path, 200);
    const secrets = scanSecrets(String(f.text ?? ''));
    if (secrets.length) out.push({ event_type: 'repository.secret', source: 'repository_engine', affected_resource: path, severity: 'high', confidence: 0.7, summary: `${secrets.length} credential-shaped value(s) (${[...new Set(secrets.map((s) => s.kind))].join(', ')}) in ${path}.`, evidence_refs: [`file:${path}`] });
    for (const issue of inspectFile({ path, text: f.text ?? null, bytes: f.bytes ?? null })) {
      if (['high', 'medium'].includes(issue.severity) && !/credential-shaped/.test(issue.what)) out.push({ event_type: 'repository.code_risk', source: 'repository_engine', affected_resource: path, severity: issue.severity, confidence: 0.6, summary: issue.what, evidence_refs: [`file:${path}`] });
    }
  }
  return out;
}

/** Dependency engine: lock-file advisories (the vendored list; the report states its coverage). */
export function reviewDependencies({ packageJson = '', pubspecLock = '' } = {}) {
  const r = dependencyAdvisories({ packageJson, pubspecLock });
  return {
    checked: r.checked,
    coverage: r.coverage,
    events: r.advisories.map((a) => ({ event_type: 'dependency.advisory', source: 'dependency_engine', affected_resource: `${a.ecosystem}:${a.name}@${a.version}`, severity: a.severity === 'critical' ? 'critical' : a.severity, confidence: 0.9, summary: `${a.name} ${a.version} matches ${a.id}.`, evidence_refs: [`advisory:${a.id}`] })),
  };
}

/**
 * Device engine (digital devices: phones, computers, browsers the host paired). New, revoked and stale devices are
 * reported; a device is only ever described by what the host recorded about it.
 */
export function reviewDevices(devices = [], now = Date.now()) {
  const events = [];
  const active = devices.filter((d) => !d.revoked_at);
  const recent = active.filter((d) => d.created_at && now - Date.parse(d.created_at) < 86_400_000);
  if (recent.length) events.push({ event_type: 'device.new', source: 'device_engine', severity: recent.length > 2 ? 'medium' : 'info', confidence: 1, summary: `${recent.length} device(s) paired in the last day.`, affected_resource: recent.map((d) => clip(d.name, 40)).join(', ') });
  const stale = active.filter((d) => d.last_seen_at && now - Date.parse(d.last_seen_at) > 60 * 86_400_000);
  if (stale.length) events.push({ event_type: 'device.stale', source: 'device_engine', severity: 'low', confidence: 1, summary: `${stale.length} paired device(s) unused for over 60 days; consider revoking.`, affected_resource: stale.map((d) => clip(d.name, 40)).join(', ') });
  return { active: active.length, revoked: devices.length - active.length, events };
}
