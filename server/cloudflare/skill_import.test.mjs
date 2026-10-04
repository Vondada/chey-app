import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFilesForAgent, skillFromMarkdown, skillImportIntent } from './skill_import.js';

const cursorSkill = `---
name: advisor
description: >-
  Advisor mode. Consult a stronger model at key checkpoints:
  before major decisions and when stuck on an error.
icon: lightbulb
---

# Advisor

## Workflow

1. Write a full briefing of the task and the decision.
2. Send it to the advisor model and wait for guidance.
3. Apply the guidance and keep doing the work yourself.
`;

test('Cursor/AgentSkills SKILL.md frontmatter becomes the skill name and trigger', () => {
  const skill = skillFromMarkdown('advisor/skills/advisor/SKILL.md', cursorSkill);
  assert.equal(skill.name, 'advisor');
  assert.match(skill.trigger, /^Advisor mode\. Consult a stronger model/);
  assert.equal(skill.steps.length, 3);
});

test('agency-agents style files still parse without frontmatter', () => {
  const skill = skillFromMarkdown('engineering/frontend-developer.md', '# Frontend Developer\n\n## Workflow Process\n\n- Read the design and component inventory first\n- Build accessible components with tests\n');
  assert.equal(skill.name, 'Frontend Developer');
  assert.equal(skill.steps.length, 2);
});

test('plugin and skill repos without agency divisions pick role-matching skill files', () => {
  const paths = [
    'README.md',
    'advisor/skills/advisor/SKILL.md',
    'pr-review-canvas/skills/review/SKILL.md',
    'third_party/x/skills/security-review/SKILL.md',
    'create-plugin/rules/plugin-quality-gates.mdc',
    'teaching/agents/tutor.md',
  ];
  const files = selectFilesForAgent(paths, 'Knox', { role: 'Senior engineer and code reviewer', specialty: 'review quality' }, 2);
  assert.ok(files.length >= 1);
  assert.ok(files.every((p) => !p.startsWith('third_party/')));
  assert.ok(files.includes('pr-review-canvas/skills/review/SKILL.md'));
});

test('agency division repos keep division-based selection', () => {
  const files = selectFilesForAgent(['engineering/backend-architect.md', 'marketing/seo.md'], 'Knox', { role: 'backend' }, 2);
  assert.deepEqual(files, ['engineering/backend-architect.md']);
});

test('skill import understands Cursor plugins, openclaw and ponytail by name', () => {
  assert.equal(skillImportIntent('give your office agents skills from cursor plugins')?.repo, 'cursor/plugins');
  assert.equal(skillImportIntent('teach the team skills from openclaw')?.repo, 'openclaw/openclaw');
  assert.equal(skillImportIntent('give the office team skills from ponytail')?.repo, 'DietrichGebert/ponytail');
});
