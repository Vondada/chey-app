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
