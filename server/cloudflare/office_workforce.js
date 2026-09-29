// CHE Office workforce across provider families.
//
// "Grok employees", "OpenAI researchers", "Llama analysts" are ordinary CHE
// Office agents whose provider/model preference points at that family. They
// are virtual CHE employees — never consumer accounts at the provider. Roles
// are generated dynamically from (provider family × specialty), not hard-coded
// classes, and temporary specialists retire themselves after their task.

import { conveneMeeting, createAgent, queueAgentTask } from './agent_runtime.js';
import { planPairedJob, providerLabel } from './capability_router.js';
import { accountsView, manifestById, providerConnection } from './provider_registry.js';

const SPECIALTIES = {
  research: { title: 'Researcher', capability: 'deep_reasoning', specialty: 'source gathering, verification and research synthesis' },
  reasoning: { title: 'Reasoning Specialist', capability: 'deep_reasoning', specialty: 'hard reasoning, planning and trade-off analysis' },
  coding: { title: 'Coding Specialist', capability: 'coding', specialty: 'implementation, debugging and code review' },
  creative: { title: 'Creative Specialist', capability: 'text', specialty: 'ideas, writing, concepts and creative direction' },
  analysis: { title: 'Analyst', capability: 'deep_reasoning', specialty: 'comparing results, data and evidence' },
  review: { title: 'QA/Security Reviewer', capability: 'deep_reasoning', specialty: 'quality, security and correctness review' },
};

export function specialtyFrom(text) {
  const lower = String(text || '').toLowerCase();
  if (/cod|program|engineer|develop|implement/.test(lower)) return 'coding';
  if (/creativ|writ|design|story|idea/.test(lower)) return 'creative';
  if (/reason|think|logic|plan|strateg/.test(lower)) return 'reasoning';
  if (/review|qa|security|audit/.test(lower)) return 'review';
  if (/analy|compar/.test(lower)) return 'analysis';
  return 'research';
}

export function providerFrom(text) {
  const lower = String(text || '').toLowerCase();
  if (/\bgrok\b|\bxai\b|x\.ai/.test(lower)) return 'xai';
  if (/\bgpt\b|openai|chatgpt/.test(lower)) return 'openai';
  if (/gemini|google/.test(lower)) return 'gemini';
  if (/claude|anthropic/.test(lower)) return 'anthropic';
  if (/llama|hugging ?face/.test(lower)) return 'huggingface';
  if (/local|ollama|on[- ]device|offline/.test(lower)) return 'ollama';
  return '';
}

// Creates a provider-backed Office employee (e.g. "Grok Coding Specialist").
export function createProviderEmployee(env, data, { provider, specialty = 'research', model = '', temporary = false, task = '', name = '' }) {
  const manifest = manifestById(data, provider);
  if (!manifest) return { error: `I don't know a provider called ${provider}.` };
  const connection = providerConnection(env, data, manifest);
  if (connection.state !== 'connected') {
    return {
      error: `${manifest.name} isn't connected yet, so I can't staff a ${providerLabel(provider)} employee. ${manifest.connect_hint}`,
      how_to_connect: manifest.connect_hint,
      state: connection.state,
    };
  }
  const spec = SPECIALTIES[specialty] || SPECIALTIES.research;
  const role = `${providerLabel(provider)} ${spec.title}`;
  const existing = data.team.find((agent) => agent.role === role && !agent.retired && !temporary);
  if (existing) return { agent: existing, existing: true };
  const made = createAgent(data, {
    name,
    role,
    specialty: spec.specialty,
    temporary,
    provider_preference: provider,
    model_preference: model,
    capability_requirements: [spec.capability],
    kind_detail: `CHE Office agent backed by ${manifest.name} through CHE's authorized API connection`,
    mission: `Deliver ${spec.specialty} for CHE. You are a CHE employee; ${manifest.name} is only your reasoning engine.`,
  });
  if (made.error) return made;
  let queued = null;
  if (String(task || '').trim()) queued = queueAgentTask(data, made.agent, task, 'owner');
  return { agent: made.agent, task: queued };
}

// Paired intelligence: independent workers from different provider families
// on the same objective, cross-checked in a War Room, synthesized by CHE.
export function startPairedJob(env, data, { objective, families = [] }) {
  const connected = accountsView(env, data).filter((item) => item.connected).map((item) => item.id);
  const plan = planPairedJob(objective, connected, families);
  const workers = plan.steps.filter((step) => step.provider && step.provider !== 'che');
  if (new Set(workers.map((step) => step.provider)).size < 2) {
    return {
      error: 'Paired intelligence needs at least two connected provider families.',
      missing: plan.missing,
      connected,
    };
  }
  const agentIds = [];
  const created = [];
  for (const step of workers.slice(0, 5)) {
    const made = createProviderEmployee(env, data, {
      provider: step.provider,
      specialty: specialtyFrom(step.role),
      temporary: true,
    });
    if (made.agent) {
      if (!made.existing) created.push(made.agent);
      agentIds.push(made.agent.id);
    }
  }
  const convened = conveneMeeting(data, { objective, agent_ids: agentIds });
  if (convened.error) return convened;
  convened.meeting.paired = { families: workers.map((step) => step.provider), plan: plan.steps };
  return { meeting: convened.meeting, plan, created, missing: plan.missing };
}

// Retires temporary specialists with no remaining queued/running work.
export function retireIdleTemporaries(data) {
  const busy = new Set(data.team_tasks.filter((t) => ['queued', 'running', 'reviewing'].includes(t.status)).map((t) => t.partner_id));
  const inMeeting = new Set((data.meetings || [])
    .filter((m) => ['drafting', 'cross_check', 'synthesizing'].includes(m.status))
    .flatMap((m) => m.participants.map((p) => p.agent_id)));
  const before = data.team.length;
  data.team = data.team.filter((agent) => !agent.temporary || busy.has(agent.id) || inMeeting.has(agent.id));
  return before - data.team.length;
}

// Provider-neutral view of an Office task envelope (what travels on handoff).
export function taskEnvelope(task) {
  return {
    id: task.id,
    job_id: task.job_id || task.id,
    objective: task.task,
    status: task.status,
    current_agent: task.partner_name,
    context_items: (task.context_items || []).map((item) => ({ id: item.id, section: item.section, data_class: item.data_class })),
    artifacts: task.artifacts || [],
    citations: task.citations || [],
    steering: (task.steering || []).map((item) => item.text),
    prior_result: task.prior_result || task.result || '',
    review_feedback: task.review_feedback || '',
    provider_trail: task.provider_trail || [],
    handoffs: task.handoffs || [],
  };
}
