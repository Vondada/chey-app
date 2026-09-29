// CHE Agent Runtime. The Office agents live here, on the backend, not in the
// Flutter app. The app only mirrors this state (GET /api/agents, or the
// /api/agents/live WebSocket).
//
// Every status shown in the app comes from a real step in this file: an agent
// is "researching" only while its model call for a queued task is running, and
// a War Room is "cross-checking" only while agents are reviewing each other's
// drafts. Nothing is animated for show.
//
// Storage: agents stay in `data.team` (the existing Office roster), their work
// in `data.team_tasks`, and War Rooms in `data.meetings`, all in the owner's
// CheState Durable Object. Long work runs from the Durable Object alarm, so it
// keeps going when the phone is locked.

export const AGENT_STATUSES = [
  'idle', 'researching', 'building', 'analyzing', 'meeting',
  'waiting', 'reviewing', 'talking', 'done', 'offline',
];

const AGENT_NAMES = ['Nova', 'Atlas', 'Mira', 'Knox', 'Sage', 'Lyra', 'Orion', 'Vale', 'Juno', 'Rhea', 'Cato', 'Iris'];

// Consistent personalities so each agent sounds the same across sessions.
const PERSONAS = {
  Nova: 'Curious and fast. Sources first, then opinions. Flags weak evidence bluntly.',
  Atlas: 'Steady and numerical. Thinks in base rates, risk and drawdown. Dry humor.',
  Mira: 'Bold visual thinker. Opinionated about taste, quick to sketch options.',
  Knox: 'Skeptical by default. Hunts for failure modes, security holes and bad assumptions.',
  Sage: 'Calm reviewer. Checks every claim against the goal and says what is missing.',
  Lyra: 'Warm, precise writer. Turns messy notes into clear, human language.',
  Orion: 'Big-picture strategist. Connects decisions to goals and sequences the work.',
  Vale: 'Operations brain. Lists, owners, deadlines, dependencies. Hates vague plans.',
  Juno: 'Pragmatic builder. Prefers the smallest version that works today.',
  Rhea: 'Customer-minded. Asks who this is for and what they would actually do.',
  Cato: 'Debater. Argues the other side on purpose to stress-test the plan.',
  Iris: 'Pattern spotter. Links people, projects and past decisions together.',
};

const OUTFITS = ['5CC8FF', 'FF8A4C', '3DDC97', '8B7BFF', 'E8B04A', 'FF5C8A', '4CD4C0', 'B38CFF', '7FD35C', 'FFB85C'];
const HAIR = ['2B1D14', '7A3B1D', '14110F', 'C9A36B', '3B2A1E', '5A2D0C', 'D9D2C5'];
const SKIN = ['C68B59', 'E0B08A', '8D5A3B', 'F1C9A5', 'A86B45', '6B4428'];

