// Moved out of worker.js (byte budget); routeRequest passes the memory probe's isolated test object name.
// The deploy's Knowledge Atlas check (#346). It runs on the same isolated test CHE as the memory check
// (never the owner's): a lesson at two depths, two risk calculations, a quiz answer graded from the
// card's formula, real progress counts, an honest strategy verdict with no journal, and two counter-cases
// that must keep their own routes. Every step is deterministic and calls no model: none may be skipped as model-dependent.
export async function atlasProbe(env, token, MEMORY_PROBE_OBJECT) {
  const probe = env.CHE_STATE.getByName(MEMORY_PROBE_OBJECT);
  const call = (path, body, device = '') => probe.fetch(new Request(`https://che.internal${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CHE-Memory-Probe': token, ...(device ? { Authorization: `Bearer ${device}` } : {}) },
    body: JSON.stringify(body),
  }));
  const paired = await (await call('/api/pair', { code: String(env.CHE_PAIR_CODE || ''), device_name: 'CHE knowledge atlas check' })).json().catch(() => ({}));
  const device = paired.device_token;
  if (!device) return { ok: false, error: 'The check could not pair with its test CHE.', steps: [] };
  const steps = [];
  const step = async (name, message, check, { history = [] } = {}) => {
    const started = Date.now();
    const res = await call('/api/chat', { message, history }, device);
    const raw = await res.text();
    let held = null;
    try { held = JSON.parse(raw); } catch (_) { held = null; }
    const events = raw.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    const reply = held?.message || events.filter((e) => e.type === 'delta').map((e) => e.delta).join('').trim();
    const pass = res.status === 200 && Boolean(check({ reply, done, held }));
    steps.push({ name, pass, optional: false, ms: Date.now() - started, route: held?.held_for_owner ? 'held' : done.source || '', model_calls: done.model_calls ?? null, reply: reply.slice(0, 300) });
    return reply;
  };
  const atlas = (done) => done.source === 'che_knowledge_atlas' && done.model_calls === 0;
  try {
    await step('lesson: recursion at the beginner level', 'Teach me recursion.',
      ({ done, reply }) => atlas(done) && /^Recursion, beginner level, sir\./.test(reply));
    await step('lesson: Big-O at the expert level', 'Explain big O at an advanced level',
      ({ done, reply }) => atlas(done) && /^Big-O notation, expert level, sir\./.test(reply));
    await step('risk: 2 MNQ with a 12-point stop is $48.00, with the math', 'What is my risk on 2 MNQ contracts with a 12 point stop?',
      ({ done, reply }) => atlas(done) && /^Your risk on 2 MNQ contracts with a 12-point stop is \$48\.00, sir\./.test(reply)
        && /total risk = \$24\.00 × 2 contracts = \$48\.00/.test(reply) && /I placed and prepared no order/.test(reply));
    await step('position size: $200 with a 10-point stop is 10 MNQ', 'How many MNQ contracts can I trade risking $200 with a 10 point stop?',
      ({ done, reply }) => atlas(done) && /^10 MNQ contracts, sir, risking \$200\.00 with a 10-point stop\./.test(reply)
        && /\$200\.00 ÷ \$20\.00 = 10, rounded down = 10 contracts/.test(reply));
    const quiz = await step('quiz: loops', 'Quiz me on loops',
      ({ done, reply }) => atlas(done) && /^Quiz on Loops and iteration, sir\. 3 questions:/.test(reply));
    await step('quiz answer graded correct, recomputed from the formula', 'number 3 is 55',
      ({ done, reply }) => atlas(done) && done.atlas_kind === 'grade' && /^Quiz finished on Loops and iteration, sir\. Question 3: correct\. You said: 55\./.test(reply)
        && /Graded by the number, recomputed from the card's formula\. Recorded in your Brain as owner practice\./.test(reply),
      { history: [{ role: 'user', content: 'Quiz me on loops' }, { role: 'assistant', content: quiz }] });
    // The memory check resets the test CHE earlier in the same deploy, but a re-run keeps its records, so this asks for real counts, not exact ones.
    await step('progress: real counts from the Brain', 'What have I learned so far in the Knowledge Atlas?',
      ({ done, reply }) => {
        const answers = /; (\d+) quiz answers?/.exec(reply);
        return atlas(done) && /^Your Knowledge Atlas progress, sir, measured from this chat: \d+ lessons? studied/.test(reply)
          && Number(answers?.[1]) >= 1 && /labelled owner practice/.test(reply);
      });
    await step('strategy verdict with no journal: no recorded trades, no invented numbers', 'Evaluate my strategy',
      ({ done, reply }) => atlas(done) && /^Your strategy, sir: no recorded trades yet\./.test(reply) && /Verdict: unsupported, because no closed trades\./.test(reply)
        && !/[+−-]?\d+(?:\.\d+)?R\b|win rate \d|\$\d/.test(reply));
    await step('counter-case: "every trade you made" keeps its own route', 'walk me through every trade you made',
      ({ done }) => done.source === 'che_trading_live' && done.model_calls === 0);
    await step('counter-case: a buy is held for the owner\'s yes, nothing runs', 'buy 2 MNQ at market',
      ({ held, done }) => held?.held_for_owner === true && held.owner_action_kind === 'money' && !done.source);
    // A following atlas turn drops the held buy without a model call, so nothing waits on the test CHE for a later yes.
    await step('the held buy is dropped by the next turn, no model call', 'list the coding cards', ({ done }) => atlas(done));
  } finally {
    await call('/api/security/revoke_self', {}, device).catch(() => null);
  }
  return {
    ok: steps.length > 0 && steps.every((s) => s.pass),
    object: MEMORY_PROBE_OBJECT,
    passed: steps.filter((s) => s.pass).length,
    total: steps.length,
    steps,
  };
}
