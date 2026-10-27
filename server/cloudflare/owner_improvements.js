// Owner Improvements (owner, 2026-10-23): "I should be able to tell CHE what feels wrong, and she should handle
// the improvement herself whenever technically possible."
//
// One ledger of owner-requested improvements, each with a real id, a status history, evidence and, for a
// preference change, the previous value kept for undo. It extends what already exists and adds no second
// router, planner, memory or agent:
// - A supported layout or look change is a typed preference from UI_CONFIG (an allow-list). It is stored here,
//   read back, sent to the iPhone in the reply's `ui_config`, applied there by CheUiPreferences with no new build,
//   and marked Verified only when the iPhone reports the value it applied (POST /api/owner/improvements/:id/applied).
// - Anything that needs code goes to CHE's existing coding pipeline (worker.selfDevelopmentReply: OpenCode or the
//   built-in team, then the che-update approval card, CI, merge and deploy). The task records the job id it returned,
//   or the real reason nothing started. Nothing here claims a job, commit, test or deploy that did not happen.
// - Money, live trading, security permissions, credentials, deleting and publishing are never auto-applied.
// - Nothing here runs on a schedule. Everything is deterministic: no model call decides a change.

export const IMPROVEMENTS_KEY = 'owner_improvements';
const MAX_TASKS = 200;

export const STATUSES = Object.freeze(['requested', 'investigating', 'configuring', 'coding', 'testing', 'awaiting_approval', 'verified', 'failed']);

// The preferences the iPhone app really consumes (lib/che_ui/che_ui_preferences.dart → applyOwnerConfig). A key
// that is not here is not configurable, and CHE says so.
export const UI_CONFIG = Object.freeze({
  'layout.density': {
    label: 'layout density', values: ['compact', 'comfortable', 'spacious'], default: 'comfortable',
    applies: 'the Trading Room, the Owner Improvements cards and the Office desks',
  },
  'chart.height': {
    label: 'chart size', values: ['compact', 'standard', 'tall'], default: 'standard',
    applies: 'the Trading Room chart',
  },
  'chart.orientation': {
    label: 'chart shape', values: ['follow_device', 'portrait'], default: 'follow_device',
    applies: 'the Trading Room chart: portrait makes it a tall chart while the iPhone is upright; nothing rotates the screen',
  },
  'status.success_color': {
    label: 'success color', values: ['mint', 'chrome_green', 'ice', 'silver'], default: 'mint',
    applies: 'finished-job banners and Verified cards (status always also has a word, never color alone)',
  },
  'text.size': {
    label: 'text size', values: ['small', 'default', 'large'], default: 'default',
    applies: 'all of CHE\'s text',
  },
});

const SPOKEN_VALUE = { follow_device: 'following the iPhone', chrome_green: 'chrome green', default: 'normal' };
const spokenValue = (v) => SPOKEN_VALUE[v] || String(v).replace(/_/g, ' ');

// ─── Understanding the owner's words ──────────────────────────────────────────────────────────────────────────

const clean = (raw) => String(raw || '').trim().toLowerCase().replace(/[’]/g, "'")
  .replace(/^(?:(?:hey|hi|ok|okay)[\s,]+)?(?:che|chay|chey|shay)[\s,.:!]+/, '')
  .replace(/^(?:please|can you|could you|would you)\s+/, '')
  .replace(/[.!?]+$/, '').trim();

// An app surface the owner can mean. A bare "room" is left out: "my room is too cramped" is a bedroom.
// Named rooms need their noun ("the home screen", never "my home").
const SURFACE = String.raw`(?:page|screen|layout|view|cards?|dashboard|tab|panel|app|(?:trading|brain|security|office|music|film|plan|meeting|chat|home|commands?|mailbox|workshop|studio|improvements?) (?:room|page|screen|tab))`;
const COLOR = String.raw`(chrome green|green|mint|ice(?: blue)?|blue|cyan|silver|grey|gray|red|amber|orange|yellow|purple|lilac|pink|white|gold)`;
const HIGH_IMPACT = /\b(?:live (?:trading|orders?|money|account)|real money|broker|buy|sell|pay|payment|order|subscribe|transfer|password|passcode|credential|api key|token|face ?id|permissions?|security (?:setting|rule|polic)|delete|remove|erase|wipe|publish|post (?:it|this) (?:to|on)|upload|deploy|merge)\b/;

