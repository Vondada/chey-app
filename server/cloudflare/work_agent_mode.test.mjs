import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WORK_AGENT_MODE_POLICY,
  isWorkAgentMode,
  shouldAutoDelegateOffice,
  laAgenciaPanelNeeds,
} from './work_agent_mode.js';

test('isWorkAgentMode recognizes full/agent/work flags', () => {
  assert.equal(isWorkAgentMode({ agent_mode: 'full' }), true);
  assert.equal(isWorkAgentMode({ agent_mode: 'agent' }), true);
  assert.equal(isWorkAgentMode({ agent_mode: 'work' }), true);
  assert.equal(isWorkAgentMode({ mode: 'Agent' }), true);
  assert.equal(isWorkAgentMode({ agent_mode: 'chat' }), false);
  assert.equal(isWorkAgentMode({}), false);
});

test('shouldAutoDelegateOffice skips chat/casual/short turns', () => {
  assert.equal(shouldAutoDelegateOffice('hey', { agentMode: true, casual: false }), false);
  assert.equal(shouldAutoDelegateOffice('Research competitors and build a landing page', {
    agentMode: false, casual: false,
  }), false);
  assert.equal(shouldAutoDelegateOffice('Research competitors and build a landing page', {
    agentMode: true, casual: true,
  }), false);
  assert.equal(shouldAutoDelegateOffice('Tell the Office to research Houston', {
    agentMode: true, casual: false,
  }), false);
});

test('shouldAutoDelegateOffice queues multi-step and capability-backed work', () => {
  assert.equal(shouldAutoDelegateOffice('Research competitors in Houston and build a landing page', {
    agentMode: true, casual: false,
  }), true);
  assert.equal(shouldAutoDelegateOffice('draft a product listing for the new pack', {
    agentMode: true, casual: false, capabilities: ['marketing_social'],
  }), true);
  assert.equal(shouldAutoDelegateOffice('build a roblox weapon tool script please', {
    agentMode: true, casual: false,
  }), true);
});

test('laAgenciaPanelNeeds routes specialist desks from the goal splitter', () => {
  const needs = laAgenciaPanelNeeds('Research competitors and build a landing page then post on Instagram');
  const names = needs.map((n) => n.name);
  assert.ok(names.includes('Atlas'));
  assert.ok(names.includes('Knox') || names.includes('Nova') || names.includes('Lyra'));
  assert.ok(WORK_AGENT_MODE_POLICY.includes('WORK AGENT MODE'));
  assert.ok(!WORK_AGENT_MODE_POLICY.toLowerCase().includes('cursor cloud agents are available'));
});
