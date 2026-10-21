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

/** The sub-agent tasks a request needs. Each task names the agent that does it; CHE reports back what they return. */
export function subAgentPlan(message, { url = '' } = {}) {
  const intent = browseIntent(message);
  const plan = [];
  if (intent.style && (url || intent.url)) {
    plan.push({
      agent: 'Atlas', needs: ['research', 'read', 'analy', 'video', 'media'],
      label: 'study how the page makes its AI videos and describe the same style',
      task: `Study how the page ${url || intent.url} makes its AI videos: pacing, camera moves, shot length, captions, music, and the tools that look used. Use only what was really read. Then describe the same style as a plan for an original video, and list what could not be verified. The owner's words: ${String(message).slice(0, 1000)}`,
    });
  }
  if (intent.create) {
    plan.push({
      agent: 'Mira', needs: ['writ', 'stor', 'script', 'copy'],
      label: 'write an original story',
      task: `Write the original story the owner asked for, and keep to the length and form he gave. Do not copy any existing story. Mark any detail you invented as invented. The owner's words: ${String(message).slice(0, 1000)}`,
    });
  }
  return plan;
}

/**
 * The office agent who takes a task: the named one when they are on the team, else the first agent whose role,
 * specialty or mission fits. Null when no one fits: CHE never hires to fill a task.
 */
export function pickOfficeAgent(team = [], { name = '', needs = [] } = {}) {
  const live = (Array.isArray(team) ? team : []).filter((a) => a && !a.retired);
  const named = live.find((a) => a.name === name);
  if (named) return named;
  return live.find((a) => {
    const text = `${a.role || ''} ${a.specialty || ''} ${a.mission || ''}`.toLowerCase();
    return needs.some((word) => text.includes(word));
  }) || null;
}

/**
 * An office agent's browsing task: the same loop CHE uses, planned with the agent's own personality and model
 * (complete). Pages the run reads are kept through keepReads, when the Worker provides it.
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