const NAMED_SCREENS = [
  [/\btrading (?:room|page|screen)\b/, 'Trading Room'], [/\bbrain (?:room|page|screen)\b/, 'Brain Room'],
  [/\bsecurity (?:room|page|screen)\b/, 'Security'], [/\boffice\b/, 'Office'], [/\bhome (?:screen|page|tab)\b/, 'Home'],
  [/\bcommands? (?:page|screen|tab)\b/, 'Commands'], [/\bimprovements? (?:page|screen|room)\b/, 'Owner Improvements'],
];
const namedScreen = (t) => NAMED_SCREENS.find(([re]) => re.test(t))?.[1] || '';

/** The owner's improvement request, or null for every other sentence. Deterministic. */
export function improvementIntent(raw, { visualOpen = false } = {}) {
  const ask = parseImprovement(raw, { visualOpen });
  if (ask && ['set', 'code', 'diagnose', 'unsupported'].includes(ask.kind)) {
    const screen = namedScreen(clean(raw));
    if (screen) ask.screen = screen;
  }
  return ask;
}

function parseImprovement(raw, { visualOpen }) {
  const t = clean(raw);
  if (!t || t.length > 160) return null;
  const has = (re) => re.test(t);

  if (has(/^(?:open|show(?: me)?|go to) (?:the |my )?(?:owner )?improvements?(?: dashboard| page| board)?$/)) return { kind: 'open' };
  if (has(/^(?:what|which) improvements? (?:are|is) (?:open|pending|in progress|left)$|^(?:improvement|improvements) status$|^(?:read|list) (?:my |the )?(?:owner )?improvements$/)) return { kind: 'list' };
  if (has(/^(?:undo|revert|roll ?back) (?:that|it|the last) (?:change|improvement|layout change)$|^(?:undo|revert) (?:the |my )?last improvement$/)
    || (!visualOpen && has(/^(?:undo|revert) (?:that|it)$|^put it back(?: the way it was)?$/))) return { kind: 'undo', bare: !has(/change|improvement/) };

  // "Why does this feature keep failing?" — about CHE, never about the owner's car.
  const why = /^why (?:does|do|is|are|did|has|have) (.{0,60}?) (?:keep|keeps|still|always) (?:failing|breaking|crashing|freezing|not working|broken|wrong|stuck)$|^why (?:is|are) (.{0,60}?) (?:still )?(?:broken|failing)$/.exec(t);
  if (why) {
    const subject = (why[1] || why[2] || '').trim();
    if (/\b(?:this|that|the|my) (?:feature|page|screen|button|app|update|patch|chart|login|sign[- ]in|voice|mic|microphone|command|room|card|banner|feed)\b|\bche\b|\byou\b|\bit\b/.test(subject)) {
      return { kind: 'diagnose', area: areaOf(subject), words: raw.trim() };
    }
    return null;
  }

  // Remember a preference: only when it maps to a real setting; anything else stays with CHE's memory.
  const prefer = /^(?:(?:please )?remember (?:that )?)?i (?:prefer|like|want) (.+)$/.exec(t);
  if (prefer) {
    const want = preferenceFor(prefer[1]);
    return want ? { kind: 'set', ...want, remember: true, words: raw.trim() } : null;
  }

  // Colors for an outcome: "use chrome green for successful actions".
  const useColor = new RegExp(String.raw`^(?:use|make|show|set) ${COLOR} (?:for|on) (?:the |my )?(.{3,50})$`).exec(t);
  const makeColor = useColor ? null : new RegExp(String.raw`^make (?:the |my )?(.{3,50}?) ${COLOR}$`).exec(t);
  if (useColor || makeColor) {
    const [name, target] = useColor ? [useColor[1], useColor[2]] : [makeColor[2], makeColor[1]];
    const tgt = String(target || '');
    if (/\b(?:success(?:ful)?|succeeded|completed?|done|finished|passed|verified)\b/.test(tgt)) {
      const value = COLOR_VALUE[name];
      return value
        ? { kind: 'set', key: 'status.success_color', value, words: raw.trim() }
        : { kind: 'unsupported', what: `${name} for successful actions`, area: 'status_colors', words: raw.trim(), hint: 'success can be mint, chrome green, ice or silver' };
    }
    if (new RegExp(String.raw`\b${SURFACE}\b|\b(?:buttons?|text|headings?|titles?|failures?|errors?|warnings?|charts?|candles?|background|icons?)\b`).test(tgt)) {
      return { kind: 'unsupported', what: `${name} for ${tgt}`, area: 'colors', words: raw.trim() };
    }
    return null;
  }

  // Chart size: "make the chart smaller", "the chart is too big".
  const chartMake = /^(?:make|set|keep) (?:the |my |this )?(?:trading |live )?charts? (?:a (?:bit|little) )?(smaller|shorter|compact|bigger|larger|taller|tall|normal|standard)(?: size)?$/.exec(t);
  const chartToo = /^(?:the |this |my )?(?:trading |live )?charts? (?:is|are|looks?) (?:way |much |a bit |a little )?too (big|large|tall|small|short|tiny)$/.exec(t);
  if (chartMake || chartToo) {
    const step = chartToo ? (/big|large|tall/.test(chartToo[1]) ? -1 : 1)
      : /normal|standard/.test(chartMake[1]) ? 0 : /smaller|shorter|compact/.test(chartMake[1]) ? -1 : 1;
    return { kind: 'set', key: 'chart.height', step, words: raw.trim() };
  }

  // Density: "this page is too cramped" / "too much empty space".
  const cramped = new RegExp(String.raw`^(?:the |this |my )?${SURFACE} (?:is|are|feels?|looks?) (?:way |so |much |a bit |a little )?(?:too )?(cramped|crowded|cluttered|tight|squished|squeezed|busy|packed|spread out|sparse|empty|roomy)$`).exec(t)
    || /^(?:there(?:'s| is) )?too much (?:empty |white |wasted )?space(?: on (?:this|the) (?:page|screen))?$/.exec(t)?.concat('sparse');
  if (cramped) {
    const word = cramped[cramped.length - 1];
    return { kind: 'set', key: 'layout.density', step: /spread out|sparse|empty|roomy/.test(word) ? -1 : 1, area: 'layout', words: raw.trim() };
  }
  if (has(/^(?:make (?:the |this )?(?:page|screen|layout|app) )?(?:more )?(compact|spacious|roomier|denser|tighter)$/) && has(/page|screen|layout|app/)) {
    return { kind: 'set', key: 'layout.density', step: has(/compact|denser|tighter/) ? -1 : 1, words: raw.trim() };
  }
  if (has(/^(?:the )?text is (?:way |a bit |a little )?too (small|tiny|big|large)$/)) {
    return { kind: 'set', key: 'text.size', step: has(/small|tiny/) ? 1 : -1, words: raw.trim() };
  }

  // Code work: repeated information, navigation problems.
  if (has(/^stop (?:showing|repeating|displaying|saying) (?:me )?(?:the same|repeated|duplicate|duplicated) (?:info|information|cards?|status|messages?|things?)(?: on (?:this|the) .{1,30})?$/)
    || has(new RegExp(String.raw`^(?:there(?:'s| is| are) )?(?:too much )?(?:repeated|duplicate|duplicated) (?:info|information|cards?) on (?:this|the) ${SURFACE}$`))) {
    return { kind: 'code', area: 'repetition', words: raw.trim() };
  }
  if (has(/^fix (?:this|the|that) navigation(?: problem| bug| issue)?$|^(?:the )?navigation (?:is )?(?:broken|confusing|wrong)$|^(?:the )?back button (?:is broken|doesn't work|does not work)$/)) {
    return { kind: 'code', area: 'navigation', words: raw.trim() };
  }
  return null;
}

const COLOR_VALUE = { 'chrome green': 'chrome_green', green: 'chrome_green', mint: 'mint', ice: 'ice', 'ice blue': 'ice', blue: 'ice', cyan: 'ice', silver: 'silver', grey: 'silver', gray: 'silver' };

function preferenceFor(what) {
  const w = String(what || '');
  if (/\bportrait charts?\b|\bcharts? (?:in )?portrait\b|\btall(?:er)? charts?\b|\bvertical charts?\b/.test(w)) return { key: 'chart.orientation', value: 'portrait', area: 'chart' };
  if (/\b(?:smaller|compact) charts?\b/.test(w)) return { key: 'chart.height', value: 'compact', area: 'chart' };
  if (/\b(?:bigger|larger|tall) charts?\b/.test(w)) return { key: 'chart.height', value: 'tall', area: 'chart' };
  if (/\bcompact (?:layouts?|pages?|screens?|cards?)\b/.test(w)) return { key: 'layout.density', value: 'compact', area: 'layout' };
  if (/\b(?:spacious|roomy|roomier) (?:layouts?|pages?|screens?|cards?)\b/.test(w)) return { key: 'layout.density', value: 'spacious', area: 'layout' };
  if (/\b(?:bigger|larger) text\b/.test(w)) return { key: 'text.size', value: 'large', area: 'text' };
  return null;
}

function areaOf(subject) {
  const s = String(subject || '');
  for (const [area, re] of [['chart', /chart|candle/], ['voice', /voice|mic|speak|listen/], ['login', /log ?in|sign[- ]?in|face ?id|pair/], ['update', /update|patch|build/], ['navigation', /navigation|back|menu|tab/], ['trading', /trad|feed|rithmic|alpaca/], ['layout', /page|screen|card|layout/]]) {
    if (re.test(s)) return area;
  }
  return 'feature';
}

// Screens (CheScreenReport.page) that read layout.density today.
export const DENSITY_SCREENS = new Set(['Trading Room', 'Owner Improvements', 'Office']);

const AREA_OF_KEY = { 'layout.density': 'layout', 'chart.height': 'chart', 'chart.orientation': 'chart', 'status.success_color': 'status_colors', 'text.size': 'text' };

// ─── The ledger ───────────────────────────────────────────────────────────────────────────────────────────────

export async function loadImprovements(storage) {
  const saved = await Promise.resolve().then(() => storage.get(IMPROVEMENTS_KEY)).catch(() => null);
  return {
    config: { values: {}, rev: 0, updated_at: null, ...(saved?.config || {}) },
    tasks: Array.isArray(saved?.tasks) ? saved.tasks : [],
    seq: Number(saved?.seq || 0),
  };
}

async function save(storage, state) {
  state.tasks = state.tasks.slice(0, MAX_TASKS);
  await storage.put(IMPROVEMENTS_KEY, state);
}

/** The configured value, or the key's default. */
export const configValue = (config, key) => (config.values && key in config.values ? config.values[key] : UI_CONFIG[key]?.default);

export function validConfigValue(key, value) {
  return Boolean(UI_CONFIG[key]) && UI_CONFIG[key].values.includes(value);
}

function newTask(state, { request, area, kind, screen, now }) {
  state.seq += 1;
  const at = new Date(now).toISOString();
  const day = at.slice(0, 10).replace(/-/g, '');
  const task = {
    id: `imp-${day}-${String(state.seq).padStart(3, '0')}`,
    request: String(request || '').slice(0, 400),
    area, kind, screen: String(screen || '').slice(0, 60),
    status: 'requested', created_at: at, updated_at: at,
    history: [{ at, status: 'requested', note: 'Owner request received.' }],
    evidence: [], change: null, undo: { available: false }, job_id: null, acceptance: [], related: [],
  };
  state.tasks.unshift(task);
  return task;
}

function move(task, status, note, now) {
  const at = new Date(now).toISOString();
  task.status = status;
  task.updated_at = at;
  task.history.push({ at, status, note: String(note || '').slice(0, 300) });
}

/** Earlier tasks about the same area (and screen, when known): what was tried and how it ended. */
export function relatedTasks(state, area, screen = '') {
  return state.tasks.filter((t) => t.area === area && (!screen || !t.screen || t.screen === screen));
}

function triedSummary(prior) {
  if (!prior.length) return '';
  const last = prior[0];
  const tried = last.change ? `I changed ${UI_CONFIG[last.change.key]?.label || last.change.key} from ${spokenValue(last.change.from)} to ${spokenValue(last.change.to)}` : last.job_id ? `I opened coding job ${String(last.job_id).slice(0, 8)}` : 'I recorded it';
  return `You raised this ${prior.length === 1 ? 'once before' : `${prior.length} times before`}: ${last.id}, where ${tried}; it is ${spokenStatus(last.status)}. `;
}

export const spokenStatus = (s) => ({ awaiting_approval: 'awaiting your approval', failed: 'failed, blocked or undone', testing: 'waiting for your iPhone to confirm it', requested: 'logged, not started' }[s] || s);

// ─── Acting on it ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Handles one improvement request. `delegate(request)` sends a coding task to CHE's existing coding pipeline and
 * returns { ok, job_id, text } from what that pipeline really said.
 */
export async function handleImprovement(storage, ask, { screen: active = '', now = Date.now(), delegate = null } = {}) {
  const screen = ask.screen || String(active || '').trim();
  const state = await loadImprovements(storage);
  const where = screen ? ` on ${screen}` : '';

  if (ask.kind === 'open') return { text: 'Opening Owner Improvements.', fields: { open_screen: 'owner_improvements' }, ok: true };
  if (ask.kind === 'list') return { text: speakList(state), fields: { improvements: summary(state) }, ok: true };
  if (ask.kind === 'undo') return undoLast(storage, state, { now, bare: ask.bare });

  if (ask.kind === 'unsupported') {
    const task = newTask(state, { request: ask.words, area: ask.area, kind: 'code', screen, now });
    task.acceptance = [`Owner can set ${ask.what} by voice or typing.`, 'The setting applies without a new build and can be undone.'];
    move(task, 'requested', `Not configurable today${ask.hint ? ` (${ask.hint})` : ''}.`, now);
    await save(storage, state);
    return { ok: false, task, text: `That isn't configurable yet${ask.hint ? `: ${ask.hint}` : ''}. I logged it as ${task.id}. I can open a coding task for it: say "start coding task ${task.id}".` };
  }

  if (ask.kind === 'diagnose') return diagnose(storage, state, ask, { screen, now });
  if (ask.kind === 'code' && !screen) {
    // Which screen is the one thing an engineer cannot guess; asking is cheaper than a wasted coding run.
    const task = newTask(state, { request: ask.words, area: ask.area, kind: 'code', screen, now });
    task.acceptance = acceptanceFor(ask.area, ask.words, '');
    move(task, 'requested', 'Waiting for the owner to say which screen.', now);
    await save(storage, state);
    return { ok: true, task, text: `${triedSummary(relatedTasks(state, ask.area).filter((p) => p.id !== task.id))}Which screen is it on? I logged it as ${task.id}. Say it again from that screen, or say "start coding task ${task.id}" to send it to my engineers as it is.` };
  }
  if (ask.kind === 'code') return codeTask(storage, state, { request: ask.words, area: ask.area, screen, now, delegate, prior: relatedTasks(state, ask.area, screen) });

  if (ask.kind === 'set') {
    const key = ask.key;
    const area = ask.area || AREA_OF_KEY[key] || 'layout';
    // The same complaint: this setting, or an earlier request about the area that changed no setting.
    const prior = relatedTasks(state, area, screen).filter((t) => !t.change || t.change.key === key);
    const spec = UI_CONFIG[key];
    if (key === 'layout.density' && screen && !DENSITY_SCREENS.has(screen)) {
      return codeTask(storage, state, { request: ask.words, area, screen, now, delegate, prior,
        reason: `the ${screen} screen does not read the layout density setting yet, so changing it would not help there` });
    }
    const from = configValue(state.config, key);
    let to = ask.value;
    if (!to) {
      const i = spec.values.indexOf(from);
      to = ask.step === 0 ? spec.default : spec.values[Math.max(0, Math.min(spec.values.length - 1, i + ask.step))];
    }
    if (to === from) {
      // The setting is already as far as it goes: saying it again would change nothing, so the earlier approach
      // is not repeated. A step that cannot move becomes a coding task with the reason written down.
      if (ask.remember) {
        const task = newTask(state, { request: ask.words, area, kind: 'config', screen, now });
        task.change = { key, from, to };
        task.evidence.push(`Stored ${key} = ${to} (unchanged; already set).`);
        move(task, 'verified', `Already ${spokenValue(to)}; kept as your preference.`, now);
        await save(storage, state);
        return { ok: true, task, text: `${triedSummary(prior.filter((p) => p.id !== task.id))}It is already ${spokenValue(to)}, and I'll keep it that way: ${task.id}.`, fields: { ui_config: uiConfigPayload(state, task) } };
      }
      return codeTask(storage, state, {
        request: ask.words, area, screen, now, delegate, prior,
        reason: `${spec.label} is already ${spokenValue(from)}, the ${ask.step < 0 ? 'smallest' : 'largest'} setting${where}, so another setting change would not fix it`,
      });
    }

    const task = newTask(state, { request: ask.words, area, kind: 'config', screen, now });
    task.related = prior.map((p) => p.id).slice(0, 5);
    move(task, 'configuring', `Changing ${key} from ${from} to ${to}.`, now);
    state.config.values = { ...state.config.values, [key]: to };
    state.config.rev += 1;
    state.config.updated_at = new Date(now).toISOString();
    task.change = { key, from, to, rev: state.config.rev };
    await save(storage, state);

    // Verify: read the stored value back. A mismatch reverts it and says so.
    const stored = configValue((await loadImprovements(storage)).config, key);
    if (stored !== to) {
      const back = await loadImprovements(storage);
      back.config.values = { ...back.config.values, [key]: from };
      const t2 = back.tasks.find((x) => x.id === task.id);
      if (t2) move(t2, 'failed', `Read back ${stored}, expected ${to}; reverted to ${from}.`, now);
      await save(storage, back);
      return { ok: false, task: t2, text: `I tried to change the ${spec.label}, but reading it back gave ${spokenValue(stored)}, so I put it back to ${spokenValue(from)}. Nothing else changed. ${task.id} is marked failed.` };
    }
    const fresh = await loadImprovements(storage);
    const saved = fresh.tasks.find((x) => x.id === task.id);
    saved.evidence.push(`Stored and read back: ${key} = ${stored} (config revision ${fresh.config.rev}).`);
    saved.undo = { available: true, key, to: from };
    move(saved, 'testing', 'Stored and read back. Waiting for the iPhone to report that it applied it.', now);
    await save(storage, fresh);
    const recurring = prior.length ? triedSummary(prior) : '';
    return {
      ok: true, task: saved,
      text: `${recurring}Done. I set the ${spec.label} from ${spokenValue(from)} to ${spokenValue(to)}${where ? '' : ''}. I read it back: ${spokenValue(stored)}. It applies to ${spec.applies}. ${ask.remember ? 'I saved it as your preference. ' : ''}Your iPhone applies it now; ${saved.id} turns Verified when the app confirms. Say "undo that" to put it back.`,
      fields: { ui_config: uiConfigPayload(fresh, saved) },
    };
  }
  return { ok: false, text: 'I could not tell what to change. Nothing was changed.' };
}

export function uiConfigPayload(state, task = null) {
  return { rev: state.config.rev, values: { ...state.config.values }, ...(task ? { task_id: task.id } : {}) };
}

async function undoLast(storage, state, { now, bare }) {
  const task = state.tasks.find((t) => t.undo?.available && t.change);
  // A bare "undo that" only reaches here for a change made in the last 15 minutes; older needs "undo the last change".
  if (!task || (bare && now - Date.parse(task.updated_at) > 15 * 60_000)) {
    return bare ? null : { ok: false, text: 'There is no setting change left to undo. Nothing was changed.' };
  }
  return undoTask(storage, task.id, { now, state });
}

/** Puts one task's setting back to its previous value (the dashboard's Undo button and "undo that"). */
export async function undoTask(storage, id, { now = Date.now(), state = null } = {}) {
  const st = state || await loadImprovements(storage);
  const task = st.tasks.find((t) => t.id === id);
  if (!task || !task.undo?.available || !task.change) return { ok: false, text: `${id} has nothing to undo. Nothing was changed.` };
  const { key, to } = task.undo;
  const before = configValue(st.config, key);
  st.config.values = { ...st.config.values, [key]: to };
  st.config.rev += 1;
  st.config.updated_at = new Date(now).toISOString();
  task.undo = { available: false };
  task.evidence.push(`Undone: ${key} back to ${to} (config revision ${st.config.rev}).`);
  move(task, 'failed', `Undone by the owner: ${key} returned to ${to}.`, now);
  await save(storage, st);
  const read = configValue((await loadImprovements(storage)).config, key);
  return {
    ok: read === to, task,
    text: read === to
      ? `Undone. The ${UI_CONFIG[key].label} is back to ${spokenValue(to)} from ${spokenValue(before)}; I read it back. ${task.id} is closed as undone.`
      : `I could not undo it: reading the ${UI_CONFIG[key].label} back gave ${spokenValue(read)}.`,
    fields: { ui_config: uiConfigPayload(st, task) },
  };
}

async function diagnose(storage, state, ask, { screen, now }) {
  const prior = relatedTasks(state, ask.area, screen);
  const failed = prior.filter((t) => t.status === 'failed');
  const task = newTask(state, { request: ask.words, area: ask.area, kind: 'diagnose', screen, now });
  task.related = prior.map((p) => p.id).slice(0, 10);
  task.evidence = prior.slice(0, 5).map((p) => `${p.id} (${p.status}): ${p.request}${p.job_id ? ` — job ${String(p.job_id).slice(0, 8)}` : ''}`);
  move(task, 'investigating', prior.length ? `Found ${prior.length} earlier report(s) for ${ask.area}.` : `No earlier report recorded for ${ask.area}.`, now);
  await save(storage, state);
  if (!prior.length) {
    return { ok: true, task, text: `I have no recorded failure for that${screen ? ` on ${screen}` : ''} yet, so I won't guess at a cause. I opened ${task.id} to investigate. Tell me what you saw happen, or send a screenshot, and I'll trace it.` };
  }
  return {
    ok: true, task,
    text: `${triedSummary(prior)}${failed.length ? `${failed.length} of those ended failed or blocked. ` : ''}I have not verified a root cause yet, so I won't call it fixed. I opened ${task.id} with that history. Say "start coding task ${task.id}" and my engineers will trace it from the evidence instead of repeating the same fix.`,
  };
}

/** Sends a task to the existing coding pipeline and records exactly what it answered. */
export async function codeTask(storage, state, { request, area, screen, now, delegate, prior = [], reason = '', task = null, approved = false }) {
  const t = task || newTask(state, { request, area, kind: 'code', screen, now });
  t.kind = 'code';
  t.related = [...new Set([...(t.related || []), ...prior.map((p) => p.id)])].slice(0, 10);
  t.acceptance = t.acceptance?.length ? t.acceptance : acceptanceFor(area, request, screen);
  if (reason) t.evidence.push(`Why code: ${reason}.`);
  const tried = prior.filter((p) => p.id !== t.id).slice(0, 3).map((p) => `${p.id} (${p.status})${p.change ? ` changed ${p.change.key} ${p.change.from}→${p.change.to}` : ''}`);
  const brief = [
    `Update your code: ${request}${screen ? ` (owner was on the ${screen} screen)` : ''}.`,
    `Owner improvement ${t.id}.`,
    reason ? `Why a setting cannot fix it: ${reason}.` : '',
    tried.length ? `Earlier attempts, do not repeat them: ${tried.join('; ')}.` : '',
    `Acceptance criteria: ${t.acceptance.map((a, i) => `${i + 1}) ${a}`).join(' ')}`,
    'Keep the chrome HUD look, VoiceOver labels and voice routes. Passive screens stay silent.',
  ].filter(Boolean).join(' ');
  t.brief = brief.slice(0, 2000);
  if (!approved && HIGH_IMPACT.test(String(request).toLowerCase())) {
    move(t, 'awaiting_approval', 'Touches money, trading, security, credentials, deleting or publishing: never started or applied automatically.', now);
    await save(storage, state);
    return { ok: false, task: t, text: `I logged ${t.id}, but I did not start it: it touches money, live trading, security, credentials, deleting or publishing, and those never change automatically. Say "start coding task ${t.id}" to approve sending it to my engineers; any PR still waits for your approval and its checks.` };
  }
  if (!delegate) {
    move(t, 'coding', 'Coding — awaiting an engineer: no coding pipeline is reachable from here.', now);
    await save(storage, state);
    return { ok: false, task: t, text: `${triedSummary(prior.filter((p) => p.id !== t.id))}${reason ? `${cap(reason)}. ` : ''}This needs a code change. I wrote it up as ${t.id} with acceptance criteria, but no coding engineer is reachable right now, so it waits under Coding.` };
  }
  await save(storage, state);
  const sent = await Promise.resolve().then(() => delegate(brief)).catch((error) => ({ ok: false, text: String(error?.message || error) }));
  const fresh = await loadImprovements(storage);
  const saved = fresh.tasks.find((x) => x.id === t.id) || t;
  if (sent?.job_id) {
    saved.job_id = String(sent.job_id);
    saved.evidence.push(`Coding pipeline accepted job ${saved.job_id}.`);
    move(saved, 'coding', `Sent to the coding pipeline as job ${String(saved.job_id).slice(0, 8)}.`, now);
  } else {
    // No job id means no job to track: the task is blocked, with the pipeline's own words as the reason.
    saved.evidence.push(`Coding pipeline answered: ${String(sent?.text || 'no answer').slice(0, 240)}`);
    move(saved, 'failed', 'Blocked: the coding pipeline did not start a trackable job.', now);
  }
  await save(storage, fresh);
  const lead = `${triedSummary(prior.filter((p) => p.id !== t.id))}${reason ? `${cap(reason)}. ` : ''}`;
  return {
    ok: Boolean(sent?.ok), task: saved, job_id: saved.job_id,
    text: saved.job_id
      ? `${lead}This needs a code change, so I opened ${saved.id} and sent it to my engineers as job ${String(saved.job_id).slice(0, 8)}, with acceptance criteria. I'll only call it done after its checks pass and it is deployed. ${String(sent.text || '').slice(0, 300)}`.trim()
      : `${lead}This needs a code change. I logged ${saved.id} with acceptance criteria, but the coding pipeline did not start a job: ${String(sent?.text || 'no answer').slice(0, 240)}`,
  };
}

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

function acceptanceFor(area, request, screen) {
  const on = screen ? `the ${screen} screen` : 'the screen the owner named';
  const base = {
    repetition: [`Each fact appears once on ${on}; repeated cards or status lines are merged.`, 'No information the owner relies on is lost.'],
    navigation: [`Going to and back from ${on} returns to where the owner was.`, 'Every step has a voice route and VoiceOver label.'],
    layout: [`${cap(on)} is readable at standard and large text without clipping.`, 'Cards keep the chrome HUD look.'],
    chart: ['The chart size the owner asked for is reachable and remembered.', 'The chart never forces a landscape rotation.'],
  }[area] || [`The owner's request "${String(request).slice(0, 120)}" is met on ${on}.`];
  return [...base, 'A test reproduces the problem and passes after the fix.', 'Required CI checks pass before merge; the deploy is verified.'];
}

/** "Start coding task imp-…": sends a logged task to the coding pipeline. */
export function startTaskIntent(raw) {
  const m = /^(?:start|open|run) (?:the )?coding task (imp-\d{8}-\d{3})$/.exec(clean(raw));
  return m ? { kind: 'start', id: m[1] } : null;
}

export async function startLoggedTask(storage, id, { now = Date.now(), delegate = null } = {}) {
  const state = await loadImprovements(storage);
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return { ok: false, text: `I have no improvement called ${id}. Nothing was started.` };
  if (task.job_id) return { ok: true, task, text: `${id} is already with my engineers as job ${String(task.job_id).slice(0, 8)}; it is ${spokenStatus(task.status)}.` };
  return codeTask(storage, state, { request: task.request, area: task.area, screen: task.screen, now, delegate, task, approved: true, prior: relatedTasks(state, task.area, task.screen) });
}

/** The iPhone reports what it applied. Matching values mark the task Verified; a mismatch reverts. */
export async function recordApplied(storage, id, report, { now = Date.now() } = {}) {
  const state = await loadImprovements(storage);
  const task = state.tasks.find((t) => t.id === id);
  if (!task || !task.change) return { status: 404, body: { detail: 'No such configuration improvement.' } };
  const applied = report && typeof report.applied === 'object' ? report.applied : {};
  const got = applied[task.change.key];
  const build = String(report?.build || '').slice(0, 80);
  if (task.status !== 'testing') return { status: 200, body: { ok: true, status: task.status, unchanged: true } };
  if (got === task.change.to) {
    task.evidence.push(`iPhone applied ${task.change.key} = ${got}${build ? ` (${build})` : ''} at ${new Date(now).toISOString()}.`);
    move(task, 'verified', 'The iPhone reported the applied value.', now);
  } else {
    // Validation failed on the phone: the stored value goes back, and the task says why.
    state.config.values = { ...state.config.values, [task.change.key]: task.change.from };
    state.config.rev += 1;
    state.config.updated_at = new Date(now).toISOString();
    task.undo = { available: false };
    task.evidence.push(`iPhone reported ${task.change.key} = ${got ?? 'nothing'}; expected ${task.change.to}. Reverted to ${task.change.from}.`);
    move(task, 'failed', 'The iPhone did not apply the value; reverted.', now);
  }
  await save(storage, state);
  return { status: 200, body: { ok: task.status === 'verified', status: task.status, task, ui_config: uiConfigPayload(state) } };
}

/** The tasks with job states read from the real job queue. */
export function withJobStates(tasks, jobs = []) {
  const byId = new Map((Array.isArray(jobs) ? jobs : []).map((j) => [String(j.id), j]));
  return tasks.map((t) => {
    const job = t.job_id ? byId.get(String(t.job_id)) : null;
    if (!job || !['coding', 'testing'].includes(t.status)) return { ...t, job_status: job?.status || null };
    const next = ['queued', 'running'].includes(job.status) ? 'coding'
      : job.status === 'failed' || job.dead_letter ? 'failed'
        : job.status === 'done' || job.status === 'completed' ? 'awaiting_approval' : t.status;
    return { ...t, status: next, job_status: job.status };
  });
}

export function summary(state) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const t of state.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  return { counts, total: state.tasks.length };
}

function speakList(state) {
  const open = state.tasks.filter((t) => !['verified', 'failed'].includes(t.status));
  if (!state.tasks.length) return 'There are no owner improvements yet. Tell me what feels wrong and I\'ll take it from there.';
  if (!open.length) return `All ${state.tasks.length} improvements are closed: ${summary(state).counts.verified} verified, ${summary(state).counts.failed} failed or undone.`;
  return `${open.length} improvement${open.length === 1 ? ' is' : 's are'} open: ${open.slice(0, 5).map((t, i) => `${i + 1}. ${t.id}, ${t.request.slice(0, 60)}, ${spokenStatus(t.status)}`).join('; ')}.`;
}
