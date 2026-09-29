// CHE's nightly review. Once a night (Cloudflare cron) CHE rereads the day's
// conversations, writes a short honest summary, lessons for herself, open
// threads and preferences the owner actually stated, and carries them into
// tomorrow's conversations.
//
// This is note-taking, not retraining: CHE gets better by remembering what
// happened and what to do differently, not by changing the AI model.

const MAX_DAY_CHARS = 14_000;
const MAX_REVIEWS = 30;
const MAX_KNOWLEDGE = 60;

function clip(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

// Pulls every chat/voice turn since `sinceIso` from CHE's conversation logs.
export async function collectDay(storage, sinceIso) {
  const since = Date.parse(sinceIso) || 0;
  const index = (await storage.get('log_index')) || [];
  const turns = [];
  for (const entry of index) {
    if ((Date.parse(entry?.updated_at) || 0) < since) continue;
    const log = await storage.get(`log:${entry.id}`);
    for (const turn of Array.isArray(log?.turns) ? log.turns : []) {
      if ((Date.parse(turn?.at) || 0) < since) continue;
      turns.push({ at: String(turn.at), title: String(log.title || ''), user: turn.user, che: turn.che, error: Boolean(turn.error) });
    }
  }
  turns.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const lines = turns.map((t) => `[${t.at}] OWNER: ${clip(t.user, 600)}\nCHE: ${t.error ? '(failed to answer)' : clip(t.che, 800)}`);
  let text = lines.join('\n\n');
  if (text.length > MAX_DAY_CHARS) text = text.slice(text.length - MAX_DAY_CHARS);
  return { turns: turns.length, failures: turns.filter((t) => t.error).length, text };
}

export function parseReview(raw) {
  const match = /\{[\s\S]*\}/.exec(String(raw || ''));
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]);
    const list = (v, n) => (Array.isArray(v) ? v : []).map((item) => clip(item, 300)).filter(Boolean).slice(0, n);
    const summary = clip(value.summary, 1500);
    if (!summary) return null;
    return {
      summary,
      lessons: list(value.lessons, 6),
      open_threads: list(value.open_threads, 8),
      stated_preferences: list(value.stated_preferences, 6),
    };
  } catch (_) {
    return null;
  }
}

export async function runNightlyReview(env, storage, data, model, nowMs = Date.now()) {
  const at = new Date(nowMs).toISOString();
  const since = data.last_nightly_at || new Date(nowMs - 24 * 3600_000).toISOString();
  const day = await collectDay(storage, since);
  data.nightly_reviews = Array.isArray(data.nightly_reviews) ? data.nightly_reviews : [];
  if (!day.turns) {
    data.last_nightly_at = at;
    return { status: 200, review: null, detail: 'No conversations since the last review.' };
  }
  let raw = '';
  try {
    const answer = await env.AI.run(model, {
      messages: [
        {
          role: 'system',
          content: [
            'You are CHE reviewing your own day with the owner, privately, at night.',
            'Use ONLY the transcript. Never invent events, facts, results or feelings. If something is unclear, leave it out.',
            'summary: what actually happened today, in a few plain sentences.',
            'lessons: concrete things YOU should do differently or keep doing (e.g. mistakes, made-up claims, unhelpful answers). Be honest about your own errors.',
            'open_threads: unfinished things the owner asked for or said he would do.',
            'stated_preferences: only preferences the owner explicitly said. Nothing sensitive (health, money details, passwords).',
            'Return ONLY JSON: {"summary": string, "lessons": [string], "open_threads": [string], "stated_preferences": [string]}',
          ].join('\n'),
        },
        { role: 'user', content: `Turns: ${day.turns} (failed answers: ${day.failures})\n\n${day.text}` },
      ],
      max_tokens: 900,
    });
    raw = String(answer?.response || answer?.choices?.[0]?.message?.content || '');
  } catch (error) {
    return { status: 503, detail: `Nightly review could not run: ${clip(error?.message || error, 300)}` };
  }
  const review = parseReview(raw);
  if (!review) return { status: 502, detail: 'Nightly review came back unreadable; will retry next night.' };
  const record = { id: crypto.randomUUID(), at, since, turns: day.turns, failures: day.failures, ...review };
  data.nightly_reviews.unshift(record);
  data.nightly_reviews = data.nightly_reviews.slice(0, MAX_REVIEWS);
  data.learned_knowledge = Array.isArray(data.learned_knowledge) ? data.learned_knowledge : [];
  for (const lesson of review.lessons) {
    if (!data.learned_knowledge.some((item) => String(item).toLowerCase() === lesson.toLowerCase())) {
      data.learned_knowledge.push(lesson);
    }
  }
  data.learned_knowledge = data.learned_knowledge.slice(-MAX_KNOWLEDGE);
  data.last_nightly_at = at;
  return { status: 200, review: record };
}

// Short context line for tomorrow's conversations.
export function nightlyContext(data) {
  const last = Array.isArray(data.nightly_reviews) ? data.nightly_reviews[0] : null;
  if (!last) return '';
  return [
    `Your private notes from your last nightly review (${last.at.slice(0, 10)}):`,
    `Summary: ${last.summary}`,
    last.lessons?.length ? `Lessons for yourself: ${last.lessons.join(' | ')}` : '',
    last.open_threads?.length ? `Open threads (mention only if relevant or asked): ${last.open_threads.join(' | ')}` : '',
  ].filter(Boolean).join('\n').slice(0, 2500);
}
