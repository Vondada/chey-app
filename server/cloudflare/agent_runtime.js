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
import { meetingEvent, officeTaskEvent, researchEvent } from './room_events.js';
import { assertAgentMayRun, permissionBlocker } from './agent_permissions.js';
import { guardRetrievalClaims } from './truth_layer.js';
import { JOB_ROLE_SPECS, POOL_NAMES, agentSoul, isPartnerAgent, pickOfficeAgent, runBrowseTask } from './browse_chat.js';

export const AGENT_STATUSES = [
  'idle', 'researching', 'building', 'analyzing', 'meeting',
  'waiting', 'reviewing', 'talking', 'done', 'offline',
];

// A delegated task's lifecycle. Only `complete` means CHE approved the result; nothing else
// becomes complete. queued -> running -> reviewing -> complete, or:
//   review_pending  CHE's review could not run (provider down, unreadable verdict); the review is
//                   retried with backoff, the agent's work is NOT redone.
//   needs_review    the review failed MAX_REVIEW_ATTEMPTS times, or the task was interrupted where
//                   re-running could repeat an action; held unverified until steered or re-reviewed.
//   rejected        CHE did not approve after MAX_REPAIR_PASSES repair passes. Terminal, never complete.
// `advisory` is a desk's input to one chat answer, recorded for history; it was never a delegated task.
export const TASK_FINISHED = new Set(['complete', 'failed', 'cancelled', 'rejected', 'advisory']);
// Work an agent still holds: not finished and not blocked on a permission or credential.
export const TASK_OPEN = new Set(['queued', 'running', 'reviewing', 'review_pending', 'needs_review']);
export const MAX_REPAIR_PASSES = 2;
export const MAX_REVIEW_ATTEMPTS = 3;
export const MAX_WORK_RETRIES = 8;
export const MAX_STALE_RECOVERIES = 3;

/** Exponential backoff: base, 2x base, 4x base ... capped. */
export function retryDelayMs(attempt, base = 60_000, cap = 3_600_000) {
  return Math.min(cap, base * 2 ** Math.max(0, Number(attempt) || 0));
}

/** CHE's review verdict: 'approved', 'needs_work', or null when the review said neither. */
export function reviewVerdict(review) {
  const first = (String(review || '').trim().split('\n')[0] || '').replace(/^\W*(?:(?:CHE\s+)?(?:verdict|review|decision)\s*[:\-]\s*)/i, '');
  // "Not approved" is a rejection, whatever follows it.
  if (/\bnot\s+approved\b/i.test(first)) return 'needs_work';
  const approved = /\bAPPROVED\b/i.test(first);
  const needsWork = /\bNEEDS[\s_-]*WORK\b/i.test(first);
  // A first line naming both is not a verdict; approval must lead the line and not be a question.
  if (approved && needsWork) return null;
  if (needsWork) return 'needs_work';
  if (approved && /^\W*APPROVED\b(?!\s*\?)/i.test(first)) return 'approved';
  return null;
}

