// CHE's connected world: one activity feed of what CHE and the Office really
// did, a "find anything" search across every room (agent work, Art Studio
// images, projects, vault items, background jobs, War Room plans), and a
// one-line greeting built only from real state. Nothing here invents work.

const clip = (text, max) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

// 3–6 word summary for glanceable titles and spoken lists.
export function shortTitle(text, maxWords = 6) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const clause = /^(.{12,}?)[.;:!?]/.exec(clean);
  const words = (clause ? clause[1] : clean).split(' ').filter(Boolean);
  return words.length <= maxWords ? words.join(' ') : `${words.slice(0, maxWords).join(' ')}…`;
}

const DONE = new Set(['complete', 'completed', 'done', 'succeeded']);

// Every real thing CHE or the Office made, as one searchable list.
export function creations(data, media = [], origin = '') {
  const items = [];
  for (const t of data.team_tasks || []) {
    if (!DONE.has(t.status) || !t.result) continue;
    items.push({
      kind: 'agent_work', id: t.id, maker: t.partner_name || 'An agent', title: shortTitle(t.task),
      text: clip(t.result, 1200), about: `${t.task} ${t.result}`, at: t.updated_at || t.created_at,
    });
  }
  for (const m of media) {
    items.push({
      kind: 'image', id: m.id, maker: m.engine === 'Your image connector' ? 'Your image connector' : 'CHE Art Studio',
      title: shortTitle(m.title || m.prompt), text: clip(m.prompt, 300), about: `${m.title} ${m.prompt} image picture art`,
      at: m.created_at, media_type: 'image',
      media_url: m.url || (origin ? `${origin}/api/media/${m.id}/image` : ''),
    });
  }
  for (const p of data.projects || []) {
    items.push({
      kind: 'project', id: p.id, maker: 'CHE', title: shortTitle(p.title), text: clip(p.brief || p.content || '', 600),
      about: `${p.title} ${p.type} ${p.brief || ''}`, at: p.updated_at || p.created_at,
    });
  }
  for (const v of data.vault_items || []) {
    items.push({
      kind: 'vault', id: v.id, maker: 'CHE', title: shortTitle(v.name), text: clip(v.content, 600),
      about: `${v.name} ${v.kind} ${v.content}`, at: v.updated_at || v.created_at,
    });
  }
  for (const j of data.jobs || []) {
    if (!DONE.has(j.status) || !j.result) continue;
    items.push({
      kind: 'job', id: j.id, maker: 'CHE', title: shortTitle(j.title || j.prompt), text: clip(j.result, 1200),
      about: `${j.title} ${j.prompt} ${j.result}`, at: j.updated_at || j.created_at,
    });
  }
  for (const m of data.meetings || []) {
    if (!m.final_plan) continue;
    items.push({
      kind: 'war_room', id: m.id, maker: 'The War Room', title: shortTitle(m.objective), text: clip(m.final_plan, 1200),
      about: `${m.objective} ${m.final_plan} plan meeting`, at: m.updated_at || m.created_at,
    });
  }
  return items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

const STOP = new Set(['the', 'a', 'an', 'my', 'that', 'which', 'who', 'made', 'make', 'created', 'wrote', 'did', 'by', 'from',
  'play', 'show', 'open', 'find', 'me', 'get', 'read', 'of', 'for', 'it', 'one', 'thing', 'please', 'che', 'chay',
  'what', 'finished', 'done', 'drew', 'did']);

const tokens = (text) => String(text || '').toLowerCase().split(/[^a-z0-9']+/).filter((w) => w && !STOP.has(w));

// "play the song Mira made" → ranked matches; maker names weigh most.
export function findCreations(data, media, query, origin = '') {
  const words = tokens(query);
  if (!words.length) return [];
  const agentNames = new Set((data.team || []).map((a) => String(a.name || '').toLowerCase()).filter(Boolean));
  const scored = [];
  for (const item of creations(data, media, origin)) {
    const maker = item.maker.toLowerCase();
    const about = new Set(tokens(`${item.title} ${item.about}`));
    let score = 0;
    for (const w of words) {
      if (agentNames.has(w) || maker.split(' ').includes(w)) score += maker.split(' ').includes(w) ? 5 : -2;
      else if (about.has(w)) score += 2;
      else if ([...about].some((a) => a.length > 3 && (a.startsWith(w) || w.startsWith(a)))) score += 1;
    }
    if (score > 0) scored.push({ ...item, score });
  }
  return scored.sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at))).slice(0, 8)
    .map(({ about, score, ...rest }) => rest);
}

const STALL_MS = 45 * 60 * 1000;

