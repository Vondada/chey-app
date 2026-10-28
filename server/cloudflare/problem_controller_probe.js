// Live check for the universal problem controller on the isolated test CHE (never the owner's). It sends real turns
// through the chat route inside the test CHE's Durable Object, the same way the study probe does, and reads back the
// reply and the execution receipt. No model call is needed for the first three steps.

const ASK_HEADERS = { 'Content-Type': 'application/json' };

/** Live steps for the arithmetic route, as {name, pass, optional, ms, route, model_calls, reply, receipt}. */
export async function arithmeticProbe(env, request, objectName) {
  const token = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '')?.[1] || '';
  const probe = env.CHE_STATE.getByName(objectName);
  const call = (path, body, device = '') => probe.fetch(new Request(`https://che.internal${path}`, {
    method: 'POST',
    headers: { ...ASK_HEADERS, 'X-CHE-Memory-Probe': token, ...(device ? { Authorization: `Bearer ${device}` } : {}) },
    body: JSON.stringify(body),
  }));
  const paired = await (await call('/api/pair', { code: String(env.CHE_PAIR_CODE || ''), device_name: 'Arithmetic check' })).json().catch(() => ({}));
  const device = paired.device_token;
  if (!device) return { ok: false, error: 'The check could not pair with its test CHE.', steps: [] };
  const steps = [];
  const ask = async (name, message, check, optional = false) => {
    const started = Date.now();
    const res = await call('/api/chat', { message, history: [] }, device);
    const events = (await res.text()).split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    const reply = events.filter((e) => e.type === 'delta').map((e) => e.delta).join('').trim();
    const pass = res.status === 200 && Boolean(check({ reply, done }));
    steps.push({ name, optional, pass, ms: Date.now() - started, route: done.source || 'model', model_calls: done.model_calls ?? null, reply: reply.slice(0, 300), receipt: done.execution_receipt || null });
  };
  try {
    await ask('typed sum: 12 times 17 is 204, computed, with a receipt and no model call', 'CHE, what is 12 times 17?',
      ({ reply, done }) => reply === '204.' && done.source === 'che_arithmetic' && done.model_calls === 0 && done.execution_receipt?.status === 'success' && done.execution_receipt?.steps?.some((s) => s.step === 'verify' && s.result === 'agrees'));
    await ask('school precedence: -2^2 + 5 is 1', 'what is -2^2 + 5',
      ({ reply, done }) => reply === '1.' && done.model_calls === 0 && done.execution_receipt?.status === 'success');
    await ask('an undefined sum is an error with a receipt, not a guess', 'what is 5 / 0',
      ({ reply, done }) => /Division by zero/.test(reply) && done.model_calls === 0 && done.execution_receipt?.status === 'error');
    await ask('a sentence about maths goes to the model, with no controller receipt', 'Tell me about 12 times 17 in history',
      ({ reply, done }) => reply.length > 0 && done.source !== 'che_arithmetic' && done.execution_receipt === undefined, true);
  } finally {
    await call('/api/security/revoke_self', {}, device).catch(() => null);
  }
  const required = steps.filter((s) => !s.optional);
  return { ok: required.length > 0 && required.every((s) => s.pass), passed: steps.filter((s) => s.pass).length, total: steps.length, steps };
}
