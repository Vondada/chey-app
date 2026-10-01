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

import { classifyItem, extractCandidateMemories } from './privacy_policy.js';
import { agentActionGuard, isLaAgenciaAgent, officeToolBlocker } from './office_company.js';
import { isResearchStyleJob, writeResearchMemoryNote } from './research_memory.js';
import { codexThreadId } from './office_router.js';
import { assertAgentMayRun, permissionBlocker } from './agent_permissions.js';

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
  Iris: 'Ad-minded creative. Tight headlines, clear CTAs, honest about missing brand assets.',
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
  agent.workspace = agent.workspace && typeof agent.workspace === 'object' ? agent.workspace : {
    notes: [],
    files: [],
    browser_session: '',
    updated_at: now(),
  };
  agent.messages = Array.isArray(agent.messages) ? agent.messages.slice(-60) : [];
  agent.skill_ids = Array.isArray(agent.skill_ids) ? agent.skill_ids.slice(0, 40) : [];
  agent.model_tier = agent.model_tier === 'strong' ? 'strong' : 'fast';
  agent.temporary = Boolean(agent.temporary);
  // Provider-neutral employee profile: CHE owns the agent; the provider and
  // model are only preferences the capability router may honor or replace.
  agent.provider_preference = clip(agent.provider_preference, 40).toLowerCase();
  agent.model_preference = clip(agent.model_preference, 160);
  agent.capability_requirements = Array.isArray(agent.capability_requirements)
    ? agent.capability_requirements.map((item) => clip(item, 40)).filter(Boolean).slice(0, 8)
    : [];
  agent.permissions = Array.isArray(agent.permissions)
    ? agent.permissions.map((item) => clip(item, 60)).filter(Boolean).slice(0, 16)
    : ['office_workspace', 'che_memory_read_filtered'];
  agent.handoff_history = Array.isArray(agent.handoff_history) ? agent.handoff_history.slice(-30) : [];
  agent.memory_refs = Array.isArray(agent.memory_refs) ? agent.memory_refs.slice(-40) : [];
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
    provider_preference: spec.provider_preference,
    model_preference: spec.model_preference,
    capability_requirements: spec.capability_requirements,
    permissions: spec.permissions,
    kind_detail: clip(spec.kind_detail, 120),
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

// Where an agent is in CHE's app world, from real runtime state: working in
// the room that fits the assignment, or on a break in a social space.
export const WORLD_ROOMS = ['office', 'studio', 'gallery', 'music', 'lounge', 'theater'];

export function agentLocation(agent, now = Date.now(), theaterUntil = 0) {
  const status = agent.runtime_status || 'idle';
  const text = `${agent.runtime_task || ''} ${agent.role || ''} ${agent.specialty || ''}`.toLowerCase();
  const working = !['idle', 'done', 'offline'].includes(status);
  if (working) {
    if (status === 'meeting') return { room: 'office', activity: 'meeting', working: true };
    if (/\b(?:dj|playlist|song|music|beat|mix|track|album)\b/.test(text)) return { room: 'music', activity: /\bdj|playlist|play\b/.test(text) ? 'djing' : 'composing', working: true };
    if (/\b(?:art|paint|draw|illustrat|image|logo|gallery|portrait)\b/.test(text)) return { room: 'gallery', activity: 'making_art', working: true };
    if (/\b(?:video|film|design|creative|studio|brand|visual)\b/.test(text)) return { room: 'studio', activity: 'creating', working: true };
    return { room: 'office', activity: status, working: true };
  }
  if (status === 'offline') return { room: 'office', activity: 'offline', working: false };
  // While the owner watches something in CHE's Theater, free agents join
  // him in the seats. (They see the room, not the video.)
  if (Number(theaterUntil) > now) return { room: 'theater', activity: 'watching_with_you', working: false };
  // Breaks rotate every ~20 minutes, differently per agent.
  const slot = Math.floor(now / (20 * 60_000)) + hashOf(agent.id || agent.name);
  const breakRooms = ['lounge', 'studio', 'gallery', 'music', 'lounge', 'office'];
  const room = breakRooms[slot % breakRooms.length];
  return { room, activity: room === 'office' ? 'idle' : 'on_break', working: false };
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
    location: agentLocation({ ...agent, runtime_status: status }, Date.now(), Number(data?.theater_watching_until || 0)),
    latest_assignment: (() => {
      const latest = (data.team_tasks || []).find((item) => item.partner_id === agent.id);
      return latest ? { id: latest.id, task: clip(latest.task, 120), status: latest.status, queued_at: latest.created_at } : null;
    })(),
    workspace: {
      notes: Array.isArray(agent.workspace?.notes) ? agent.workspace.notes.length : 0,
      files: Array.isArray(agent.workspace?.files) ? agent.workspace.files.length : 0,
      browser_session: Boolean(agent.workspace?.browser_session),
    },
    learned_skills: Array.isArray(agent.skill_ids) ? agent.skill_ids.length : 0,
    temporary: agent.temporary,
    provider_preference: agent.provider_preference || 'auto',
    model_preference: agent.model_preference || 'auto',
    capability_requirements: agent.capability_requirements,
    permissions: agent.permissions,
    memory_refs: agent.memory_refs.length,
    handoffs: agent.handoff_history.length,
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
        provider_trail: Array.isArray(item.provider_trail) ? item.provider_trail.slice(-10) : [],
        handoffs: Array.isArray(item.handoffs) ? item.handoffs.slice(-10) : [],
        created_at: item.created_at,
        updated_at: item.updated_at,
      })),
    handoff_history: agent.handoff_history.slice(-20),
    meetings: (data.meetings || [])
      .filter((item) => item.participants.some((p) => p.agent_id === agent.id))
      .slice(0, 10)
      .map(meetingSummary),
  };
}

