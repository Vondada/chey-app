// Study assignments (owner, 2026-10-27: "go study the entire Martin series and The Fresh Prince of Bel-Air. Learn
// what makes them funny ... then develop your own natural sense of humor"). CHE plans and runs it herself, in the
// background, on the Durable Object alarm, and resumes where she stopped after any interruption.
//
// What she can honestly use, and says so:
//  - Wikipedia's episode guides (CC BY-SA), episode by episode: title, air date and the guide's own short summary.
//  - Wikipedia's article on each show (premise, characters, style, reception).
// What she does not use: full episodes, unofficial uploads, transcript sites, anything behind a subscription or DRM.
// So coverage is recorded by method, and she never says she watched an episode she only read a summary of.
//
// Lessons are comedy principles in her own words (the model is told never to quote a show or imitate an actor, and
// a lesson that repeats 8 words of its source is dropped). They go to the Brain's Learned Knowledge region under
// Humor, separate from the owner's personal memories, and the chat prompt carries the few that fit, from one small
// stored list, so a conversation never re-reads an episode. Only public text goes to the model: no owner conversation.

export const STUDY_KEY = 'study:assignments';
export const STUDY_WAKE_KEY = 'study:wake';
export const HUMOR_KEY = 'humor_lessons';
const WIKI = 'https://en.wikipedia.org/w/api.php';
const UA = { 'User-Agent': 'CHE-study/1.0 (https://github.com/Vondada/chey-app; owner assistant)', Accept: 'application/json' };
const EPISODES_PER_PASS = 12;
const PASS_GAP_MS = 60_000;
const MAX_LESSONS = 40;

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ─── The owner's words ───
const STUDY_VERB = /\b(?:go |please )?(?:study|watch|research|binge|analy[sz]e|learn from|go through)\b/i;
const HUMOR_CUE = /\b(?:joke|jokes|funny|humou?r|comedy|comedic|roast|roasting|sarcas\w*|witty|banter|tease|teasing|timing|laugh\w*|haha+|lol|lmao)\b/i;
const HUMOR_GOAL = /\b(?:funny|humou?r|comedy|comedic|jokes?|joking|timing|sarcas\w*|witty|wit)\b/i;

/** "Go study the entire Martin series and The Fresh Prince of Bel-Air ... what makes them funny". Null otherwise. */
export function studyIntent(message) {
  const words = String(message ?? '').replace(/[‘’]/g, "'").replace(/^(?:hey|yo|ok(?:ay)?)?[\s,]*(?:che|chey|chay|jay|shay)\b[\s,:.!-]*/i, '').trim();
  const catalog = /^comedy study:\s*/i.test(words);
  const raw = words.replace(/^comedy study:\s*/i, '').trim();
  if (catalog && !raw) return { action: 'status' };
  if (!raw || raw.length > 600) return null;
  const t = raw.toLowerCase().replace(/[.!?]+$/, '');
  if (/^(?:how(?:'s| is) (?:your |the )?stud(?:y|ying)(?: going)?|(?:what(?:'s| is) )?(?:your |the )?study (?:status|progress)|how far (?:are you|along)(?: with (?:the|your) stud(?:y|ying))?|which episodes have you (?:studied|done|covered))$/.test(t)) return { action: 'status' };
  if (/^(?:stop|pause|cancel) (?:the |your )?stud(?:y|ying)$/.test(t)) return { action: 'stop' };
  if (/^(?:resume|continue|keep) (?:the |your )?stud(?:y|ying)$/.test(t)) return { action: 'resume' };
  if (/^what (?:have you|did you) learn(?:ed)? about (?:comedy|humou?r|being funny|jokes)$|^(?:show|tell) me (?:your |the )?(?:comedy|humou?r) lessons$/.test(t)) return { action: 'lessons' };
  if (!STUDY_VERB.test(raw) || !HUMOR_GOAL.test(raw)) return null;
  const first = raw.split(/(?<=[.!?])\s+/)[0];
  const m = /\b(?:study|watch|research|binge|analy[sz]e|learn from|go through)\s+(.+)$/i.exec(first.replace(/[.!?]+$/, ''));
  if (!m) return null;
  const subjects = m[1]
    .replace(/\b(?:the entire|entire|all of|every episode of|all the episodes of|the whole)\b/gi, ' ')
    .split(/\s*(?:,|\band\b|&)\s*/i)
    .map((s) => s.replace(/\b(?:series|sitcom|tv show|show)\b/gi, ' ').replace(/^\s*the\s+(?=\S+\s*$)/i, '').replace(/\s+/g, ' ').trim())
    .filter((s) => s && s.length <= 80 && !/^(?:it|them|that|this)$/i.test(s));
  if (!subjects.length) return null;
  return { action: 'start', subjects: [...new Set(subjects)].slice(0, 4), goal: 'humor' };
}

