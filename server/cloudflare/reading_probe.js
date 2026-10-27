// Reading comprehension, live on the isolated test CHE (the staging probe suite, `reading`).
// Ten questions, each with a paragraph written for this check, so the answer must come from the text and
// not from memory. A question passes only when every required fact is in her reply and nothing it forbids is.
// The replies are recorded verbatim; the grading is deterministic.

const BLUE_OVEN = 'Marta opened Blue Oven in 2019 on Keel Street. It closes at 3 p.m. on Sundays, and its rye bread sells out by noon on weekdays. The bakery has four ovens but only two bakers.';

export const READING_QUESTIONS = [
  { id: 'facts', paragraph: BLUE_OVEN,
    ask: 'How many ovens does Blue Oven have, when does it close on Sundays, and why might the rye run out early?',
    must: [/\bfour\b|\b4\b/i, /3\s*p\.?\s*m|3 o'?clock|15:00/i, /noon/i], forbid: [] },
  { id: 'not-stated', paragraph: BLUE_OVEN,
    ask: "What is Blue Oven's yearly revenue?",
    must: [/(doesn'?t|does not|do not|don'?t)\b[^.]*\b(say|state|give|mention|include|tell)|not (stated|given|in the text|in the paragraph|mentioned)|no (revenue|figure|number|information)|(don'?t|do not) have (enough )?(information|data|figures|numbers)/i],
    forbid: [/\$\s?\d|\d+\s*(million|thousand)|\bdollars\b/i] },
  { id: 'cause', paragraph: 'The river rose 2 metres overnight. Heavy rain fell on the hills upstream, and the drain at the old mill was blocked with leaves, so the water had nowhere to go.',
    ask: 'What caused the flooding, and which cause was the main one?',
    must: [/rain/i, /(drain|blocked|leaves)/i], forbid: [] },
  { id: 'pronoun', paragraph: 'Dev met Sam at the station. He handed her the keys, and she thanked him before leaving.',
    ask: 'Who handed over the keys, and who left?',
    must: [/\bDev\b[^.]*\b(handed|gave|passed)|\b(handed|gave|passed)[^.]*\bDev\b/i, /\bSam\b[^.]*\bleft|\bleft\b[^.]*\bSam\b|\bSam\b[^.]*\bleaving|she[^.]*\bleft/i], forbid: [] },
  { id: 'contradiction', paragraph: 'The meeting is on Thursday the 14th. Please bring your forms by Friday the 15th, and note that the meeting moved to Wednesday the 13th.',
    ask: 'When is the meeting?',
    must: [/13/, /14/, /(conflict|contradict|two dates|differ|inconsisten|which is right|unclear|moved|both)/i], forbid: [] },
  { id: 'fact-opinion', paragraph: 'The city built 40 new bike lanes in 2025. Critics say this was a waste of money, but the traffic count on Main Road rose 18 percent after they opened.',
    ask: 'Which sentence is a fact, which is an opinion, and what does the traffic count suggest?',
    must: [/40/, /18/, /opinion/i, /fact/i], forbid: [/(lanes|they|it) (caused|led to|made)[^.]*(18|rise|increase)|(caused|led to) the (18|rise|increase)/i] },
  { id: 'inference', paragraph: 'Ana was late for work. The bus route was cancelled that morning, and the sign at the stop said to use the train instead.',
    ask: 'Why was Ana late, and what can you infer about how she got to work?',
    must: [/cancel/i, /\bbus\b/i, /(train|another route|different route|other route|alternative)/i], forbid: [/(definitely|certainly|for sure|confirmed)[^.]*(train|took)/i] },
  { id: 'rule', paragraph: 'From 1 November, the library charges 20 cents a day for overdue books, up from 10 cents. Books more than 30 days late are charged a flat $5 instead.',
    ask: "I'm returning a book that is 12 days late, and another that's 40 days late. What do I owe for each?",
    must: [/2\.40|\$2\.4\b/i, /\$\s?5\b|5 dollars/i], forbid: [] },
  { id: 'chain', paragraph: 'Lina is older than Omar. Omar is older than Petra. Petra is twice as old as Yusuf.',
    ask: 'Who is the youngest, and who is the oldest?',
    must: [/youngest[^.]*\bYusuf\b|\bYusuf\b[^.]*youngest/i, /oldest[^.]*\bLina\b|\bLina\b[^.]*oldest/i], forbid: [] },
  { id: 'retention', paragraph: BLUE_OVEN, turns: ['What time is it?', 'Tell me a joke.'],
    ask: 'Earlier, what did I say about the rye?',
    must: [/rye/i, /noon/i], forbid: [] },
];

/** Grades one question's reply: every `must` matches and no `forbid` does. */
export function gradeReading(question, reply) {
  const text = String(reply || '');
  const missing = question.must.filter((re) => !re.test(text)).map((re) => String(re));
  // An internal mood label leaking into the reply (for example "Warmth 7/10:") fails every question.
  const leaked = [/\b(?:warmth|mood|energy|humou?r|register)\s*\d+\s*\/\s*10\b/i];
  const forbidden = [...question.forbid, ...leaked].filter((re) => re.test(text)).map((re) => String(re));
  return { pass: missing.length === 0 && forbidden.length === 0 && text.length > 0, missing, forbidden };
}

async function readingChat(call, device, message, history) {
  const started = Date.now();
  const res = await call('/api/chat', { message, history }, device);
  const events = (await res.text()).split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
  const done = events.find((e) => e.type === 'done') || {};
  const reply = events.filter((e) => e.type === 'delta').map((e) => e.delta).join('').trim();
  return { status: res.status, reply, done, ms: Date.now() - started };
}

/** The live run: pairs with the test CHE, asks each question in order, grades every reply, records each verbatim. */
export async function readingProbe(env, request, objectName) {
  const token = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '')?.[1] || '';
  const probe = env.CHE_STATE.getByName(objectName);
  const call = (path, body, device = '') => probe.fetch(new Request(`https://che.internal${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CHE-Memory-Probe': token, ...(device ? { Authorization: `Bearer ${device}` } : {}) },
    body: JSON.stringify(body),
  }));
  const paired = await (await call('/api/pair', { code: String(env.CHE_PAIR_CODE || ''), device_name: 'CHE reading check' })).json().catch(() => ({}));
  const device = paired.device_token;
  if (!device) return { ok: false, error: 'The check could not pair with its test CHE.', steps: [] };
  const steps = [];
  try {
    for (const q of READING_QUESTIONS) {
      // The paragraph and the question go in one message. The retention question first shows the paragraph alone,
      // then two unrelated turns, then asks about it with the history kept.
      const history = [];
      if (q.turns) {
        const first = await readingChat(call, device, q.paragraph, history);
        history.push({ role: 'user', content: q.paragraph }, { role: 'assistant', content: first.reply });
        for (const turn of q.turns) {
          const r = await readingChat(call, device, turn, history);
          history.push({ role: 'user', content: turn }, { role: 'assistant', content: r.reply });
        }
      }
      const message = q.turns ? q.ask : `${q.paragraph}\n\n${q.ask}`;
      const r = await readingChat(call, device, message, history);
      const grade = gradeReading(q, r.reply);
      steps.push({ name: q.id, question: q.ask, pass: r.status === 200 && grade.pass, ms: r.ms, route: r.done.source || 'model', model_calls: r.done.model_calls ?? null,
        reply: r.reply, missing: grade.missing, forbidden: grade.forbidden });
    }
  } finally {
    await call('/api/security/revoke_self', {}, device).catch(() => null);
  }
  return { ok: steps.length > 0 && steps.every((s) => s.pass), passed: steps.filter((s) => s.pass).length, total: steps.length, steps };
}
