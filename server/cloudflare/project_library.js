// Project manager over the projects CHE already keeps (owner, 2026-10-24: "remove ML classification projects from the
// creative list ... fix duplicate cards without losing history ... show Active, Paused, Completed and Archived, with
// status, last activity, output and next action"; "recover and finish every Roblox game studio — tonight project").
//
// One read model, no second store: cards come from data.projects (Creator Studio, Office goals, ML runs), their crew
// work from data.team_tasks (linked by job_ids or goal_id), and 3D creations from the Creation Studio. Grouping
// duplicates only changes what is shown: every copy stays stored, each card lists its copies' ids, and its history
// merges theirs. The state buttons write project.status (the existing field) and append to project.history.
import { extractLuau, placeXml } from './roblox_place.js';

export const STATES = ['active', 'paused', 'completed', 'archived'];
export const STATE_LABEL = { active: 'Active', paused: 'Paused', completed: 'Completed', archived: 'Archived' };
const STATUS_FOR = { active: 'in_progress', paused: 'paused', completed: 'completed', archived: 'archived' };

/** Creation types the Projects list groups by; code and research are not creative work and are listed apart. */
export const CATEGORIES = {
  roblox: 'Roblox games', character: 'Characters and 3D', film: 'Film and video', music: 'Music', art: 'Art and images',
  invention: 'Inventions', writing: 'Writing', general: 'Other creative', code: 'Code and apps', research: 'AI and research',
};
export const NON_CREATIVE = new Set(['code', 'research']);

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const time = (v) => Date.parse(v || '') || 0;

export function categoryOf(p) {
  const type = String(p?.type || '').toLowerCase();
  const kinds = `${type} ${String(p?.goal_kind || '').toLowerCase()}`;
  const title = String(p?.title || '').toLowerCase();
  if (/^roblox/.test(type) || /\broblox\b/.test(title)) return 'roblox';
  if (/(?:^|[\s_])ml(?:_|\b)|ml_eval|classif|cluster|dataset|benchmark|research|analysis|model_eval/.test(kinds) || /^ml (?:classification|clustering)\b/.test(title)) return 'research';
  if (/app|website|web|software|code|api|bot|script_tool|plugin/.test(type)) return 'code';
  if (/character|avatar|person|3d|model/.test(type)) return 'character';
  if (/film|video|movie|storyboard|screenplay|youtube|short|series/.test(type)) return 'film';
  if (/music|song|beat|album|track|lyric|podcast|audio/.test(type)) return 'music';
  if (/art|image|thumbnail|design|logo|poster|illustration|photo/.test(type)) return 'art';
  if (/invent/.test(type)) return 'invention';
  if (/book|novel|story|script|writing|essay|article|blog/.test(type)) return 'writing';
  return 'general';
}

export function stateOf(p) {
  const s = String(p?.status || '').toLowerCase();
  if (s === 'archived') return 'archived';
  if (/^(?:completed|complete|done|published|delivered|finished|merged)$/.test(s)) return 'completed';
  if (/^(?:paused|on_hold|hold)$/.test(s)) return 'paused';
  return 'active';
}

/** The crew work linked to a project: its job_ids, or every task of its Office goal. */
export function linkedTasks(p, tasks = []) {
  const ids = new Set(Array.isArray(p?.job_ids) ? p.job_ids : []);
  return tasks.filter((t) => t && (ids.has(t.id) || (p?.goal_id && t.job_id === p.goal_id)));
}

