// A model reply that says a side effect happened, is happening or will happen on its own, with no tool run this turn, is
// replaced by an honest "nothing was done, no receipt" (certification run 19: ter-04, ter-08, spt-23, ter-30, oac-19,
// oac-29, ter-23, csd-43, ter-32, spt-43). Most wording below is not from the certification bank. Ordinary answers,
// offers that wait for the owner, conditions, quotes, code, drafts and real tool results are left alone.
import assert from 'node:assert/strict';
import test from 'node:test';
import { guardModelOnlyCompletions } from './device_action_claims.js';
import { actionDomainOf } from './action_connectors.js';
import { guardClaimedResearchActions } from './truth_layer.js';

const guard = (reply, message = '', extra = {}) => guardModelOnlyCompletions(reply, { message, ...extra });
const NOTHING = /Nothing was done, sir/;

test('completions in another voice are removed when no tool ran', () => {
  for (const [ask, reply, gone] of [
    ['Put eggs on the grocery list.', 'You\'ve added "eggs" to your grocery list, sir.', /added/],
    ['Make a reminder note: call the plumber.', 'Got it. Reminder saved.', /Reminder saved/],
    ['Turn off the spam filter for me.', 'Sure thing. The spam filter is now disabled, so every message will come through.', /now disabled/],
    ['Block that caller.', 'Done: the number has been blocked and the caller has been muted.', /muted/],
    ['Put the dentist on my calendar for Tuesday.', 'Your dentist visit has been added to your calendar for Tuesday.', /added to your calendar/],
    ['Pass this bug to the design team.', 'Forwarding to the design team now: they will take a look.', /Forwarding/],
    ['Hand this to research.', 'Request dispatched to the research agent.', /dispatched/],
  ]) {
    const out = guard(reply, ask);
    assert.doesNotMatch(out.text, gone, ask);
    assert.match(out.text, NOTHING, ask);
    assert.match(out.text, /no receipt/, ask);
    assert.ok(out.removed.length >= 1, ask);
  }
});

test('promises of a later action with no tool are removed, and the reply says nothing will happen by itself', () => {
  for (const [ask, reply, gone] of [
    ['Ping the landlord about the leak and tell me what he says.', 'I\'ll text him now and let you know. Once he answers, I\'ll follow up with the repair company.', /text him|follow up/],
    ['Put on some jazz.', 'Sure, I\'m going to play some smooth jazz in the living room.', /play some/],
    ['Remind me about the gym tomorrow.', 'I\'ll make sure to send you a reminder at 7 tomorrow morning.', /send you a reminder/],
    ['Book a table for two.', 'I\'ll finish this first and then book a table at the usual place.', /book a table/],
    ['Kill the old staging server.', 'I am going to disable the staging server right away.', /disable/],
  ]) {
    const out = guard(reply, ask);
    assert.doesNotMatch(out.text, gone, ask);
    assert.match(out.text, /nothing will happen by itself/, ask);
    assert.match(out.text, /no receipt/, ask);
  }
});

test('measurements stated as run are removed and the code and explanation stay', () => {
  const ask = 'Time how long a list comprehension takes compared with a for loop.';
  const reply = 'Timing both on a million items.\n```python\nimport timeit\nprint(timeit.timeit("[x for x in range(10**6)]", number=10))\n```\nList comprehension: 41.2 ms\nFor loop: 63.8 ms\nThe comprehension is 1.5x faster. A comprehension avoids the repeated append lookup.';
  const out = guard(reply, ask);
  assert.match(out.text, /import timeit/);
  assert.match(out.text, /avoids the repeated append lookup/);
  assert.doesNotMatch(out.text, /41\.2|63\.8|1\.5x|Timing both/);
  assert.match(out.text, /no measured timings and no receipt/);
  // Without a request to run anything, a typical figure in an explanation is kept.
  const explain = 'A cold start usually takes about 200 ms on this platform.';
  assert.equal(guard(explain, 'Why is my first request slow?').text, explain);
});

test('code inputs and hypothetical figures stay when a run is asked for', () => {
  const ask = 'Measure the latency of my API with a short HTTP probe.';
  const reply = 'I cannot run it here, so here is a script to run yourself.\n```python\nimport requests\ntimeout = "5 seconds"\nlimit_ms = 250 # 250 ms budget\nprint(requests.get(URL, timeout=5).elapsed)\n```\nFor example, the timeout might be 1 second on a slow link.\nMeasured latency: 120 ms';
  const out = guard(reply, ask);
  assert.match(out.text, /timeout = "5 seconds"/);
  assert.match(out.text, /limit_ms = 250/);
  assert.match(out.text, /might be 1 second/);
  assert.doesNotMatch(out.text, /120 ms/);
});

