// Owner tone corrections, read from one message (owner, 2026-10-26: "Chill, I'm by my mama" means clean up the language).
// A pure classifier. It only says what the owner asked for and how long it should last; it never stores anything and
// never decides who is physically present. Questions about past instructions, quoted speech and hypotheticals are not
// corrections, so they return null.
//
// Scope: 'situational' for this conversation or setting ("I'm by my mama", "we're around company"), 'temporary' for a
// one-off reaction ("be serious for a second"), 'persistent' only when the owner says so ("from now on", "always").

const HYPOTHETICAL = /\b(?:if|suppose|what if|imagine|pretend|for example|like when|quote|said:)\b|["“”]/i;
const QUESTION_ABOUT_PAST = /\b(?:remember|remind me|do you recall|what did i|how i told you)\b/i;
const PERSISTENT = /\b(?:from now on|always|every time|going forward|in general)\b/i;

const RULES = [
  { id: 'clean_language', re: /\b(?:chill,?\s*)*(?:i'?m|i am|we'?re|we are) (?:by|around|with|near) (?:my |the |some |little )?(?:mama|momma|mom|mommy|mother|moms|family|grandma|granny|grandmother|grandparents|dad|pops|kids?|children|little ones|nephews?|nieces?)\b|\b(?:my )?(?:mama|momma|mom|mother|grandma|kids?|children) (?:is|are|'s|'re) (?:here|right here|nearby|listening|in the room|with me)\b|\b(?:i'?m|we'?re|i am|we are) (?:in public|out in public|at church)\b|\bwatch (?:your|the) (?:language|mouth)\b|\bclean (?:up )?(?:your|the) language\b|\bkeep (?:it )?clean\b|\bno (?:more )?(?:cussing|cursing|swearing)\b/i, patch: { cleanLanguage: true, formality: 7 }, reply: 'Oh, my bad. Excuse my language.' },
  { id: 'around_company', re: /\b(?:we'?re|we are) (?:around|with) (?:company|people|others|guests)\b/i, patch: { cleanLanguage: true, formality: 7, playfulness: 2 }, reply: 'Got it. I will keep it clean and professional.' },
  { id: 'professional', re: /\bkeep it (?:professional|business(?:like)?|serious)\b|\bprofessional(?:ly)? please\b/i, patch: { formality: 8, playfulness: 1 }, reply: 'Understood. Professional tone.' },
  { id: 'relaxed', re: /\b(?:relax|it'?s just us|just us|we'?re good|no need to be formal)\b|\byou can (?:talk|speak) normal(?:ly)?\b|\btalk (?:normal(?:ly)?|regular) again\b|\bback to normal\b|\byou can (?:curse|cuss|swear)(?: again)?\b|\b(?:she|he|they|mama|momma|my mom|the kids)(?:'s|'re| is| are) (?:gone|asleep|not here)\b|\b(?:she|he|they|mama|my mom|the kids) (?:left|went (?:home|to bed|to sleep))\b|\b(?:i'?m|we'?re) (?:alone|by myself) (?:now|again)\b/i, patch: { formality: 3, playfulness: 6, cleanLanguage: false }, reply: 'Got it. Relaxed again.' },
  { id: 'less_robotic', re: /\b(?:don'?t talk to me like a robot|stop (?:sounding|talking) like a robot|you sound like a robot)\b/i, patch: { formality: 3, warmth: 8 }, reply: 'Fair. I will talk to you more naturally.' },
  { id: 'less_detail', re: /\byou'?re doing (?:too much|way too much)\b|\btoo (?:much|long)\b/i, patch: { verbosity: 2 }, reply: 'Understood. Shorter answers.' },
  { id: 'serious_moment', re: /\bbe serious (?:for a (?:second|sec|minute|moment))?\b|\bthis is serious\b/i, patch: { playfulness: 0, formality: 6 }, reply: 'Understood. Serious tone.' },
];

/**
 * Classifies one owner message as a tone correction, or returns null. Result: { id, scope, patch, reply }.
 * `patch` holds the trait changes the owner asked for; the caller decides whether to apply them (and where).
 */
export function classifySocialCorrection(message) {
  // iPhone smart punctuation types ’ for '.
  const text = String(message ?? '').replace(/[\u2018\u2019]/g, "'").trim();
  if (!text || text.length > 300) return null;
  if (QUESTION_ABOUT_PAST.test(text) || HYPOTHETICAL.test(text)) return null;
  const rule = RULES.find((r) => r.re.test(text));
  if (!rule) return null;
  const scope = PERSISTENT.test(text) ? 'persistent' : /\bfor a (?:second|sec|minute|moment)\b/i.test(text) ? 'temporary' : 'situational';
  return { id: rule.id, scope, patch: { ...rule.patch }, reply: rule.reply };
}

// ─── The conversation's language register (owner, 2026-10-27) ───
// "Chill, I'm by my mama" keeps CHE's language clean until the owner lifts it ("you can talk normal again"), the
// conversation goes quiet for three hours, or he set it "from now on" (then it stays). Only the owner's own words
// change it: CHE never guesses who is nearby. Stored as one small owner-only value in CHE's storage.
export const SOCIAL_REGISTER_KEY = 'social_register';
const SITUATIONAL_MS = 3 * 60 * 60_000;
const PROFANITY = /\b(?:fuck\w*|motherf\w*|shit\w*|bullshit|bitch\w*|damn\w*|goddamn|ass(?:hole|es)?|dick\w*|pussy|bastard|crap)\b/i;
const BARE_CHILL = /^\W*(?:(?:yo|ay|ayy|whoa|woah|hey|chay|che|chey)\W+)?chill(?:\W+chill)*(?:\W+(?:out|bro|sis|che|chay|chey))?\W*$/i;
// What lifts clean language: the owner saying so, or that the people have gone. A bare "relax" or "we're good" does not.
const LIFT = /\bjust us\b|\byou can (?:talk|speak) normal|\btalk (?:normal(?:ly)?|regular) again\b|\bback to normal\b|\byou can (?:curse|cuss|swear)|(?:'s|'re| is| are) (?:gone|asleep|not here)\b|\b(?:left|went (?:home|to bed|to sleep))\b|\b(?:alone|by myself) (?:now|again)\b/i;
const MODE_TALK = /\b(?:(?:family[- ]friendly|clean|safe|polite|kid[- ]friendly) mode|mode (?:on|activated|enabled)|switching (?:to|into) (?:clean|family))\b/i;

export const hasProfanity = (text) => PROFANITY.test(String(text || ''));
export const announcesMode = (text) => MODE_TALK.test(String(text || ''));

/** The active register, or null when none is set or it lapsed. */
export function activeRegister(reg, now = Date.now()) {
  if (!reg || !reg.clean) return null;
  if (reg.scope === 'persistent') return reg;
  return now - Number(reg.last_at || reg.at || 0) < SITUATIONAL_MS ? reg : null;
}

/** The register after one owner message. `lastReply` is CHE's previous reply, for a bare "chill chill". */
export function nextRegister(prev, message, { lastReply = '', now = Date.now() } = {}) {
  const current = activeRegister(prev, now);
  const c = classifySocialCorrection(message);
  if (c?.patch?.cleanLanguage === true) return { clean: true, id: c.id, scope: c.scope === 'persistent' ? 'persistent' : 'situational', at: now, last_at: now };
  if (c?.patch?.cleanLanguage === false && LIFT.test(String(message || '').replace(/[\u2018\u2019]/g, "'"))) return null;
  // A bare "chill" only means "watch it" right after CHE swore; otherwise it is just a word.
  if (!current && BARE_CHILL.test(String(message || '')) && hasProfanity(lastReply)) return { clean: true, id: 'chill', scope: 'situational', at: now, last_at: now };
  return current ? { ...current, last_at: now } : null;
}

/** Reads, updates and stores the register for one owner turn. Storage failures keep the previous state. */
export async function socialTurn(storage, message, history = [], now = Date.now()) {
  let prev = null;
  try { prev = (await storage.get(SOCIAL_REGISTER_KEY)) || null; } catch (_) { return null; }
  const lastReply = [...(Array.isArray(history) ? history : [])].reverse().find((h) => h?.role === 'assistant')?.content || '';
  const reg = nextRegister(prev, message, { lastReply, now });
  try { if (reg) await storage.put(SOCIAL_REGISTER_KEY, reg); else if (prev) await storage.delete(SOCIAL_REGISTER_KEY); } catch (_) { /* the reply still follows the new state */ }
  return reg;
}

export async function readRegister(storage, now = Date.now()) {
  try { return activeRegister(await storage.get(SOCIAL_REGISTER_KEY), now); } catch (_) { return null; }
}

// The model's language line. Clean: no profanity at all, naturally, with no announcement and no guess about who is
// there. Otherwise the owner's adult default.
export function languageLine(reg) {
  return reg?.clean
    ? ' RIGHT NOW the owner asked you to keep it clean (someone may be nearby, or he wants it that way). Use clean, respectful, family-friendly language: no profanity, slurs, crude or sexual jokes, even if he or earlier messages swore; never repeat his swear words. Stay warm and natural. Do not announce a mode, do not mention who might be listening unless he does, and keep it clean until he says you can talk normal again.'
    : ' You may swear naturally back at the adult owner when it fits his tone, but do not force profanity, imitate slurs, threaten, harass, or let edgy language reduce accuracy.';
}

// ─── Live check (deploy and staging gate) ───
// Talks to the isolated test CHE (never the owner's) with the target's real model: profanity, then "Chill, chill, I'm by
// my mama", five more turns, "you can talk normal again", "I'm around kids right now", and a bare "chill chill" after a
// reply that swore. Each step checks the stored register and that the reply has no profanity and announces no mode.
export async function socialProbe(env, request, objectName) {
  const token = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '')?.[1] || '';
  const probe = env.CHE_STATE.getByName(objectName);
  const call = (path, body, device = '') => probe.fetch(new Request(`https://che.internal${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CHE-Memory-Probe': token, ...(device ? { Authorization: `Bearer ${device}` } : {}) },
    body: JSON.stringify(body),
  }));
  const paired = await (await call('/api/pair', { code: String(env.CHE_PAIR_CODE || ''), device_name: 'CHE social check' })).json().catch(() => ({}));
  const device = paired.device_token;
  if (!device) return { ok: false, error: 'The check could not pair with its test CHE.', steps: [] };
  const steps = [];
  let history = [];
  const say = async (message) => {
    const res = await call('/api/chat', { message, history }, device);
    const events = (await res.text()).split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    const reply = events.filter((e) => e.type === 'delta').map((e) => e.delta).join('').trim();
    history = [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }].slice(-12);
    const register = (await (await call('/api/social', {}, device)).json().catch(() => ({}))).register || null;
    return { status: res.status, reply, done, register };
  };
  const step = async (name, message, { clean, optional = false } = {}) => {
    const started = Date.now();
    const out = await say(message);
    const registerOk = clean === undefined || Boolean(out.register?.clean) === clean;
    const replyOk = !clean || (!hasProfanity(out.reply) && !announcesMode(out.reply));
    steps.push({ name, optional, pass: out.status === 200 && Boolean(out.reply) && registerOk && replyOk, ms: Date.now() - started, route: out.done.source || 'model', model_calls: out.done.model_calls ?? null, register: out.register ? `clean (${out.register.id}, ${out.register.scope})` : 'normal', reply: out.reply.slice(0, 400) });
  };
  try {
    await step('casual talk with profanity (baseline, any language allowed)', 'Bro this traffic was so fucking bad today, I almost lost my shit. Say something funny about it.', { clean: false, optional: true });
    await step('Test 1: "Chill, chill, I\'m by my mama." switches to clean language', "Chill, chill, I'm by my mama.", { clean: true });
    const five = ['So what should I cook for dinner tonight?', 'That traffic though, be real with me, how bad was it?', 'Give me a quick joke.', 'What do you think about people who cut in line?', 'Hype me up for tomorrow, I got a big day.'];
    for (const [i, message] of five.entries()) await step(`Test 5: clean language holds, turn ${i + 1} of 5`, message, { clean: true });
    await step('Test 2: "Alright, you can talk normal again." lifts it', 'Alright, you can talk normal again.', { clean: false });
    history = [];
    await step('Test 3: "I\'m around kids right now." switches to clean language', "I'm around kids right now.", { clean: true });
    await step('Test 3: the next turn stays clean', 'What should we do this weekend?', { clean: true });
    await step('lifting it again', 'They went to bed, you can talk normal again.', { clean: false });
    history = [{ role: 'user', content: 'that ref was terrible' }, { role: 'assistant', content: 'Man, that ref was straight-up shit tonight.' }];
    await step('Test 4: a bare "chill chill" right after CHE swore switches to clean language', 'chill chill', { clean: true });
  } finally {
    await call('/api/chat', { message: 'you can talk normal again', history: [] }, device).catch(() => null);
    await call('/api/security/revoke_self', {}, device).catch(() => null);
  }
  const required = steps.filter((s) => !s.optional);
  const passed = steps.filter((s) => s.pass).length;
  return { ok: required.every((s) => s.pass), passed, total: steps.length, steps };
}