// Claims that something happened outside the model call: a deploy, merge, push, PR, message, upload,
// order or payment. An Office agent's model call has no tools, so such a claim needs a tool receipt on the
// task. Only past-tense claims count: "I will open a PR" and "I have not deployed" never match, because
// nothing but claim adverbs may sit between the subject and the verb. Quoted words and attributed
// sentences ("according to", "said", "per the 10-K") are someone else's account, so research stays clean.
const CLAIM_SUBJECT = String.raw`\b(?:I|we)(?:'ve|'d|\s+have|\s+had)?\s+(?:(?:just|successfully|already|also|then|now)\s+)*`;
// Money verbs count only with a money object: "paid close attention", "ordered the findings" and
// "bought into the thesis" are idioms.
const MONEY_VERBS = String.raw`paid\s+(?:\$|USD|for\b|the\s+(?:invoice|bill|fee|deposit|balance|vendor|supplier)|an?\s+(?:invoice|bill|fee|deposit)|\d)|purchased\b|bought\s+(?:\d+|an?|the|some|more)\s+(?:\w+\s+){0,2}(?:shares?|stock|contracts?|domains?|ads?|units?|items?|products?|inventory|supplies|samples?|tickets?|subscriptions?|plans?|licen[cs]es?|lamps?)\b|sold\s+(?:\d+|the|our|my|an?|some)\s+(?:\w+\s+){0,2}(?:shares?|contracts?|positions?|stock|units?|items?|products?|lamps?)\b|ordered\s+(?:\d+|an?|more|new|the)\s+(?:\w+\s+){0,2}(?:units?|items?|products?|stock|inventory|supplies|samples?|copies|parts?|lamps?)\b|transferred\s+(?:\$|\d|the\s+(?:money|funds|balance|payment))|placed\s+(?:an?\s+|the\s+)?(?:order|trade)\b|executed\s+(?:an?\s+|the\s+)?(?:order|trade|payment|transfer)\b`;
const ACTION_VERBS = String.raw`deployed|merged|pushed|committed|published|uploaded|posted|sent|emailed|texted|messaged|opened\s+(?:an?\s+|the\s+)?(?:new\s+)?(?:PR|pull\s+request|issue)|created\s+(?:an?\s+|the\s+)?(?:new\s+)?(?:PR|pull\s+request|branch|repo(?:sitory)?|listing|campaign|video|account)|rendered\s+(?:an?\s+|the\s+)?(?:video|mp4|clip|image)|executed\s+(?:an?\s+|the\s+)?(?:script|command|workflow|deploy(?:ment)?)|ran\s+(?:the\s+|our\s+)?(?:tests?|script|command|workflow|job)`;
const ACTION_CLAIM = new RegExp(`${CLAIM_SUBJECT}(?:${ACTION_VERBS})\\b`, 'i');
// A second past-tense action after "and" or "then" in one sentence: "I've created a branch, and opened a pull request."
// A modal, a negation or a question word makes it a plan or a refusal, not a claim.
const COMPOUND_CLAIM = new RegExp(`${CLAIM_SUBJECT}[^.!?]{0,120}?\\b(?:and|then|also)\\s+(?:${ACTION_VERBS})\\b`, 'i');
const PLAN_OR_REFUSAL = /\b(?:will|would|shall|should|could|might|may|can|must|plan|planning|want|wish|need|not|never|no|don'?t|didn'?t|won'?t|can'?t|couldn'?t|isn'?t|haven'?t|hasn'?t)\b|\b(?:once|until|when|if|after)\b|\?/i;
// A test result is a claim that the tests ran: "All tests passed: 12 of 12." needs a run receipt.
const TEST_CLAIM = /\b(?:all\s+)?(?:\d+\s+)?tests?\s+(?:have\s+|has\s+)?passed\b|\btest\s+results?\s*:|\b\d+\s+of\s+\d+\s+tests?\s+pass(?:ed|es)?\b/i;
const MONEY_CLAIM = new RegExp(`${CLAIM_SUBJECT}(?:${MONEY_VERBS})|\\b(?:(?:our|my|your|this|the)\\s+)(?:order|trade|payment|transfer|purchase)\\s+(?:was|has\\s+been|is\\s+now)\\s+(?:successfully\\s+)?(?:placed|filled|executed|sent|made|completed)\\b`, 'i');
// Without a first-person subject: "Deployed to production at 3pm." / "The PR was merged." / "Your email was sent."
const BARE_START = /^(?:successfully\s+)?(?:deployed|merged|pushed|published|uploaded|sent|emailed|posted)\s+(?:to|on|at|it|them|this|the\s+(?:fix|change|PR|pull\s+request|branch|update|build|post|email|message|listing|video))\b|^(?:successfully\s+)?(?:deployed|merged|pushed|published|uploaded|sent|emailed|posted)[.!]?$/i;
const BARE_PASSIVE = /^(?:the|our|my|your|this)\s+(?:new\s+)?(?:PR|pull\s+request|branch|fix|change|commit|build|release|email|message|listing|video|post|order|trade|payment|transfer|purchase|app|site|website|landing\s+page|page|worker|update|patch|code|campaign|invoice)\s+(?:#?\d+\s+)?(?:was|has\s+been|have\s+been|were|is\s+now)\s+(?:successfully\s+)?(?:deployed|merged|pushed|published|uploaded|sent|posted|opened|created|placed|filled|executed|made|completed)\b/i;
// Someone else's account: an attributed source, a named third party's work, a past date, a backtest.
const ATTRIBUTED = /\b(?:according\s+to|per\s+(?:the|its|their)|said|says|stated|reported|announced|wrote|told|cited|described\s+in|in\s+(?:the|its|their)\s+(?:filing|report|10-K|10-Q|earnings|paper|study|press\s+release))\b/i;
const OWNER_INSTRUCTED = /\b(?:as\s+you\s+(?:told|asked|said)|you\s+(?:told|asked|said)|per\s+(?:your|the\s+owner'?s?)|(?:the\s+)?owner\s+(?:said|told|asked)|(?:told|asked)\s+me)\b/i;
const THIRD_PARTY = /\b[A-Z][a-z]+'s\s+(?:fix|change|update|release|video|post|order|trade)\b|\b(?:19|20)\d{2}\b|\blast\s+(?:week|month|year)\b|\bbacktest|\bback-test|\bsimulat|\bpaper[- ]trad|\bhypothetical/i;
// Real quotation marks only: an apostrophe inside a word ("team's", "I've") is not a quote.
const QUOTED = /"[^"]*"|“[^”]*”|(?<![A-Za-z])'[^'\n]{12,}'(?![A-Za-z])/g;

/**
 * Sentences of an agent result that claim an external action or a record read no receipt backs. A
 * successful computer-workspace receipt backs workspace actions; no Office receipt backs a payment,
 * purchase, order or transfer, which only a broker or payment receipt could.
 */
export function unbackedActionClaims(result, receipts = []) {
  const workspace = (Array.isArray(receipts) ? receipts : []).some((r) => r && r.status === 'ok');
  const text = String(result || '');
  const claims = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean)
    .filter((sentence) => {
      const own = sentence.replace(QUOTED, ' ').trim();
      // The owner's instruction ("as you told me") is not someone else's account of the action.
      const attributed = ATTRIBUTED.test(own) && !OWNER_INSTRUCTED.test(own);
      if (attributed) return false;
      if (MONEY_CLAIM.test(own) && !THIRD_PARTY.test(own)) return true;
      if (workspace) return false;
      if (TEST_CLAIM.test(own) && !THIRD_PARTY.test(own)) return true;
      const compound = COMPOUND_CLAIM.test(own) && !PLAN_OR_REFUSAL.test(own);
      return ACTION_CLAIM.test(own) || compound || ((BARE_START.test(own) || BARE_PASSIVE.test(own)) && !THIRD_PARTY.test(own));
    });
  const records = workspace ? [] : guardRetrievalClaims(text, { flagOnly: true }).removed.map((r) => r.sentence);
  return [...new Set([...claims, ...records])].map((s) => clip(s, 240)).slice(0, 4);
}

const AGENT_NAMES = ['Nova', 'Atlas', 'Mira', 'Knox', 'Sage', 'Lyra', 'Orion', 'Vale', 'Juno', 'Rhea', 'Cato', 'Iris'];

// Consistent personalities so each agent sounds the same across sessions.
export const PERSONAS = {
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

export const CORE_AGENT_PROFILES = {
  Nova: {
    strengths: ['Product framing', 'Offer clarity', 'Listings and sales-page structure'],
    limitations: ['Not the primary research verifier', 'Not the primary finance reviewer'],
    appearance: { body_type: 'standard', face: 'oval', skin_tone: 'warm', hair: 'waves', eyes: 'hazel', outfit: 'jacket-teal', accessory: 'chain', animation: 'confident' },
  },
  Atlas: {
    strengths: ['Research depth', 'Source comparison', 'Competitive checks'],
    limitations: ['Slower when evidence is thin', 'Not the primary visual creative'],
    appearance: { body_type: 'tall', face: 'square', skin_tone: 'deep', hair: 'close', eyes: 'brown', outfit: 'suit', accessory: 'glasses', animation: 'focused' },
  },
  Mira: {
    strengths: ['Customer empathy', 'Support copy', 'Translation and multilingual drafts'],
    limitations: ['Not the primary implementation engineer', 'Needs verified facts for policy-sensitive replies'],
    appearance: { body_type: 'compact', face: 'round', skin_tone: 'golden', hair: 'curls', eyes: 'green', outfit: 'jacket-red', accessory: 'none', animation: 'calm' },
  },
  Knox: {
    strengths: ['Implementation', 'Testing and debugging', 'Failure-mode and security review'],
    limitations: ['Can over-focus on failure cases', 'Not the primary brand or social writer'],
    appearance: { body_type: 'tall', face: 'square', skin_tone: 'brown', hair: 'locs', eyes: 'dark', outfit: 'tech', accessory: 'headset', animation: 'focused' },
  },
  Sage: {
    strengths: ['Financial summaries', 'Read-only Stripe reporting', 'Claim and goal verification'],
    limitations: ['Read-only money access', 'Cannot spend, transfer, or open payouts'],
    appearance: { body_type: 'standard', face: 'oval', skin_tone: 'tan', hair: 'bun', eyes: 'brown', outfit: 'suit', accessory: 'glasses', animation: 'calm' },
  },
  Lyra: {
    strengths: ['Clear writing', 'Social content', 'Turning rough notes into human language'],
    limitations: ['Not the primary finance analyst', 'Needs source facts before making factual claims'],
    appearance: { body_type: 'compact', face: 'round', skin_tone: 'light', hair: 'braids', eyes: 'blue', outfit: 'studio', accessory: 'none', animation: 'confident' },
  },
  Iris: {
    strengths: ['Ad concepts', 'Headlines and CTAs', 'Paid-social creative packages'],
    limitations: ['Needs brand assets for exact visual matching', 'Not the primary code reviewer'],
    appearance: { body_type: 'standard', face: 'oval', skin_tone: 'golden', hair: 'curls', eyes: 'hazel', outfit: 'jacket-red', accessory: 'hat', animation: 'confident' },
  },
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

function agentProfileTraits(agent) {
  const core = CORE_AGENT_PROFILES[agent.name];
  if (core) return core;
  const role = `${agent.role || ''} ${agent.specialty || ''}`.toLowerCase();
  const strengths = [];
  if (/research|source|intel/.test(role)) strengths.push('Research and source comparison');
  if (/code|engineer|build|implement|test/.test(role)) strengths.push('Implementation and technical problem solving');
  if (/write|copy|content|support|social/.test(role)) strengths.push('Clear communication and audience-focused writing');
  if (/finance|stripe|market|quant/.test(role)) strengths.push('Numerical analysis and reporting');
  if (!strengths.length) strengths.push('Focused execution in the assigned specialty');
  return {
    strengths,
    limitations: ['Best used inside the assigned specialty', 'Owner-gated actions remain unavailable without approval'],
    appearance: null,
  };
}

function agentAppearance(data, agent) {
  const core = agentProfileTraits(agent).appearance;
  const h = hashOf(agent.id || agent.name);
  const fallback = {
    body_type: ['compact', 'standard', 'tall'][h % 3],
    face: ['round', 'oval', 'square'][(h >>> 3) % 3],
    skin_tone: ['deep', 'brown', 'warm', 'tan', 'golden', 'light'][(h >>> 6) % 6],
    hair: ['close', 'fade', 'waves', 'curls', 'braids', 'locs', 'bun', 'bald'][(h >>> 9) % 8],
    eyes: ['dark', 'brown', 'hazel', 'green', 'blue'][(h >>> 12) % 5],
    outfit: ['suit', 'jacket-red', 'jacket-teal', 'hoodie', 'studio', 'tech'][(h >>> 15) % 6],
    accessory: ['none', 'glasses', 'headset', 'chain', 'hat'][(h >>> 18) % 5],
    animation: ['calm', 'focused', 'confident', 'walking'][(h >>> 21) % 4],
  };
  const saved = data?.workshop_avatars?.[agent.id];
  return { ...(core || fallback), ...(saved && typeof saved === 'object' ? saved : {}) };
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
    department: agent.department ? { id: agent.department.id, title: agent.department.title } : null,
    mission: agent.mission || '',
    personality: agent.personality,
    strengths: agentProfileTraits(agent).strengths,
    limitations: agentProfileTraits(agent).limitations,
    appearance: agentAppearance(data, agent),
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
    skills: ensureSkillStore(data)
      .filter((skill) => agent.skill_ids.includes(skill.id) || (skill.assigned_agents || []).includes(agent.name))
      .slice(0, 40)
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        trigger: skill.trigger || '',
        capabilities: Array.isArray(skill.capabilities) ? skill.capabilities : [],
        source: skill.source || null,
        uses: Number(skill.uses || 0),
      })),
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
    work_log: (Array.isArray(data.agent_work_log) ? data.agent_work_log : [])
      .filter((item) => item.agent_id === agent.id)
      .slice(0, 10),
    meetings: (data.meetings || [])
      .filter((item) => item.participants.some((p) => p.agent_id === agent.id))
      .slice(0, 10)
      .map(meetingSummary),
  };
}