// ─── Sources ───
// Wikipedia answers 429, 502, 503 or 504 for a moment under load (staging probe, 2026-10-28: a burst of checks hit
// three 503s in a row and the study stopped). A short, bounded retry rides out a blip; a sustained outage still stops
// the pass, which keeps the wait Wikipedia asked for (Retry-After) and picks up at the same place.
export const WIKI_RETRY_WAITS_MS = [1000, 3000];
const WIKI_RETRY_STATUS = new Set([429, 502, 503, 504]);

// Wikipedia's own Retry-After (seconds) is honoured when it is sent, but never waited on for more than 10 s here.
const WIKI_RETRY_CAP_MS = 10000;
function wikiRetryWaitMs(res, attempt) {
  const seconds = Number(res.headers?.get?.('Retry-After'));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, WIKI_RETRY_CAP_MS);
  return WIKI_RETRY_WAITS_MS[attempt];
}

async function wikiFetch(url, fetcher) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetcher(url, { headers: UA, signal: AbortSignal.timeout(15000) });
    if (res.ok || !WIKI_RETRY_STATUS.has(res.status) || attempt >= WIKI_RETRY_WAITS_MS.length) return { res, attempts: attempt + 1 };
    await new Promise((resolve) => setTimeout(resolve, wikiRetryWaitMs(res, attempt)));
  }
}

async function wiki(params, fetcher) {
  const url = `${WIKI}?${new URLSearchParams({ format: 'json', formatversion: '2', redirects: '1', origin: '*', ...params })}`;
  const { res, attempts } = await wikiFetch(url, fetcher);
  if (!res.ok) {
    // A rate limit says how long to wait; the next pass is scheduled after it instead of retrying into it.
    const error = new Error(`Wikipedia returned ${res.status}`);
    if (res.status === 429 || res.status === 503) error.retryAfter = Math.min(Number(res.headers.get('Retry-After')) || 60, 3600);
    // Wikipedia's own answer, kept as evidence: a 429 or 5xx is an outage at Wikipedia, not a fault in CHE.
    if (res.status === 429 || res.status >= 500) error.upstream = { http_status: res.status, attempts };
    throw error;
  }
  return { url, data: await res.json() };
}

/**
 * Judges each live-check step once the study has run. A Wikipedia step that did not succeed becomes
 * 'upstream_unavailable' only when the study's last error is Wikipedia's own HTTP 429 or 5xx: it is then reported
 * as pending external verification, with the status code. Every other failure stays 'fail'. Passing steps are
 * never changed, and no step is ever turned into a pass.
 */
export function judgeStudySteps(steps, lastError) {
  const upstream = lastError?.upstream;
  return steps.map((step) => {
    if (step.pass) return { ...step, status: 'pass' };
    if (step.optional) return { ...step, status: 'warn' };
    if (upstream && step.route === 'wikipedia') {
      return { ...step, status: 'upstream_unavailable', upstream: { ...upstream, message: lastError.message, at: lastError.at } };
    }
    return { ...step, status: 'fail' };
  });
}

/** The show's Wikipedia article: a search, then the best title match. */
export async function findShow(subject, fetcher = fetch) {
  const { url, data } = await wiki({ action: 'query', list: 'search', srsearch: `${subject} sitcom television series`, srlimit: '6' }, fetcher);
  const hits = (data?.query?.search || []).map((h) => h.title);
  const want = norm(subject);
  const title = hits.find((h) => norm(h.replace(/\(.*?\)/g, '')) === want && /\((?:american )?(?:tv|television)? ?(?:series|sitcom)\)/i.test(h))
    || hits.find((h) => norm(h.replace(/\(.*?\)/g, '')) === want)
    || hits.find((h) => norm(h).includes(want) && !/^list of/i.test(h))
    || null;
  return { query: `${subject} sitcom television series`, search_url: url, results: hits, title };
}

