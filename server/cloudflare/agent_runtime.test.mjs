import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAgent,
  handoffAgentTask,
  officeSkillsView,
  queueAgentTask,
  steerAgentTask,
  teachOfficeSkill,
} from './agent_runtime.js';

function state() {
  return { team: [], team_tasks: [], meetings: [], owner_context: [], office_skills: [] };
}

test('CHE Office can learn and expose reusable workflows', () => {
  const data = state();
  const taught = teachOfficeSkill(data, {
    name: 'Ship a Flutter UI fix',
    trigger: 'change CHE UI',
    steps: ['Inspect the current screen', 'Implement the smallest change', 'Run analyze and tests'],
  });
  assert.ok(taught.skill.id);
  assert.equal(officeSkillsView(data).length, 1);
  assert.deepEqual(officeSkillsView(data)[0].steps, [
    'Inspect the current screen',
    'Implement the smallest change',
    'Run analyze and tests',
  ]);
});

test('owner can redirect a live Office task without losing it', () => {
  const data = state();
  const agent = createAgent(data, { name: 'Nova', role: 'Research Partner' }).agent;
  const task = queueAgentTask(data, agent, 'Research the launch plan', 'owner');
  const steered = steerAgentTask(data, task.id, 'Focus on the fastest no-cost path.');
  assert.equal(steered.task.steering_version, 1);
  assert.equal(steered.task.steering[0].text, 'Focus on the fastest no-cost path.');
  assert.equal(steered.task.status, 'queued');
});

test('Office tasks can be handed between specialist agents', () => {
  const data = state();
  const first = createAgent(data, { name: 'Nova', role: 'Research Partner' }).agent;
  const second = createAgent(data, { name: 'Juno', role: 'Build Partner' }).agent;
  const task = queueAgentTask(data, first, 'Investigate and then implement', 'owner');
  const moved = handoffAgentTask(data, task.id, second.id, 'Research is done; build the implementation.');
  assert.equal(moved.task.partner_id, second.id);
  assert.equal(moved.task.partner_name, 'Juno');
  assert.equal(moved.task.handoffs.length, 1);
  assert.match(moved.task.handoffs[0].note, /build the implementation/i);
});

test('computer work is permission-scoped and explicit in task metadata', () => {
  const data = state();
  const agent = createAgent(data, { role: 'Systems Integration Partner' }).agent;
  const task = queueAgentTask(data, agent, 'Update the CRM', 'owner', {
    use_computer: true,
    owner_approved_computer: true,
    computer_permissions: ['browser:crm.example', 'filesystem:/workspace'],
    teach_as_skill: 'CRM update',
  });
  assert.equal(task.use_computer, true);
  assert.equal(task.owner_approved_computer, true);
  assert.deepEqual(task.computer_permissions, ['browser:crm.example', 'filesystem:/workspace']);
  assert.equal(task.teach_as_skill, 'CRM update');
});