const MAX_AGENT_WORK_LOG = 120;

// The Brain hears an Office outcome when it happens (owner, Build 2): the Worker passes ctx.roomEvent, which
// queues the event (room_events.js). Without it (tests, older callers) nothing is reported and nothing fails.
async function reportRoomEvent(ctx, event) {
  if (!event || typeof ctx?.roomEvent !== 'function') return;
  try { await ctx.roomEvent(event); } catch (_) { /* a Brain record never blocks Office work */ }
}

/**
 * Per-agent working memory with provenance: one compact entry per terminal
 * task outcome (complete / failed), newest first. Lives in the owner's
 * Durable Object, so an agent's record survives restarts; research-style jobs
 * additionally keep their full distilled note via writeResearchMemoryNote.
 */
export function recordAgentWork(data, { task = {}, agent = {}, outcome = 'complete', verified = false, memoryNoteId = '', error = '' } = {}) {
  data.agent_work_log = Array.isArray(data.agent_work_log) ? data.agent_work_log : [];
  const entry = {
    agent: clip(agent.name || task.partner_name || 'Office agent', 40) || 'Office agent',
    agent_id: clip(agent.id || task.partner_id, 80),
    task_id: clip(task.id, 80),
    // Do not duplicate raw owner prompts or provider errors in the general
    // per-agent memory log. Both may contain passwords, tokens or private
    // content. Use the task ID to retrieve details through the existing
    // owner-authenticated task history instead.
    task: 'See owner-authorized task history',
    status: clip(outcome, 20) || 'complete',
    verified_by_che: Boolean(verified),
    memory_note_id: clip(memoryNoteId, 120),
    error: error ? 'Failure recorded; details in owner-authorized task history' : '',
    at: now(),
  };
  data.agent_work_log.unshift(entry);
  data.agent_work_log = data.agent_work_log.slice(0, MAX_AGENT_WORK_LOG);
  if (agent && agent.id) {
    agent.last_work = { task_id: entry.task_id, status: entry.status, verified: entry.verified_by_che, at: entry.at };
  }
  return entry;
}

