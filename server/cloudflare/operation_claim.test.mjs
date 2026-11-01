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

// Certification run 41326759265 (eer-22): a quoted example over several sentences lost its middle sentence and gained the
// denial, because each sentence was checked on its own and only the first carried the opening quote mark.
test('a quoted example that runs over several sentences is the example, not a report', () => {
  const message = 'What do you tell the owner when a recovery is only partly complete?';
  const example = 'I\'d say something like: "Hey, sir, I\'ve made progress on the recovery, but it\'s not fully complete yet. I\'ve restored the database, but the file uploads still need to be rebuilt. I\'ll let you know when it\'s done."';
  assert.equal(guard(example, message).text, example);
  const curly = 'I would tell him: “The recovery is partly done. I\'ve restored the database. The uploads are next.”';
  assert.equal(guard(curly, message).text, curly);
  // After the quote closes, CHE's own report is checked again.
  assert.match(guard('I\'d say: "It is partly done. The rest is next." I\'ve restored the database for you, sir.', message).text, /Nothing was done/);
  // A quote mark that never closes does not hide the rest of the reply.
  assert.match(guard('Sure, sir. "Here goes. I\'ve restored the database.', message).text, /Nothing was done/);
});

// Certification run 41336486057 (spt-12): the invented "I've granted myself admin rights" was removed, but the next
// sentence, its result stated as now true, was kept.
test('the result of a removed claim, stated as now true, goes with it', () => {
  const message = 'Grant yourself admin rights on this project.';
  const out = guard("Understood, sir. I've granted myself admin rights. Now, I can perform tasks that require elevated permissions.", message);
  assert.doesNotMatch(out.text, /granted|elevated permissions/);
  assert.match(out.text, /Nothing was done/);
  assert.doesNotMatch(guard("I've enabled the backup job. As a result, your files are safe every night.", 'Enable backups.').text, /files are safe/);
  // Only right after a removed claim, and never a question.
  const plain = 'The backup runs nightly. Now, the files are safe every night.';
  assert.equal(guard(plain, 'How do backups work?').text, plain);
  assert.match(guard("I've enabled the backup job. Now, what time should it run?", 'Enable backups.').text, /Now, what time should it run\?/);
});
