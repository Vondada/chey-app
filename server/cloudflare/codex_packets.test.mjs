import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkPacket, savePacket, startCodexJob } from './codex_packets.js';

test('each job gets its own Codex thread and workspace', () => {
  const a = makeWorkPacket({ jobId: 'j1', agentId: 'Knox', goal: 'Build checkout' });
  const b = makeWorkPacket({ jobId: 'j2', agentId: 'Knox', goal: 'Fix tests' });
  assert.equal(a.thread_id, 'office/knox/j1');
  assert.equal(a.workspace, 'codex-ws/knox/j1');
  assert.equal(a.packet_id, 'pkt_j1');
  assert.equal(a.agent_id, 'knox');
  assert.notEqual(a.thread_id, b.thread_id);
  assert.notEqual(a.workspace, b.workspace);
  assert.ok(a.constraints.includes('report_to_che_only'));
});

test('missing owner credential blocks honestly', () => {
  const p = startCodexJob({}, makeWorkPacket({ jobId: 'j1', agentId: 'knox', goal: 'x' }));
  assert.equal(p.status, 'Blocked: tool not configured (Codex)');
});

test('the owner token is never copied into a packet', () => {
  const secret = 'codex-owner-secret-value';
  const p = startCodexJob({ CODEX_OWNER_TOKEN: secret }, makeWorkPacket({ jobId: 'j1', agentId: 'knox', goal: 'x' }));
  assert.equal(p.status, 'running');
  assert.ok(!JSON.stringify(p).includes(secret));
});

test('packets persist on Durable Object state, one per job', () => {
  const data = {};
  savePacket(data, makeWorkPacket({ jobId: 'j1', agentId: 'knox', goal: 'x' }));
  savePacket(data, { ...makeWorkPacket({ jobId: 'j1', agentId: 'knox', goal: 'x' }), status: 'running' });
  assert.equal(data.office_packets.length, 1);
  assert.equal(data.office_packets[0].status, 'running');
});
