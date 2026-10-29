// The offline guard refuses outside hosts, so no Worker test can depend on the runner's network.
import assert from 'node:assert/strict';
import test from 'node:test';
import './test_offline_guard.mjs';

test('the Worker test run refuses a request to an outside host, with the host named', async () => {
  await assert.rejects(fetch('https://en.wikipedia.org/w/api.php?format=json'), (error) => /offline in tests: en\.wikipedia\.org/.test(error.message));
  await assert.rejects(fetch('https://api.github.com/repos/o/r'), /offline in tests: api\.github\.com/);
});
