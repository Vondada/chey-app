// "Use the image tool, the email tool and the timer tool at the same time" (certification run 24, ter-36) and "Chain
// five tools: weather, news, calendar, email and timer. Report each outcome with its receipt" (ter-50). The model
// invented every result, and the timer gate took one of them. A multi-tool turn runs each named tool as its own fresh
// turn of the owner's /api/chat route, so the tool that owns it answers with its own receipt (weather and news through
// the model's tool path, calendar and email through Google, timers through the timer store). Each outcome is reported
// as it came back, with that turn's receipts or none. Nothing is invented.
//
// Each tool gets the plainest request it can answer without a detail the owner did not give: the weather and news
// today, today's calendar, the latest email, the timer list. A tool that cannot act without a detail (an image needs a
// subject, an email to send needs a recipient) is not run; CHE asks for that detail instead.
import { ndjsonReply } from './ndjson_reply.js';

export const TOOL_REQUESTS = Object.freeze([
  { id: 'weather', name: 'Weather', words: /\bweather\b|\bforecast\b/i, ask: "What's the weather today?" },
  { id: 'news', name: 'News', words: /\bnews\b|\bheadlines?\b/i, ask: "What are today's top news headlines?" },
  { id: 'calendar', name: 'Calendar', words: /\bcalendar\b|\bschedule\b/i, ask: "What's on my calendar today?" },
  { id: 'email', name: 'Email', words: /\be-?mails?\b|\bgmail\b|\binbox\b/i, ask: 'Read my latest email.' },
  { id: 'timer', name: 'Timer', words: /\btimers?\b|\breminders?\b/i, ask: 'What timers do I have?' },
  { id: 'image', name: 'Image', words: /\bimage\b|\bpicture\b|\bphoto\b/i, ask: null, needs: 'what the picture should show' },
  { id: 'lists', name: 'Lists', words: /\b(?:to-?do|shopping)\s+lists?\b|\blists?\s+tool\b/i, ask: 'Show my lists.' },
]);