// The owner's request without the capability note officeRobloxJob appends, for telling copies apart.
const requestOf = (p) => clip(String(p?.brief || '').split('\n\n')[0], 160);
const keyOf = (p) => `${categoryOf(p)}|${clip(p?.title, 120).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}|${requestOf(p).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;

function outputOf(p, tasks) {
  const done = tasks.filter((t) => String(t.result || '').trim());
  const luau = [...extractLuau(p.content, 'project'), ...done.flatMap((t) => extractLuau(t.result, t.id))];
  const words = String(p.content || '').split(/\s+/).filter(Boolean).length;
  const parts = [];
  if (luau.length) parts.push(`${luau.length} Luau script${luau.length === 1 ? '' : 's'}`);
  if (done.length) parts.push(`${done.length} crew result${done.length === 1 ? '' : 's'}`);
  if (words && !parts.length) parts.push(`a ${words}-word draft`);
  return { line: parts.length ? parts.join(', ') : 'No output yet', luau: luau.length, results: done.length, words };
}

function nextActionOf(card, tasks) {
  if (card.state === 'archived') return 'Archived. Say restore to keep working on it.';
  if (card.state === 'paused') return 'Paused. Say resume to continue.';
  const running = tasks.filter((t) => ['queued', 'running', 'reviewing', 'revising'].includes(t.status)).length;
  const blocked = tasks.filter((t) => ['blocked', 'failed'].includes(t.status));
  if (running) return `Wait: ${running} crew task${running === 1 ? ' is' : 's are'} still working.`;
  if (blocked.length) return `${blocked.length} crew task${blocked.length === 1 ? ' is' : 's are'} blocked: ${clip(blocked[0].error, 140) || 'no reason recorded'}.`;
  if (card.category === 'roblox') {
    return card.output.luau ? 'Download the place file and open it in Roblox Studio to playtest.' : 'No Luau scripts yet: say continue to ask the crew for the game scripts.';
  }
  if (card.state === 'completed') return 'Done. Open it to see the output.';
  return card.output.words || card.output.results ? 'Open it and tell CHE what to build next.' : 'Nothing made yet: say continue to start it.';
}

function history(p, tasks) {
  const h = [{ at: p.created_at, event: 'created' }, ...(Array.isArray(p.history) ? p.history : [])];
  for (const t of tasks) {
    h.push({ at: t.created_at, event: `${t.partner_name || 'crew'} task queued`, task_id: t.id });
    if (t.status !== 'queued') h.push({ at: t.updated_at, event: `${t.partner_name || 'crew'} task ${t.status}`, task_id: t.id });
  }
  return h.filter((e) => e.at);
}

/**
 * The project manager: one card per distinct project (copies grouped), each with its category, state, last activity,
 * output and next action; plus the counts per state and per list (creative, or AI, code and research).
 */
export function projectLibrary(data = {}, creations = []) {
  const tasks = Array.isArray(data.team_tasks) ? data.team_tasks : [];
  const groups = new Map();
  for (const p of Array.isArray(data.projects) ? data.projects : []) {
    if (!p?.id) continue;
    const k = keyOf(p);
    groups.set(k, [...(groups.get(k) || []), p]);
  }
  const cards = [];
  for (const copies of groups.values()) {
    const linked = copies.map((p) => ({ p, t: linkedTasks(p, tasks) }));
    const score = ({ p, t }) => t.filter((x) => String(x.result || '').trim()).length * 1e6 + String(p.content || '').length;
    linked.sort((a, b) => score(b) - score(a) || time(b.p.updated_at) - time(a.p.updated_at));
    const { p } = linked[0];
    const all = linked.flatMap((l) => l.t);
    const merged = { ...p, content: linked.map((l) => l.p.content || '').join('\n\n') };
    const output = outputOf(merged, all);
    const last = Math.max(...copies.map((c) => time(c.updated_at) || time(c.created_at)), ...all.map((t) => time(t.updated_at)));
    const card = {
      id: p.id, ids: copies.map((c) => c.id), copies: copies.length, title: clip(p.title, 120) || 'Untitled project',
      request: requestOf(p), type: p.type || 'general', category: categoryOf(p), state: stateOf(p), status: p.status || 'new',
      last_activity: last ? new Date(last).toISOString() : null, output, source: 'project',
      tasks: all.map((t) => ({ id: t.id, agent: t.partner_name || '', status: t.status, updated_at: t.updated_at, error: clip(t.error, 200) })),
      history: copies.flatMap((c, i) => history(c, linked.find((l) => l.p === c)?.t || []).map((e) => ({ ...e, copy: i + 1 })))
        .sort((a, b) => time(a.at) - time(b.at)).slice(-60),
    };
    card.state_label = STATE_LABEL[card.state];
    card.category_label = CATEGORIES[card.category];
    card.creative = !NON_CREATIVE.has(card.category);
    card.next_action = nextActionOf(card, all);
    cards.push(card);
  }
  for (const c of creations) {
    const j = c.job || null;
    const state = c.archived ? 'archived' : j && ['completed'].includes(j.state) ? 'completed' : j?.state === 'paused' && j.owner_paused ? 'paused' : 'active';
    cards.push({
      id: c.id, ids: [c.id], copies: 1, title: clip(c.title, 120) || 'Creation', request: '', type: `creation_${c.kind || 'person'}`,
      category: 'character', category_label: CATEGORIES.character, creative: true, state, state_label: STATE_LABEL[state], status: j?.state || 'not generated',
      last_activity: c.updated_at || c.created_at || null, source: 'creation', job_id: j?.id || null,
      output: { line: c.model_url ? '3D model ready' : j ? `${j.display_state || j.state}` : 'Not generated yet', luau: 0, results: 0, words: 0, model_url: c.model_url || null },
      next_action: c.model_url ? 'Open it in the 3D viewport.' : j && ['queued', 'rendering'].includes(j.state) ? `${j.status_line || 'Building now.'}` : j?.state === 'failed' ? 'Failed: say retry.' : 'Say generate to build it.',
      tasks: [], history: [],
    });
  }
  cards.sort((a, b) => time(b.last_activity) - time(a.last_activity));
  const count = (f) => STATES.reduce((o, s) => ({ ...o, [s]: cards.filter((c) => f(c) && c.state === s).length }), {});
  const duplicates = cards.filter((c) => c.copies > 1).map((c) => ({ id: c.id, title: c.title, copies: c.copies, ids: c.ids }));
  return {
    ok: true, cards, counts: { creative: count((c) => c.creative), ai_code_research: count((c) => !c.creative) },
    categories: CATEGORIES, duplicates,
    spoken: speakLibrary(cards, duplicates),
  };
}

function speakLibrary(cards, duplicates) {
  if (!cards.length) return 'You have no projects yet.';
  const creative = cards.filter((c) => c.creative); const other = cards.length - creative.length;
  const by = (s) => creative.filter((c) => c.state === s).length;
  return `${creative.length} creative project${creative.length === 1 ? '' : 's'}: ${by('active')} active, ${by('paused')} paused, `
    + `${by('completed')} completed and ${by('archived')} archived. ${other} more in AI, code and research.`
    + (duplicates.length ? ` ${duplicates.length} had duplicate copies, now shown once; every copy is kept.` : '');
}

/** Roblox recovery: every Roblox project (copies grouped), what the crew really produced, and what can be built. */
export function robloxRecovery(data = {}) {
  const lib = projectLibrary(data);
  const tasks = Array.isArray(data.team_tasks) ? data.team_tasks : [];
  const all = (Array.isArray(data.projects) ? data.projects : []).filter((p) => categoryOf(p) === 'roblox');
  const projects = lib.cards.filter((c) => c.category === 'roblox').map((c) => {
    const copies = all.filter((p) => c.ids.includes(p.id));
    const linked = copies.flatMap((p) => linkedTasks(p, tasks));
    const scripts = [...copies.flatMap((p) => extractLuau(p.content, p.id)), ...linked.flatMap((t) => extractLuau(t.result, t.id))];
    const unique = [...new Map(scripts.map((s) => [s.source.trim(), s])).values()];
    return {
      id: c.id, ids: c.ids, title: c.title, request: c.request, copies: c.copies, state: c.state, last_activity: c.last_activity,
      tasks: linked.map((t) => ({ id: t.id, agent: t.partner_name, status: t.status, result_chars: String(t.result || '').length, error: clip(t.error, 200), updated_at: t.updated_at })),
      scripts: unique.map((s) => ({ name: s.name, kind: s.kind, lines: s.source.split('\n').length, from: s.from })),
      place_file: unique.length ? `/api/projects/roblox/place.rbxlx?id=${c.id}` : null,
      verified: false,
      next_action: c.next_action,
    };
  });
  const n = projects.length; const withCode = projects.filter((p) => p.scripts.length).length;
  return {
    ok: true, projects, stored_copies: all.length,
    spoken: n === 0 ? 'There are no Roblox projects saved.'
      : `${n} Roblox project${n === 1 ? '' : 's'} (${all.length} saved cop${all.length === 1 ? 'y' : 'ies'}, nothing removed). `
        + `${withCode} ha${withCode === 1 ? 's' : 've'} Luau scripts I can put in a Roblox place file; ${n - withCode} ha${n - withCode === 1 ? 's' : 've'} only notes so far. `
        + 'None has been playtested in Roblox Studio, so none is called playable.',
  };
}

/** The crew brief for continuing a Roblox project: the owner's request, what exists, and the shape the place builder reads. */
export function continueBrief(rec) {
  return [
    `Continue the Roblox project "${clip(rec.title, 120)}"${rec.request ? ` (owner request: ${rec.request})` : ''}.`,
    rec.scripts.length ? `Scripts already written: ${rec.scripts.map((s) => `${s.name} (${s.kind})`).join(', ')}. Keep what works and complete the rest.` : 'No Luau scripts exist yet.',
    'Write complete, working Luau for a first playable version: the server Script(s), the client or Tool scripts and any ModuleScripts.',
    'Put each script in its own ```luau code block whose first line is `-- name: ScriptName`.',
    'The server decides damage, money and scores; never trust a value a RemoteEvent receives from a client.',
    'Do not publish, upload, spend Robux, list on the Marketplace or contact anyone.',
  ].join(' ');
}

