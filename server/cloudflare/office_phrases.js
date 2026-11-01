// Deterministic Office voice phrases. CHE is always the speaker; agents never
// address the owner. Every line is built from the real board only.
import { OFFICE_AGENTS } from './office_router.js';
import { officeAgentForRole } from './office_company.js';
import { parseOpportunityScoutPhrase } from './opportunity_scout.js';
import { parseRobloxPhrase } from './roblox_studio.js';
import { parseMlPhrase } from './ml_studio.js';
import { parseTranslatePhrase } from './translate.js';

const AGENTS = OFFICE_AGENTS;

// "the writing agent", "the research desk", "the quality assurance lead": a desk named by its role, not its name.
const ROLE_REF = /\bthe ((?:[a-z]+ )?[a-z]+) (?:agent|desk|department|director|lead|head)(?:'s|s)?\b/g;
const cap = (name) => name.charAt(0).toUpperCase() + name.slice(1);

/** The roster name for a role reference ("writing" or "quality assurance"), or ''. */
function roleAgent(words) {
  const parts = String(words || '').split(' ');
  return officeAgentForRole(parts.join(' ')) || (parts.length > 1 ? officeAgentForRole(parts[parts.length - 1]) : '');
}

// Delegating and reassigning change the Office at once, so they run only on a plain order for now. A negated one
// ("don't reassign …") or one that waits on something ("… after I approve it", "once I send the brief") is not one.
const NEGATED = /\b(?:don'?t|do not|never|no need to|stop|not yet)\b/;
const CONDITIONAL = /\b(?:if|unless|once|when|whenever|after|until|before|later|tomorrow|tonight|next (?:week|month|time))\b/;
function notAnOrderNow(t) {
  return NEGATED.test(t) || CONDITIONAL.test(t);
}

/** Every Office desk the text names, by role or by name, in order: [{ name, at }]. */
function agentRefs(t) {
  const refs = [];
  for (const m of t.matchAll(ROLE_REF)) {
    const name = roleAgent(m[1]);
    if (name) refs.push({ name, at: m.index });
  }
  for (const m of t.matchAll(new RegExp(`\\b(${AGENTS.join('|')})(?:'s|s)?\\b`, 'g'))) refs.push({ name: cap(m[1]), at: m.index });
  return refs.sort((a, b) => a.at - b.at);
}

export function matchOfficePhrase(raw) {
  const original = String(raw || '').trim();
  const t = original.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9 ?']/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:hey )?(?:che|chay|chey)\s+/, '');
  if (!t) return null;
  if (/\bwhat(?:'s|s| is)? (?:happening|going on) in the office\b/.test(t)) return { type: 'happening' };
  if (/\bwhat did (?:they|the office|the team|we) (?:build|ship|finish) today\b/.test(t)) return { type: 'builtToday' };
  if (/\bhow much (?:did we|have we) (?:make|made|earn|earned) today\b/.test(t)) return { type: 'earnedToday' };
  if (/\b(?:what(?:'s|s| is)\s+stalled|any\s+stalled|what(?:'s|s| is)\s+stuck|is\s+anything\s+(?:stalled|stuck)|anything\s+stuck)\b/.test(t)) return { type: 'stalled' };
  if (/\bread (?:this |the )?office(?: board)?(?: to me)?\b/.test(t)) return { type: 'readOffice' };
  // "Who is in the office?", "what is the team working on?": the same board (comprehension audit).
  if (/^who(?:'s|s| is| are)? (?:in|at|working in) the office\b/.test(t)) return { type: 'readOffice' };
  if (/^what(?:'s|s| is| are) (?:the team|the office|my team|my office|the agents|my agents|the crew|my crew|everyone in the office) (?:working on|doing)(?: right now| now| today)?\s*\??$/.test(t)) return { type: 'happening' };
  // "Stop the Atlas task", "cancel Knox's job", "tell Mira to stop": cancels that agent's open Office work.
  const stop = t.match(/^(?:please )?(?:stop|cancel|halt|abort|kill)(?: the| my)? ([a-z]+)(?:'s|s)? (?:task|tasks|job|jobs|work)\b/)
    || t.match(/^(?:please )?(?:tell|have|ask) ([a-z]+) to (?:stop|cancel|stand down)\b/);
  // "Review Atlas's task again", "review it again": a held result goes back to CHE's review as is.
  const named = t.match(/^(?:please )?(?:re ?review|review|check)(?: the| my)? ([a-z]+)(?:'s|s)? (?:task|result|work)(?: again)?\b/);
  const again = (named && [named[1], named[1].replace(/s$/, '')].some((n) => AGENTS.includes(n)) ? named : null)
    || t.match(/^(?:please )?(?:re ?review|review) (?:the |that |this )?(?:office (?:task|result)|office's (?:task|result)|held (?:task|result)|task) again\b/);
  if (again) {
    const name = again[1] && [again[1], again[1].replace(/s$/, '')].find((n) => AGENTS.includes(n));
    if (name || !again[1]) return { type: 'reviewAgentTask', agentId: name || '' };
  }
  // "The writing agent is at capacity. Reassign its queue to the research agent": queued work moves desks.
  if (/\b(?:reassign|re assign|move|hand (?:off|over)|transfer|shift)\b/.test(t) && /\b(?:queue|backlog|tasks|jobs|work)\b/.test(t) && !notAnOrderNow(t)) {
    const to = t.lastIndexOf(' to ');
    const refs = agentRefs(t);
    const target = refs.find((ref) => ref.at > to);
    const source = refs.find((ref) => ref.at < to && ref.name !== target?.name);
    if (to > 0 && target && source) return { type: 'reassignQueue', from: source.name, to: target.name };
  }
  // "Recap the open tasks in the office queue", "what's waiting in the team's backlog?": read the queue itself.
  if (/^(?:please )?(?:recap|summari[sz]e|list|show(?: me)?|read(?: me)?|tell me|give me|go over|run through|what(?:'s|s| is| are)?|how many|any)\b/.test(t)
    && (/\b(?:office|team|agents?)(?:'s|s)? (?:queue|backlog|task list|to do list)\b/.test(t)
      || /\b(?:open|queued|pending|waiting) (?:office |team )?(?:tasks|jobs|work)\b.*\b(?:office|team|agents)\b/.test(t))) {
    return { type: 'officeQueue' };
  }
  const stopped = stop && [stop[1], stop[1].replace(/s$/, '')].find((name) => AGENTS.includes(name));
  if (stopped) return { type: 'stopAgentTask', agentId: stopped };
  const who = t.match(/\bwhat(?:'s|s| is) ([a-z]+) (?:doing|working on)\b/);
  if (who && AGENTS.includes(who[1])) return { type: 'agentStatus', agentId: who[1] };
  if (/^(?:office )?stand down\b|\boffice,? stand down\b/.test(t)) return { type: 'standDown' };

  // The Office organisation (owner, 2026-10-23): "Who runs the Office departments?", "show the Office org chart".
  if (/^(?:who (?:runs|leads|heads|is in charge of) (?:the |my |each )?(?:office(?: departments?)?|departments?|office's departments)|(?:show|read|open|tell)(?: me)? (?:the |my )?office(?:'s)? (?:org(?:ani[sz]ation)?(?: chart)?|hierarchy|departments|department heads|chain of command)|what(?:'s|s| is) the office(?:'s)? (?:org chart|chain of command|hierarchy))\b/.test(t)) {
    return { type: 'officeOrg' };
  }
  // A coordinated, multi-department Office job: "Have Nova coordinate a redesign of the chart with design,
  // engineering, security and testing".
  const coordinate = original.match(/^(?:(?:hey )?(?:che|chay|chey)[, ]+)?(?:please )?(?:have|ask|get|let) (?:nova|the office) (?:to )?(?:coordinate|run|work together on) (.{6,})$/i);
  if (coordinate) return { type: 'officeJob', request: coordinate[1].replace(/[.!?]+$/, '').trim() };
  const jobId = t.match(/\boffice job (oj [0-9a-f]{8}|oj-[0-9a-f]{8})\b/) || original.match(/\b(oj-[0-9a-f]{8})\b/i);
  if (jobId || /\b(?:status of (?:the |my )?(?:coordinated )?office jobs?|(?:coordinated )?office jobs? status|how (?:is|are) (?:the |my )?(?:coordinated )?office jobs? (?:going|doing))\b/.test(t)) {
    return { type: 'officeJobStatus', id: jobId ? jobId[1].replace(' ', '-').toLowerCase() : '' };
  }

  const ml = parseMlPhrase(original, t);
  if (ml) return ml;
  const translate = parseTranslatePhrase(original, t);
  if (translate) return translate;

  // Roblox / Luau catalog jobs (games, weapon, clothing/UGC, passes) — owner confirm before publish/spend.
  const roblox = parseRobloxPhrase(original, t);
  if (roblox) return roblox;

  // Hire Iris (Ad Studio core desk — rostered via ensureLaAgenciaRoster).
  if (/\bhire\s+iris\b/.test(t) || /\b(?:add|staff)\s+iris\b/.test(t) || /\biris\b.*\b(?:ad studio|join(?:s|ed)? the office)\b/.test(t)) {
    const fromOriginal = original.match(/\bhire\s+iris\s+(?:for|to|as)\s+(.+)$/i);
    const task = (fromOriginal && fromOriginal[1] ? fromOriginal[1] : '').replace(/[.!?]+$/, '').trim();
    return { type: 'hireIris', task: task || null };
  }

  // Fiverr scout → shortlist for owner review (never auto-outbound).
  if (/\bscout\s+fiverr\b/.test(t) || /\bfiverr\s+scout\b/.test(t)) {
    const fromOriginal = original.match(/\bscout\s+fiverr\s+for\s+(.+)$/i)
      || original.match(/\bfiverr\s+scout\s+for\s+(.+)$/i);
    const query = (fromOriginal && fromOriginal[1] ? fromOriginal[1] : 'AI ad buyers').replace(/[.!?]+$/, '').trim() || 'AI ad buyers';
    return { type: 'fiverrScout', query };
  }

  // Forever opportunity scout (Pinterest / dropship / multi-channel) — shortlist only.
  const opportunity = parseOpportunityScoutPhrase(original, t);
  if (opportunity) return opportunity;

  // Direct Tonight Pack brief (no "tell the Office" wrapper required).
  const pack = original.match(/^(?:(?:hey )?(?:che|chay|chey)[, ]+)?(?:draft|make|prepare|build)\s+(?:a |the )?tonight pack\b([\s\S]{0,400})$/i);
  if (pack) {
    const rest = (pack[1] || '').replace(/[.!?]+$/, '').trim();
    return { type: 'goal', goal: (`Draft a tonight pack${rest ? ` ${rest}` : ''}`).trim() };
  }

  // "Ask the writing agent to draft a memo": the desk with that role gets the task. A role the roster does not
  // have ("the travel agent") is not the Office, so it falls through.
  const delegate = original.match(/^(?:(?:hey )?(?:che|chay|chey)[, ]+)?(?:please )?(?:ask|tell|have|get|let) the ((?:[a-z]+ )?[a-z]+) (?:agent|desk|department|director|lead|head)(?: to|,)? (.{4,})$/i);
  const delegateTo = delegate && roleAgent(delegate[1].toLowerCase());
  if (delegateTo) {
    const task = delegate[2].replace(/[.!?]+$/, '').trim();
    if (/^(?:stop|cancel|halt|abort|stand down)\b/i.test(task)) return { type: 'stopAgentTask', agentId: delegateTo.toLowerCase() };
    if (notAnOrderNow(t)) return null;
    return { type: 'delegateAgent', agent: delegateTo, role: delegate[1].toLowerCase(), task };
  }

  const goal = original.match(/^(?:(?:hey )?(?:che|chay|chey)[, ]+)?(?:tell|have|put|get) the office (?:to |on |working on )?(.{6,})$/i);
  if (goal) return { type: 'goal', goal: goal[1].replace(/[.!?]+$/, '').trim() };
  return null;
}

export function dollars(cents) {
  const n = Number(cents || 0) / 100;
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
}

function blockerLine(item) {
  if (typeof item === 'string') return item;
  return `${item.agent || 'An agent'}: ${item.detail || 'Blocked'}${item.task ? ` on ${item.task}` : ''}`;
}

export function speakOfficeBoard(board, phrase) {
  const b = board || {};
  const connected = b.stripe?.connected === true;
  const money = connected
    ? `Stripe today: charges ${dollars(b.stripe.charges_cents)}, refunds ${dollars(b.stripe.refunds_cents)}, net ${dollars(b.stripe.net_cents)}.`
    : 'Stripe not connected. Earned today $0.00.';
  const blockers = (b.blockers || []).length
    ? `Blockers: ${(b.blockers || []).map(blockerLine).join('; ')}.`
    : 'No blockers.';
  const stalledRows = Array.isArray(b.stalled) ? b.stalled : [];
  const stalled = stalledRows.length
    ? `Stalled: ${stalledRows.map((item) => `${item.agent || 'An agent'}: ${item.task || 'a job'} (${item.detail || 'stalled'})`).join('; ')}.`
    : 'Nothing stalled.';
  const started = Number(b.started_today ?? (b.started || []).length ?? 0);
  const finished = Number(b.finished_today ?? (b.shipped || []).length ?? 0);
  const working = Number(b.agents_working || 0);
  const desks = (b.agents || []).map((a, i) => `${i + 1}. ${a.name}: ${a.status || 'Idle'}`).join('. ');
  const built = (b.shipped || []).map((s, i) => `${i + 1}. ${s.agent || 'The Office'} finished ${s.task}`).join('. ');
  switch (phrase?.type) {
    case 'happening':
      return `CHE here. ${working} ${working === 1 ? 'agent' : 'agents'} working. Started today ${started}. Finished today ${finished}. ${blockers} ${stalled}`;
    case 'builtToday':
      return finished
        ? `CHE here. Finished today ${finished}. ${built}.`
        : `CHE here. Nothing finished yet today. Started today ${started}.`;
    case 'earnedToday':
      return `CHE here. ${money}`;
    case 'stalled':
      return stalledRows.length
        ? `CHE here. ${stalled}`
        : 'CHE here. Nothing is stalled right now.';
    case 'readOffice':
      return `CHE here. Office board. Started today ${started}. Finished today ${finished}. ${working} working. ${money} ${blockers} ${stalled}${desks ? ` Desks: ${desks}.` : ''}`;
    case 'agentStatus': {
      const agent = (b.agents || []).find((a) => String(a.id).toLowerCase() === phrase.agentId);
      return agent
        ? `CHE here. ${agent.name} — ${agent.status || 'Idle'}.`
        : `CHE here. I do not have a live desk for ${phrase.agentId}.`;
    }
    case 'standDown':
      return 'CHE here. Office standing down. Queued Office work is paused and agents stay on my channel only. Say resume to restart.';
    default:
      return null;
  }
}

/**
 * "Tell me more" right after an Office desk reply: everything the Office board holds for that agent (status, blockers,
 * stalled and finished work), read from the board only (subject-loss audit, 2026-10-24).
 */
export function speakOfficeAgentMore(board, agentId) {
  const b = board || {};
  const agent = (b.agents || []).find((a) => String(a.id).toLowerCase() === agentId);
  const name = agent?.name || agentId;
  const ofAgent = (row) => [agentId, String(name).toLowerCase()].includes(String(row?.agent || '').toLowerCase());
  const lines = [speakOfficeBoard(b, { type: 'agentStatus', agentId })];
  const blocked = (b.blockers || []).filter((row) => typeof row === 'object' && ofAgent(row));
  if (blocked.length) lines.push(`Blocked: ${blocked.map((row) => `${row.detail || 'blocked'}${row.task ? ` on "${String(row.task).slice(0, 80)}"` : ''}`).join('; ')}.`);
  const stalled = (b.stalled || []).filter(ofAgent);
  if (stalled.length) lines.push(`Stalled: ${stalled.map((row) => `"${String(row.task || 'a job').slice(0, 80)}" (${row.detail || 'stalled'})`).join('; ')}.`);
  const finished = (b.shipped || []).filter(ofAgent);
  if (finished.length) lines.push(`Finished today: ${finished.map((row) => `"${String(row.task || '').slice(0, 80)}"`).join('; ')}.`);
  if (agent) lines.push(`That is everything the Office board holds for ${name}, sir.`);
  return lines.join(' ');
}

// Spoken result of CHE splitting an owner goal into queued Office jobs.
export function speakGoalPlan(jobs) {
  if (!jobs.length) return 'CHE here. I did not hear a goal to split. Say, tell the Office to, then the goal.';
  const lines = jobs.map((j, i) => `${i + 1}. ${j.agent}: ${j.task}${j.blocker ? ` — ${j.blocker}` : ''}`).join('. ');
  const blocked = jobs.filter((j) => j.blocker).length;
  return `CHE here. I split that into ${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}. ${lines}.${blocked ? ` ${blocked} blocked until the tool is configured.` : ''}`;
}

// "Recap the office queue": the open Office tasks as the durable record holds them, never a model summary.
export function speakOfficeQueue(tasks, openStatuses) {
  const open = (Array.isArray(tasks) ? tasks : []).filter((task) => openStatuses.has(task?.status));
  if (!open.length) return 'CHE here. The Office queue is empty: there are no open tasks.';
  const lines = open.slice(0, 10).map((task, i) => `${i + 1}. ${task.partner_name || 'An agent'}, ${String(task.status).replace(/_/g, ' ')}: "${String(task.task || '').slice(0, 90)}" (task ${String(task.id || '').slice(0, 8)})`);
  const more = open.length > 10 ? ` And ${open.length - 10} more.` : '';
  return `CHE here. The Office queue has ${open.length} open ${open.length === 1 ? 'task' : 'tasks'}. ${lines.join('. ')}.${more}`;
}