export function queueAgentTask(data, agent, task, source = 'owner', options = {}) {
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
    prior_result: '',
    review_feedback: '',
    revision_count: 0,
    steering: [],
    steering_version: 0,
    handoffs: [],
    use_computer: options.use_computer === true,
    owner_approved_computer: options.owner_approved_computer === true,
    computer_permissions: Array.isArray(options.computer_permissions)
      ? options.computer_permissions.map((item) => clip(item, 80)).filter(Boolean).slice(0, 12)
      : [],
    teach_as_skill: clip(options.teach_as_skill, 80),
    // Provider-neutral envelope: context, artifacts, citations and history
    // travel with the task, whichever provider family works on it next.
    context_items: Array.isArray(options.context_items) ? options.context_items.slice(0, 16) : null,
    artifacts: Array.isArray(options.artifacts) ? options.artifacts.slice(0, 20) : [],
    citations: [],
    provider_trail: [],
    job_id: clip(options.job_id, 80),
    // Job kind (e.g. merge, spend, payout) is checked against the agent's
    // permission flags before the job runs.
    kind: clip(options.kind, 40),
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


function ensureSkillStore(data) {
  data.office_skills = Array.isArray(data.office_skills) ? data.office_skills : [];
  return data.office_skills;
}

export function teachOfficeSkill(data, body = {}) {
  const name = clip(body.name, 80);
  const trigger = clip(body.trigger || body.when, 240);
  const steps = Array.isArray(body.steps)
    ? body.steps.map((item) => clip(item, 500)).filter(Boolean).slice(0, 20)
    : [];
  if (!name || !trigger || !steps.length) return { error: 'Skill name, trigger, and at least one step are required.' };
  // Skills describe workflow and capabilities, never "always use model X";
  // the router picks the best available provider when the skill runs.
  const neutralSteps = steps.map(neutralizeProviderMentions);
  const capabilities = Array.isArray(body.capabilities)
    ? body.capabilities.map((item) => clip(item, 40)).filter(Boolean).slice(0, 8)
    : inferSkillCapabilities(`${name} ${trigger} ${steps.join(' ')}`);
  const store = ensureSkillStore(data);
  const id = clip(body.id, 80) || crypto.randomUUID();
  const existing = store.find((item) => item.id === id || item.name.toLowerCase() === name.toLowerCase());
  const skill = existing || { id, created_at: now() };
  Object.assign(skill, {
    name,
    trigger,
    steps: neutralSteps,
    capabilities,
    provider_neutral: true,
    notes: clip(body.notes, 1200),
    updated_at: now(),
    uses: Number(skill.uses || 0),
  });
  if (!existing) store.unshift(skill);
  data.office_skills = store.slice(0, 120);
  return { skill };
}

export function officeSkillsView(data) {
  return ensureSkillStore(data).map((skill) => ({
    id: skill.id,
    name: skill.name,
    trigger: skill.trigger,
    steps: skill.steps,
    capabilities: Array.isArray(skill.capabilities) ? skill.capabilities : [],
    provider_neutral: skill.provider_neutral !== false,
    notes: skill.notes || '',
    uses: Number(skill.uses || 0),
    created_at: skill.created_at,
    updated_at: skill.updated_at,
  }));
}

const PROVIDER_WORDS = /\b(?:always\s+)?use\s+(?:the\s+)?(?:gpt[-\w.]*|chatgpt|openai|grok[-\w.]*|xai|gemini[-\w.]*|claude[-\w.]*|anthropic|llama[-\w.]*|mistral[-\w.]*|ollama)(?:\s+model)?\b/gi;

export function neutralizeProviderMentions(step) {
  return String(step || '').replace(PROVIDER_WORDS, 'use the best available model for this step');
}

function inferSkillCapabilities(text) {
  const lower = String(text).toLowerCase();
  const caps = [];
  if (/research|source|search|find/.test(lower)) caps.push('deep_reasoning');
  if (/code|build|implement|debug|test/.test(lower)) caps.push('coding');
  if (/image|logo|visual/.test(lower)) caps.push('image_generation');
  if (/document|pdf|file/.test(lower)) caps.push('file_analysis');
  return caps.length ? caps : ['text'];
}

function matchedOfficeSkills(data, task, max = 3) {
  const text = String(task || '').toLowerCase();
  const words = new Set(text.split(/[^a-z0-9]+/).filter((item) => item.length > 2));
  const scored = ensureSkillStore(data).map((skill) => {
    const hay = `${skill.name} ${skill.trigger}`.toLowerCase();
    let score = text.includes(String(skill.trigger || '').toLowerCase()) ? 8 : 0;
    for (const word of words) if (hay.includes(word)) score += 1;
    return { skill, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, max);
  return scored.map((item) => item.skill);
}

export function steerAgentTask(data, taskId, instruction) {
  const task = data.team_tasks.find((item) => item.id === taskId);
  if (!task) return { error: 'Office task not found.' };
  if (['complete', 'failed', 'cancelled'].includes(task.status)) return { error: 'That task is already finished.' };
  const text = clip(instruction, 1200);
  if (!text) return { error: 'Steering instruction required.' };
  task.steering = Array.isArray(task.steering) ? task.steering : [];
  task.steering.push({ text, at: now() });
  task.steering = task.steering.slice(-12);
  task.steering_version = Number(task.steering_version || 0) + 1;
  task.updated_at = now();
  return { task };
}

export function handoffAgentTask(data, taskId, targetAgentId, note = '') {
  const task = data.team_tasks.find((item) => item.id === taskId);
  if (!task) return { error: 'Office task not found.' };
  if (['complete', 'failed', 'cancelled'].includes(task.status)) return { error: 'That task is already finished.' };
  const target = data.team.find((item) => item.id === targetAgentId && !item.retired);
  if (!target) return { error: 'Target agent not found.' };
  const from = data.team.find((item) => item.id === task.partner_id);
  task.handoffs = Array.isArray(task.handoffs) ? task.handoffs : [];
  const handoff = {
    from_agent_id: task.partner_id,
    from_agent_name: task.partner_name,
    from_provider: from?.provider_preference || task.provider_trail?.slice(-1)[0]?.provider || 'auto',
    to_agent_id: target.id,
    to_agent_name: target.name,
    to_provider: target.provider_preference || 'auto',
    note: clip(note, 1200),
    carried: {
      prior_result: Boolean(task.result || task.prior_result),
      review_feedback: Boolean(task.review_feedback),
      steering: (task.steering || []).length,
      context_items: Array.isArray(task.context_items) ? task.context_items.length : 0,
      artifacts: (task.artifacts || []).length,
      citations: (task.citations || []).length,
    },
    at: now(),
  };
  task.handoffs.push(handoff);
  // The next worker builds on everything done so far.
  if (task.result && !task.prior_result) task.prior_result = task.result;
  for (const agent of [from, target]) {
    if (!agent) continue;
    normalizeAgent(agent);
    agent.handoff_history.push({ task_id: task.id, from: handoff.from_agent_name, to: handoff.to_agent_name, from_provider: handoff.from_provider, to_provider: handoff.to_provider, at: handoff.at });
    agent.handoff_history = agent.handoff_history.slice(-30);
  }
  task.handoffs = task.handoffs.slice(-20);
  task.partner_id = target.id;
  task.partner_name = target.name;
  task.role = target.role;
  task.status = 'queued';
  task.updated_at = now();
  target.runtime_status = 'waiting';
  target.runtime_task = clip(task.task, 80);
  target.runtime_updated_at = now();
  if (from) {
    from.runtime_status = 'idle';
    from.runtime_task = null;
    from.runtime_updated_at = now();
  }
  return { task, target };
}

async function runComputerWorkspace(env, agent, task, fetcher = fetch) {
  const endpoint = String(env.CHE_COMPUTER_URL || '').trim();
  if (!endpoint || !task.use_computer) return null;
  if (!task.owner_approved_computer) {
    return { status: 'approval_required', detail: 'Computer use was requested but not owner-approved.' };
  }
  let url;
  try {
    url = new URL(endpoint);
    if (url.protocol !== 'https:') throw new Error('https required');
  } catch (_) {
    return { status: 'unavailable', detail: 'CHE_COMPUTER_URL must be a valid HTTPS endpoint.' };
  }
  const response = await fetcher(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.CHE_COMPUTER_TOKEN ? { Authorization: `Bearer ${env.CHE_COMPUTER_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      workspace_id: `che-agent:${agent.id}`,
      agent: { id: agent.id, name: agent.name, role: agent.role },
      task: task.task,
      steering: Array.isArray(task.steering) ? task.steering : [],
      permissions: task.computer_permissions || [],
      owner_approved: true,
      mode: 'persistent_cloud_computer',
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const raw = (await response.text()).slice(0, 24000);
  let data;
  try { data = JSON.parse(raw); } catch (_) { data = { detail: raw }; }
  if (!response.ok) return { status: 'failed', detail: clip(data?.detail || raw || `HTTP ${response.status}`, 1200) };
  return { status: 'ok', data };
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
  } else if (action === 'set_provider') {
    agent.provider_preference = clip(body.provider, 40).toLowerCase();
    agent.model_preference = clip(body.model, 160);
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
  { test: /app|code|build|software|website|api|feature|roblox|luau|ugc|game pass/, role: 'Build + Operations Partner', specialty: 'implementation plans, engineering trade-offs, delivery, and Roblox/Luau experience drafts' },
  { test: /roblox|luau|ugc|game pass|roblox clothing|roblox weapon/, role: 'Roblox Experience Partner', specialty: 'Roblox games, weapons, clothing/UGC, avatars, passes — Luau drafts and publish checklists; owner confirm before upload/spend' },
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
    `You are ${agent.name}, an AI agent on CHE's Office team. CHE is the Office Boss and your manager; you never address the owner directly. Report to CHE, accept steering, and hand finished work back for CHE review.`,
    `Role: ${agent.role}. Specialty: ${agent.specialty || 'general specialist work'}.`,
    `Personality (stay in character, briefly): ${agent.personality}`,
    agent.mission ? `Mission: ${agent.mission}` : '',
    agent.responsibilities?.length ? `Ongoing responsibilities: ${agent.responsibilities.join('; ')}` : '',
    agent.workspace?.notes?.length ? `Persistent workspace notes: ${agent.workspace.notes.slice(-8).join(' | ')}` : '',
    agent.messages?.length ? `Recent Office messages: ${agent.messages.slice(-8).map((m) => `${m.from}: ${m.text}`).join(' | ')}` : '',
    'Deliver concrete, useful work: findings, decisions, risks, next actions. No filler.',
    'Use verified prior results as evidence when they are relevant. Compare patterns, combine compatible lessons, and explain why the combination makes sense.',
    'Never promote an unverified prior result, memory, estimate or hypothesis into a fact.',
    'If a task asks for a backtest, benchmark, live quote, account number or measured result, use only supplied tool/connector output. If none exists, give the test method and label it UNTESTED instead of inventing numbers.',
    'Never claim you searched the web, ran code, traded, paid, or contacted anyone. You only have your own reasoning here unless a connected result is included; label assumptions.',
    extra || '',
  ].filter(Boolean).join('\n');
}

function modelFor(env, agent, models) {
  return agent.model_tier === 'strong'
    ? (env.CHE_STRONG_MODEL || models.strong)
    : (env.CHE_FAST_MODEL || models.fast);
}

// Routing hints for an Office agent: the capability router honors the
// agent's provider/model preference when that provider is healthy and
// authorized, and falls back otherwise. Context items are filtered per
// provider inside the router, so a handoff to another family re-filters them.
export function routingForAgent(agent, data, task = null, route = 'office') {
  const privacy = data?.ai_layer?.privacy || {};
  const permissions = Object.fromEntries(Object.entries(privacy).map(([id, value]) => [id, value?.allowed || []]));
  // 'auto' means let ai_router pick (Groq/Gemini/Cerebras/…); do not pin a fake provider id.
  const pref = String(agent?.provider_preference || '').trim().toLowerCase();
  const modelPref = String(agent?.model_preference || '').trim();
  const realProvider = pref && pref !== 'auto' ? pref : '';
  const realModel = modelPref && modelPref.toLowerCase() !== 'auto' ? modelPref : '';
  return {
    ...(realProvider ? { che_provider: realProvider } : {}),
    ...(realProvider && realModel ? { che_model: realModel } : {}),
    ...(agent?.capability_requirements?.[0] ? { che_capability: agent.capability_requirements[0] } : {}),
    ...(data?.ai_layer?.policy?.local_only ? { che_local_only: true } : {}),
    ...(task?.context_items?.length ? { che_context: { items: task.context_items, permissions } } : {}),
    // Every Office model call goes through CHE's router tagged with the agent
    // and a stable per-job thread: office/<agentId>/<jobId>.
    ...(agent ? { che_agent_id: officeAgentId(agent) } : {}),
    ...(agent && task ? { che_thread_id: codexThreadId(officeAgentId(agent), task.job_id || task.id) } : {}),
    che_audit: {
      task: clip(task?.task || route, 160),
      agent: agent ? `${agent.name} (${agent.role})` : 'CHE',
      route,
    },
  };
}

// La Agencia agents are addressed by their lowercase name (knox); others by id.
export function officeAgentId(agent) {
  return isLaAgenciaAgent(agent) ? String(agent.name).toLowerCase() : String(agent?.id || '');
}

async function runModelDetailed(env, model, system, user, maxTokens, routing = {}) {
  const answer = await env.AI.run(model, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: String(user).slice(0, 16000) },
    ],
    max_tokens: maxTokens,
    ...routing,
  });
  return { text: modelText(answer), engine: String(answer?.engine || ''), model: String(answer?.model || '') };
}

async function runModel(env, model, system, user, maxTokens, routing = {}) {
  return (await runModelDetailed(env, model, system, user, maxTokens, routing)).text;
}

// Builds CHE's canonical context items for a task from pgvector recall.
// Secrets never enter; the router later sends each provider only the classes
// it may receive.
export function contextItemsFrom(matches = []) {
  return matches.map((match) => {
    const text = clip(`${match.title ? `${match.title}: ` : ''}${match.content || ''}`, 700);
    const dataClass = classifyItem(match);
    return { id: clip(match.id || match.external_id, 120), section: clip(match.kind || 'knowledge', 40), data_class: dataClass, text };
  }).filter((item) => item.text && item.data_class !== 'secret').slice(0, 12);
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
  // Permission flags are checked before any work runs: an agent without
  // can_merge_code / can_spend_money / can_open_payouts is refused in code.
  try {
    assertAgentMayRun(agent, task);
  } catch (error) {
    task.status = 'blocked';
    task.error = permissionBlocker(agent, error);
    task.updated_at = now();
    agent.runtime_status = 'available';
    agent.runtime_task = '';
    agent.runtime_updated_at = now();
    await save(data);
    return true;
  }
  // A La Agencia job whose tool has no owner credential on the server stops
  // here with an honest blocker; CHE reads it aloud from the board.
  const blocker = agentActionGuard(agent, task.task) || (isLaAgenciaAgent(agent) ? officeToolBlocker(env, agent) : '');
  if (blocker) {
    task.status = 'blocked';
    task.error = blocker;
    task.updated_at = now();
    agent.runtime_status = 'offline';
    agent.runtime_task = blocker;
    agent.runtime_updated_at = now();
    await save(data);
    notify();
    return true;
  }
  task.status = 'running';
  task.updated_at = now();
  agent.runtime_status = workingStatusFor(agent);
  agent.runtime_task = clip(task.task, 80);
  agent.runtime_updated_at = now();
  await save(data);
  notify();

  let result = '';
  let error = '';
  let retryable = false;
  const startSteeringVersion = Number(task.steering_version || 0);
  const skills = matchedOfficeSkills(data, task.task);
  for (const skill of skills) {
    skill.uses = Number(skill.uses || 0) + 1;
    skill.updated_at = now();
    if (!agent.skill_ids.includes(skill.id)) agent.skill_ids.push(skill.id);
  }
  const computer = await runComputerWorkspace(env, agent, task);
  // pgvector context is gathered once and stored on the task envelope so it
  // survives handoffs between provider families.
  if (!Array.isArray(task.context_items) && typeof ctx.recall === 'function') {
    try {
      const recall = await ctx.recall(task.task);
      const items = contextItemsFrom(recall?.matches || []);
      const fresh = await load();
      const stored = fresh.team_tasks.find((item) => item.id === task.id);
      if (stored) {
        stored.context_items = items;
        await save(fresh);
      }
      task.context_items = items;
    } catch (_) {
      task.context_items = [];
    }
  }
  const steeringText = (task.steering || []).map((item) => item.text).filter(Boolean).join('\n- ');
  const verifiedHistory = (data.team_tasks || [])
    .filter((item) => item.id !== task.id && item.partner_id === agent.id && item.verified_by_che === true && item.result)
    .slice(0, 6)
    .map((item) => ({ task: clip(item.task, 220), result: clip(item.result, 1200) }));
  const workContext = [
    task.prior_result ? `PRIOR WORK TO PRESERVE OR IMPROVE:\n${task.prior_result}` : '',
    task.review_feedback ? `CHE REVIEW FEEDBACK TO FIX:\n${task.review_feedback}` : '',
    steeringText ? `OWNER STEERING RECEIVED:\n- ${steeringText}` : '',
    verifiedHistory.length ? `VERIFIED PAST RESULTS — use only when relevant; compare and recombine proven patterns, never copy blindly:\n${verifiedHistory.map((item) => `- ${item.task}: ${item.result}`).join('\n')}` : '',
    skills.length ? `REUSABLE OFFICE SKILLS:\n${skills.map((skill) => `${skill.name}: ${skill.steps.join(' -> ')}`).join('\n')}` : '',
    computer ? `CONNECTED COMPUTER RESULT:\n${JSON.stringify(computer).slice(0, 16000)}` : '',
  ].filter(Boolean).join('\n\n');
  let worker = { engine: '', model: '' };
  try {
    const detailed = await runModelDetailed(
      env,
      modelFor(env, agent, models),
      agentSystemPrompt(agent, workContext),
      task.task,
      agent.model_tier === 'strong' ? 1800 : 1100,
      routingForAgent(agent, data, task),
    );
    result = clip(detailed.text, 16000);
    worker = { engine: detailed.engine, model: detailed.model };
    if (!result) error = 'No result returned.';
  } catch (failure) {
    error = String(failure?.message || failure).slice(0, 1000);
    retryable = Boolean(failure?.quota || /quota|busy|overload|429|resting|cooldown|budget|neurons|timeout|abort/i.test(error));
    console.log('CHE Office error:', task.id, error);
  }

  data = await load();
  const t1 = data.team_tasks.find((item) => item.id === task.id);
  const a1 = data.team.find((item) => item.id === agent.id);
  if (!t1) return true;
  if (!error && Number(t1.steering_version || 0) > startSteeringVersion) {
    t1.prior_result = result;
    t1.status = 'queued';
    t1.updated_at = now();
    if (a1) {
      a1.runtime_status = 'waiting';
      a1.runtime_task = 'Owner redirected the task';
      a1.runtime_updated_at = now();
    }
    await save(data);
    notify();
    return true;
  }
  if (error) {
    const retry = retryable && (t1.retry_count || 0) < 24;
    t1.status = retry ? 'queued' : 'failed';
    t1.retry_count = (t1.retry_count || 0) + (retry ? 1 : 0);
    t1.retry_at = retry ? Date.now() + 300000 : null;
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
  t1.provider_trail = Array.isArray(t1.provider_trail) ? t1.provider_trail : [];
  t1.provider_trail.push({ agent: agent.name, provider: worker.engine || 'unknown', model: worker.model || '', at: now() });
  t1.provider_trail = t1.provider_trail.slice(-20);
  if (a1 && Array.isArray(t1.context_items)) {
    normalizeAgent(a1);
    a1.memory_refs = [...new Set([...a1.memory_refs, ...t1.context_items.map((item) => item.id).filter(Boolean)])].slice(-40);
  }
  // Useful knowledge from any provider comes back into CHE's memory review
  // queue, never straight into owner memory.
  const candidates = extractCandidateMemories(result, { provider: worker.engine, task: task.task });
  if (candidates.length) {
    data.memory_candidates = [...candidates, ...(Array.isArray(data.memory_candidates) ? data.memory_candidates : [])].slice(0, 60);
  }
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
      'You are CHE, Office Boss, reviewing a delegated result from one of your Office agents. You own the outcome: accept solid work, reject weak or unverified claims.',
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
  t2.che_review = clip(review, 2000) || 'CHE review unavailable; result not verified.';
  t2.verified_by_che = approved;
  t2.updated_at = now();

  if (!approved && review && Number(t2.revision_count || 0) < 2) {
    t2.prior_result = result;
    t2.review_feedback = clip(review, 1800);
    t2.revision_count = Number(t2.revision_count || 0) + 1;
    t2.status = 'queued';
    if (a2) {
      a2.runtime_status = 'waiting';
      a2.runtime_task = `Repair pass ${t2.revision_count}`;
      a2.runtime_updated_at = now();
    }
    await save(data);
    notify();
    return true;
  }

  t2.status = 'complete';
  // Research / opportunity scout → Durable Object memory notes (owner-visible).
  if (isResearchStyleJob(t2, a2 || agent)) {
    const written = writeResearchMemoryNote(data, {
      result: t2.result || result,
      task: t2,
      agent: a2 || agent,
      sources: Array.isArray(t2.citations) ? t2.citations : [],
    });
    if (written.written) {
      t2.memory_note_id = written.note.id;
      t2.memory_written = true;
    }
  }
  if (approved && t2.teach_as_skill) {
    const skill = teachOfficeSkill(data, {
      name: t2.teach_as_skill,
      trigger: t2.task,
      steps: [
        'Review the stored prior result and owner goal.',
        'Repeat the proven workflow using current inputs and permissions.',
        'Return the result to CHE for independent review before completion.',
      ],
      notes: clip(result, 1200),
    }).skill;
    if (skill && a2 && !a2.skill_ids.includes(skill.id)) a2.skill_ids.push(skill.id);
  }
  if (a2) {
    a2.workspace.notes = Array.isArray(a2.workspace?.notes) ? a2.workspace.notes : [];
    if (approved) {
      a2.workspace.notes.push(clip(`CHE-VERIFIED: ${task.task} | ${result}`, 700));
      a2.workspace.notes = a2.workspace.notes.slice(-30);
    }
    a2.workspace.updated_at = now();
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
          `Objective: ${meeting.objective}\nDraft your slice: key findings, proposal, risks, open questions. Under 220 words.`, 600,
          routingForAgent(agent, data, { task: meeting.objective }, 'war_room'));
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
          `Objective: ${meeting.objective}\n${target.from}'s draft:\n${target.text}\n\nReply to ${target.from}: what holds up, what is weak or missing, and one concrete fix. Under 120 words.`, 350,
          routingForAgent(agent, data, { task: meeting.objective }, 'war_room_review'));
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

