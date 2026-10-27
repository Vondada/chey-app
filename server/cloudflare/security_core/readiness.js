// Security Core: readiness score. Built only from metrics the host measured. A metric the host could not measure is
// listed as unknown and left out of the score (it never counts as passing), and the result shows every component,
// its weight and the evidence, so the number can be checked by hand.

const COMPONENTS = Object.freeze([
  { id: 'recent_check', label: 'Security check in the last day', weight: 15, score: (m) => (m.last_check_age_h == null ? null : m.last_check_age_h <= 24 ? 1 : m.last_check_age_h <= 168 ? 0.5 : 0), evidence: (m) => `last check ${m.last_check_age_h == null ? 'never' : `${Math.round(m.last_check_age_h)} h ago`}` },
  { id: 'open_incidents', label: 'No open incidents', weight: 20, score: (m) => (m.open_incidents == null ? null : m.open_incidents === 0 ? 1 : 0), evidence: (m) => `${m.open_incidents} open incident(s)` },
  { id: 'high_events', label: 'No open high-severity events', weight: 15, score: (m) => (m.open_high_events == null ? null : Math.max(0, 1 - m.open_high_events / 3)), evidence: (m) => `${m.open_high_events} open high/critical event(s)` },
  { id: 'least_privilege', label: 'No wildcard or broad grants', weight: 15, score: (m) => (m.wide_grants == null ? null : m.wide_grants === 0 ? 1 : Math.max(0, 1 - m.wide_grants / 3)), evidence: (m) => `${m.wide_grants} wildcard/broad grant(s)` },
  { id: 'reviewed_capabilities', label: 'Every usable tool security-reviewed', weight: 10, score: (m) => (m.unreviewed_capabilities == null ? null : m.unreviewed_capabilities === 0 ? 1 : 0), evidence: (m) => `${m.unreviewed_capabilities} usable tool(s) without a passing review` },
  { id: 'dependencies', label: 'No matched dependency advisories', weight: 10, score: (m) => (m.dependency_advisories == null ? null : m.dependency_advisories === 0 ? 1 : 0), evidence: (m) => `${m.dependency_advisories} advisory match(es)` },
  { id: 'backup', label: 'Trusted snapshot within a week', weight: 10, score: (m) => (m.snapshot_age_h == null ? 0 : m.snapshot_age_h <= 168 ? 1 : 0.5), evidence: (m) => (m.snapshot_age_h == null ? 'no trusted snapshot' : `snapshot ${Math.round(m.snapshot_age_h)} h old`) },
  { id: 'exposed_secrets', label: 'No credential exposures in the last day', weight: 5, score: (m) => (m.secret_redactions_24h == null ? null : m.secret_redactions_24h === 0 ? 1 : 0.5), evidence: (m) => `${m.secret_redactions_24h} redaction(s) in the last day` },
]);

export function readinessComponents() { return COMPONENTS.map(({ id, label, weight }) => ({ id, label, weight })); }

export function computeReadiness(metrics = {}) {
  const parts = COMPONENTS.map((c) => {
    const s = c.score(metrics);
    return { id: c.id, label: c.label, weight: c.weight, score: s == null ? null : Math.round(s * 100) / 100, status: s == null ? 'unknown' : s >= 1 ? 'pass' : s > 0 ? 'partial' : 'fail', evidence: s == null ? 'not measured' : c.evidence(metrics) };
  });
  const known = parts.filter((p) => p.score != null);
  const weight = known.reduce((n, p) => n + p.weight, 0);
  const score = weight ? Math.round((known.reduce((n, p) => n + p.weight * p.score, 0) / weight) * 100) : null;
  return {
    score,
    measured_weight: weight,
    total_weight: COMPONENTS.reduce((n, c) => n + c.weight, 0),
    components: parts,
    unknown: parts.filter((p) => p.score == null).map((p) => p.id),
    how: `Weighted average of ${known.length} measured component(s) out of ${parts.length}; unmeasured components are excluded, not counted as passing. A readiness score measures preparation, not immunity.`,
  };
}
