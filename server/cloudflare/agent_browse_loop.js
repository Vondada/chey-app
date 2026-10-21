// CHE's browsing loop: plan one step, run it, read what came back, repeat until she can answer or must
// stop. Every app step passes the gate in agent_permissions.js. Search is a plugin: a provider is any
// object with { id, name, search(query) -> [{ title, url, snippet }] }, and none is connected by default.
//
// Anti-fabrication: an answer counts only when it cites a page this run actually read. A search result
// lists where to look; it is not evidence.
import { assertBrowserStepMayRun } from './agent_permissions.js';

export const LOOP_LIMITS = Object.freeze({ maxSteps: 12, maxSearches: 4, maxTextChars: 2000 });

/** Registry for search providers (plugins). Registering a provider is the only way one is used. */
export function createSearchRegistry() {
  const providers = new Map();
  return {
    register(provider) {
      if (!provider || typeof provider.id !== 'string' || !provider.id || typeof provider.search !== 'function') {
        throw new Error('A search provider needs an id and a search(query) function.');
      }
      providers.set(provider.id, provider);
      return provider.id;
    },
    list() { return [...providers.values()].map((p) => ({ id: p.id, name: p.name || p.id })); },
    /** The provider to search with: the named one, else the first registered. Null when none is connected. */
    pick(id = '') { return (id && providers.get(id)) || [...providers.values()][0] || null; },
  };
}

function result(status, extra) {
  return { status, ...extra };
}

/**
 * Runs the loop.
 * planner({ question, observations, steps }) -> one action:
 *   { type: 'search', query } | { type: 'open', url } | { type: 'read' } | { type: 'click', label }
 *   | { type: 'type', label, text? , vault_ref?, secret? } | { type: 'finish', answer, cite: [url] }
 *   | { type: 'ask_owner', reason }
 * executor(action) -> { ok, url, text, error? } runs one phone step (open, read, click, type).
 * Returns { status, answer?, sources?, steps, reason? } with status one of:
 *   answered | not_found | uncited | needs_owner | held | refused | budget_exhausted | no_plan
 */
export async function runBrowseLoop({ question, planner, executor, search = null, app = 'browser', grants = [], ownerConfirmed = false, limits = LOOP_LIMITS } = {}) {
  const observations = [];
  const steps = [];
  let searches = 0;
  for (let i = 0; i < limits.maxSteps; i++) {
    const action = await planner({ question, observations, steps });
    if (!action || typeof action !== 'object') return result('no_plan', { steps });
    steps.push({ n: i + 1, type: action.type });

    if (action.type === 'finish') {
      const read = observations.filter((o) => o.read && o.ok && o.url);
      if (!read.length) return result('not_found', { steps, answer: null, reason: 'No page was read, so there is nothing to answer from.' });
      const cited = read.filter((o) => Array.isArray(action.cite) && action.cite.includes(o.url));
      if (!cited.length || !String(action.answer || '').trim()) {
        return result('uncited', { steps, answer: null, reason: 'The answer does not cite a page that was read in this run.' });
      }
      return result('answered', { steps, answer: String(action.answer), sources: cited.map((o) => o.url) });
    }

    if (action.type === 'ask_owner') return result('needs_owner', { steps, reason: String(action.reason || 'CHE needs the owner to decide.') });

    if (action.type === 'search') {
      const provider = search?.pick?.(action.provider || '') || null;
      if (!provider) {
        observations.push({ ok: false, read: false, error: 'No search provider is connected yet.' });
        continue;
      }
      if (searches >= limits.maxSearches) {
        observations.push({ ok: false, read: false, error: `The search limit of ${limits.maxSearches} was reached.` });
        continue;
      }
      searches++;
      try {
        const rows = await provider.search(String(action.query || question));
        const items = (Array.isArray(rows) ? rows : []).slice(0, 8).map((r) => ({ title: String(r.title || ''), url: String(r.url || ''), snippet: String(r.snippet || '').slice(0, 300) }));
        observations.push({ ok: true, read: false, search: action.query, items });
      } catch (error) {
        observations.push({ ok: false, read: false, error: `The search failed: ${error?.message || error}` });
      }
      continue;
    }

    // A step in an app. The gate decides first; a refused step ends the loop, a held step asks the owner.
    const kindOf = { open: 'navigate', read: 'read', click: 'click', type: 'type' }[action.type];
    if (!kindOf) {
      observations.push({ ok: false, read: false, error: `Unknown step "${action.type}".` });
      continue;
    }
    let gate;
    try {
      gate = assertBrowserStepMayRun({ action: kindOf, label: action.label || '', secret: Boolean(action.secret), vault_ref: action.vault_ref }, { app, grants, ownerConfirmed });
    } catch (error) {
      return result('refused', { steps, reason: error.message });
    }
    if (gate.held) return result('held', { steps, reason: gate.reason, kind: gate.kind });

    const outcome = await executor({ ...action, kind: gate.kind });
    const text = String(outcome?.text || '').slice(0, limits.maxTextChars);
    observations.push({ ok: Boolean(outcome?.ok), read: action.type === 'read' || action.type === 'open', url: String(outcome?.url || ''), text, error: outcome?.error });
  }
  return result('budget_exhausted', { steps, reason: `The step limit of ${limits.maxSteps} was reached before an answer.` });
}