function hashOf(value) {
  let h = 2166136261;
  for (const ch of String(value)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function now() {
  return new Date().toISOString();
}

function clip(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function modelText(answer) {
  return String(answer?.response || answer?.choices?.[0]?.message?.content || '').trim();
}

// What an agent visibly does while running a task, from its role.
export function workingStatusFor(agent) {
  const text = `${agent.role || ''} ${agent.specialty || ''}`.toLowerCase();
  if (/review|verif|qa|audit|security|check/.test(text)) return 'reviewing';
  if (/research|source|public record|search/.test(text)) return 'researching';
  if (/market|quant|trad|financ|analy|data|insight/.test(text)) return 'analyzing';
  return 'building';
}

// Fill in runtime fields on an Office coworker (older records lack them).
export function normalizeAgent(agent) {
  const h = hashOf(agent.id || agent.name);
  agent.personality = clip(agent.personality || PERSONAS[agent.name] ||
    'Focused, candid and concise. Delivers concrete work, not filler.', 600);
  agent.look = agent.look && typeof agent.look === 'object' ? agent.look : {
    color: OUTFITS[h % OUTFITS.length],
    hair: HAIR[(h >>> 4) % HAIR.length],
    skin: SKIN[(h >>> 8) % SKIN.length],
  };
  agent.responsibilities = Array.isArray(agent.responsibilities) ? agent.responsibilities : [];
  agent.model_tier = agent.model_tier === 'strong' ? 'strong' : 'fast';
  agent.temporary = Boolean(agent.temporary);
  if (!AGENT_STATUSES.includes(agent.runtime_status)) {
    // Legacy `status` was 'available' / 'working' with nothing actually running.
    agent.runtime_status = 'idle';
  }
  return agent;
}

function nextName(data) {
  const used = new Set(data.team.map((item) => String(item.name || '')));
  return AGENT_NAMES.find((item) => !used.has(item)) || `Agent ${data.team.length + 1}`;
}

export function createAgent(data, spec) {
  const role = clip(spec.role, 80);
  if (!role) return { error: 'Agent role required.' };
  const requested = clip(spec.name, 40);
  if (requested && data.team.some((item) => String(item.name).toLowerCase() === requested.toLowerCase())) {
    return { error: `${requested} already works in the Office.` };
  }
  const at = now();
  const agent = normalizeAgent({
    id: crypto.randomUUID(),
    name: requested || nextName(data),
    kind: 'CHE AI coworker',
    role,
    specialty: clip(spec.specialty, 160),
    mission: clip(spec.mission, 1200) || 'Help CHE deliver owner-authorized work faster and more reliably.',
    personality: clip(spec.personality, 600),
    responsibilities: Array.isArray(spec.responsibilities)
      ? spec.responsibilities.map((item) => clip(item, 200)).filter(Boolean).slice(0, 12)
      : [],
    temporary: Boolean(spec.temporary),
    status: 'available',
    introduced: false,
    created_at: at,
    updated_at: at,
  });
  data.team.push(agent);
  data.team = data.team.slice(-24);
  return { agent };
}

function doneIsFresh(agent) {
  const at = Date.parse(agent.runtime_updated_at || '');
  return Number.isFinite(at) && Date.now() - at < 10 * 60_000;
}

export function agentView(agent, data) {
  normalizeAgent(agent);
  let status = agent.runtime_status;
  if (status === 'done' && !doneIsFresh(agent)) status = 'idle';
  const owned = (data.owner_context || []).filter((item) => item.owner_agent_id === agent.id);
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    specialty: agent.specialty || '',
    mission: agent.mission || '',
    personality: agent.personality,
    color: agent.look.color,
    hair: agent.look.hair,
    skin: agent.look.skin,
    status,
    task: agent.runtime_task || null,
    responsibilities: [
      ...agent.responsibilities,
      ...owned.slice(0, 6).map((item) => `${item.title || item.type}: ${item.next_responsibility || 'keep current'}`),
    ],
    model_tier: agent.model_tier,
    temporary: agent.temporary,
    introduced: Boolean(agent.introduced),
    created_at: agent.created_at,
    updated_at: agent.updated_at,
  };
}

// CHE's own status on the Office floor, derived from real runtime work.
function cheStatus(data) {
  const meetings = data.meetings || [];
  const live = meetings.find((item) => ['drafting', 'cross_check', 'synthesizing'].includes(item.status));
  if (live?.status === 'synthesizing') return { status: 'reviewing', task: `Synthesizing: ${live.objective.slice(0, 60)}` };
  if (live) return { status: 'meeting', task: `War Room: ${live.objective.slice(0, 60)}` };
  const reviewing = data.team_tasks.find((item) => item.status === 'reviewing');
  if (reviewing) return { status: 'reviewing', task: `Reviewing ${reviewing.partner_name}'s work` };
  const running = data.team_tasks.filter((item) => item.status === 'running' || item.status === 'queued');
  if (running.length) return { status: 'waiting', task: `${running.length} delegated task${running.length === 1 ? '' : 's'} in progress` };
  return { status: 'idle', task: null };
}

function meetingSummary(meeting) {
  return {
    id: meeting.id,
    objective: meeting.objective,
    status: meeting.status,
    progress: meeting.progress,
    participants: meeting.participants.map((item) => ({ agent_id: item.agent_id, name: item.name, role: item.role })),
    created_at: meeting.created_at,
    updated_at: meeting.updated_at,
  };
}

export function runtimeSnapshot(data) {
  const agents = data.team.filter((item) => !item.retired).map((item) => agentView(item, data));
  return {
    che: cheStatus(data),
    agents,
    working: agents.filter((item) => !['idle', 'offline', 'done'].includes(item.status)).length,
    meetings: (data.meetings || []).slice(0, 12).map(meetingSummary),
    updated_at: now(),
  };
}

export function agentDetail(data, agent) {
  return {
    agent: agentView(agent, data),
    history: data.team_tasks
      .filter((item) => item.partner_id === agent.id)
      .slice(0, 30)
      .map((item) => ({
        id: item.id,
        task: item.task,
        status: item.status,
        result: clip(item.result, 4000),
        che_review: item.che_review || '',
        verified_by_che: Boolean(item.verified_by_che),
        error: item.error || '',
        created_at: item.created_at,
        updated_at: item.updated_at,
      })),
    meetings: (data.meetings || [])
      .filter((item) => item.participants.some((p) => p.agent_id === agent.id))
      .slice(0, 10)
      .map(meetingSummary),
  };
}

export function queueAgentTask(data, agent, task, source = 'owner') {
  const at = now();
  const entry = {
    id: crypto.randomUUID(),
    partner_id: agent.id,
    partner_name: agent.name,
    role: agent.role,
    task: clip(task, 3000),
    source,
    status: 'queued',
    result: '',
    error: '',
    created_at: at,
    updated_at: at,
  };
  data.team_tasks.unshift(entry);
  data.team_tasks = data.team_tasks.slice(0, 150);
  agent.runtime_status = 'waiting';
  agent.runtime_task = clip(task, 80);
  agent.runtime_updated_at = at;
  agent.status = 'working';
  agent.updated_at = at;
  return entry;
}

// PATCH /api/agents/:id — reassign, upgrade, retire or edit an agent.
export function updateAgent(data, agent, body) {
  const action = clip(body.action, 20);
  const at = now();
  if (action === 'retire') {
    const pending = data.team_tasks.filter((item) => item.partner_id === agent.id && ['queued', 'running'].includes(item.status));
    for (const item of pending) {
      item.status = 'cancelled';
      item.error = 'Agent retired before the task ran.';
      item.updated_at = at;
    }
    data.team = data.team.filter((item) => item.id !== agent.id);
    // Owner context this agent owned goes back to CHE until reassigned.
    for (const item of data.owner_context || []) {
      if (item.owner_agent_id !== agent.id) continue;
      item.owner_agent_id = '';
      item.owner_agent_name = 'CHE Office';
      item.updated_at = at;
    }
    return { retired: true };
  }
  if (action === 'upgrade') {
    agent.model_tier = 'strong';
  } else if (action === 'downgrade') {
    agent.model_tier = 'fast';
  } else if (action === 'reassign') {
    if (!Array.isArray(body.responsibilities)) return { error: 'Responsibilities list required.' };
    agent.responsibilities = body.responsibilities.map((item) => clip(item, 200)).filter(Boolean).slice(0, 12);
    if (body.role != null && clip(body.role, 80)) agent.role = clip(body.role, 80);
  } else if (action === 'keep') {
    agent.temporary = false;
  } else if (action && action !== 'edit') {
    return { error: 'Unknown agent action.' };
  }
  if (body.name != null && clip(body.name, 40)) agent.name = clip(body.name, 40);
  if (body.personality != null) agent.personality = clip(body.personality, 600) || agent.personality;
  if (body.specialty != null) agent.specialty = clip(body.specialty, 160);
  if (body.mission != null) agent.mission = clip(body.mission, 1200);
  agent.updated_at = at;
  return { agent };
}

// ─── War Room ────────────────────────────────────────────────────────────

const MEETING_ROLES = [
  { test: /market|trad|stock|crypto|futures|portfolio|price/, role: 'Market Intelligence Partner', specialty: 'markets, backtesting, risk and trading systems' },
  { test: /business|revenue|customer|sales|launch|pricing|budget|cash|advertis|marketing|campaign|media buying/, role: 'Business Operations Partner', specialty: 'planning, operations, leads, advertising, campaigns, billing and workflows' },
  { test: /design|brand|visual|video|image|music|creative|logo/, role: 'Creative Studio Partner', specialty: 'visual concepts, media production and creative assets' },
  { test: /app|code|build|software|website|api|feature/, role: 'Build + Operations Partner', specialty: 'implementation plans, engineering trade-offs and delivery' },
];

function pickParticipants(data, objective, agentIds) {
  const live = data.team.filter((item) => !item.retired);
  if (Array.isArray(agentIds) && agentIds.length) {
    return live.filter((item) => agentIds.includes(item.id)).slice(0, 5);
  }
  const text = objective.toLowerCase();
  const scored = live
    .map((agent) => {
      const words = `${agent.role} ${agent.specialty}`.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
      return { agent, score: words.filter((w) => text.includes(w)).length };
    })
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 4).map((item) => item.agent);
}

export function conveneMeeting(data, body) {
  const objective = clip(body.objective, 1200);
  if (!objective) return { error: 'War Room objective required.' };
  data.meetings = Array.isArray(data.meetings) ? data.meetings : [];
  let participants = pickParticipants(data, objective, body.agent_ids);
  const created = [];
  // A War Room needs at least two specialties. Staff only what the objective needs.
  const needed = [
    ...MEETING_ROLES.filter((rule) => rule.test.test(objective.toLowerCase())),
    { role: 'Research Partner', specialty: 'source gathering, verification and public research' },
    { role: 'Critical Reviewer', specialty: 'stress-testing plans, risks and weak assumptions' },
  ];
  for (const spec of needed) {
    if (participants.length >= 2) break;
    if (participants.some((item) => item.role === spec.role)) continue;
    let agent = data.team.find((item) => item.role === spec.role && !item.retired);
    if (!agent) {
      const made = createAgent(data, spec);
      if (made.error) continue;
      agent = made.agent;
      created.push(agent);
    }
    participants.push(agent);
  }
  participants = participants.slice(0, 5);
  const at = now();
  const meeting = {
    id: crypto.randomUUID(),
    objective,
    status: 'drafting',
    progress: 0.05,
    participants: participants.map((agent) => ({
      agent_id: agent.id,
      name: agent.name,
      role: agent.role,
      responsibility: `Own the ${agent.role.replace(/ Partner$/, '').toLowerCase()} slice of the objective.`,
    })),
    board: [{
      from: 'CHE',
      kind: 'brief',
      text: `Objective: ${objective}\nEveryone drafts your slice, then cross-check a teammate. I make the final call.`,
      at,
    }],
    decisions: [],
    conflicts: [],
    recommendations: [],
    final_plan: '',
    error: '',
    created_at: at,
    updated_at: at,
  };
  data.meetings.unshift(meeting);
  data.meetings = data.meetings.slice(0, 30);
  for (const agent of participants) {
    agent.runtime_status = 'meeting';
    agent.runtime_task = `War Room: ${objective.slice(0, 60)}`;
    agent.runtime_updated_at = at;
  }
  return { meeting, created };
}

export function meetingView(meeting) {
  return { ...meeting };
}

// ─── Execution (called from the Durable Object alarm) ───────────────────

function agentSystemPrompt(agent, extra) {
  return [
    `You are ${agent.name}, an AI agent on CHE's Office team. CHE is your manager; you never address the owner directly.`,
    `Role: ${agent.role}. Specialty: ${agent.specialty || 'general specialist work'}.`,
    `Personality (stay in character, briefly): ${agent.personality}`,
    agent.mission ? `Mission: ${agent.mission}` : '',
    agent.responsibilities?.length ? `Ongoing responsibilities: ${agent.responsibilities.join('; ')}` : '',
    'Deliver concrete, useful work: findings, decisions, risks, next actions. No filler.',
    'Never claim you searched the web, ran code, traded, paid, or contacted anyone. You only have your own reasoning here; label assumptions.',
    extra || '',
  ].filter(Boolean).join('\n');
}

function modelFor(env, agent, models) {
  return agent.model_tier === 'strong'
    ? (env.CHE_STRONG_MODEL || models.strong)
    : (env.CHE_FAST_MODEL || models.fast);
}

async function runModel(env, model, system, user, maxTokens) {
  const answer = await env.AI.run(model, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: String(user).slice(0, 16000) },
    ],
    max_tokens: maxTokens,
  });
  return modelText(answer);
}