/**
 * The team member who takes a job: the best existing fit (named roster first, partners last). Only when nobody on
 * the team covers the job is a new agent created, for the role the job needs, with a name not yet taken.
 */
export function ensureJobAgent(data, { needs = [], roleSpec = null } = {}) {
  // 1. A named agent or a pool name already on the team whose job fits (partners not yet).
  const fit = pickOfficeAgent(data.team, { needs, partners: false });
  if (fit) return { agent: fit, hired: false };
  const spec = roleSpec || JOB_ROLE_SPECS.fallback;
  const order = spec.role === JOB_ROLE_SPECS.trade.role ? ['Orion'] : POOL_NAMES;
  // 2. Work with no name of its own goes to a pool name already on the team (Orion for trades).
  const live = data.team.filter((a) => a && !a.retired);
  const kept = order.map((name) => live.find((a) => a.name === name && !isPartnerAgent(a))).find(Boolean);
  if (kept) return { agent: kept, hired: false };
  // 3. Only then a new agent, for the role, under the first pool name not yet taken.
  const free = order.find((name) => !data.team.some((a) => a && a.name === name));
  if (free) {
    const made = createAgent(data, { name: free, role: spec.role, specialty: spec.specialty, mission: spec.specialty });
    if (!made.error) return { agent: made.agent, hired: true };
  }
  // 4. Partners are the last resort: placeholders, used only when nothing else can take the job.
  const placeholder = pickOfficeAgent(data.team, { needs });
  if (placeholder) return { agent: placeholder, hired: false };
  return { agent: null, hired: false, error: 'every pool name is taken and no partner fits' };
}

// The next free pool name for a new War Room partner: partners keep these names, never their role titles.
function freePoolName(data) {
  return POOL_NAMES.find((name) => !data.team.some((a) => a && a.name === name)) || undefined;
}

