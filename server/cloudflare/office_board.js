// Live La Agencia board derived only from persisted Office jobs and Stripe data.
// Agents report to CHE; this module never creates owner-facing agent messages.

const ACTIVE = new Set(['queued', 'running', 'reviewing']);
const DONE = new Set(['complete']);
const BLOCKED = new Set(['failed', 'blocked']);

function dayKey(value, now = new Date()) {
  const d = value ? new Date(value) : now;
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export function officeToday(data, stripeSummary, now = new Date()) {
  const today = dayKey(now, now);
  const tasks = Array.isArray(data?.team_tasks) ? data.team_tasks : [];
  const todays = tasks.filter((t) => dayKey(t.created_at, now) === today);
  const finished = todays.filter((t) => DONE.has(t.status));
  const blocked = todays.filter((t) => BLOCKED.has(t.status));
  const workingIds = new Set(tasks.filter((t) => ACTIVE.has(t.status)).map((t) => t.partner_id));

  const stripeConnected = stripeSummary?.status === 200;
  const sales = stripeConnected && Array.isArray(stripeSummary.sales) ? stripeSummary.sales : [];
  const todaysSales = sales.filter((s) => dayKey(s.created_at, now) === today);
  const charges = todaysSales.reduce((n, s) => n + Number(s.amount || 0), 0);
  const refunds = todaysSales.reduce((n, s) => n + Number(s.amount_refunded || 0), 0);

  return {
    date: today,
    started: todays.map((t) => ({ id: t.id, agent: t.partner_name, task: t.task, status: t.status })),
    shipped: finished.map((t) => ({ id: t.id, agent: t.partner_name, task: t.task })),
    blockers: blocked.map((t) => ({ id: t.id, agent: t.partner_name, task: t.task, detail: t.error || 'Blocked' })),
    agents_working: workingIds.size,
    stripe: {
      connected: stripeConnected,
      charges_cents: stripeConnected ? charges : 0,
      refunds_cents: stripeConnected ? refunds : 0,
      net_cents: stripeConnected ? charges - refunds : 0,
      status: stripeConnected ? 'connected' : 'not_connected',
    },
  };
}

export function agentMayMessageOwner(agentId) {
  return String(agentId || '').toLowerCase() === 'che';
}
