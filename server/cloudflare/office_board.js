// Live La Agencia board derived only from persisted Office jobs and Stripe data.
// Agents report to CHE; this module never creates owner-facing agent messages.

import { LA_AGENCIA_ROLES, officeToolBlocker } from './office_company.js';

const ACTIVE = new Set(['queued', 'running', 'reviewing']);
const DONE = new Set(['complete']);
const BLOCKED = new Set(['failed', 'blocked']);

// The owner's day runs midnight to midnight in his own time zone (Chicago by
// default), not UTC, so "today" never resets at 7 PM Central.
export const OWNER_TIMEZONE = 'America/Chicago';

export function ownerTimeZone(env) {
  const tz = String(env?.CHE_OWNER_TIMEZONE || '').trim();
  if (tz) {
    try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return tz; } catch (_) { /* fall back */ }
  }
  return OWNER_TIMEZONE;
}

export function ownerDayKey(value, timeZone = OWNER_TIMEZONE) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function dayKey(value, now = new Date(), timeZone = OWNER_TIMEZONE) {
  return ownerDayKey(value || now, timeZone);
}

// Real per-desk status: the agent's latest job decides it, never a default
// "Idle" when work exists.
function deskStatus(agent, tasks, env) {
  const mine = tasks.filter((t) => t.partner_id === agent.id || t.partner_name === agent.name)
    .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
  const active = mine.find((t) => ACTIVE.has(t.status));
  if (active) {
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
  const tz = ownerTimeZone(env);
  const day = (value) => dayKey(value, now, tz);
  const today = day(now);
  const tasks = Array.isArray(data?.team_tasks) ? data.team_tasks : [];
  const todays = tasks.filter((t) => day(t.created_at) === today);
  const finished = tasks.filter((t) => DONE.has(t.status) && day(t.updated_at || t.created_at) === today);
  const blocked = tasks.filter((t) => BLOCKED.has(t.status) && day(t.updated_at || t.created_at) === today);
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
    const todaysSales = sales.filter((s) => day(s.created_at) === today);
    charges = todaysSales.reduce((n, s) => n + Number(s.amount || 0), 0);
    refunds = todaysSales.reduce((n, s) => n + Number(s.amount_refunded || 0), 0);
  }

  const roster = (Array.isArray(data?.team) ? data.team : []).filter((a) => a && !a.retired);
  const agents = roster.map((agent) => ({
    id: String(agent.name || '').toLowerCase(),
    agent_id: agent.id,
    name: agent.name,
    role: agent.role || '',
    core: Boolean(LA_AGENCIA_ROLES[agent.name]),
    ...deskStatus(agent, tasks, env),
  }));

  return {
    date: today,
    started: todays.map((t) => ({ id: t.id, agent: t.partner_name, task: t.task, status: t.status })),
    shipped: finished.map((t) => ({ id: t.id, agent: t.partner_name, task: t.task })),
    blockers: blocked.map((t) => ({ id: t.id, agent: t.partner_name, task: t.task, detail: t.error || 'Blocked' })),
    started_today: todays.length,
    finished_today: finished.length,
    built_today: finished.length,
    agents_working: workingIds.size,
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