/**
 * The deploy's read-only projects audit (che-worker-deploy.yml): counts only, never a title, brief or script, since
 * the deploy log is public. Proves on the owner's real stored projects how many Roblox projects, copies and scripts
 * exist, and how the creative and the AI, code and research lists split.
 */
export function projectAudit(data = {}) {
  const lib = projectLibrary(data); const rb = robloxRecovery(data);
  return {
    ok: true, stored_projects: (data.projects || []).length, cards: lib.cards.length, duplicate_groups: lib.duplicates.length,
    creative: lib.counts.creative, ai_code_research: lib.counts.ai_code_research,
    roblox: { cards: rb.projects.length, stored_copies: rb.stored_copies, with_scripts: rb.projects.filter((p) => p.scripts.length).length,
      scripts: rb.projects.reduce((n, p) => n + p.scripts.length, 0), crew_tasks: rb.projects.reduce((n, p) => n + p.tasks.length, 0),
      crew_results: rb.projects.reduce((n, p) => n + p.tasks.filter((t) => t.result_chars > 0).length, 0), playtested: 0 },
  };
}

/**
 * GET /api/projects/library, GET /api/projects/roblox, GET /api/projects/roblox/place.rbxlx?id=,
 * POST /api/projects/state {ids|id, state}. `save` persists data.
 */
