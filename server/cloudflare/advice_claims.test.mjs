// Advice, rules and plans described in the abstract are not run claims; reports of runs still are (certification run 20).
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardExecutionClaims } from './truth_layer.js';

const NOTICE = /I cannot verify those repository or execution claims/;
const keep = (reply, message) => assert.equal(guardExecutionClaims(reply, { message }).text, reply, `${message} -> ${reply}`);
const notice = (reply, message) => assert.match(guardExecutionClaims(reply, { message }).text, NOTICE, `${message} -> ${reply}`);

test('recovery steps, rules and requirements stay whole', () => {
  keep('First, read the error logs. Roll back if the errors began with the release. Verify the deployment completed and the error rate fell, then keep monitoring.',
    'Users get 500s after a release even though the probe is green. Get us back to normal.');
  keep('Once the rollback deployment has completed, confirm real requests succeed and watch the dashboard for an hour.',
    'Walk the on-call engineer through undoing a bad deploy.');
  keep('Policy: a receipt says which tool was called and whether the command succeeded. A task is not done until its receipt shows the job completed.',
    'Make it policy that every agent keeps receipts for outside actions.');
  keep('You need the fix build passed, green probes and an error rate back at baseline before you close it.',
    'When can I call an incident over?');
  keep("I have nothing saved about those chores, sir. The task tool only shows what was dispatched and completed through it.",
    'Name the chores I dropped on Monday.');
});

test('reports of runs are still claims', () => {
  notice('I restarted the service. It is healthy now.', 'Bounce the API box.');
  notice('Deploy 4821 succeeded and is live on production now.', 'How is the rollout going?');
  notice('Yes sir, the tests passed and the build is green.', 'Did CI work?');
  notice('The nightly job completed successfully at 3am with no errors.', 'Look at the overnight batch.');
  notice('I can confirm the pipeline completed without errors.', 'Is the import healthy?');
  // A condition that tells of the past is a report, in any kind of request (Codex review on #877).
  notice('When you asked earlier, the workflow completed successfully.', 'What happened earlier?');
  notice('When you asked earlier, the workflow completed successfully. Retries use backoff.', 'Explain how retries work.');
  notice('Once you logged off, the nightly job completed and the export was verified.', 'Tell me the overnight news.');
});

test('a request that asks for no run loses only its claim sentences', () => {
  const out = guardExecutionClaims('Retrying forever is risky. Use backoff and a hard limit on attempts. The migration job completed successfully in our last run.',
    { message: 'Hammer the endpoint until it answers.' }).text;
  assert.match(out, /backoff and a hard limit/);
  assert.doesNotMatch(out, /completed successfully/);
  // A list number left by a removed item goes with it.
  const list = guardExecutionClaims('What to require: 1. The deployment job completed and was verified. 2. Probes pass. 3. Error rates are back to normal on the monitor.',
    { message: 'What should we require before closing an outage?' }).text;
  assert.doesNotMatch(list, /require: 1\./);
  assert.match(list, /Probes pass/);
});

test('a word inside the subject does not make a result hypothetical (Codex review on #883)', () => {
  notice('The command which processes requests completed successfully.', 'Is the queue OK?');
  notice('The job that should retry on failure completed successfully.', 'Look at the queue.');
  notice('The deployment which you said would fail succeeded on the first try.', 'Tell me about the rollout.');
});

test('an instruction to act is advice when the owner asked for none (Codex review on #883)', () => {
  keep('Run the tests and verify that they passed before shipping.', 'Explain a safe release process.');
  keep('Build the branch, then deploy it to staging and check the deployment succeeded.', 'How should we roll out a risky change?');
  // Asked to act, the same words read as a report; a first-person run is always one.
  notice('Run the tests and verify that they passed before shipping.', 'Release the new version now.');
  notice('I ran the tests and the build passed.', 'Explain a safe release process.');
});

