import test from 'node:test';
import assert from 'node:assert/strict';
import { computerControl } from './shipper_poc.js';

test('allowlisted commands without execution adapters never produce successful action receipts', async () => {
  for (const action of ['screenshot', 'list_files', 'scaffold_website']) {
    const response = await computerControl({ action, target: 'https://example.com', approve: true });
    assert.equal(response.ok, false, action);
    assert.equal(response.executed, false, action);
    assert.equal(response.status, 'unavailable', action);
    assert.equal(response.receipt_id, undefined, action);
    assert.equal(response.result, undefined, action);
  }
});
