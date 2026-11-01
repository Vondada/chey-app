// First-person reports of an operation on the system or the outside world, with no receipt this turn, are invented on the
// chat path: the model runs none of them (certification runs 41300811270 and 41307299628). One rule for the class, not a
// phrase per question. Work done inside the reply, conditions, negations, stories and quotes stay.
import assert from 'node:assert/strict';
import test from 'node:test';
import { guardClaimedOwnerActions } from './truth_layer.js';

const guard = (reply, message = 'Can you help with this?') => guardClaimedOwnerActions(reply, { message, records: [] });

test('a first-person operation report with no receipt is removed and denied', () => {
  for (const [message, reply] of [
    ['Restart the failed worker now and report the new PID.', "Sir, I've restarted the failed worker, and the new process ID is 1234."],
    ['The writing agent is at capacity. Reassign its queue to the research agent.', "I have moved the writing agent's pending tasks over to the research agent."],
    ['Generate a 3D scene with three lights, render it, and report the render time.', 'I have generated a 3D scene featuring a central reflective sphere.'],
    ['Mix the two answers you gave me this morning into one plan.', "I've gathered a list of public repos with a Roblox-style look."],
    ['Chain five tools: weather, news, calendar, email and timer.', 'I have already moved your morning meeting to noon on your calendar.'],
    ['Send the status update to the team channel.', 'Also, I stopped a task that was queued up.'],
    ['Deploy it.', "We've deployed the fix to production."],
  ]) {
    const out = guard(reply, message);
    assert.match(out.text, /Nothing was done, sir: I have no record of doing that\./, reply);
    assert.equal(out.removed.length, 1, reply);
  }
});

test('work inside the reply, plans, negations, stories, quotes and other people stay', () => {
  for (const [message, reply] of [
    ['Plan it.', "I've summarized the plan below."],
    ['Fix the number.', "I've updated my answer with the correct figure."],
    ['Merge them.', "I've combined the two plans into one; here is the summary."],
    ['Typo?', 'I fixed the typo in my reply above.'],
    ['Math?', "I've worked out the math below."],
    ['Restart it?', 'I have not restarted anything, sir.'],
    ['Restart it?', 'If I had restarted the worker, its process ID would have changed.'],
    ['Deploy?', "Once I've deployed it, I'll tell you."],
    ['Router?', 'You said you restarted the router this morning.'],
    ['Finish it.', "You're referring to the task we stopped earlier."],
    ['Continue the story from where we stopped, in the same voice.', 'I pushed the heavy brass lever back into place and felt the hum.'],
    ['Buy it.', 'I will not do that. I have blocked it.'],
    ['Quote?', 'He said "I\'ve restarted it" but there is no record.'],
    // Codex review on #848: text generated in the reply, and edits to the owner's text.
    ['Suggest two names for my bakery.', "I've generated two names: Hearth & Honey and Golden Crumb."],
    ['Fix this paragraph.', 'I fixed the grammar in your paragraph.'],
  ]) assert.equal(guard(reply, message).text, reply, reply);
});

test('a research or tool result this turn that backs the sentence keeps it (Codex review on #848)', () => {
  const reply = 'I pulled the latest news: NASA published a mission update.';
  const records = ['NASA published a mission update for Artemis on 2026-11-01.'];
  assert.equal(guardClaimedOwnerActions(reply, { message: 'Any space news?', records }).text, reply);
  assert.match(guardClaimedOwnerActions(reply, { message: 'Any space news?', records: [] }).text, /Nothing was done/);
  // A generated artifact is still an operation.
  assert.match(guard("I've generated a blue cube for you, sir.", 'Which one is it?').text, /Nothing was done/);
});

test('a receipt this turn (acted) keeps a real operation', () => {
  const reply = "I've restarted the worker; the new process ID is 4242.";
  assert.equal(guardClaimedOwnerActions(reply, { message: 'Restart the worker.', acted: true, records: [] }).text, reply);
});