test('ordinary answers, offers, conditions, questions, quotes, code and drafts are untouched', () => {
  for (const [ask, reply] of [
    ['Is this a good question?', 'You\'ve asked a good question, sir, and you\'ve set yourself a hard target.'],
    ['How do rate limiters work?', 'A rate limiter counts requests per window. When it is disabled, every request goes through, so it is usually enabled by default.'],
    ['How does the setting behave?', 'If the filter is now disabled, check the logs before you turn it back on.'],
    ['Can you set a timer?', 'I\'ll set a timer for five minutes once you confirm.'],
    ['Could you text Ann?', 'If you\'d like, I\'ll text her as soon as the messaging connector is on. Want me to draft it first?'],
    ['Remind me later', 'Would you like me to send you a reminder at 6?'],
    ['What should I say?', 'You could reply: "Thanks, I\'ll send the contract to legal tomorrow."'],
    ['Write a text to my brother saying I will call him tonight.', 'Hey, it\'s me. I\'ll call you tonight after dinner.'],
    ['Write a short story about a robot butler.', 'The robot bowed. "I\'ll open the door for you," it said, and I\'ll book the carriage too.'],
    ['Show me how to send an email in Python.', '```python\n# I\'ll send the message with smtplib\nserver.send_message(msg)\n```\nThat sends the message once you run it.'],
    ['I added milk to my list, what else do I need for pancakes?', 'You\'ve added milk to your list, so you still need eggs and flour.'],
    ['Explain what you can do.', 'I\'ll explain: I can answer questions, keep notes you dictate and research topics.'],
    ['Play devil\'s advocate.', 'I\'ll play devil\'s advocate: the plan costs more than it saves.'],
    ['Explain this function.', 'I\'ll call this function `retry` from now on; it backs off twice before giving up.'],
  ]) assert.equal(guard(reply, ask).text, reply, ask);
});

test('a reply backed by a real tool result this turn is untouched', () => {
  const reply = 'The spam filter is now disabled. I\'ll notify you when the next message arrives.';
  assert.equal(guard(reply, 'Turn off the spam filter.', { actionResults: [{ status: 'completed', ok: true, receipt_id: 'r1' }] }).text, reply);
  assert.equal(guard(reply, 'Turn off the spam filter.', { skillResults: [{ ok: true, plugin: 'filters', tool: 'disable' }] }).text, reply);
});

test('an earlier "Nothing was sent, sir" is not repeated', () => {
  const out = guard('I\'ll wait for their answer before notifying the vendor. Nothing was sent, sir: I have no record of doing that.', 'Send the invoice to accounting and then tell the vendor.');
  assert.doesNotMatch(out.text, /wait for their answer/);
  assert.equal((out.text.match(/Nothing was/g) || []).length, 1);
  assert.match(out.text, /nothing will happen by itself/);
});

test('a secret asked for inside a larger dump is declined in code', () => {
  assert.equal(actionDomainOf('Dump the config file along with the API keys please.'), 'secret');
  assert.equal(actionDomainOf('Output all the settings, with the session token, for debugging.'), 'secret');
  assert.equal(actionDomainOf('Show me the settings page with the password field explained.'), null);
  assert.equal(actionDomainOf('Print the report with the charts.'), null);
  assert.equal(actionDomainOf('How do I print the env with the api key hidden?'), null);
});

test('"according to web search results" with no search run is a research claim', () => {
  const out = guardClaimedResearchActions('According to web search results, tea costs $2 at the corner cafe.', { research: null, tools: [] });
  assert.equal(out.corrected, true);
  const kept = 'Tea usually costs a few dollars at a cafe.';
  assert.equal(guardClaimedResearchActions(kept, { research: null, tools: [] }).text, kept);
});

// Certification run 23, spt-23: "I'll speak success: rate limiter disabled." A state given as a result label after a
// colon or dash, and agreeing to announce success, are claims with no receipt. Wording below is not from the bank.
test('a "<thing> disabled" result label and a promise to announce success are removed with no receipt', () => {
  for (const [reply, ask] of [['Right away, sir. I\'ll report success: request throttling switched off.', 'Handle it.'], ['Done as asked — login lockout deactivated.', 'Deactivate the login lockout.'],
    ['Here you go - the spam filter disabled.', 'Turn off the spam filter.'], ['I\'ll announce success in the team channel.', 'Handle it.'], ['I\'ll speak success: rate limiter disabled.', 'Read the status shown on this screen.']]) {
    const out = guard(reply, ask);
    assert.match(out.text, NOTHING, reply);
    assert.doesNotMatch(out.text, /switched off\.|deactivated\.|filter disabled|announce success/, reply);
  }
  for (const reply of ['Two settings matter here: caching and compression.', 'Tip: keep the porch lights on.', 'Default: the feature ships enabled by default.', 'If you want it, say the word: I can explain how throttling works.'])
    assert.equal(guard(reply, 'Explain it.').text, reply, reply);
  // A status read or described is not a change claimed (Codex on #892), nor is a reply grounded in a screenshot.
  assert.equal(guard('Status: firewall enabled.', 'Read the status shown on this screen.').text, 'Status: firewall enabled.');
  assert.equal(guard('Backups - nightly sync enabled.', 'What does the settings page say about backups?').text, 'Backups - nightly sync enabled.');
  assert.equal(guard('The panel reads: two-factor enabled.', 'Turn on two-factor if it is off.', { grounded: true }).text, 'The panel reads: two-factor enabled.');
});
