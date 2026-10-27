// Existing live Command Center probe, extracted unchanged except run-isolated identity and explicit dependencies.
import { probeObjectName } from './probe_identity.js';

export async function commandCenterProbe(env, token, { commands, categories, voiceSecrets = {} }) {
  const probe = env.CHE_STATE.getByName(await probeObjectName(token));
  const call = (path, body, device = '') => probe.fetch(new Request(`https://che.internal${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CHE-Memory-Probe': token, ...(device ? { Authorization: `Bearer ${device}` } : {}) },
    body: JSON.stringify(body),
  }));
  const paired = await (await call('/api/pair', { code: String(env.CHE_PAIR_CODE || ''), device_name: 'CHE command center check' })).json().catch(() => ({}));
  const device = paired.device_token;
  if (!device) return { ok: false, error: 'The check could not pair with its test CHE.', steps: [] };
  const steps = [];
  const step = async (name, message, check, { optional = false } = {}) => {
    const started = Date.now();
    const res = await call('/api/chat', { message, history: [] }, device);
    const raw = await res.text();
    let held = null;
    try { held = JSON.parse(raw); } catch (_) { held = null; }
    const events = raw.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    const reply = held?.message || events.filter((e) => e.type === 'delta').map((e) => e.delta).join('').trim();
    const pass = res.status === 200 && check({ reply, done, held, events });
    steps.push({ name, pass, optional, ms: Date.now() - started, route: held?.held_for_owner ? 'held' : done.source || '', model_calls: done.model_calls ?? null, reply: reply.slice(0, 300) });
  };
  try {
    const catalog = await (await call('/api/commands', {}, device)).json().catch(() => ({}));
    steps.push({ name: `catalog: ${commands.length} commands in ${categories.length} categories`, pass: catalog.commands?.length === commands.length && catalog.categories?.length === categories.length, ms: 0, route: 'catalog', model_calls: 0, reply: `${catalog.commands?.length} commands` });
    await step('unknown command answered honestly, nothing run', '/lead-scot barbers',
      ({ done, reply }) => done.source === 'che_command' && done.ok === false && done.model_calls === 0 && /Nothing was run/.test(reply));
    await step('slash command reaches its existing handler', '/trade-journal',
      ({ done }) => done.source === 'che_trading' && Number(done.model_calls || 0) === 0);
    // This isolated CHE has no broker sign-in, so the money command must say
    // what is missing and run nothing (its approval hold is unit-tested).
    await step('a command needing setup says what is missing, nothing run', '/trade-execute',
      ({ done, reply }) => done.source === 'che_command' && done.ok === false && done.model_calls === 0
        && ['setup_required', 'unsupported'].includes(done.command_status) && /Nothing was run/.test(reply));
    await step('a suggestion card follows a matching question', 'How can I make some money building websites?',
      ({ events }) => events.some((e) => e.type === 'command_suggestions' && e.suggestions?.[0]?.id === 'website-clients'), { optional: true });
  } finally {
    await call('/api/security/revoke_self', {}, device).catch(() => null);
  }
  // Production CHE_STATE returns a Durable Object stub (fetch only), not a
  // CheState instance. Ask the owner's object for the read-only count through
  // a probe-token-gated endpoint; never pretend an unknown count is zero.
  let readiness;
  try {
    const owner = env.CHE_STATE.getByName('owner');
    if (typeof owner.commandReadiness === 'function') {
      // Asked of the owner's object directly, as the voice probe asks it. There is no token to
      // hand over, so a stored env cannot refuse this deploy's check.
      readiness = await owner.commandReadiness();
    } else {
      // A stub that exposes only fetch(): hand this deploy's token over first, then ask the route.
      // Without that, the object keeps the env it was created with and refuses the token (HTTP 404).
      if (typeof owner.setVoiceSecrets === 'function') {
        await owner.setVoiceSecrets({ ...voiceSecrets, CHE_VOICE_PROBE_TOKEN: String(env.CHE_VOICE_PROBE_TOKEN || '') });
      }
      const response = await owner.fetch(new Request('https://che.internal/api/commands/readiness', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      }));
      if (!response.ok) throw new Error(`Readiness request returned HTTP ${response.status}`);
      readiness = await response.json();
    }
    if (!Number.isInteger(readiness?.available) || !Array.isArray(readiness?.setup_required)) {
      throw new Error('Readiness count was not returned');
    }
  } catch (error) {
    readiness = { error: String(error?.message || error).slice(0, 160) };
  }
  return {
    ok: steps.every((s) => s.pass || s.optional) && !readiness.error,
    passed: steps.filter((s) => s.pass).length,
    total: steps.length,
    steps,
    readiness,
  };
}
