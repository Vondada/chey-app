// The owner's chat, routed into CHE's browsing loop and her sub-agents. The owner's own words decide the route:
//   - "look up / search the web for X": the browsing loop, on the free sources. Her soul plans each step, the gate
//     checks each step, and the answer must cite a page the run actually read.
//   - "study <page>": the link goes to REA, which reads what the site allows.
//   - "write an original story" and "recreate the style": sub-agents do the work and report back to CHE. CHE does
//     not do it herself.
// Pure functions only. The Worker supplies the model, the stored data and the task queue.
import { runBrowseLoop, createSearchRegistry, soulPlanner } from './agent_browse_loop.js';
import { FREE_PROVIDERS, registerFreeSources, serverExecutor } from './free_sources.js';
import { memorySearchIntent } from './memory_search.js';
import { LA_AGENCIA_ROLES } from './office_company.js';

// Only the browser wording starts the loop. Ordinary "look it up" and "search the web" questions keep their own
// research route (comprehension_corpus.test.mjs), so this route never takes them over.
const SEARCH = /\b(?:browse|browsing|(?:use|with|in)\s+the\s+browser)\b/i;
const STUDY = /\b(?:study|analy[sz]e|inspect|look\s+at)\b[\s\S]{0,80}\b(?:page|site|website|account|profile|video|reel|post|link|instagram|tiktok|youtube)\b/i;
// The owner's "original story". A plain story ("tell me a story about a robot") stays with CHE's own answer.
const CREATE = /\boriginal\s+stor(?:y|ies)\b/i;
const STYLE = /\b(?:recreate|same\s+(?:type\s+of\s+)?style|style|render)\b/i;
// A question about search itself ("shouldn't searching the web be free?") is an answer, not a search.
const QUESTION_OPENER = /^(?:why|should|shouldn'?t|is|isn'?t|does|doesn'?t|do\s+you\s+think|what\s+do\s+you\s+think)\b/i;
const URL_RE = /https?:\/\/[^\s)"'<>]+/i;
// The research pages CHE kept from her reads. Listing is free; forgetting always waits for the owner's yes.
const LIST_PAGES = /\b(?:list|show|what)\b[\s\S]{0,40}\b(?:research\s+pages?|pages\s+(?:you|che)\s+(?:read|kept|stored|saved))\b/i;
const FORGET_PAGES = /\b(?:forget|delete|remove|erase)\b[\s\S]{0,60}\b(?:research\s+pages?|(?:the\s+)?pages?\s+(?:you|che)\s+(?:read|kept|stored|saved))\b/i;

/** What the owner's words ask for. A message can ask for more than one thing. */
export function browseIntent(message) {
  const text = String(message || '').trim();
  if (!text || memorySearchIntent(text)) return { search: false, study: false, create: false, style: false, list: false, forget: false, all: false, url: '' };
  const url = ((text.match(URL_RE) || [])[0] || '').replace(/[.,;!?]+$/, '');
  const question = QUESTION_OPENER.test(text);
  const study = STUDY.test(text) && !question;
  const create = CREATE.test(text) && !question;
  return {
    search: SEARCH.test(text) && !question,
    study,
    create,
    style: STYLE.test(text) && (study || create),
    list: LIST_PAGES.test(text) && !question,
    forget: FORGET_PAGES.test(text) && !question,
    all: /\b(?:all|every)\b/i.test(text),
    url,
  };
}

// Job descriptions, matched against each office agent's role, specialty and mission (the roster in office_company.js).
// Research goes to the researcher (Atlas); content, video and story work goes to the content agent (Lyra).
export const JOB_NEEDS = Object.freeze({
  research: ['research', 'scout', 'source', 'analy', 'study', 'read', 'competitor', 'market'],
  content: ['content', 'social', 'video', 'story', 'script', 'copy', 'creative', 'caption'],
});

/**
 * The jobs a request needs, in order. A research job comes first when the request needs reading; a content job
 * follows it and receives the research as its input (the research task's `next`). Each job names what it needs,
 * never a fixed agent: the agent is chosen from the team by job description.
 */
export function subAgentPlan(message, { url = '' } = {}) {
  const intent = browseIntent(message);
  const link = url || intent.url;
  const research = intent.study && link
    ? {
      needs: JOB_NEEDS.research,
      roleSpec: JOB_ROLE_SPECS.research,
      label: 'study the page and describe how it makes its videos',
      task: `Study the page ${link}: pacing, camera moves, shot length, captions, music, and the tools that look used. Use only what was really read. List what could not be verified. The owner's words: ${String(message).slice(0, 800)}`,
    }
    : null;
  const contentWanted = intent.create || (intent.style && Boolean(link));
  if (!contentWanted) return research ? [research] : [];
  const content = {
    needs: JOB_NEEDS.content,
    roleSpec: JOB_ROLE_SPECS.content,
    label: intent.create && !research ? 'write an original story' : 'make an original video in the same style',
    task: research
      ? `Make an original video plan in the same style as the research that follows. Do not copy the source. Mark any detail you invented as invented. The owner's words: ${String(message).slice(0, 800)}`
      : `Write the original story the owner asked for, and keep to the length and form he gave. Do not copy any existing story. Mark any detail you invented as invented. The owner's words: ${String(message).slice(0, 800)}`,
  };
  if (!research) return [content];
  return [{ ...research, next: content }];
}

// Who takes a job, in order: the named roster first (Nova, Atlas, Mira, Knox, Sage, Lyra, Iris, from office_company.js),
// then any other named agent, and partners last. Within a tier the best job-description match wins. Null when no one fits.
export function pickOfficeAgent(team = [], { needs = [] } = {}) {
  const live = (Array.isArray(team) ? team : []).filter((a) => a && !a.retired);
  const onRoster = (a) => Object.prototype.hasOwnProperty.call(LA_AGENCIA_ROLES, a.name);
  const isPartner = (a) => /partner|reviewer/i.test(String(a.role || ''));
  const tiers = [
    live.filter(onRoster),
    live.filter((a) => !onRoster(a) && !isPartner(a)),
    live.filter(isPartner),
  ];
  for (const tier of tiers) {
    let best = null;
    let bestScore = 0;
    for (const agent of tier) {
      const text = `${agent.role || ''} ${agent.specialty || ''} ${agent.mission || ''}`.toLowerCase();
      const score = needs.filter((word) => text.includes(word)).length;
      if (score > bestScore) { best = agent; bestScore = score; }
    }
    if (best) return best;
  }
  return null;
}

// The role CHE creates when nobody on the team covers a job. Created only then, and only with a name not yet taken.
export const JOB_ROLE_SPECS = Object.freeze({
  research: Object.freeze({ role: 'Research / scout', specialty: 'Research, source reading and public-page study' }),
  content: Object.freeze({ role: 'Content / social', specialty: 'Content, video and story drafts' }),
});

/** An office agent's own personality plus the job it holds at CHE, used as the soul of its loop. */
export function agentSoul(agent = {}) {
  return [String(agent.personality || '').trim(), agent.role ? `Your job at CHE: ${agent.role}${agent.specialty ? ` (${agent.specialty})` : ''}. Work only within it.` : '']
    .filter(Boolean).join('\n');
}

/**
 * An office agent's browsing task: the same loop CHE uses, planned with the agent's own soul (personality and job)
 * through complete. Pages the run reads are kept through keepReads, when the Worker provides it.
 */
export async function runBrowseTask({ question, soul = '', complete, fetcher = fetch, keepReads = null }) {
  const outcome = await runSearchRoute(question, { complete, soul, fetcher });
  const kept = keepReads ? keepReads(question, outcome.observations || []) : 0;
  return { text: kept ? `${outcome.text}\nI kept ${kept} page${kept === 1 ? '' : 's'} I read as research pages.` : outcome.text, status: outcome.status };
}

/** Plain text of the loop's outcome. Every reason is the real one; nothing is filled in. */
export function browseReply(outcome, question = '') {
  const steps = Array.isArray(outcome.steps) ? outcome.steps.length : 0;
  const read = (outcome.observations || []).filter((o) => o.read && o.ok).length;
  const trail = `(${steps} step${steps === 1 ? '' : 's'}, ${read} page${read === 1 ? '' : 's'} read)`;
  if (outcome.status === 'answered') {
    const sources = (outcome.sources || []).map((url, i) => `${i + 1}. ${url}`).join('\n');
    return `${String(outcome.answer || '').trim()}\n\nSources I read:\n${sources}\n${trail}`;
  }
  const why = outcome.reason ? ` ${outcome.reason}` : '';
  const lead = {
    not_found: 'I searched and read no page that answers that, so I have no answer.',
    uncited: 'I read pages, but my answer did not cite one of them, so I am not giving it.',
    no_plan: 'I could not decide the next step, so I stopped.',
    budget_exhausted: 'I ran out of steps before I could answer.',
    needs_owner: 'I stopped here and need you.',
    held: 'This step waits for your yes.',
    refused: 'I am not allowed to take that step.',
  }[outcome.status] || 'I could not finish that.';
  return `${lead}${why} ${trail}`.trim();
}

/**
 * Runs the search route. deps: { complete(messages) -> text (the model), soul, fetcher, storage? }.
 * Every search provider is a free source; the owner's typed request is the permission for the browser.
 */
export async function runSearchRoute(message, { complete, soul = '', fetcher = fetch } = {}) {
  // The providers read through the same fetcher as the page reader, so a test (or a limit) reaches all of them.
  const providers = Object.fromEntries(Object.entries(FREE_PROVIDERS).map(([key, p]) => [key, { ...p, search: (query) => p.search(query, fetcher) }]));
  const registry = createSearchRegistry();
  registerFreeSources(registry, providers);
  const outcome = await runBrowseLoop({
    question: String(message || '').slice(0, 1000),
    planner: soulPlanner({ soul, complete }),
    executor: serverExecutor({ fetcher }),
    search: registry,
    app: 'browser',
    grants: ['browser'],
  });
  return { ...outcome, text: browseReply(outcome, message) };
}
