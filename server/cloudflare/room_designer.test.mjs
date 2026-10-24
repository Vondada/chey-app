// CHE Living World: a room is proposed, previewed, approved or changed by the owner, verified before it is activated,
// and can be rolled back. Pure logic over the Office record; the routes are owner-device gated in worker.js.
import assert from 'node:assert/strict';
import test from 'node:test';

import { HQ_ROOMS, hqView, roomById } from './headquarters.js';
import { normalizeAgent } from './agent_runtime.js';
import { ensureLaAgenciaRoster } from './office_company.js';
import { activeRoomsOf, decideProposal, designProposal, rollbackRoom, roomProposalsView, templateForNeed } from './room_designer.js';

const RESERVED = HQ_ROOMS.map((room) => room.id);

function officeData() {
  const data = { team: [], team_tasks: [], office_goals: [], office_inbox: [] };
  ensureLaAgenciaRoster(data);
  data.team.forEach(normalizeAgent);
  return data;
}

test('a robotics need gets a reviewed design: the lead it recommends, its tools, and what waits for approval', () => {
  assert.equal(templateForNeed('Set up a robot arm lab')?.id, 'robotics_lab');
  assert.equal(templateForNeed('sell shoes online'), null);
  const data = officeData();
  const { proposal } = designProposal(data, { need: 'Set up a robot arm lab' });
  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.room.name, 'Robotics Lab');
  assert.equal(proposal.lead.name, 'Knox');
  assert.equal(proposal.lead.on_roster, true);
  assert.ok(proposal.equipment.every((e) => e.needs_approval === true && e.connected === false));
  assert.ok(proposal.tools.some((t) => t.name === 'Physical robot' && t.connected === false));
  assert.ok(proposal.approvals.includes('Connecting a real robot or device'));
  assert.equal(proposal.cost.measured, null, 'no cost is invented');
  assert.equal(designProposal(data, { need: 'robots for the lab' }).reused, true, 'an open proposal is reused, not duplicated');
});

test('an unknown need gets an honest refusal and no proposal', () => {
  const data = officeData();
  const out = designProposal(data, { need: 'sell shoes online' });
  assert.equal(out.status, 400);
  assert.equal((data.hq_proposals || []).length, 0);
});

test('the owner can change a proposal, and a changed one waits for approval again', () => {
  const data = officeData();
  const { proposal } = designProposal(data, { need: 'robotics' });
  const out = decideProposal(data, proposal.id, { decision: 'modify', changes: { name: 'Robot Bay' }, reservedIds: RESERVED });
  assert.equal(out.proposal.room.name, 'Robot Bay');
  assert.equal(out.proposal.version, 2);
  assert.equal(out.proposal.status, 'proposed');
  assert.equal(activeRoomsOf(data).length, 0, 'nothing is built by a change');
});

test('a rejected proposal builds nothing and cannot be approved afterwards', () => {
  const data = officeData();
  const { proposal } = designProposal(data, { need: 'robotics' });
  assert.equal(decideProposal(data, proposal.id, { decision: 'reject', reservedIds: RESERVED }).proposal.status, 'rejected');
  const again = decideProposal(data, proposal.id, { decision: 'approve', reservedIds: RESERVED });
  assert.equal(again.status, 409);
  assert.equal(activeRoomsOf(data).length, 0);
});

test('approval builds and verifies the room, and the headquarters shows it with its lead', () => {
  const data = officeData();
  const { proposal } = designProposal(data, { need: 'robotics' });
  const out = decideProposal(data, proposal.id, { decision: 'approve', reservedIds: RESERVED });
  assert.equal(out.proposal.status, 'active');
  assert.equal(out.proposal.verification.passed, true);
  assert.equal(out.proposal.verification.checks.length, 5);
  assert.deepEqual(activeRoomsOf(data).map((r) => r.id), ['robotics_lab']);
  assert.equal(roomById('robotics_lab', data).lead, 'Knox');
  const view = hqView(data, {});
  const robotics = view.rooms.find((r) => r.id === 'robotics_lab');
  assert.ok(robotics, 'the new room appears in the headquarters');
  assert.equal(robotics.lead, 'Knox');
  assert.equal(robotics.on_roster, true);
  assert.equal(view.rooms.length, HQ_ROOMS.length + 1);
});

test('a room whose lead has left the roster is not activated, and says which check failed', () => {
  const data = officeData();
  const { proposal } = designProposal(data, { need: 'robotics' });
  data.team = data.team.filter((a) => a.name !== 'Knox');
  const out = decideProposal(data, proposal.id, { decision: 'approve', reservedIds: RESERVED });
  assert.equal(out.proposal.status, 'failed_verification');
  assert.equal(out.proposal.verification.passed, false);
  assert.match(out.proposal.history.at(-1).detail, /the lead is on the roster/);
  assert.equal(activeRoomsOf(data).length, 0, 'an unverified room never reaches the headquarters');
});

test('a tool claimed connected that is not connected blocks the room', () => {
  const data = officeData();
  const { proposal } = designProposal(data, { need: 'robotics' });
  proposal.tools.find((t) => t.name === 'Physical robot').connected = true;
  const out = decideProposal(data, proposal.id, { decision: 'approve', reservedIds: RESERVED });
  assert.equal(out.proposal.status, 'failed_verification');
  const check = out.proposal.verification.checks.find((c) => c.check === 'no tool is claimed connected unless it is');
  assert.equal(check.passed, false);
});

test('a rebuilt room keeps its earlier version, and rollback restores it', () => {
  const data = officeData();
  const first = designProposal(data, { need: 'robotics' }).proposal;
  decideProposal(data, first.id, { decision: 'approve', reservedIds: RESERVED });
  const second = designProposal(data, { need: 'robotics' }).proposal;
  assert.notEqual(second.id, first.id, 'an active room is proposed again as a new proposal');
  decideProposal(data, second.id, { decision: 'modify', changes: { name: 'Robot Bay' }, reservedIds: RESERVED });
  const rebuilt = decideProposal(data, second.id, { decision: 'approve', reservedIds: RESERVED });
  assert.equal(rebuilt.proposal.status, 'active');
  const room = data.hq_rooms.find((r) => r.id === 'robotics_lab');
  assert.equal(room.name, 'Robot Bay');
  assert.equal(room.versions.length, 2);
  const back = rollbackRoom(data, 'robotics_lab');
  assert.equal(back.rolled_back_to, 1);
  assert.equal(data.hq_rooms.find((r) => r.id === 'robotics_lab').name, 'Robotics Lab');
  assert.equal(activeRoomsOf(data).length, 1);
});

test('a room with no earlier version is retired by rollback and leaves the headquarters', () => {
  const data = officeData();
  const { proposal } = designProposal(data, { need: 'robotics' });
  decideProposal(data, proposal.id, { decision: 'approve', reservedIds: RESERVED });
  const out = rollbackRoom(data, 'robotics_lab');
  assert.equal(out.room.status, 'retired');
  assert.equal(activeRoomsOf(data).length, 0);
  assert.equal(rollbackRoom(data, 'nope_room').status, 404);
  const listing = roomProposalsView(data);
  assert.equal(listing.proposals.length, 1);
  assert.equal(listing.rooms[0].status, 'retired');
});
