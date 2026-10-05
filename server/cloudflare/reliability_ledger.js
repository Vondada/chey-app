// Private reliability telemetry for CHE. This ledger records routing outcomes
// without storing prompts, replies, secrets, or owner content.
const KEY = 'che_reliability_ledger';
const MAX = 500;

export async function recordReliability(storage, event = {}) {
  if (!storage?.get || !storage?.put) return;
  try {
    const saved = await storage.get(KEY);
  const rows = Array.isArray(saved) ? saved : [];
    rows.unshift({
      at: new Date().toISOString(),
      workflow: String(event.workflow || 'unknown').slice(0, 40),
      outcome: String(event.outcome || 'unknown').slice(0, 40),
      engine: String(event.engine || '').slice(0, 40),
      failovers: Math.max(0, Number(event.failovers) || 0),
      recovered: event.recovered === true,
      latency_ms: Math.max(0, Number(event.latency_ms) || 0),
    });
    await storage.put(KEY, rows.slice(0, MAX));
  } catch (_) { /* telemetry never breaks owner work */ }
}

export async function reliabilitySummary(storage) {
  if (!storage?.get) return { jobs: 0, recoveries: 0, failovers: 0 };
  const rows = Array.isArray(await storage.get(KEY)) ? await storage.get(KEY) : [];
  return {
    jobs: rows.length,
    recoveries: rows.filter((r) => r.recovered).length,
    failovers: rows.reduce((sum, r) => sum + (Number(r.failovers) || 0), 0),
    failures: rows.filter((r) => r.outcome === 'failed').length,
  };
}