// Runs one queued delegated task: agent works, CHE reviews, result recorded.
async function runOneTask(ctx) {
  const { env, load, save, notify, models } = ctx;
  let data = await load();
  if (data.autonomy === false) return false;
  const task = [...data.team_tasks].reverse().find((item) => item.status === 'queued' && (!item.retry_at || item.retry_at <= Date.now()));
  if (!task) return false;
  const agent = data.team.find((item) => item.id === task.partner_id);
  if (!agent) {
    task.status = 'failed';
    task.error = 'Agent no longer in the Office.';
    task.updated_at = now();
    await save(data);
    return true;
  }
  normalizeAgent(agent);
  task.status = 'running';
  task.updated_at = now();
  agent.runtime_status = workingStatusFor(agent);
  agent.runtime_task = clip(task.task, 80);
  agent.runtime_updated_at = now();
  await save(data);
  notify();

  let result = '';
  let error = '';
  try {
    result = clip(await runModel(env, modelFor(env, agent, models), agentSystemPrompt(agent),
      task.task, agent.model_tier === 'strong' ? 1400 : 800), 12000);
    if (!result) error = 'No result returned.';
  } catch (_) {
    error = 'Agent execution failed.';
  }

  data = await load();
  const t1 = data.team_tasks.find((item) => item.id === task.id);
  const a1 = data.team.find((item) => item.id === agent.id);
  if (!t1) return true;
  if (error) {
    t1.status = 'failed';
    t1.error = error;
    t1.updated_at = now();
    if (a1) {
      a1.runtime_status = 'idle';
      a1.runtime_task = null;
      a1.runtime_updated_at = now();
    }
    await save(data);
    notify();
    return true;
  }
  t1.status = 'reviewing';
  t1.result = result;
  t1.updated_at = now();
  if (a1) {
    a1.runtime_status = 'waiting';
    a1.runtime_task = 'Waiting on CHE review';
    a1.runtime_updated_at = now();
  }
  await save(data);
  notify();

  // CHE reviews every delegated result before it counts as done.
  let review = '';
  try {
    review = await runModel(env, env.CHE_FAST_MODEL || models.fast, [
      'You are CHE reviewing a delegated result from one of your Office agents.',
      'First line must be exactly APPROVED or NEEDS WORK.',
      'Then at most 3 short lines: what is solid, what is weak or unverified, what to do next.',
      'Do not invent facts. Unverifiable claims are weak.',
    ].join('\n'), JSON.stringify({ task: task.task, agent: agent.name, result }), 260);
  } catch (_) {
    review = '';
  }

  data = await load();
  const t2 = data.team_tasks.find((item) => item.id === task.id);
  const a2 = data.team.find((item) => item.id === agent.id);
  if (!t2) return true;
  const approved = /^\s*APPROVED\b/i.test(review);
  t2.status = 'complete';
  t2.che_review = clip(review, 2000) || 'CHE review unavailable; result not verified.';
  t2.verified_by_che = approved;
  t2.updated_at = now();
  if (a2) {
    a2.runtime_status = 'done';
    a2.runtime_task = clip(task.task, 80);
    a2.runtime_updated_at = now();
    a2.status = 'available';
    if (a2.temporary && !data.team_tasks.some((item) => item.partner_id === a2.id && item.status === 'queued')) {
      data.team = data.team.filter((item) => item.id !== a2.id);
    }
  }
  await save(data);
  notify();
  return true;
}