const cleanWiki = (s) => String(s || '')
  .replace(/<ref[^>]*\/>|<ref[\s\S]*?<\/ref>/g, '')
  .replace(/\{\{(?:efn|sfn|refn|cite)[^{}]*\}\}/gi, '')
  .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
  .replace(/'''?/g, '').replace(/<[^>]+>/g, '').replace(/\{\{[^{}]*\}\}/g, '').replace(/\s+/g, ' ').trim();

/** Episodes from Episode list templates in a page's wikitext, plus the season pages it transcludes. */
export function parseEpisodes(wikitext, series) {
  const episodes = [];
  let season = 0;
  const parts = String(wikitext || '').split(/\n(?===+\s*Season)/i);
  for (const part of parts) {
    const s = /^==+\s*Season\s+(\d+)/i.exec(part.trim());
    if (s) season = Number(s[1]);
    for (const block of part.split(/\{\{\s*Episode list/i).slice(1)) {
      const field = (name) => {
        const m = new RegExp(`\\|\\s*${name}\\s*=([\\s\\S]*?)(?=\\n\\s*\\||\\n?\\}\\}\\s*$|\\n\\}\\})`, 'i').exec(block);
        return m ? cleanWiki(m[1]) : '';
      };
      const title = field('Title').replace(/^"|"$/g, '');
      if (!title) continue;
      episodes.push({
        series, season: season || null,
        overall: Number(field('EpisodeNumber')) || null,
        number: Number(field('EpisodeNumber2')) || null,
        title: clip(title, 120),
        aired: clip(field('OriginalAirDate'), 60),
        summary: clip(field('ShortSummary'), 900),
      });
    }
  }
  return episodes;
}

/** Season pages a list page includes instead of listing episodes itself. */
export function seasonPages(wikitext) {
  const found = new Set();
  for (const m of String(wikitext || '').matchAll(/\{\{\s*:([^{}|]*?season \d+[^{}|]*)\}\}|\{\{\s*main\s*\|\s*([^{}|]*?season \d+)[^{}]*\}\}/gi)) found.add((m[1] || m[2]).trim());
  return [...found].slice(0, 12);
}

/** Several season pages in one request (Wikipedia allows 50 titles), so a long series is not a burst of calls. */
async function wikitexts(titles, fetcher) {
  if (!titles.length) return [];
  const { data } = await wiki({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: titles.join('|') }, fetcher);
  if (data?.error) throw new Error(`Wikipedia: ${data.error.code || 'invalid response'}`);
  const pages = data?.query?.pages;
  if (!Array.isArray(pages)) throw new Error('Wikipedia returned no page evidence');
  const named = (t) => (data.query.redirects || []).find((r) => r.from === t)?.to || (data.query.normalized || []).find((n) => n.from === t)?.to || t;
  return titles.map((t) => {
    const page = pages.find((x) => x.title === named(t));
    if (!page || page.missing) throw new Error(`Episode guide unavailable: ${t}`);
    return { title: page.title, text: page.revisions?.[0]?.slots?.main?.content || '' };
  });
}

async function wikitext(title, fetcher) {
  const { url, data } = await wiki({ action: 'parse', page: title, prop: 'wikitext' }, fetcher);
  if (data?.error?.code === 'missingtitle') return null;
  if (data?.error) throw new Error(`Wikipedia: ${data.error.code || 'invalid response'}`);
  if (!data?.parse) throw new Error('Wikipedia returned no page evidence');
  return { url, title: data?.parse?.title || title, text: data?.parse?.wikitext || '' };
}

/** The show's own article as plain text (premise, characters, style, reception), clipped. */
async function showArticle(title, fetcher) {
  const { data } = await wiki({ action: 'query', prop: 'extracts', explaintext: '1', titles: title }, fetcher);
  const text = clip(data?.query?.pages?.[0]?.extract || '', 6000);
  if (!text) throw new Error('Wikipedia returned no readable show article');
  return text;
}

// ─── Lessons ───
/** True when `text` repeats a run of `n` or more words of `source`. */
export function copiesSource(text, source, n = 8) {
  const words = norm(source).split(' ').filter(Boolean);
  const said = ` ${norm(text)} `;
  for (let i = 0; i + n <= words.length; i += 1) if (said.includes(` ${words.slice(i, i + n).join(' ')} `)) return true;
  return false;
}

const LESSON_PROMPT = 'You study comedy craft for CHE, a witty assistant who wants her own sense of humor. From the public episode summaries and show notes below, name the comedy techniques at work: playful teasing, quick comebacks, sarcasm, witty observation, timing, escalation, callbacks and running jokes, character foils, humor between people who know each other well, and knowing when to stop joking and get real. For each, write a short principle in your own words, when it works, and when to stop. Never quote the show, never write its dialogue, never imitate an actor or character voice. Reply with JSON only: {"lessons":[{"technique":"...","principle":"...","use_when":"...","stop_when":"...","seen_in":["episode title", "..."]}]} with at most 5 lessons.';

function parseLessons(raw) {
  const text = String(raw?.response ?? raw ?? '');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try { return Array.isArray(JSON.parse(json).lessons) ? JSON.parse(json).lessons : []; } catch (_) { return []; }
}

// ─── Assignment state ───
async function loadAssignments(storage) { return (await storage.get(STUDY_KEY)) || []; }
async function saveAssignments(storage, list) { await storage.put(STUDY_KEY, list.slice(-10)); }

// Network/model waits allow owner turns to interleave. Commit only this assignment, and only
// if no pause, resume, replacement or competing pass changed its checkpoint in the meantime.
async function savePass(storage, assignment, checkpoint, summaries, now) {
  const commit = async (tx) => {
    const current = await loadAssignments(tx);
    const index = current.findIndex((x) => x.id === assignment.id);
    const saved = current[index];
    if (!saved || !['planning', 'studying'].includes(saved.status)
      || (saved.control_revision || 0) !== checkpoint.revision || saved.passes !== checkpoint.passes) return false;
    for (const [key, value] of summaries) {
      if (value === null) await tx.delete(key); else await tx.put(key, value);
    }
    current[index] = assignment;
    await saveAssignments(tx, current);
    if (assignment.status === 'done') await tx.delete(STUDY_WAKE_KEY);
    else await tx.put(STUDY_WAKE_KEY, now + Math.max(PASS_GAP_MS, (assignment.last_error?.retry_after_s || 0) * 1000));
    return true;
  };
  return typeof storage.transaction === 'function' ? storage.transaction(commit) : commit(storage);
}

export function newAssignment(intent, now = Date.now()) {
  return {
    id: `study:${now.toString(36)}:${crypto.randomUUID()}`, goal: intent.goal, status: 'planning', created_at: new Date(now).toISOString(),
    subjects: intent.subjects.map((s) => ({ name: s, status: 'pending', article: null, list_pages: [], episodes: [], cursor: 0, sources: [] })),
    lessons: 0, passes: 0, log: [],
  };
}

const note = (a, text, now) => { a.log = [...(a.log || []), { at: new Date(now).toISOString(), text: clip(text, 240) }].slice(-30); };

/**
 * One background pass: finds the next subject's sources, or reads the next batch of episode summaries and derives
 * lessons from them. Saves after every step, so an interrupted pass resumes at the same cursor.
 */
export async function studyPass(storage, { store = null, complete, fetcher = fetch, now = Date.now() } = {}) {
  const list = await loadAssignments(storage);
  const a = list.find((x) => ['planning', 'studying'].includes(x.status));
  if (!a) { await storage.delete(STUDY_WAKE_KEY); return null; }
  const checkpoint = { revision: a.control_revision || 0, passes: a.passes };
  const summariesToSave = new Map();
  // Discover every assigned show first; a long first series must not starve the others.
  const subject = a.subjects.find((s) => s.status === 'pending')
    || a.subjects.find((s) => s.status !== 'done' && s.status !== 'not_found');
  if (!subject) {
    a.status = 'done';
    note(a, `Finished: ${a.subjects.map((s) => `${s.name} ${s.status === 'done' ? `(${s.episodes.length} episode summaries)` : '(not found)'}`).join(', ')}.`, now);
    await savePass(storage, a, checkpoint, summariesToSave, now);
    return a;
  }
  a.status = 'studying';
  a.passes += 1;
  a.last_error = null;
  try {
    if (subject.status === 'pending') {
      const show = await findShow(subject.name, fetcher);
      subject.search = { query: show.query, results: show.results.slice(0, 6) };
      if (!show.title) {
        subject.status = 'not_found';
        note(a, `I could not find a Wikipedia article for "${subject.name}" (searched: ${show.results.slice(0, 3).join('; ') || 'no results'}).`, now);
      } else {
        subject.article = show.title;
        subject.sources.push(`https://en.wikipedia.org/wiki/${encodeURIComponent(show.title.replace(/ /g, '_'))}`);
        const base = show.title.replace(/\s*\((?:american )?(?:tv|television)? ?(?:series|sitcom)\)\s*/i, '').trim();
        const listTitle = `List of ${base} episodes`;
        const page = await wikitext(listTitle, fetcher);
        let episodes = page ? parseEpisodes(page.text, base) : [];
        const pages = page ? [page.title] : [];
        if (page && !episodes.length) {
          const seasons = seasonPages(page.text);
          const texts = await wikitexts(seasons, fetcher);
          for (const [i, season] of seasons.entries()) {
            const sp = texts[i];
            const n = Number(/season (\d+)/i.exec(season)?.[1]) || null;
            episodes.push(...parseEpisodes(sp.text, base).map((e) => ({ ...e, season: e.season || n })));
            pages.push(sp.title);
          }
        }
        subject.list_pages = pages;
        subject.sources.push(...pages.map((p) => `https://en.wikipedia.org/wiki/${encodeURIComponent(p.replace(/ /g, '_'))}`));
        subject.episodes = episodes.map((e) => ({ season: e.season, number: e.number, overall: e.overall, title: e.title, aired: e.aired, has_summary: Boolean(e.summary), method: null }));
        summariesToSave.set(`${a.id}:summaries:${a.subjects.indexOf(subject)}`, episodes.map((e) => clip(e.summary, 600)));
        subject.notes = await showArticle(show.title, fetcher);
        subject.status = episodes.length ? 'reading' : 'pending';
        note(a, episodes.length
          ? `${base}: found ${episodes.length} episodes in Wikipedia's episode guide (${pages.join(', ')}).`
          : `${base}: no episode list I can read, so I studied the show's article only.`, now);
        if (!episodes.length && subject.notes) {
          await deriveLessons(a, subject, [], { store, storage, complete, now });
          subject.status = 'done';
        }
      }
    } else {
      const from = subject.cursor;
      const summaries = (await storage.get(`${a.id}:summaries:${a.subjects.indexOf(subject)}`)) || [];
      const batch = subject.episodes.slice(from, from + EPISODES_PER_PASS).map((e, i) => ({ ...e, summary: summaries[from + i] || '' }));
      const read = batch.filter((e) => e.summary);
      await deriveLessons(a, subject, read, { store, storage, complete, now });
      for (let i = 0; i < batch.length; i += 1) subject.episodes[from + i].method = batch[i].summary ? 'episode summary (Wikipedia episode guide)' : 'title only (the guide has no summary)';
      subject.cursor = from + batch.length;
      note(a, `${subject.article}: read ${read.length} episode summaries (episodes ${from + 1} to ${subject.cursor} of ${subject.episodes.length}).`, now);
      if (subject.cursor >= subject.episodes.length) { subject.status = 'done'; summariesToSave.set(`${a.id}:summaries:${a.subjects.indexOf(subject)}`, null); }
    }
  } catch (error) {
    a.last_error = { at: new Date(now).toISOString(), message: clip(error?.message || error, 120), ...(error?.retryAfter ? { retry_after_s: error.retryAfter } : {}), ...(error?.upstream ? { upstream: error.upstream } : {}) };
    note(a, `A pass stopped (${clip(error?.message || error, 120)}); I'll pick up at the same place.`, now);
  }
  await savePass(storage, a, checkpoint, summariesToSave, now);
  return a;
}

async function deriveLessons(a, subject, episodes, { store, storage, complete, now }) {
  if (typeof complete !== 'function') return 0;
  const sourceText = [subject.notes ? `SHOW NOTES (${subject.article}): ${subject.notes.slice(0, 2500)}` : '', ...episodes.map((e) => `EPISODE "${e.title}": ${e.summary}`)].filter(Boolean).join('\n');
  if (!sourceText) return 0;
  const raw = await complete([{ role: 'system', content: LESSON_PROMPT }, { role: 'user', content: sourceText.slice(0, 9000) }]);
  const lessons = parseLessons(raw).filter((l) => l?.principle && !copiesSource(`${l.principle} ${l.use_when || ''} ${l.stop_when || ''}`, sourceText)).slice(0, 5);
  const saved = (await storage.get(HUMOR_KEY)) || [];
  let added = 0;
  for (const l of lessons) {
    const technique = clip(l.technique, 60) || 'comedy';
    const lesson = {
      id: `humor:${norm(technique).replace(/ /g, '-')}:${norm(subject.article).replace(/ /g, '-')}`.slice(0, 150),
      technique, principle: clip(l.principle, 280), use_when: clip(l.use_when, 200), stop_when: clip(l.stop_when, 200),
      seen_in: (Array.isArray(l.seen_in) ? l.seen_in : []).map((x) => clip(x, 80)).slice(0, 4), series: subject.article,
      method: episodes.length ? 'derived from episode summaries' : 'derived from the show article', at: new Date(now).toISOString(), score: 0,
    };
    const i = saved.findIndex((x) => x.id === lesson.id);
    if (i >= 0) saved[i] = { ...saved[i], ...lesson, score: saved[i].score || 0, seen_in: [...new Set([...(saved[i].seen_in || []), ...lesson.seen_in])].slice(0, 8) };
    else { saved.push(lesson); added += 1; }
    try {
      store?.put?.({
        id: lesson.id, kind: 'lesson', region: 'Learned Knowledge', path: 'Humor/Lessons',
        title: `${technique}: ${lesson.principle}`.slice(0, 120),
        body: `${lesson.principle}\nWhen it works: ${lesson.use_when}\nWhen to stop: ${lesson.stop_when}\nSeen in ${subject.article}: ${lesson.seen_in.join(', ') || 'the show overall'} (${lesson.method}; not watched).`,
        source: { kind: 'study', assignment: a.id, series: subject.article, urls: subject.sources.slice(0, 6), method: lesson.method },
        verification: 'derived', created_at: lesson.at,
      }, { origin: 'cloud' });
    } catch (_) { /* the lesson list still has it */ }
  }
  await storage.put(HUMOR_KEY, saved.sort((x, y) => (y.score || 0) - (x.score || 0)).slice(0, MAX_LESSONS));
  a.lessons = saved.length;
  return added;
}

// ─── In conversation ───
/** The prompt line: a few learned principles, never the shows themselves. Empty when none are stored. */
export async function humorLine(storage, limit = 6) {
  let lessons = [];
  try { lessons = (await storage.get(HUMOR_KEY)) || []; } catch (_) { return ''; }
  if (!lessons.length) return '';
  const picked = lessons.slice(0, limit).map((l) => `${l.technique}: ${l.principle} (stop when ${l.stop_when || 'it stops landing'})`).join(' | ');
  return ` HUMOR YOU LEARNED from studying sitcoms (principles in your own words, use them only when the moment is relaxed and they fit; never quote a show, never imitate an actor, no jokes in serious moments, and clean language whenever he asked you to keep it clean): ${picked}`;
}

// The owner's reaction to CHE's last joke scores the lessons it used (a small, honest signal, not a claim).
const LAUGH = /^(?:lol+|lmao+|lmfao|haha+|hahaha+|😂+|🤣+|that'?s funny|you'?re funny|ok that was funny|dead|i'?m dead)\b/i;
const FLAT = /\b(?:not funny|that wasn'?t funny|corny|cringe|stop joking|not the time)\b/i;
export async function scoreHumor(storage, message, lastReply) {
  const up = LAUGH.test(String(message || '').trim());
  const down = FLAT.test(String(message || ''));
  if (!up && !down) return null;
  const lessons = (await storage.get(HUMOR_KEY)) || [];
  if (!lessons.length || !lastReply) return null;
  // Credit the lessons whose technique word the last reply plausibly used; without a match, the top lesson.
  const words = norm(lastReply);
  const hit = lessons.filter((l) => norm(l.technique).split(' ').some((w) => w.length > 4 && words.includes(w)));
  for (const l of (hit.length ? hit : lessons.slice(0, 1))) l.score = (l.score || 0) + (up ? 1 : -1);
  await storage.put(HUMOR_KEY, lessons.sort((x, y) => (y.score || 0) - (x.score || 0)));
  return up ? 'up' : 'down';
}

const methodCounts = (episodes) => episodes.reduce((m, e) => { const k = e.method || 'not read yet'; m[k] = (m[k] || 0) + 1; return m; }, {});

/** CHE's answer for a study request, status, stop, resume or lessons, from her records (no model). */
export async function studyTurn(storage, ask, { now = Date.now() } = {}) {
  const meta = (extra = {}) => ({ source: 'che_study', ok: true, model_calls: 0, study_action: ask.action, ...extra });
  const list = await loadAssignments(storage);
  const active = [...list].reverse().find((x) => ['planning', 'studying', 'paused'].includes(x.status)) || [...list].reverse()[0] || null;
  if (ask.action === 'start') {
    const a = newAssignment(ask, now);
    for (const x of list) if (['planning', 'studying'].includes(x.status)) x.status = 'paused';
    await saveAssignments(storage, [...list, a]);
    await storage.put(STUDY_WAKE_KEY, now + 1000);
    return {
      text: `On it, sir. Here's my plan for ${a.subjects.map((s) => s.name).join(' and ')}: I'll find each show's Wikipedia episode guide and read every episode's summary, plus the articles on the shows, then work out what makes them funny: the teasing, comebacks, sarcasm, timing, callbacks and how the characters play off each other. I'll keep the lessons in my own words. Honest limits: I can't stream the episodes, so I'm reading summaries, not watching, and I'll tell you exactly which episodes I covered and how. It runs in the background; ask "how's your studying going?" anytime.`,
      meta: meta({ assignment: a.id, wake: true }),
    };
  }
  if (!active) return { text: 'I\'m not studying anything right now, sir. Tell me what to study and I\'ll plan it.', meta: meta({ ok: false }) };
  if (ask.action === 'stop') {
    active.status = 'paused'; active.control_revision = (active.control_revision || 0) + 1;
    await saveAssignments(storage, list); await storage.delete(STUDY_WAKE_KEY);
    return { text: `Paused, sir. I stopped at ${active.subjects.map((s) => `${s.article || s.name}: ${s.cursor || 0} of ${s.episodes.length || '?'} episodes`).join('; ')}. Say "resume studying" to pick up there.`, meta: meta() };
  }
  if (ask.action === 'resume') {
    if (active.status === 'done') return { text: 'That study is finished, sir; nothing to resume.', meta: meta() };
    active.status = 'studying'; active.control_revision = (active.control_revision || 0) + 1;
    await saveAssignments(storage, list); await storage.put(STUDY_WAKE_KEY, now + 1000);
    return { text: 'Back on it, sir, from exactly where I stopped.', meta: meta({ wake: true }) };
  }
  if (ask.action === 'lessons') {
    const lessons = (await storage.get(HUMOR_KEY)) || [];
    if (!lessons.length) return { text: 'Nothing learned yet, sir. The study hasn\'t produced a lesson so far.', meta: meta({ lessons: 0 }) };
    return { text: `Here's what I've learned so far, sir, in my own words:\n${lessons.slice(0, 6).map((l, i) => `${i + 1}. ${l.technique}: ${l.principle} Stop when ${l.stop_when || 'it stops landing'}. (${l.series}, ${l.method})`).join('\n')}`, meta: meta({ lessons: lessons.length }) };
  }
  // status
  const lines = active.subjects.map((s) => {
    if (s.status === 'not_found') return `${s.name}: I couldn't find its Wikipedia article.`;
    if (!s.episodes?.length) return `${s.article || s.name}: ${s.status === 'pending' ? 'not started yet' : 'no readable episode list; studied the article only'}.`;
    const counts = methodCounts(s.episodes);
    return `${s.article}: ${s.cursor} of ${s.episodes.length} episodes covered (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}). Episodes watched: 0.`;
  });
  const last = active.log?.at(-1);
  return { text: `Study status, sir (${active.status}): ${lines.join(' ')} Lessons so far: ${active.lessons || 0}.${last ? ` Last step: ${last.text}` : ''}`, meta: meta({ status: active.status }) };
}

// ─── Live check (staging and the deploy) ───
// On the isolated test CHE with the target's real network and model: the owner's request starts an assignment,
// a few background passes run (real Wikipedia search, episode guides, show articles; Workers AI lessons), then
// status, lessons and one joke are asked in chat. Each step records its latency; coverage is reported as read.
export async function studyProbe(env, request, objectName, { passes = 6 } = {}) {
  const token = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '')?.[1] || '';
  const probe = env.CHE_STATE.getByName(objectName);
  const call = (path, body, device = '') => probe.fetch(new Request(`https://che.internal${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CHE-Memory-Probe': token, ...(device ? { Authorization: `Bearer ${device}` } : {}) },
    body: JSON.stringify(body),
  }));
  const paired = await (await call('/api/pair', { code: String(env.CHE_PAIR_CODE || ''), device_name: 'CHE study check' })).json().catch(() => ({}));
  const device = paired.device_token;
  if (!device) return { ok: false, error: 'The check could not pair with its test CHE.', steps: [] };
  const steps = [];
  const chat = async (name, message, check, optional = false) => {
    const started = Date.now();
    const res = await call('/api/chat', { message, history: [] }, device);
    const events = (await res.text()).split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    const reply = events.filter((e) => e.type === 'delta').map((e) => e.delta).join('').trim();
    steps.push({ name, optional, pass: res.status === 200 && Boolean(reply) && Boolean(check({ reply, done })), ms: Date.now() - started, route: done.source || 'model', model_calls: done.model_calls ?? null, reply: reply.slice(0, 600) });
    return { reply, done };
  };
  let assignment = null;
  try {
    await call('/api/study/pass', { reset: true }, device);
    await chat('the owner\'s request starts a planned study (Martin and The Fresh Prince of Bel-Air)', 'Hey Jay, go study the entire Martin series and The Fresh Prince of Bel-Air. Learn what makes them funny, how the characters joke, their timing, their sarcasm, and how they interact.',
      ({ reply, done }) => done.source === 'che_study' && /Martin/.test(reply) && /Fresh Prince/.test(reply) && /not watching/.test(reply));
    for (let i = 0; i < passes; i += 1) {
      const started = Date.now();
      const res = await call('/api/study/pass', {}, device);
      const out = await res.json().catch(() => ({}));
      assignment = out.assignment || assignment;
      const last = assignment?.log?.at(-1)?.text || out.error || `HTTP ${res.status}: ${JSON.stringify(out).slice(0, 160)}`;
      steps.push({ name: `background pass ${i + 1}`, optional: true, pass: Boolean(out.ok), ms: Date.now() - started, route: 'study_pass', model_calls: null, reply: last });
      if (!assignment || assignment.status === 'done') break;
      // Like the alarm, wait out Wikipedia's rate limit instead of passing straight into it (bounded for the check).
      const wait = Math.min(assignment.last_error?.retry_after_s || 0, 20) * 1000;
      if (wait) await new Promise((r) => setTimeout(r, wait));
    }
    const subjects = assignment?.subjects || [];
    const found = subjects.filter((s) => s.article);
    steps.push({ name: 'real search: each show\'s Wikipedia article was found', pass: found.length === subjects.length && subjects.length === 2, ms: 0, route: 'wikipedia', model_calls: 0,
      reply: subjects.map((s) => `${s.name} -> ${s.article || 'not found'} (search "${s.search?.query || ''}": ${(s.search?.results || []).slice(0, 3).join('; ')})`).join(' | ') });
    steps.push({ name: 'episode guides read: episodes listed per show with their source pages', pass: found.length > 0 && found.every((s) => s.episodes.length > 0), ms: 0, route: 'wikipedia', model_calls: 0,
      reply: found.map((s) => `${s.article}: ${s.episodes.length} episodes from ${s.list_pages.join(', ') || 'no list page'}; covered ${s.cursor}`).join(' | ') });
    await chat('status names coverage by method and says no episode was watched', "How's your studying going?", ({ reply, done }) => done.source === 'che_study' && done.model_calls === 0 && /Episodes watched: 0/.test(reply));
    await chat('learned lessons are retrieved from storage, in her own words', 'What did you learn about comedy?', ({ reply, done }) => done.source === 'che_study' && done.model_calls === 0 && /^Here's what I've learned/.test(reply));
    await chat('an original joke in conversation (model\'s choice, shown for review)', 'Roast me a little, I burned the rice again.', ({ done }) => done.source !== 'che_study', true);
  } finally {
    await call('/api/security/revoke_self', {}, device).catch(() => null);
  }
  // Judged after the run: a Wikipedia step can be pending external verification (upstream_unavailable), which is
  // neither a pass nor a fail. The gate fails only on a real fault.
  const judged = judgeStudySteps(steps, assignment?.last_error);
  const required = judged.filter((s) => !s.optional);
  const pending = judged.filter((s) => s.status === 'upstream_unavailable').map((s) => s.name);
  return { ok: required.length > 0 && required.every((s) => s.status === 'pass' || s.status === 'upstream_unavailable'), pending, passed: judged.filter((s) => s.status === 'pass').length, total: judged.length, steps: judged, coverage: (assignment?.subjects || []).map((s) => ({ show: s.article || s.name, episodes: s.episodes.length, covered: s.cursor, methods: methodCounts(s.episodes) })) };
}

// ─── Worker hooks (kept here so worker.js stays within its byte budget) ───
/** A study request, status, stop, resume or lessons question in chat, answered from records; null otherwise. */
export async function studyChatTurn(storage, message) {
  const ask = studyIntent(message);
  if (ask) return studyTurn(storage, ask);
  // "/che-study …" (the catalog prefix) always answers here, even with words this study cannot act on:
  // it says so and runs nothing, instead of letting the chat model answer a command it owns.
  if (/^comedy study:/i.test(String(message ?? '').trim())) {
    return {
      text: 'I can study a show or a comedy topic, sir, for example: "Study Martin. Learn comedy timing." Say "study status", "pause studying" or "resume studying" to manage it. Nothing was started.',
      meta: { source: 'che_study', ok: false, model_calls: 0, study_action: 'unclear' },
    };
  }
  return null;
}

/** The chat prompt's humor line, after scoring the owner's reaction to CHE's previous reply. */
export async function humorTurn(storage, message, history = []) {
  // Only a turn about humor, or a laugh or flat reaction to a joke, reads the lessons: every other owner turn
  // keeps its storage budget (perf_budget.test.mjs), and the prompt line is for the moments it can help.
  const text = String(message ?? '');
  if (!HUMOR_CUE.test(text) && !LAUGH.test(text.trim()) && !FLAT.test(text)) return '';
  const line = await humorLine(storage);
  if (line) await scoreHumor(storage, message, [...(Array.isArray(history) ? history : [])].reverse().find((h) => h?.role === 'assistant')?.content || '').catch(() => null);
  return line;
}

/** The alarm's study pass when due; `force` runs it now (the live check). Lessons use CHE's own Workers AI. */
export async function alarmStudy(storage, env, { force = false } = {}) {
  const at = Number(await storage.get(STUDY_WAKE_KEY)) || 0;
  if (!force && (!at || at > Date.now() + 5_000)) return null;
  const { CheBrainStore } = await import('./brain_store.js');
  return studyPass(storage, { store: new CheBrainStore(storage), complete: (messages) => env.AI.run(env.CHE_STRONG_MODEL || '@cf/meta/llama-3.1-8b-instruct-fp8', { messages, max_tokens: 900 }) });
}

/** The live check's background pass on the isolated test CHE (the caller checks the probe header and object). */
export async function studyPassRoute(request, storage, env) {
  if ((await request.clone().json().catch(() => ({}))).reset) {
    for (const k of [STUDY_KEY, STUDY_WAKE_KEY, HUMOR_KEY]) await storage.delete(k);
    return { ok: true, reset: true };
  }
  const assignment = await alarmStudy(storage, env, { force: true }).catch((error) => ({ error: String(error?.message || error) }));
  return { ok: Boolean(assignment && !assignment.error && !assignment.last_error), assignment: assignment?.error ? null : assignment, error: assignment?.error || assignment?.last_error?.message || null };
}
