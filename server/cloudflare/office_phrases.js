// Deterministic Office voice phrases. CHE is always the speaker; agents never
// address the owner. Every line is built from the real board only.
import { OFFICE_AGENTS } from './office_router.js';
import { parseOpportunityScoutPhrase } from './opportunity_scout.js';
import { parseRobloxPhrase } from './roblox_studio.js';

const AGENTS = OFFICE_AGENTS;

export function matchOfficePhrase(raw) {
  const original = String(raw || '').trim();
  const t = original.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9 ?']/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:hey )?(?:che|chay|chey)\s+/, '');
  if (!t) return null;
  if (/\bwhat(?:'s|s| is)? (?:happening|going on) in the office\b/.test(t)) return { type: 'happening' };
  if (/\bwhat did (?:they|the office|the team|we) (?:build|ship|finish) today\b/.test(t)) return { type: 'builtToday' };
  if (/\bhow much (?:did we|have we) (?:make|made|earn|earned) today\b/.test(t)) return { type: 'earnedToday' };
  if (/\b(?:what(?:'s|s| is)\s+stalled|any\s+stalled|what(?:'s|s| is)\s+stuck)\b/.test(t)) return { type: 'stalled' };
  if (/\bread (?:this |the )?office(?: board)?(?: to me)?\b/.test(t)) return { type: 'readOffice' };
  const who = t.match(/\bwhat(?:'s|s| is) ([a-z]+) (?:doing|working on)\b/);
  if (who && AGENTS.includes(who[1])) return { type: 'agentStatus', agentId: who[1] };
  if (/^(?:office )?stand down\b|\boffice,? stand down\b/.test(t)) return { type: 'standDown' };

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

// Spoken result of CHE splitting an owner goal into queued Office jobs.
export function speakGoalPlan(jobs) {
  if (!jobs.length) return 'CHE here. I did not hear a goal to split. Say, tell the Office to, then the goal.';
  const lines = jobs.map((j, i) => `${i + 1}. ${j.agent}: ${j.task}${j.blocker ? ` — ${j.blocker}` : ''}`).join('. ');
  const blocked = jobs.filter((j) => j.blocker).length;
  return `CHE here. I split that into ${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}. ${lines}.${blocked ? ` ${blocked} blocked until the tool is configured.` : ''}`;
}