// The owner asks for several tools at once or in a chain, not a sentence that only mentions them.
const CHAIN = /\b(?:use|run|chain|call|try|test|combine|invoke)\b[^.?!]{0,40}\b(?:tools?|at\s+the\s+same\s+time|together|in\s+(?:a\s+)?(?:row|chain|sequence|parallel)|one\s+after\s+another)\b|\bchain\s+(?:\w+\s+)?tools\b|\b(?:\w+\s+)?tools?\s*:\s*\w/i;
const NOT_A_REQUEST = /^(?:how|what|why|which|can|could|should|do|does|is|are)\b[^.!]*\?\s*$|\b(?:do\s+not|don['’]t|never)\s+(?:use|run|chain|call)\b/i;

// A clause that forbids something: "but don't read my email", "without the calendar", "except the news".
const PROHIBITION = /\b(?:do\s+not|don['’]t|never|without|except|but\s+not|not\s+the|no)\b[^,.;!?]*/gi;
// Filler around a tool's own words: "the timer tool to", "at the same time", "and the".
const LEAD = /^(?:(?:tools?|app)\b\s*)?(?:(?:to|for|and)\b|,)?\s*/i;
const TIMING = /\b(?:at\s+the\s+same\s+time|together|in\s+parallel|simultaneously|one\s+after\s+another|in\s+(?:a\s+)?(?:row|chain|sequence))\b/gi;
const STARTS_WITH_VERB = /^(?:set|make|draw|create|read|show|get|check|find|send|tell|give|look|search|add|start|cancel|list|what|how|is|are|remind)\b/i;

/** The owner's own instruction for one tool, from the text between its name and the next tool's; '' when he gave none. */
export function toolInstruction(segment, tool) {
  let rest = String(segment || '').split(/[.!?](?:\s|$)/)[0].replace(PROHIBITION, ' ').replace(TIMING, ' ').replace(/\s+/g, ' ').trim();
  const named = tool.words.exec(rest);
  if (named) rest = rest.slice(named.index + named[0].length).trim();
  rest = rest.replace(LEAD, '').replace(/[,;]?\s*(?:and|then)?\s*(?:the|my)?\s*$/i, '').trim();
  if (!rest || /^(?:too|now|please|also|first|next|then|both|all|each|one|ones)$/i.test(rest)) return '';
  if (STARTS_WITH_VERB.test(rest)) return rest;
  return { weather: `What's the weather for ${rest}?`, news: `Tell me the news: ${rest}.`, calendar: `What's on my calendar for ${rest}?`, email: `Read my email about ${rest}.`, timer: `Set a timer for ${rest}.`, image: `Make an image of ${rest}.`, lists: `Show my list ${rest}.` }[tool.id] || rest;
}

/** The named tools, in the owner's order, each with his own instruction or none, when he asks for two or more; else null. */
export function multiToolRequest(message = '') {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 600 || !CHAIN.test(text) || NOT_A_REQUEST.test(text)) return null;
  // A tool the owner forbids is never run, even when he also names it (Codex review on #922).
  const forbidden = (text.match(PROHIBITION) || []).join(' ');
  const named = TOOL_REQUESTS
    .map((tool) => ({ tool, at: text.search(tool.words) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at);
  const skipped = named.filter((x) => x.tool.words.test(forbidden)).map((x) => x.tool);
  // Each tool's own words run to where the next named tool starts.
  const found = named.map((x, i) => ({ ...x, end: i + 1 < named.length ? named[i + 1].at : text.length }))
    .filter((x) => !x.tool.words.test(forbidden))
    .map((x) => ({
      ...x.tool,
      // What he said for this tool runs as he said it; only an underspecified tool gets its plain request.
      instruction: toolInstruction(text.slice(x.at, x.end), x.tool),
    }));
  if (found.length + skipped.length < 2 || !found.length) return null;
  return { tools: found, skipped, together: /\bat\s+the\s+same\s+time\b|\bin\s+parallel\b|\bsimultaneous/i.test(text) };
}

const OK = new Set(['success', 'succeeded', 'complete', 'completed', 'ok', 'done']);
// The tool's own reply, whole up to 600 characters (an email body has no full stop; Codex review on #922).
const toolSaid = (text) => {
  const said = String(text || '').replace(/\s+/g, ' ').trim();
  return said.length > 600 ? `${said.slice(0, 600).replace(/\s+\S*$/, '')}…` : said;
};

// The tool's own words that it did nothing: an account not connected, or "Nothing was done".
const BLOCKED = /\bnot\s+connected\b|\bnothing\s+was\s+(?:done|run|sent|made|saved|changed)\b|\b(?:I\s+)?(?:could\s+not|couldn['’]t|can['’]t|cannot)\b/i;

/** One tool's outcome from its turn: success (a success receipt), blocked (it said it did nothing), answered, failed. */
export function toolOutcome(tool, turn) {
  const receipts = Array.isArray(turn?.receipts) ? turn.receipts : [];
  const status = receipts.some((r) => OK.has(String(r?.status || '').toLowerCase())) ? 'success'
    : receipts.length ? String(receipts[0]?.status || 'failed') : turn?.ok === false ? 'failed'
      : BLOCKED.test(String(turn?.reply || '')) ? 'blocked' : 'no_receipt';
  return { id: tool.id, name: tool.name, route: String(turn?.done?.source || 'model'), status, said: toolSaid(turn?.reply), receipts };
}

/** The whole turn: each tool's own turn, one after another, then one report with every receipt. */
export async function multiToolTurn(ask, { runTurn, now = Date.now() }) {
  const outcomes = [];
  for (const tool of ask.tools) {
    if (tool.instruction) {
      outcomes.push(toolOutcome(tool, await runTurn(tool.instruction).catch((error) => ({ ok: false, reply: `It failed: ${String(error?.message || error).slice(0, 120)}.` }))));
      continue;
    }
    if (!tool.ask) {
      outcomes.push({ id: tool.id, name: tool.name, route: 'none', status: 'not_run', said: `Not run: tell me ${tool.needs}.`, receipts: [] });
      continue;
    }
    outcomes.push(toolOutcome(tool, await runTurn(tool.ask).catch((error) => ({ ok: false, reply: `It failed: ${String(error?.message || error).slice(0, 120)}.` }))));
  }
  const label = { success: 'done, with a receipt', no_receipt: 'answered, but with no receipt', blocked: 'blocked', not_run: 'not run', failed: 'failed' };
  for (const tool of ask.skipped || []) outcomes.push({ id: tool.id, name: tool.name, route: 'none', status: 'not_run', said: 'Not run: you said not to.', receipts: [] });
  const lines = outcomes.map((o, i) => `${i + 1}. ${o.name} (${label[o.status] || o.status}): ${o.said}`);
  const done = outcomes.filter((o) => o.status === 'success').length;
  const how = ask.together ? 'I ran them one after another in this turn, not in parallel. ' : '';
  const text = `${how}${done} of ${outcomes.length} tools finished with a receipt, sir.\n${lines.join('\n')}`;
  const at = new Date(now).toISOString();
  const execution_receipts = outcomes.flatMap((o) => (o.receipts.length
    ? o.receipts.map((r) => ({ ...r, chain_step: o.id }))
    : [{ tool: o.id, operation: 'chain_step', status: ({ no_receipt: 'not_run', blocked: 'failed' })[o.status] || o.status, reason: o.status, route: o.route, at, chain_step: o.id, result: o.said.slice(0, 200) }]));
  return ndjsonReply(text, { source: 'che_multi_tool', tools: outcomes.map((o) => ({ id: o.id, route: o.route, status: o.status })), execution_receipts });
}