function ageMs(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Date.now() - t : 0;
}

export function stalledTasks(data) {
  const out = [];
  for (const t of data.team_tasks || []) {
    if (!['running', 'queued', 'blocked', 'waiting'].includes(t.status)) continue;
    const blob = `${t.task || ''} ${t.result || ''} ${t.blocker || ''}`;
    const waitingOnOwner = /need(s)? (you|the owner|approval|a decision)/i.test(blob);
    const stale = ageMs(t.updated_at || t.created_at) > STALL_MS;
    if (t.status === 'blocked' || waitingOnOwner || stale) {
      out.push({
        id: t.id,
        who: t.partner_name || 'An agent',
        title: shortTitle(t.task),
        reason: waitingOnOwner ? 'needs your decision' : t.status === 'blocked' ? 'blocked' : 'no update in a while',
        at: t.updated_at || t.created_at,
      });
    }
  }
  return out.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
}

export function decisionsNeeded(data) {
  return stalledTasks(data).filter((s) => s.reason === 'needs your decision');
}

export function nextActions(data) {
  const actions = [];
  const decide = decisionsNeeded(data)[0];
  if (decide) actions.push('Decide on "' + decide.title + '" for ' + decide.who);
  const stall = stalledTasks(data).find((s) => s.reason !== 'needs your decision');
  if (stall) actions.push('Check in on ' + stall.who + ' — "' + stall.title + '" is ' + stall.reason);
  const done = (data.team_tasks || []).find((t) => DONE.has(t.status));
  if (done) actions.push('Read what ' + (done.partner_name || 'the Office') + ' finished');
  const project = (data.projects || [])[0];
  if (project) actions.push("What's next on " + shortTitle(project.title, 4) + '?');
  return actions.slice(0, 3);
}