function parseSynthesis(text) {
  const match = /\{[\s\S]*\}/.exec(text);
  if (match) {
    try {
      const value = JSON.parse(match[0]);
      const list = (v) => (Array.isArray(v) ? v.map((item) => clip(typeof item === 'string' ? item : JSON.stringify(item), 400)).filter(Boolean).slice(0, 10) : []);
      return {
        decisions: list(value.decisions),
        conflicts: list(value.conflicts),
        recommendations: list(value.recommendations),
        final_plan: clip(value.final_plan, 8000),
      };
    } catch (_) { /* fall through to plain text */ }
  }
  return { decisions: [], conflicts: [], recommendations: [], final_plan: clip(text, 8000) };
}

function setParticipantStatus(data, meeting, status, task) {
  for (const p of meeting.participants) {
    const agent = data.team.find((item) => item.id === p.agent_id);
    if (!agent) continue;
    agent.runtime_status = status;
    agent.runtime_task = task;
    agent.runtime_updated_at = now();
  }
}

// Advances one War Room by one phase. Each phase is a real set of model calls.
async function advanceMeeting(ctx) {
  const { env, load, save, notify, models } = ctx;
  let data = await load();
  data.meetings = Array.isArray(data.meetings) ? data.meetings : [];
  const meeting = data.meetings.find((item) => ['drafting', 'cross_check', 'synthesizing'].includes(item.status));
  if (!meeting) return false;
  const participants = meeting.participants
    .map((p) => ({ p, agent: data.team.find((item) => item.id === p.agent_id) }))
    .filter((item) => item.agent)
    .map((item) => ({ ...item, agent: normalizeAgent(item.agent) }));
  const phase = meeting.status;

  const finish = async (mutate) => {
    data = await load();
    const m = (data.meetings || []).find((item) => item.id === meeting.id);
    if (!m) return;
    mutate(data, m);
    m.updated_at = now();
    await save(data);
    notify();
  };

  if (!participants.length) {
    await finish((_, m) => {
      m.status = 'failed';
      m.error = 'No agents were available for this War Room.';
    });
    return true;
  }

  if (phase === 'drafting') {
    setParticipantStatus(data, meeting, 'meeting', `War Room: ${meeting.objective.slice(0, 60)}`);
    await save(data);
    notify();
    const drafts = await Promise.all(participants.map(async ({ p, agent }) => {
      try {
        const text = await runModel(env, modelFor(env, agent, models),
          agentSystemPrompt(agent, `You are in a War Room chaired by CHE. Your responsibility: ${p.responsibility}`),
          `Objective: ${meeting.objective}\nDraft your slice: key findings, proposal, risks, open questions. Under 220 words.`, 600);
        return { from: agent.name, agent_id: agent.id, kind: 'draft', text: clip(text, 4000) || '(no draft returned)', at: now() };
      } catch (_) {
        return { from: agent.name, agent_id: agent.id, kind: 'draft', text: '(draft failed)', failed: true, at: now() };
      }
    }));
    await finish((d, m) => {
      m.board.push(...drafts);
      m.status = 'cross_check';
      m.progress = 0.4;
      setParticipantStatus(d, m, 'reviewing', 'Cross-checking a teammate');
    });
    return true;
  }

  if (phase === 'cross_check') {
    const drafts = meeting.board.filter((item) => item.kind === 'draft' && !item.failed);
    // Round-robin: each agent reviews the next teammate's draft.
    const critiques = drafts.length < 2 ? [] : await Promise.all(participants.map(async ({ agent }) => {
      const own = drafts.findIndex((item) => item.agent_id === agent.id);
      if (own < 0) return null;
      const target = drafts[(own + 1) % drafts.length];
      try {
        const text = await runModel(env, modelFor(env, agent, models),
          agentSystemPrompt(agent, 'You are cross-checking a teammate in the War Room. Challenge weak assumptions directly but constructively, in character.'),
          `Objective: ${meeting.objective}\n${target.from}'s draft:\n${target.text}\n\nReply to ${target.from}: what holds up, what is weak or missing, and one concrete fix. Under 120 words.`, 350);
        return { from: agent.name, agent_id: agent.id, to: target.from, kind: 'critique', text: clip(text, 3000), at: now() };
      } catch (_) {
        return null;
      }
    }));
    await finish((d, m) => {
      m.board.push(...critiques.filter(Boolean));
      m.status = 'synthesizing';
      m.progress = 0.7;
      setParticipantStatus(d, m, 'waiting', 'Waiting on CHE synthesis');
    });
    return true;
  }

  // synthesizing — CHE chairs and makes the final call.
  let synthesis;
  try {
    const text = await runModel(env, env.CHE_STRONG_MODEL || models.strong, [
      'You are CHE, chairing your War Room. Combine your agents\' drafts and cross-checks into one decision-ready result for the owner.',
      'Resolve conflicts explicitly; keep what survived the cross-check; drop weak claims.',
      'Return ONLY JSON: {"decisions":[string],"conflicts":[string],"recommendations":[string],"final_plan":string}.',
      'final_plan is a concise numbered plan with owners (agent names) where useful. Label assumptions; do not invent facts.',
    ].join('\n'), JSON.stringify({ objective: meeting.objective, board: meeting.board.map(({ from, to, kind, text }) => ({ from, to, kind, text })) }), 1400);
    synthesis = parseSynthesis(text);
  } catch (_) {
    synthesis = null;
  }
  await finish((d, m) => {
    if (!synthesis || !synthesis.final_plan) {
      m.status = 'failed';
      m.error = 'CHE could not synthesize the War Room result.';
      setParticipantStatus(d, m, 'idle', null);
      return;
    }
    Object.assign(m, synthesis);
    m.board.push({ from: 'CHE', kind: 'synthesis', text: synthesis.final_plan, at: now() });
    m.status = 'complete';
    m.progress = 1;
    setParticipantStatus(d, m, 'done', `War Room done: ${m.objective.slice(0, 50)}`);
  });
  return true;
}

// Does a bounded slice of agent work. Returns true if more work remains.
export async function processAgentWork(ctx, budget = 6) {
  for (let i = 0; i < budget; i++) {
    if ((await ctx.load()).autonomy === false) return false;
    const did = (await advanceMeeting(ctx)) || (await runOneTask(ctx));
    if (!did) return false;
  }
  const data = await ctx.load();
  return data.team_tasks.some((item) => item.status === 'queued') ||
    (data.meetings || []).some((item) => ['drafting', 'cross_check', 'synthesizing'].includes(item.status));
}

// Stale "running" work (e.g. the Durable Object was evicted mid-call) goes
// back to the queue so status never claims work that is no longer happening.
export function recoverStaleWork(data, maxAgeMs = 5 * 60_000) {
  let changed = false;
  const cutoff = Date.now() - maxAgeMs;
  for (const task of data.team_tasks) {
    if (['running', 'reviewing'].includes(task.status) && Date.parse(task.updated_at) < cutoff) {
      task.status = 'queued';
      task.updated_at = now();
      changed = true;
    }
  }
  return changed;
}

