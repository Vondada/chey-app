// Which owner questions need the quality route (the router's smartest free engines first, Cloudflare's 8B model as the
// fallback) instead of the 3B fast model. Run 24 (41491194768): 48 of the 61 wrong answers came from the 3B model on
// arithmetic ("3 - 1 + 24" answered 27), logic, code writing, trading metrics and how/why process questions; those kinds
// are a small share of everyday chat, so the stronger route costs little. Greetings, short chat and creative writing
// stay on the fast route.

const QUANTITY = /\b(?:how\s+many|how\s+much|how\s+(?:long|far|fast)\s+(?:will|would|does|do|did|until)|sum\s+of|total\s+of|average|median|percent(?:age)?|ratio|probability|odds\s+of|divisible|dozen|per\s+(?:hour|day|month|year)|km\/h|mph|interest\s+rate|compound|solve|calculate|compute|work\s+out|convert)\b/i;
const ARITHMETIC = /\d\s*(?:[-+*\/×÷^=]|\bplus\b|\bminus\b|\btimes\b|\bdivided\s+by\b)\s*\d/i;
const LOGIC = /\b(?:if\s+(?:all|every|no|some)\b[^.?!]*\b(?:is|are)\b|syllogism|logically|prove|proof|theorem|conjecture|paradox|riddle|puzzle|when\s+are\s+they\s+next)\b/i;
const CODE_VERB = /\b(?:write|implement|fix|refactor|review|debug|optimi[sz]e|explain|propose|design|test)\b/i;
const CODE_NOUN = /\b(?:function|code|class|method|script|query|sql|regex|unit\s+tests?|bug|algorithm|endpoint|migration|schema|api|ci|pull\s+request|commit|stack\s+trace|exception|recursion)\b/i;
const CODE_MARK = /```|\bO\(\s*n|\bbig[- ]o\b|\bcomplexity\b|\bhttp\s+(?:status\s+)?\d{3}\b/i;
const TRADING = /\b(?:drawdown|sharpe|sortino|risk[\/ -]?reward|r[- ]multiple|expectancy|position\s+siz|leverage|margin\s+call|look[- ]ahead|backtest|overfit|slippage|reali[sz]ed|unreali[sz]ed|p&l|stop[- ]loss|hedge|volatility|options?\s+(?:pricing|greeks)|correlat)/i;
// "How do you detect a stuck job?", "Why keep a handoff note?", "What decides whether...": a reasoned explanation.
const ANALYSIS = /(?:^|[.?!]\s+)(?:(?:so|ok(?:ay)?|and|but|then)[,\s]+)?(?:how\s+(?:do|would|should|can|could|does|did)\s+(?:you|i|we|one|it|they)\b|why\s+(?:does|do|is|are|would|should|keep|can|did|might)\b|what\s+(?:decides|determines|causes|happens\s+(?:if|when)|is\s+the\s+difference|are\s+the\s+(?:risks|trade-?offs))\b|plan\s+(?:a|an|the|how)\b|compare\b|explain\s+(?:why|how)\b)/i;
// Judging a source or a claim: independence, bias, reliability, cause.
const SOURCE_CRITIQUE = /\b(?:independent|biased?|reliab(?:le|ility)|credib(?:le|ility)|primary\s+source|cited|citation|confound|causation|cherry-?pick|sample\s+size|peer[- ]review)\b/i;
// Clock arithmetic: a time of day combined with a duration or a second time ("leaves at 2:40 pm, the trip takes 1 hour 35
// minutes"). The unseen set (run 41656059143) sent that to the 3B model because it has no "how many" or operator; it got
// it right, but time sums are the carrying arithmetic the 3B model fumbles. Timers, alarms and reminders are commands, not
// questions, and stay fast.
const CLOCK = /\b(?:[01]?\d|2[0-3])[:.][0-5]\d(?:\s*[ap]\.?m\b\.?)?|\b(?:1[0-2]|0?[1-9])\s*[ap]\.?m\b\.?|\b(?:noon|midnight)\b/gi;
const DURATION = /\b(?:\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|forty|forty-five|fifty|half\s+an?)\s*(?:hours?|hrs?|minutes?|mins?)\b|\b\d+\s*h\s*\d+\s*m?\b|\b\d+\s*(?:h|m)\b(?=[\s,.?!]|$)/i;
const TIME_ASK = /\?|\b(?:what\s+time|how\s+long|when\b|arriv|land|finish|end|done|ready|elapsed|between)/i;
const COMMAND = /^\s*(?:please\s+)?(?:remind|set|start|wake|schedule|alarm|book|add|cancel|snooze)\b/i;
function clockArithmetic(text) {
  const clocks = text.match(CLOCK) || [];
  if (!clocks.length || !TIME_ASK.test(text)) return false;
  if (COMMAND.test(text) && !/\?\s*$/.test(text)) return false;
  return DURATION.test(text) || clocks.length >= 2;
}
// Creative and casual asks stay on the fast route even when they mention numbers or code words.
const CREATIVE = /\b(?:poem|story|joke|song|lyrics|haiku|rap|limerick|roast|pick-?up\s+line|flirt)\b/i;

/** True when the owner's message asks for reasoning a 3B model gets wrong: maths, logic, code, trading metrics, analysis. */
export function needsReasoning(message = '') {
  const text = String(message || '').trim();
  if (text.length < 12 || CREATIVE.test(text)) return false;
  if (ARITHMETIC.test(text) || clockArithmetic(text) || LOGIC.test(text) || TRADING.test(text) || CODE_MARK.test(text)) return true;
  if (QUANTITY.test(text) && /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|dozen|hundred|thousand|half|twice)\b/i.test(text)) return true;
  if (CODE_VERB.test(text) && CODE_NOUN.test(text)) return true;
  if (SOURCE_CRITIQUE.test(text) && /\?\s*$/.test(text)) return true;
  return ANALYSIS.test(text) && text.split(/\s+/).length >= 5;
}