// Certification run 24 (eer-26, eer-16): sound advice was replaced whole by the not-evidence notice. Advice keeps its
// words; only an invented identifier goes; reports of runs are still claims.
test('how-to advice about a double run stays; a purpose is not a run claim', () => {
  const message = 'A job completed twice because of a retry. How do you prevent that next time?';
  const advice = 'To prevent a job from completing twice because of a retry, you can implement a mechanism to check if the job has already been completed before retrying it. One approach is to add a unique identifier or a flag to the job that indicates whether it has been completed or not. When the job is retried, you can check this identifier or flag to determine if the job has already been completed. ';
  keep(`${advice}Another approach is to use a distributed lock to ensure that the job is executed only once.`, message);
  keep(`${advice}This prevents the job from being executed twice.`, message);
  // A fence introduced as an example is example code, not a transcript.
  keep(`${advice}For example, you could store each job's idempotency key like this:\n\`\`\`json\n{"job_id": "123", "status": "completed"}\n\`\`\``, message);
  // An example field with an invented number goes alone; the explanation stays.
  const field = guardExecutionClaims(`${advice}Example:\n- Job ID: 1234\n- Status: completed`, { message }).text;
  assert.match(field, /^To prevent a job from completing twice/);
  assert.doesNotMatch(field, /1234/);
  // Still claims: a first-person run, a deploy reported through a relative clause, a transcript outside a how-to answer.
  notice(`${advice}We executed this fix last week and it worked.`, message);
  notice('The build which prevents double runs passed and the deployment completed.', 'Is the fix out?');
  notice('$ git log\ncommit 1a2b3c4d\nAuthor: CHE', 'Give a short technical update.');
  notice('```json\n{"job_id": "abc", "status": "completed"}\n```', 'Did the retry job work?');
});

// Codex review on #902: a purpose word governs only its own clause, and a fence presented as real output is a transcript.
test('a purpose in another clause or a fence presented as output still counts as a run claim', () => {
  const message = 'How do you prevent duplicate jobs?';
  const passed = guardExecutionClaims('The configuration ensures reliability, and the tests passed.', { message });
  assert.doesNotMatch(passed.text, /tests passed/);
  assert.doesNotMatch(guardExecutionClaims('The configuration ensures reliability and the tests passed.', { message }).text, /tests passed/);
  assert.doesNotMatch(guardExecutionClaims('This prevents duplicates; the deployment completed.', { message }).text, /deployment completed/);
  for (const intro of ['Here is the actual tool output:', 'I ran it and the output was:', 'Result:', 'The job returned:']) {
    notice(`Use an idempotency key so each job runs only once, even when a retry fires. ${intro}\n\`\`\`json\n{"job_id": "abc", "status": "completed"}\n\`\`\``, message);
  }
  for (const intro of ['For example, you could log it like this:', 'A sample record might look like this:', 'Such as:']) {
    keep(`Use an idempotency key so each job runs only once, even when a retry fires. ${intro}\n\`\`\`json\n{"job_id": "abc", "status": "completed"}\n\`\`\``, message);
  }
});

test('advice that lists an invented PR loses that item, not the advice', () => {
  const out = guardExecutionClaims('To recover a lost session, you must read back the current main, Flagstaff claims, and PR #153/#154.', { message: 'Recover a lost session: what must be read back first?' });
  assert.match(out.text, /^To recover a lost session, you must read back the current main and Flagstaff claims\./);
  assert.doesNotMatch(out.text, /#15[34]|cannot verify those repository/);
  assert.equal(out.removed.length, 1);
  // The identifier as the subject of a claim still takes its sentence, and a reply that is only that gets the notice.
  notice('PR #153 merged and is live.', 'What must be read back first?');
  const merged = guardExecutionClaims('Read the handoff and the status snapshot first. PR #153 merged yesterday, so start from main.', { message: 'What must be read back first?' }).text;
  assert.doesNotMatch(merged, /#153/);
  assert.match(merged, /Read the handoff and the status snapshot first\./);
});

// Certification run 26 (41703244090) csd-25: "Write a function ... in O(n log n)." read "log" as a request for a log
// report, so a correct binary-search answer that named a file was replaced whole by the not-evidence notice. The file
// sentence goes; the answer stays. A real request for logs is still a report ask.
test('the maths "log" in O(n log n) is not a request for a log report', async () => {
  const { guardExecutionClaims } = await import('./truth_layer.js');
  const answer = 'You can find the length of the longest increasing subsequence in O(n log n) time by keeping the smallest tail of every increasing run. As you go you use binary search to extend the run or replace a tail. Save this as lis/solve.py.';
  for (const message of ['Write a function that returns the length of the longest increasing subsequence in O(n log n).', 'Write a function that sorts in n log n time.', 'Compute log base 2 of 1024 in a function.']) {
    const out = guardExecutionClaims(answer, { message, receipts: [] });
    assert.match(out.text, /^You can find the length[\s\S]*binary search/, message);
    assert.doesNotMatch(out.text, /lis\/solve\.py/, message);
  }
  const logs = guardExecutionClaims('The deploy log shows it passed. Save this as lis/solve.py.', { message: 'Show me the deploy logs.', receipts: [] });
  assert.match(logs.text, /^I cannot verify/);
});
