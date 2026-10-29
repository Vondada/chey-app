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
    await ask('a hypothetical trade: the figures given are calculated (-$1.70 a trade), not read from the journal', 'A paper trading strategy made 100 trades: 70 wins averaging $4 each and 30 losses averaging $15 each. It has a 70% win rate. Should I keep running it? Calculate its expected profit per trade.',
      ({ reply, done }) => /-\$1\.70/.test(reply) && done.source === 'che_arithmetic' && done.model_calls === 0 && done.execution_receipt?.capability_id === 'math.trade_expectancy' && !/paper journal|evidence pass|portfolios/.test(reply));
    await ask('conflicting hypothetical counts are refused, not calculated', 'A strategy made 100 trades: 70 wins averaging $4 and 25 losses averaging $15. Expected profit per trade?',
      ({ reply, done }) => /make 95 trades, not 100/.test(reply) && done.model_calls === 0 && done.ok === false);
    // Routing only: the probe asks for a health check, never a render, so a CI run never starts a GPU job.
    await ask('the Modal command is answered by the Modal report, not deployment status', 'CHE, connect Modal. Verify it with an authenticated health check.',
      ({ reply, done }) => done.source === 'che_modal_connect' && done.model_calls === 0 && /^Modal is (?:not )?connected/.test(reply) && !/#\d+|pull request/i.test(reply));
    await ask('a sentence about maths goes to the model, with no controller receipt', 'Tell me about 12 times 17 in history',
      ({ reply, done }) => reply.length > 0 && done.source !== 'che_arithmetic' && done.execution_receipt === undefined, true);
  } finally {
    await call('/api/security/revoke_self', {}, device).catch(() => null);
  }
  const required = steps.filter((s) => !s.optional);
  return { ok: required.length > 0 && required.every((s) => s.pass), passed: steps.filter((s) => s.pass).length, total: steps.length, steps };
}