// One activity feed, newest first.
export function activityFeed(data, media = [], origin = '', limit = 30) {
  const events = [];
  for (const s of stalledTasks(data)) {
    events.push({ at: s.at, who: s.who, kind: 'stalled', id: s.id, line: s.who + ' is stalled on "' + s.title + '" (' + s.reason + ').' });
  }
  for (const t of data.team_tasks || []) {
    const who = t.partner_name || 'An agent';
    const title = shortTitle(t.task);
    let line = '';
    if (DONE.has(t.status)) line = who + ' finished "' + title + '".';
    else if (t.status === 'running') line = who + ' is working on "' + title + '".';
    else if (t.status === 'queued') line = who + ' has "' + title + '" next.';
    else if (t.status === 'failed') line = who + ' could not finish "' + title + '".';
    if (line) events.push({ at: t.updated_at || t.created_at, who, line, kind: 'agent_task', id: t.id });
  }
  for (const m of data.meetings || []) {
    events.push({
      at: m.updated_at || m.created_at, who: 'War Room', kind: 'meeting', id: m.id,
      line: m.final_plan
        ? 'The War Room made a plan for "' + shortTitle(m.objective) + '".'
        : 'The War Room is meeting on "' + shortTitle(m.objective) + '".',
    });
  }
  for (const m of media) {
    events.push({ at: m.created_at, who: 'Art Studio', kind: 'image', id: m.id, line: 'Art Studio made "' + shortTitle(m.title || m.prompt) + '".' });
  }
  for (const j of data.jobs || []) {
    const title = shortTitle(j.title || j.prompt);
    let line = '';
    if (DONE.has(j.status)) line = 'CHE finished "' + title + '".';
    else if (j.status === 'queued' || j.status === 'running') line = 'CHE is working on "' + title + '".';
    else if (j.status === 'failed') line = 'CHE could not finish "' + title + '".';
    if (line) events.push({ at: j.updated_at || j.created_at, who: 'CHE', kind: 'job', id: j.id, line });
  }
  for (const p of data.projects || []) {
    events.push({ at: p.created_at, who: 'CHE', kind: 'project', id: p.id, line: 'CHE started the project "' + shortTitle(p.title) + '".' });
  }
  return events.filter((e) => e.at).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

function timeSuggestion(hour) {
  if (hour < 5) return 'Up late? I can wind down with some music.';
  if (hour < 11) return 'Want me to plan your day?';
  if (hour < 14) return 'Want a quick midday check of your top project?';
  if (hour < 18) return 'Want me to put the team on your next big task?';
  if (hour < 22) return 'Want to watch something together in the Theater?';
  return 'Want a quick recap of today before bed?';
}

function partOfDay(hour) {
  if (hour < 5) return 'Hey night owl';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

// One short greeting line from real state: what finished, what's next, or
// one suggestion for the time of day.
export function greeting(data, media = [], { hour = 12, since = '' } = {}) {
  const h = Number.isFinite(Number(hour)) ? Math.max(0, Math.min(23, Number(hour))) : 12;
  const hello = partOfDay(h);
  const decide = decisionsNeeded(data)[0];
  if (decide) return { line: hello + '! ' + decide.who + ' needs you on "' + decide.title + '".', kind: 'decision' };
  const stall = stalledTasks(data)[0];
  if (stall) return { line: hello + '! ' + stall.who + ' is stalled on "' + stall.title + '".', kind: 'stalled' };
  const tasks = data.team_tasks || [];
  const finished = tasks.filter((t) => DONE.has(t.status) && (!since || String(t.updated_at || '') > since));
  if (finished.length) {
    const t = finished[0];
    const more = finished.length > 1 ? ' and ' + (finished.length - 1) + ' more' : '';
    return { line: hello + '! ' + (t.partner_name || 'The Office') + ' finished "' + shortTitle(t.task, 5) + '"' + more + '. Want to hear it?', kind: 'finished' };
  }
  const running = tasks.find((t) => t.status === 'running' || t.status === 'queued');
  if (running) return { line: hello + '! ' + (running.partner_name || 'The Office') + ' is on "' + shortTitle(running.task, 5) + '". ' + timeSuggestion(h), kind: 'working' };
  const plan = (data.meetings || []).find((m) => m.final_plan && (!since || String(m.updated_at || '') > since));
  if (plan) return { line: hello + '! The War Room has a plan for "' + shortTitle(plan.objective, 5) + '". Want it?', kind: 'plan' };
  return { line: hello + '! ' + timeSuggestion(h), kind: 'suggestion' };
} = {}) {
  const h = Number.isFinite(Number(hour)) ? Math.max(0, Math.min(23, Number(hour))) : 12;
  const hello = partOfDay(h);
  const tasks = data.team_tasks || [];
  const finished = tasks.filter((t) => DONE.has(t.status) && (!since || String(t.updated_at || '') > since));
  if (finished.length) {
    const t = finished[0];
    const more = finished.length > 1 ? ` and ${finished.length - 1} more thing${finished.length > 2 ? 's' : ''}` : '';
    return { line: `${hello}! ${t.partner_name || 'The Office'} finished “${shortTitle(t.task, 5)}”${more}. Want to hear it?`, kind: 'finished' };
  }
  const running = tasks.find((t) => t.status === 'running' || t.status === 'queued');
  if (running) {
    return { line: `${hello}! ${running.partner_name || 'The Office'} is on “${shortTitle(running.task, 5)}”. ${timeSuggestion(h)}`, kind: 'working' };
  }
  const plan = (data.meetings || []).find((m) => m.final_plan && (!since || String(m.updated_at || '') > since));
  if (plan) return { line: `${hello}! The War Room has a plan for “${shortTitle(plan.objective, 5)}”. Want it?`, kind: 'plan' };
  return { line: `${hello}! ${timeSuggestion(h)}`, kind: 'suggestion' };
}

// Three smart suggestions: real follow-ups first, then time of day.
export function suggestions(data, { hour = 12 } = {}) {
  const out = nextActions(data);
  if ((data.team || []).some((a) => !a.retired) && !out.some((s) => /office/i.test(s))) out.push('What is the Office doing?');
  const fill = Number(hour) < 11
    ? ['Plan my day', 'What is the weather today?', 'Play some music']
    : Number(hour) < 18
      ? ['Put the team on my top task', 'Make me an image', 'Research something for me']
      : ['Watch something in the Theater', 'Recap my day', 'Play some music'];
  for (const f of fill) if (out.length < 3 && !out.includes(f)) out.push(f);
  return out.slice(0, 3);
} = {}) {
  const out = [];
  const tasks = data.team_tasks || [];
  const done = tasks.find((t) => DONE.has(t.status));
  if (done) out.push(`Read me what ${done.partner_name || 'the Office'} finished`);
  const project = (data.projects || [])[0];
  if (project) out.push(`What's next on ${shortTitle(project.title, 4)}?`);
  if ((data.team || []).some((a) => !a.retired)) out.push('What is the Office doing?');
  const h = Number(hour);
  const fill = h < 11 ? ['Plan my day', 'What’s the weather today?', 'Play some music']
    : h < 18 ? ['Put the team on my top task', 'Make me an image', 'Research something for me']
      : ['Watch something in the Theater', 'Recap my day', 'Play some music'];
  for (const f of fill) if (out.length < 3 && !out.includes(f)) out.push(f);
  return out.slice(0, 3);
}
