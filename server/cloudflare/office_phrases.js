const AGENTS = ['nova', 'atlas', 'mira', 'knox', 'sage', 'lyra'];

export function matchOfficePhrase(raw) {
  const t = String(raw || '').toLowerCase().replace(/[^a-z0-9 ?']/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/\bwhat(?:'s|s| is)? happening in the office\b/.test(t)) return { type: 'happening' };
  if (/\bwhat did they build today\b/.test(t)) return { type: 'builtToday' };
  if (/\bhow much did we make today\b/.test(t)) return { type: 'earnedToday' };
  if (/\bread (?:this |the )?office(?: to me)?\b/.test(t)) return { type: 'readOffice' };
  const who = t.match(/\bwhat is ([a-z]+) doing\b/);
  if (who && AGENTS.includes(who[1])) return { type: 'agentStatus', agentId: who[1] };
  if (/\bstand down\b/.test(t)) return { type: 'standDown' };
  return null;
}

export function speakOfficeBoard(board, phrase) {
  const b = board || {};
  const connected = b.stripe?.connected === true;
  const money = connected
    ? `Charges ${(b.stripe.charges_cents || 0) / 100}, refunds ${(b.stripe.refunds_cents || 0) / 100}, net ${(b.stripe.net_cents || 0) / 100}.`
    : 'Stripe not connected. Earnings $0.00.';
  const blockers = (b.blockers || []).length
    ? `Blockers: ${(b.blockers || []).join('; ')}.`
    : 'No blockers.';
  const jobs = (b.agents || []).map((a) => `${a.name}: ${a.status || a.job || 'Idle'}`).join('. ');
  switch (phrase?.type) {
    case 'happening':
      return `CHE here. ${b.agents_working || 0} working. Started ${b.started_today || 0}. Shipped ${b.finished_today || 0}. ${blockers}`;
    case 'builtToday':
      return `CHE here. Started today ${b.started_today || 0}. Finished today ${b.finished_today || 0}. ${jobs}`;
    case 'earnedToday':
      return `CHE here. ${money}`;
    case 'readOffice':
      return `CHE here. Started ${b.started_today || 0}. Finished ${b.finished_today || 0}. Working ${b.agents_working || 0}. ${jobs}. ${blockers} ${money}`;
    case 'agentStatus': {
      const agent = (b.agents || []).find((a) => String(a.id).toLowerCase() === phrase.agentId);
      return agent
        ? `CHE here. ${agent.name} is ${agent.status || agent.job || 'Idle'}.`
        : `CHE here. I do not have a live desk for ${phrase.agentId}.`;
    }
    case 'standDown':
      return 'CHE here. Office standing down. Agents stay on my channel only.';
    default:
      return null;
  }
}
