// Live La Agencia board derived only from persisted Office jobs and Stripe data.
// Agents report to CHE; this module never creates owner-facing agent messages.

import { LA_AGENCIA_ROLES, officeToolBlocker } from './office_company.js';
import { chicagoDayKey } from './chicago_time.js';
import { stalledTasks } from './activity.js';

const ACTIVE = new Set(['queued', 'running', 'reviewing']);
const DONE = new Set(['complete']);
const BLOCKED = new Set(['failed', 'blocked']);

// The owner's day (America/Chicago), not the UTC day.
function dayKey(value, now = new Date()) {
  return chicagoDayKey(value ? new Date(value) : now);
}

// Real per-desk status: the agent's latest job decides it, never a default
// "Idle" when work exists.
function deskStatus(agent, tasks, env, stallById = new Map()) {
  const mine = tasks.filter((t) => t.partner_id === agent.id || t.partner_name === agent.name)
    .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
  const active = mine.find((t) => ACTIVE.has(t.status));
  if (active) {
    const stall = stallById.get(active.id);
    if (stall) {
      return {
        state: 'stalled',
        job: active.task,
        job_id: active.id,
        status: `Stalled (${stall.reason}): ${active.task}`,
      };
    }
    const verb = active.status === 'queued' ? 'Up next' : active.status === 'reviewing' ? 'In CHE review' : 'Working';
    return { state: active.status === 'queued' ? 'queued' : 'working', job: active.task, job_id: active.id, status: `${verb}: ${active.task}` };
  }
  const blocked = mine.find((t) => t.status === 'blocked');
  const tool = env ? officeToolBlocker(env, agent) : '';
  if (blocked) return { state: 'blocked', job: blocked.task, job_id: blocked.id, status: blocked.error || tool || 'Blocked' };
  if (tool) return { state: 'blocked', job: '', job_id: '', status: tool };
  const last = mine[0];
  if (last && DONE.has(last.status)) return { state: 'done', job: last.task, job_id: last.id, status: `Finished: ${last.task}` };
  if (last && last.status === 'failed') return { state: 'failed', job: last.task, job_id: last.id, status: `Could not finish: ${last.task}` };
  return { state: 'idle', job: '', job_id: '', status: 'Idle' };
}

export function officeToday(data, stripeSummary, now = new Date(), env = null) {
  const today = dayKey(now, now);
  const tasks = Array.isArray(data?.team_tasks) ? data.team_tasks : [];
  const todays = tasks.filter((t) => dayKey(t.created_at, now) === today);
  const finished = tasks.filter((t) => DONE.has(t.status) && dayKey(t.updated_at || t.created_at, now) === today);
  const blocked = tasks.filter((t) => BLOCKED.has(t.status) && dayKey(t.updated_at || t.created_at, now) === today);
  const workingIds = new Set(tasks.filter((t) => ACTIVE.has(t.status)).map((t) => t.partner_id));

  // Stripe: webhook totals in the Durable Object are live truth; the Stripe
  // API read is the backup when no webhook has arrived today.
  const webhook = data?.office_stripe && data.office_stripe.date === today ? data.office_stripe : null;
  const apiConnected = stripeSummary?.status === 200;
  const stripeConnected = Boolean(webhook) || apiConnected;
  let charges = 0;
  let refunds = 0;
  if (webhook) {
    charges = Number(webhook.charges_cents || 0);
    refunds = Number(webhook.refunds_cents || 0);
  } else if (apiConnected) {
    const sales = Array.isArray(stripeSummary.sales) ? stripeSummary.sales : [];
    const todaysSales = sales.filter((s) => dayKey(s.created_at, now) === today);
    charges = todaysSales.reduce((n, s) => n + Number(s.amount || 0), 0);
    refunds = todaysSales.reduce((n, s) => n + Number(s.amount_refunded || 0), 0);
  }

  const stall = stalledTasks(data);
  const stallById = new Map(stall.map((s) => [s.id, s]));
  const roster = (Array.isArray(data?.team) ? data.team : []).filter((a) => a && !a.retired);
  const agents = roster.map((agent) => ({
    id: String(agent.name || '').toLowerCase(),
    agent_id: agent.id,
    name: agent.name,
    role: agent.role || '',
    core: Boolean(LA_AGENCIA_ROLES[agent.name]),
    ...deskStatus(agent, tasks, env, stallById),
  }));

  return {
    date: today,
    started: todays.map((t) => ({ id: t.id, agent: t.partner_name, task: t.task, status: t.status })),
    shipped: finished.map((t) => ({ id: t.id, agent: t.partner_name, task: t.task })),
    blockers: blocked.map((t) => ({ id: t.id, agent: t.partner_name, task: t.task, detail: t.error || 'Blocked' })),
    // Live stalled work (blocked, waiting on owner, or no update for 45+ min).
    stalled: stall.map((s) => ({ id: s.id, agent: s.who, task: s.title, detail: s.reason, at: s.at })),
    started_today: todays.length,
    finished_today: finished.length,
    built_today: finished.length,
    agents_working: workingIds.size,
    stalled_count: stall.length,
    agents,
    stripe: {
      connected: stripeConnected,
      charges_cents: stripeConnected ? charges : 0,
      refunds_cents: stripeConnected ? refunds : 0,
      net_cents: stripeConnected ? charges - refunds : 0,
      status: stripeConnected ? 'connected' : 'not_connected',
      source: webhook ? 'webhook' : apiConnected ? 'stripe_api' : 'none',
    },
    earned_today_cents: stripeConnected ? charges - refunds : 0,
  };
}

export function agentMayMessageOwner(agentId) {
  return String(agentId || '').toLowerCase() === 'che';
}