export async function projectLibraryRoute({ data, save, creations = async () => [], now = () => Date.now(), continueProject = null }, path, request, body = {}) {
  const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
  if (path === '/api/projects/library' && request.method === 'GET') return json(projectLibrary(data, await creations()));
  if (path === '/api/projects/roblox' && request.method === 'GET') return json(robloxRecovery(data));
  if (path === '/api/projects/roblox/place.rbxlx' && request.method === 'GET') {
    const id = String(new URL(request.url).searchParams.get('id') || '');
    const rec = robloxRecovery(data).projects.find((p) => p.ids.includes(id));
    if (!rec) return json({ detail: 'No Roblox project with that id.' }, 404);
    const tasks = Array.isArray(data.team_tasks) ? data.team_tasks : [];
    const copies = data.projects.filter((p) => rec.ids.includes(p.id));
    const scripts = [...copies.flatMap((p) => extractLuau(p.content, p.id)), ...copies.flatMap((p) => linkedTasks(p, tasks)).flatMap((t) => extractLuau(t.result, t.id))];
    const unique = [...new Map(scripts.map((s) => [s.source.trim(), s])).values()];
    if (!unique.length) return json({ detail: 'This Roblox project has no Luau scripts yet, so there is no place file to build. Nothing was made up.' }, 404);
    const { xml, placed } = placeXml({ scripts: unique });
    const name = rec.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'roblox-project';
    return new Response(xml, { status: 200, headers: {
      'Content-Type': 'application/xml', 'Content-Disposition': `attachment; filename="${name}.rbxlx"`,
      'X-CHE-Placed': JSON.stringify(placed).slice(0, 2000), 'X-CHE-Verified': 'false',
    } });
  }
  // Continue a Roblox project with the crew: one Atlas task linked to the existing project (no new project card).
  if (path === '/api/projects/continue' && request.method === 'POST') {
    const id = String(body?.id || '');
    const rec = robloxRecovery(data).projects.find((p) => p.ids.includes(id));
    if (!rec) return json({ ok: false, open_editor: true, detail: 'Only Roblox projects continue with the crew here; open the project to keep working on it.' }, 409);
    if (!continueProject) return json({ ok: false, detail: 'The crew is not connected on this Worker, so nothing was queued.' }, 503);
    const lead = data.projects.find((p) => p.id === rec.id);
    const out = await continueProject(lead, continueBrief(rec));
    if (!out.ok) return json(out, 409);
    return json({ ...out, receipt: { at: new Date(now()).toISOString(), project_id: lead.id, task_id: out.task_id, agent: out.agent },
      spoken: `${out.agent} is writing the Luau for ${clip(rec.title, 80)}${rec.request ? `, ${clip(rec.request, 80)}` : ''}. The scripts appear on this card when the task finishes; none of it is called playable until it is playtested in Roblox Studio.` });
  }
  if (path === '/api/projects/state' && request.method === 'POST') {
    const state = String(body?.state || '');
    if (!STATES.includes(state)) return json({ ok: false, detail: `Say one of: ${STATES.join(', ')}.` }, 400);
    const ids = new Set([...(Array.isArray(body?.ids) ? body.ids : []), body?.id].map((v) => String(v || '')).filter(Boolean));
    const hit = (Array.isArray(data.projects) ? data.projects : []).filter((p) => ids.has(p.id));
    if (!hit.length) return json({ ok: false, detail: 'No project with that id.' }, 404);
    const at = new Date(now()).toISOString();
    for (const p of hit) {
      const from = stateOf(p);
      p.status = STATUS_FOR[state]; p.updated_at = at;
      p.history = [...(Array.isArray(p.history) ? p.history : []), { at, event: `${STATE_LABEL[from]} → ${STATE_LABEL[state]}`, via: 'owner' }].slice(-40);
    }
    await save();
    const t = clip(hit[0].title, 80);
    return json({ ok: true, ids: hit.map((p) => p.id), state, receipt: { at, ids: hit.map((p) => p.id), state, stored: true },
      spoken: `${t} is now ${STATE_LABEL[state].toLowerCase()}${hit.length > 1 ? ` (all ${hit.length} copies)` : ''}. Saved.` });
  }
  return null;
}