// The job a finished research task hands on: queued to the agent whose job description fits it, with the research
// as its input. When nobody on the team fits, the hand-off is recorded as blocked; nobody is hired.
export function queueNextJob(data, task, researcher) {
  const next = task.next;
  task.next = null;
  const { agent, error } = ensureJobAgent(data, { needs: next.needs || [], roleSpec: next.roleSpec });
  if (!agent) {
    task.next_blocked = `No agent could take ${next.label || 'the next job'}: ${error || 'no one on the team fits it'}.`;
    return null;
  }
  const input = clip(task.result, 6000);
  const queued = queueAgentTask(data, agent, `${next.task}\n\nRESEARCH FROM ${researcher?.name || 'the researcher'}:\n${input}`, 'collaboration');
  task.next_queued_to = agent.name;
  return queued;
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
    // A browsing task runs the browsing loop (browse_chat.js) with the agent's own model and personality.
    browse: options.browse === true,
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
  const hasAssignedAgents = Array.isArray(body.assigned_agents);
  const requestedAssigned = hasAssignedAgents
    ? [...new Set(body.assigned_agents.map((item) => clip(item, 40)).filter(Boolean))].slice(0, 8)
    : [];
  const requestedSource = body.source && typeof body.source === 'object'
    ? { repo: clip(body.source.repo, 120), path: clip(body.source.path, 240), license: clip(body.source.license, 40) }
    : null;
  const importedIdentity = Boolean(requestedSource?.repo && requestedSource?.path);
  const existing = store.find((item) => {
    if (item.id === id) return true;
    if (String(item.name || '').toLowerCase() !== name.toLowerCase()) return false;
    // Manual/local skills keep the historical name-based update behavior.
    if (!importedIdentity) return true;
    // Imported skills are distinct by source + assigned agent set so two
    // agents can legitimately have same-named workflows without overwriting
    // each other's provenance or assignment.
    if (item.source?.repo !== requestedSource.repo || item.source?.path !== requestedSource.path) return false;
    const currentAssigned = Array.isArray(item.assigned_agents) ? [...item.assigned_agents].sort() : [];
    const nextAssigned = [...requestedAssigned].sort();
    return currentAssigned.length === nextAssigned.length
      && currentAssigned.every((value, index) => value === nextAssigned[index]);
  });
  const skill = existing || { id, created_at: now() };
  const assigned = hasAssignedAgents
    ? requestedAssigned
    : (Array.isArray(skill.assigned_agents) ? skill.assigned_agents : []);
  Object.assign(skill, {
    name,
    trigger,
    steps: neutralSteps,
    capabilities,
    provider_neutral: true,
    notes: clip(body.notes, 1200),
    assigned_agents: assigned,
    source: requestedSource || skill.source || null,
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
    assigned_agents: Array.isArray(skill.assigned_agents) ? skill.assigned_agents : [],
    source: skill.source || null,
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

function matchedOfficeSkills(data, task, max = 3, agent = null) {
  const text = String(task || '').toLowerCase();
  const words = new Set(text.split(/[^a-z0-9]+/).filter((item) => item.length > 2));
  const scored = ensureSkillStore(data).map((skill) => {
    const hay = `${skill.name} ${skill.trigger} ${(skill.steps || []).join(' ')}`.toLowerCase();
    let score = text.includes(String(skill.trigger || '').toLowerCase()) ? 8 : 0;
    for (const word of words) if (hay.includes(word)) score += 1;
    // Skills assigned to this agent are its own playbook: preferred.
    if (score > 0 && agent && (skill.assigned_agents || []).includes(agent.name)) score += 4;
    return { skill, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, max);
  return scored.map((item) => item.skill);
}

export function steerAgentTask(data, taskId, instruction) {
  const task = data.team_tasks.find((item) => item.id === taskId);
  if (!task) return { error: 'Office task not found.' };
  if (TASK_FINISHED.has(task.status)) return { error: 'That task is already finished.' };
  const text = clip(instruction, 1200);
  if (!text) return { error: 'Steering instruction required.' };
  task.steering = Array.isArray(task.steering) ? task.steering : [];
  task.steering.push({ text, at: now() });
  task.steering = task.steering.slice(-12);
  task.steering_version = Number(task.steering_version || 0) + 1;
  // New owner direction earns fresh repair passes.
  task.revision_count = 0;
  // A held, unverified result is reworked with the new instruction rather than left waiting.
  if (['needs_review', 'review_pending'].includes(task.status)) {
    if (task.result) task.prior_result = task.result;
    task.status = 'queued';
    task.review_attempts = 0;
    task.retry_at = null;
  }
  task.updated_at = now();
  return { task };
}

// An agent whose task was cancelled, handed on or recovered under it shows what it really holds now.
function settleAgent(data, agentId) {
  const agent = (data.team || []).find((a) => a.id === agentId);
  if (!agent) return;
  const open = (data.team_tasks || []).filter((t) => t.partner_id === agentId && TASK_OPEN.has(t.status));
  if (open.some((t) => t.status === 'running')) return;
  const waiting = open.find((t) => ['queued', 'review_pending', 'reviewing'].includes(t.status));
  agent.runtime_status = waiting ? 'waiting' : 'idle';
  agent.runtime_task = waiting ? clip(waiting.task, 80) : null;
  agent.runtime_updated_at = now();
  if (!waiting) agent.status = 'available';
}

/** "Stop the Atlas task": cancels every open task of the named Office agent, in durable state. */
export function cancelAgentTasks(data, agentName, reason = 'Owner stopped it.') {
  const name = String(agentName || '').toLowerCase();
  const agent = (data.team || []).find((a) => String(a.name || '').toLowerCase() === name && !a.retired);
  if (!agent) return { agent: null, cancelled: [] };
  const cancelled = (data.team_tasks || []).filter((t) => t.partner_id === agent.id && TASK_OPEN.has(t.status));
  const at = now();
  for (const task of cancelled) {
    task.status = 'cancelled';
    task.error = reason;
    task.retry_at = null;
    task.updated_at = at;
  }
  if (cancelled.length) {
    agent.runtime_status = 'idle';
    agent.runtime_task = null;
    agent.runtime_updated_at = at;
    agent.status = 'available';
  }
  return { agent, cancelled };
}

// "Review it again": a result CHE could not review goes back to CHE's review as is; the agent's
// work, and any computer action, is not repeated.
export function requeueAgentReview(data, taskId) {
  const task = data.team_tasks.find((item) => item.id === taskId);
  if (!task) return { error: 'Office task not found.' };
  if (!['needs_review', 'review_pending'].includes(task.status) || !task.result) return { error: 'That task has no result waiting for review.' };
  task.status = 'review_pending';
  task.review_attempts = 0;
  task.retry_at = null;
  task.error = '';
  task.updated_at = now();
  return { task };
}

export function handoffAgentTask(data, taskId, targetAgentId, note = '') {
  const task = data.team_tasks.find((item) => item.id === taskId);
  if (!task) return { error: 'Office task not found.' };
  if (TASK_FINISHED.has(task.status)) return { error: 'That task is already finished.' };
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
    const pending = data.team_tasks.filter((item) => item.partner_id === agent.id && TASK_OPEN.has(item.status));
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
      const made = createAgent(data, { ...spec, name: freePoolName(data) });
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

// Runs one queued delegated task: agent works, CHE reviews, result recorded. A task whose review
// is due again (review_pending) goes straight back to CHE's review; the agent's work is not redone.
// The owner's Knowledge Library passages for this task (indexed text, cited; cataloged works named as unread).
function knowledgeLines(ctx, question) {
  try { return typeof ctx.knowledge === 'function' ? String(ctx.knowledge(question) || '') : ''; } catch (_) { return ''; }
}

async function runOneTask(ctx) {
  const { env, load, save, notify, models } = ctx;
  let data = await load();
  if (data.autonomy === false) return false;
  const due = (item) => !item.retry_at || item.retry_at <= Date.now();
  const oldestFirst = [...data.team_tasks].reverse();
  const pendingReview = oldestFirst.find((item) => item.status === 'review_pending' && due(item));
  if (pendingReview) return reviewDelegatedResult(ctx, pendingReview.id);
  const task = oldestFirst.find((item) => item.status === 'queued' && due(item));
  if (!task) return false;
  const agent = data.team.find((item) => item.id === task.partner_id);
  if (!agent) {
    task.status = 'failed';
    task.error = 'Agent no longer in the Office.';
    task.updated_at = now();
    await save(data);
    await reportRoomEvent(ctx, officeTaskEvent(task, { agent: task.partner_name, outcome: 'failed', at: task.updated_at }));
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
  const blocker = agentActionGuard(agent, task.task) || (isLaAgenciaAgent(agent) ? officeToolBlocker(env, agent, task.task) : '');
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
  task.run_started_at = task.updated_at;
  // A repair pass reuses the workspace result instead of acting again; only new owner steering re-runs it.
  const computerAgain = !(Number(task.revision_count || 0) > 0 && Number(task.computer_steering_version ?? -1) === Number(task.steering_version || 0));
  const computerWillRun = Boolean(task.use_computer && task.owner_approved_computer && String(env.CHE_COMPUTER_URL || '').trim() && computerAgain);
  if (computerWillRun) {
    task.computer_started_at = task.updated_at;
    task.computer_steering_version = Number(task.steering_version || 0);
  }
  agent.runtime_status = workingStatusFor(agent);
  agent.runtime_task = clip(task.task, 80);
  agent.runtime_updated_at = now();
  await save(data);
  notify();

  let result = '';
  let error = '';
  let retryable = false;
  const startSteeringVersion = Number(task.steering_version || 0);
  const skills = matchedOfficeSkills(data, task.task, 3, agent);
  for (const skill of skills) {
    skill.uses = Number(skill.uses || 0) + 1;
    skill.updated_at = now();
    if (!agent.skill_ids.includes(skill.id)) agent.skill_ids.push(skill.id);
  }
  const computer = computerAgain ? await runComputerWorkspace(env, agent, task) : null;
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
    knowledgeLines(ctx, task.task),
    computer ? `CONNECTED COMPUTER RESULT:\n${JSON.stringify(computer).slice(0, 16000)}` : '',
    !computer && task.computer_result ? `CONNECTED COMPUTER RESULT (from the earlier pass; not run again):\n${task.computer_result}` : '',
  ].filter(Boolean).join('\n\n');
  let worker = { engine: '', model: '' };
  try {
    const routing = routingForAgent(agent, data, task);
    const detailed = task.browse
      ? await runBrowseTask({
        question: task.task,
        soul: agentSoul(agent),
        complete: async ({ system, user }) => (await runModelDetailed(env, modelFor(env, agent, models), system, user, 400, routing)).text,
        keepReads: ctx.keepReads || null,
      }).then((run) => ({ text: run.text, engine: 'browse_loop', model: '' }))
      : await runModelDetailed(
        env,
        modelFor(env, agent, models),
        agentSystemPrompt(agent, workContext),
        task.task,
        agent.model_tier === 'strong' ? 1800 : 1100,
        routing,
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
  // Cancelled, handed to another agent, retired or recovered while this agent worked: the result is stale.
  if (t1.status !== 'running' || t1.partner_id !== agent.id) {
    settleAgent(data, agent.id);
    await save(data);
    notify();
    return true;
  }
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
    const retry = retryable && (t1.retry_count || 0) < MAX_WORK_RETRIES;
    t1.status = retry ? 'queued' : 'failed';
    t1.retry_at = retry ? Date.now() + retryDelayMs(t1.retry_count || 0, 300_000, 6 * 3_600_000) : null;
    t1.retry_count = (t1.retry_count || 0) + (retry ? 1 : 0);
    t1.error = error;
    t1.updated_at = now();
    if (!retry) {
      recordAgentWork(data, { task: t1, agent: a1 || agent, outcome: 'failed', verified: false, error: t1.error });
      await reportRoomEvent(ctx, officeTaskEvent(t1, { agent: (a1 || agent)?.name, outcome: 'failed', at: t1.updated_at }));
    }
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
  t1.review_attempts = 0;
  // The only tool this loop runs is the owner-approved computer workspace; its answer is the receipt.
  if (computer) {
    t1.receipts = [{ kind: 'computer_workspace', status: computer.status, at: now() }];
    t1.computer_result = JSON.stringify(computer).slice(0, 16000);
  }
  else if (computerAgain || !Array.isArray(t1.receipts)) t1.receipts = [];
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

  return reviewDelegatedResult(ctx, task.id, { saved: true });
}

// CHE reviews a delegated result before it counts as done. Approval is the only way to `complete`:
// a rejection is repaired (bounded) and then `rejected`, a review that cannot run is retried with
// backoff and then held as `needs_review`, and an approved result that claims an action no receipt
// backs is sent back for repair like a rejection.
async function reviewDelegatedResult(ctx, taskId, { saved = false } = {}) {
  const { env, load, save, notify, models } = ctx;
  let data = await load();
  const t0 = data.team_tasks.find((item) => item.id === taskId);
  if (!t0) return true;
  const agent = data.team.find((item) => item.id === t0.partner_id) || { name: t0.partner_name || 'Office agent' };
  const result = t0.result || '';
  const task = { task: t0.task };
  const steeringAtReview = Number(t0.steering_version || 0);
  const partnerAtReview = t0.partner_id;
  if (!saved) {
    t0.status = 'reviewing';
    t0.updated_at = now();
    await save(data);
    notify();
  }

  let review = '';
  try {
    review = await runModel(env, env.CHE_FAST_MODEL || models.fast, [
      'You are CHE, Office Boss, reviewing a delegated result from one of your Office agents. You own the outcome: accept solid work, reject weak or unverified claims.',
      'First line must be exactly APPROVED or NEEDS WORK.',
      'Then at most 3 short lines: what is solid, what is weak or unverified, what to do next.',
      'Do not invent facts. Unverifiable claims are weak. A claim that something was deployed, merged, sent, bought or published is unverified without a tool receipt.',
    ].join('\n'), JSON.stringify({ task: task.task, agent: agent.name, result, receipts: t0.receipts || [] }), 260);
  } catch (_) {
    review = '';
  }

  data = await load();
  const t2 = data.team_tasks.find((item) => item.id === taskId);
  const a2 = data.team.find((item) => item.id === t2?.partner_id);
  if (!t2) return true;
  // Cancelled, handed off or steered while CHE was reviewing: this review no longer applies.
  if (t2.status !== 'reviewing') return true;
  if (Number(t2.steering_version || 0) !== steeringAtReview || t2.partner_id !== partnerAtReview) {
    // The owner redirected it (or moved it to another agent) during review: rework with the new direction.
    t2.prior_result = result;
    t2.status = 'queued';
    t2.updated_at = now();
    settleAgent(data, partnerAtReview);
    if (t2.partner_id !== partnerAtReview) settleAgent(data, t2.partner_id);
    await save(data);
    notify();
    return true;
  }
  const verdict = reviewVerdict(review);
  t2.updated_at = now();
  t2.verified_by_che = false;

  if (!verdict) {
    const attempts = Number(t2.review_attempts || 0) + 1;
    t2.review_attempts = attempts;
    t2.che_review = 'CHE review unavailable; result not verified.';
    if (attempts < MAX_REVIEW_ATTEMPTS) {
      t2.status = 'review_pending';
      t2.retry_at = Date.now() + retryDelayMs(attempts - 1);
      if (a2) {
        a2.runtime_status = 'waiting';
        a2.runtime_task = 'Waiting to retry CHE review';
        a2.runtime_updated_at = now();
      }
    } else {
      t2.status = 'needs_review';
      t2.retry_at = null;
      t2.error = `CHE could not review this result after ${attempts} attempts. It is held unverified and is not complete.`;
      recordAgentWork(data, { task: t2, agent: a2 || agent, outcome: 'needs_review', verified: false, error: t2.error });
      if (a2) {
        a2.runtime_status = 'idle';
        a2.runtime_task = null;
        a2.runtime_updated_at = now();
        a2.status = 'available';
      }
    }
    await save(data);
    notify();
    return true;
  }

  const unbacked = verdict === 'approved' ? unbackedActionClaims(result, t2.receipts) : [];
  const approved = verdict === 'approved' && !unbacked.length;
  const receiptNote = unbacked.length
    ? `Receipt check: no tool receipt backs ${unbacked.map((c) => `"${c}"`).join('; ')}. Remove the claim or state it as a proposal.`
    : '';
  t2.che_review = clip([review, receiptNote].filter(Boolean).join('\n'), 2000);
  t2.verified_by_che = approved;
  t2.review_attempts = 0;
  t2.retry_at = null;

  if (!approved) {
    const feedback = clip(verdict === 'needs_work' ? review : receiptNote, 1800);
    if (Number(t2.revision_count || 0) < MAX_REPAIR_PASSES) {
      t2.prior_result = result;
      t2.review_feedback = feedback;
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
    t2.status = 'rejected';
    t2.review_feedback = feedback;
    t2.error = `CHE did not approve this result after ${MAX_REPAIR_PASSES} repair passes. It is not complete.`;
    recordAgentWork(data, { task: t2, agent: a2 || agent, outcome: 'rejected', verified: false, error: t2.error });
    await reportRoomEvent(ctx, officeTaskEvent(t2, { agent: (a2 || agent)?.name, outcome: 'rejected', at: t2.updated_at }));
    if (a2) {
      a2.runtime_status = 'idle';
      a2.runtime_task = null;
      a2.runtime_updated_at = now();
      a2.status = 'available';
    }
    await save(data);
    notify();
    return true;
  }

  t2.status = 'complete';
  // A research job passes its result to the content job it was planned with, to whichever agent's job fits it.
  if (t2.next && t2.next.task) queueNextJob(data, t2, a2 || agent);
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
  // Per-agent working memory with provenance for every finished task.
  recordAgentWork(data, {
    task: t2,
    agent: a2 || agent,
    outcome: 'complete',
    verified: approved,
    memoryNoteId: t2.memory_note_id || '',
    error: '',
  });
  await reportRoomEvent(ctx, officeTaskEvent(t2, { agent: (a2 || agent)?.name, outcome: 'complete', verified: approved, at: t2.updated_at || now() }));
  if (t2.memory_written) {
    const note = (data.memory_notes || []).find((item) => item.id === t2.memory_note_id);
    // An agent's research note is a lead: its cited pages were not checked, so the event says inferred.
    if (note) await reportRoomEvent(ctx, researchEvent({ id: note.id, title: note.title, summary: (note.bullets || []).join(' '), sources: note.url ? [note.url] : [], by: (a2 || agent)?.name || 'an Office agent', sourcesRead: false, at: note.created_at }));
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
    normalizeAgent(a2);
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
    if (a2.temporary && !data.team_tasks.some((item) => item.partner_id === a2.id && TASK_OPEN.has(item.status))) {
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
    // A meeting that concluded or ended without a result is a Meeting Room event (owner, Build 2).
    if (m.status === 'complete') await reportRoomEvent(ctx, meetingEvent(m, 'concluded'));
    else if (m.status === 'failed') await reportRoomEvent(ctx, meetingEvent(m, 'failed'));
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
  return data.team_tasks.some((item) => ['queued', 'review_pending'].includes(item.status)) ||
    (data.meetings || []).some((item) => ['drafting', 'cross_check', 'synthesizing'].includes(item.status));
}

// Stale work (e.g. the Durable Object was evicted mid-call) is recovered so status never claims
// work that is no longer happening, without doing anything twice:
// - interrupted in review: the stored result goes back to CHE's review, the agent does not redo it;
// - interrupted while working: queued again, at most MAX_STALE_RECOVERIES times, then failed;
// - interrupted during owner-approved computer use: held as needs_review, never re-run, because the
//   workspace may already have acted.
export function recoverStaleWork(data, maxAgeMs = 5 * 60_000) {
  let changed = false;
  const cutoff = Date.now() - maxAgeMs;
  for (const task of data.team_tasks) {
    if (!['running', 'reviewing'].includes(task.status) || !(Date.parse(task.updated_at) < cutoff)) continue;
    task.stale_recoveries = Number(task.stale_recoveries || 0) + 1;
    task.updated_at = now();
    changed = true;
    if (task.status === 'running' && task.computer_started_at && Date.parse(task.computer_started_at) >= Date.parse(task.run_started_at || 0)) {
      task.status = 'needs_review';
      task.error = 'Interrupted during computer use. Not re-run, so no action is repeated; check the workspace before steering it again.';
    } else if (task.stale_recoveries > MAX_STALE_RECOVERIES) {
      // A result that exists is held for review; work that never finished stops.
      task.status = task.status === 'reviewing' && task.result ? 'needs_review' : 'failed';
      task.error = `Interrupted ${task.stale_recoveries} times without finishing; stopped.`;
    } else if (task.status === 'reviewing' && task.result) {
      task.status = 'review_pending';
      task.retry_at = null;
    } else {
      task.status = 'queued';
    }
    const agent = (data.team || []).find((item) => item.id === task.partner_id);
    if (agent && task.status !== 'queued') {
      agent.runtime_status = task.status === 'review_pending' ? 'waiting' : 'idle';
      agent.runtime_task = task.status === 'review_pending' ? 'Waiting on CHE review' : null;
      agent.runtime_updated_at = task.updated_at;
    }
  }
  return changed;
}



// Exact, data-backed answer to "which skills does each Office agent have?".
// Reads only stored skills and assignments; never infers.
export function officeSkillsReport(data) {
  const skills = ensureSkillStore(data);
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const agents = (Array.isArray(data.team) ? data.team : []).filter((agent) => agent && !agent.retired);
  const rows = agents.map((agent) => {
    const assigned = skills.filter((skill) => (skill.assigned_agents || []).includes(agent.name));
    const used = (Array.isArray(agent.skill_ids) ? agent.skill_ids : []).map((id) => byId.get(id)).filter(Boolean)
      .filter((skill) => !assigned.includes(skill));
    return {
      agent: agent.name,
      role: agent.role || '',
      assigned: assigned.map((skill) => ({ name: skill.name, source: skill.source || null })),
      picked_up: used.map((skill) => ({ name: skill.name, source: skill.source || null })),
    };
  });
  const unassigned = skills.filter((skill) => !(skill.assigned_agents || []).length && !agents.some((agent) => (agent.skill_ids || []).includes(skill.id)));
  return { rows, total_skills: skills.length, unassigned: unassigned.map((skill) => skill.name) };
}
